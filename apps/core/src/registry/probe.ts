import type { RegistryCheckResult, RegistryProbe, RegistryProbeInput } from "@ostra/domain";
import { z } from "zod";

// Core's own calls to a registry's OCI distribution API, for the `registry.check` job (F-120,
// ADR 0060): `/v2/`, the token flow when the registry asks for it, a push scope on the prefix
// checked by starting an upload and cancelling it, and a pull scope checked on an existing
// manifest or the repository's tag list. No image is pushed and no blob is written. The result's
// words carry status codes and the registry's host, never a credential or a token.

type Credential = { readonly username: string; readonly token: string };

type Challenge = { readonly kind: "none" } | { readonly kind: "basic" } | { readonly kind: "bearer"; readonly realm: string; readonly service: string | null };

type Step = { readonly ok: true } | { readonly ok: false; readonly status: number | null; readonly detail: string };

const TIMEOUT_MS = 10_000;

const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

/** A token endpoint's answer (Docker's token flow): a vendor's format, so unknown fields are let through. */
const tokenAnswerSchema = z.looseObject({ token: z.string().min(1).optional(), access_token: z.string().min(1).optional() });

const basic = (credential: Credential): string => `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString("base64")}`;

/** The parameters of a `WWW-Authenticate` challenge: `Bearer realm="...",service="..."`. */
const challengeParams = (header: string): Readonly<Record<string, string>> =>
  Object.fromEntries([...header.matchAll(/([a-z]+)="([^"]*)"/gi)].flatMap((match) => (match[1] === undefined || match[2] === undefined ? [] : [[match[1].toLowerCase(), match[2]]])));

export type ProbeOptions = {
  /** Each request's timeout. Default 10 s. */
  readonly timeoutMs?: number;
};

/** A probe of the distribution API over `fetch`. */
export const createRegistryProbe =
  (options: ProbeOptions = {}): RegistryProbe =>
  async (input: RegistryProbeInput): Promise<RegistryCheckResult> => {
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const host = new URL(input.baseUrl).host;
    const call = async (url: string, init: { readonly method: string; readonly headers?: Record<string, string> }): Promise<Response | null> => {
      try {
        return await fetch(url, { method: init.method, headers: init.headers ?? {}, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        return null;
      }
    };
    const api = (path: string): string => `${input.baseUrl}/v2/${path}`;

    // Authentication: what the registry asks for.
    const base = await call(`${input.baseUrl}/v2/`, { method: "GET" });
    if (base === null) {
      return { result: "refused", status: null, detail: `The registry at ${host} didn't answer.` };
    }
    let challenge: Challenge = { kind: "none" };
    if (base.status === 401) {
      const header = base.headers.get("www-authenticate") ?? "";
      const params = challengeParams(header);
      challenge = /^bearer /i.test(header) && params["realm"] !== undefined ? { kind: "bearer", realm: params["realm"], service: params["service"] ?? null } : { kind: "basic" };
    } else if (base.status !== 200) {
      return { result: "refused", status: base.status, detail: `The registry at ${host} answered ${String(base.status)} for /v2/: it may not be a registry.` };
    }

    /** The `Authorization` header for a credential and a scope, through the token flow when it's Bearer. */
    const authorize = async (credential: Credential, actions: string): Promise<{ readonly header: string } | { readonly status: number | null }> => {
      if (challenge.kind !== "bearer") {
        return { header: basic(credential) };
      }
      const realm = new URL(challenge.realm);
      if (challenge.service !== null) {
        realm.searchParams.set("service", challenge.service);
      }
      realm.searchParams.set("scope", `repository:${input.repository}:${actions}`);
      const answer = await call(realm.toString(), { method: "GET", headers: { authorization: basic(credential) } });
      if (answer?.status !== 200) {
        return { status: answer?.status ?? null };
      }
      const body = tokenAnswerSchema.safeParse(await answer.json().catch(() => null));
      const token = body.success ? (body.data.token ?? body.data.access_token) : undefined;
      return token === undefined ? { status: answer.status } : { header: `Bearer ${token}` };
    };

    const refusedBy = (what: string, status: number | null): Step => ({
      ok: false,
      status,
      detail: status === 401 || status === 403 ? `The ${what} credential was refused (${String(status)}).` : `The ${what} check failed${status === null ? "" : ` (${String(status)})`}.`,
    });

    // The push scope: an upload started and cancelled, so nothing is written.
    const pushStep = async (credential: Credential): Promise<Step> => {
      const auth = await authorize(credential, "push,pull");
      if (!("header" in auth)) {
        return refusedBy("push", auth.status);
      }
      const started = await call(api(`${input.repository}/blobs/uploads/`), { method: "POST", headers: { authorization: auth.header } });
      if (started?.status !== 202) {
        return refusedBy("push", started?.status ?? null);
      }
      const location = started.headers.get("location");
      if (location !== null) {
        await call(new URL(location, input.baseUrl).toString(), { method: "DELETE", headers: { authorization: auth.header } });
      }
      return { ok: true };
    };

    // The pull scope: an existing snapshot's manifest, or the repository's tag list, where "no such
    // repository" (404) still says the credential was let in.
    const pullStep = async (credential: Credential): Promise<Step> => {
      const auth = await authorize(credential, "pull");
      if (!("header" in auth)) {
        return refusedBy("pull", auth.status);
      }
      const answer =
        input.manifestDigest === null
          ? await call(api(`${input.repository}/tags/list`), { method: "GET", headers: { authorization: auth.header } })
          : await call(api(`${input.repository}/manifests/${input.manifestDigest}`), { method: "HEAD", headers: { authorization: auth.header, accept: MANIFEST_TYPES } });
      const allowed = answer !== null && (answer.status === 200 || (input.manifestDigest === null && answer.status === 404));
      return allowed ? { ok: true } : refusedBy("pull", answer?.status ?? null);
    };

    const push = input.push === null ? refusedBy("push", null) : await pushStep(input.push);
    const pull: Step = input.pull === null ? { ok: true } : await pullStep(input.pull);
    const pullNote = input.pull === null ? " Pulls use the cluster's own identity, which core doesn't check." : "";
    if (pull.ok && push.ok) {
      return { result: "push-and-pull", status: null, detail: `Push and pull are allowed under ${input.repository.split("/").slice(0, -1).join("/") || "the registry"} on ${host}.${pullNote}` };
    }
    if (pull.ok && !push.ok) {
      return { result: "pull-only", status: push.status, detail: `Pull is allowed, push isn't: ${push.detail}${pullNote}` };
    }
    return { result: "refused", status: pull.ok ? null : pull.status, detail: pull.ok ? "Refused." : pull.detail };
  };
