import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookupCallback } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { TLSSocket } from "node:tls";

import { z } from "zod";

import type { Clock } from "../ports.ts";
import { previewOriginOf } from "./host.ts";
import type { PreviewOrigin } from "./host.ts";

// The instance's preview domain check (milestone 8, ticket 25, F-144; `instance-preview-domain.md`):
// resolve a random name under the domain, open it over HTTPS on core's public port, and report the
// DNS record, the certificate, whether core's preview proxy answered, and whether a WebSocket
// upgrade went through, each passed, failed or not run. Core's proxy answers `/.ostra/check` on any
// preview host with a mark only a replica of this install can make (an HMAC under the secrets key
// over the host), so a server that isn't ostra's can't pass for it. Under `localhost` browsers need
// no record and no certificate, so the check runs the last two over `http`.

/** The path core's preview proxy answers the check on, on any host under the preview domain. */
export const PREVIEW_CHECK_PATH = "/.ostra/check";

/** The header core's answer carries its mark in. */
export const PREVIEW_CHECK_HEADER = "x-ostra-preview-check";

/** The mark core puts on its check answer for `host`: an HMAC under the secrets key, so only this install's core makes it. */
export const previewCheckMark = (secret: string, host: string): string =>
  createHmac("sha256", secret).update(`preview-check\n${host.toLowerCase().replace(/:\d{1,5}$/, "").replace(/\.$/, "")}`).digest("base64url");

const sameMark = (given: string, wanted: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(wanted);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * What a row that passed found, as a code and its values, which the settings page words (F-083):
 * the name, core's host and the addresses it resolved to; the certificate's domain and end; core's
 * proxy answering; an upgrade going through.
 */
export const previewCheckPassSchema = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("dns-resolves"), name: z.string(), coreHost: z.string(), addresses: z.array(z.string()) }),
  /** `validTo` as the certificate gives it (`Feb 19 12:00:00 2027 GMT`), or `null` when it gives none. */
  z.strictObject({ code: z.literal("certificate-valid"), domain: z.string(), validTo: z.string().nullable() }),
  z.strictObject({ code: z.literal("proxy-answered") }),
  z.strictObject({ code: z.literal("upgrade-through") }),
]);
export type PreviewCheckPass = z.infer<typeof previewCheckPassSchema>;

/**
 * Why a row failed, as a code and its values (F-083). `error` is Node's code for a call that failed
 * (`ECONNREFUSED`, `timeout`); `names` the certificate's names, `[]` when it lists none.
 */
export const previewCheckFailureSchema = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("dns-no-record"), name: z.string() }),
  z.strictObject({ code: z.literal("dns-elsewhere"), name: z.string(), addresses: z.array(z.string()), coreHost: z.string() }),
  /** Core's public address is plain http: browsers drop a preview's cookie there. */
  z.strictObject({ code: z.literal("core-http") }),
  z.strictObject({ code: z.literal("no-https-answer"), name: z.string(), error: z.string() }),
  z.strictObject({ code: z.literal("no-certificate"), name: z.string() }),
  z.strictObject({ code: z.literal("certificate-names"), domain: z.string(), names: z.array(z.string()) }),
  z.strictObject({ code: z.literal("certificate-expired"), validTo: z.string().nullable() }),
  z.strictObject({ code: z.literal("certificate-untrusted") }),
  z.strictObject({ code: z.literal("no-answer"), name: z.string(), error: z.string() }),
  /** Something that isn't this install's core answered on the name. */
  z.strictObject({ code: z.literal("something-else") }),
  z.strictObject({ code: z.literal("upgrade-failed"), error: z.string() }),
  z.strictObject({ code: z.literal("upgrade-refused"), status: z.number().int() }),
]);
export type PreviewCheckFailure = z.infer<typeof previewCheckFailureSchema>;

/**
 * One row of the check, as the settings page shows it: codes and values, never sentences (F-083).
 * A result kept before rows were codes doesn't parse, so the page reads the domain as not checked
 * until the next check.
 */
export const previewCheckRowSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("passed"), detail: previewCheckPassSchema }),
  z.strictObject({ state: z.literal("failed"), reason: previewCheckFailureSchema }),
  /** It needs a row before it that didn't pass: the DNS record, the certificate or core's proxy. */
  z.strictObject({ state: z.literal("skipped"), needs: z.enum(["dns", "certificate", "proxy"]) }),
  /** Under `localhost`: no record and no certificate to add, for this domain. */
  z.strictObject({ state: z.literal("not-needed"), domain: z.string() }),
]);
export type PreviewCheckRow = z.infer<typeof previewCheckRowSchema>;

/** The check's answer once it ran: each row's result (kept per install, ticket 26). */
export const previewDomainCheckedSchema = z.strictObject({
  state: z.literal("checked"),
  /** The random name it tried, under the domain. */
  name: z.string(),
  /** Epoch ms. */
  at: z.number().int(),
  dns: previewCheckRowSchema,
  certificate: previewCheckRowSchema,
  proxy: previewCheckRowSchema,
  upgrade: previewCheckRowSchema,
  /** Every row passed (or wasn't needed): the native preview works. */
  passed: z.boolean(),
});

/** The check's answer (`instance.previewDomainCheck`): not set, or each row's result. */
export const previewDomainCheckSchema = z.discriminatedUnion("state", [z.strictObject({ state: z.literal("not-set") }), previewDomainCheckedSchema]);
export type PreviewDomainCheck = z.infer<typeof previewDomainCheckSchema>;

/** What a fetch of the check path saw. */
export type ProbeAnswer =
  | {
      readonly ok: true;
      readonly status: number;
      readonly mark: string | null;
      /** Over `https`: the certificate the name presented, and whether this machine trusts it for the name. */
      readonly certificate: ProbeCertificate | null;
    }
  | { readonly ok: false; readonly error: string };

export type ProbeCertificate = {
  readonly authorized: boolean;
  /** Node's code for why it isn't trusted (`ERR_TLS_CERT_ALTNAME_INVALID`, `CERT_HAS_EXPIRED`, …). */
  readonly error: string | null;
  /** The names it covers (`subjectaltname`), as `DNS:*.example.com, DNS:example.com`. */
  readonly names: string | null;
  readonly validTo: string | null;
};

/** The network calls the check makes: Node's own by default, fakes in tests. */
export type PreviewDomainProbe = {
  /** A name's addresses; `[]` when it doesn't resolve. */
  readonly resolve: (hostname: string) => Promise<readonly string[]>;
  readonly fetch: (url: URL) => Promise<ProbeAnswer>;
  /** A WebSocket upgrade on `url`: the status that answered it (101 when it went through). */
  readonly upgrade: (url: URL) => Promise<{ readonly ok: true; readonly status: number } | { readonly ok: false; readonly error: string }>;
};

const isLocalhostDomain = (domain: string): boolean => domain === "localhost" || domain.endsWith(".localhost");

const isAddress = (host: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");

const codeOf = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.name : "failed");

/**
 * `dns.lookup`, except that every name under `localhost` is this machine's loopback, as browsers
 * have it (spike 08 §3.5): a container's or a CI machine's resolver may not know `*.localhost`, and
 * a one-machine install's check (core's own, at its start) must reach core there all the same.
 */
export const localhostLookup: LookupFunction = (hostname, lookupOptions, callback) => {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) {
    if (lookupOptions.all === true) {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    } else {
      callback(null, "127.0.0.1", 4);
    }
    return;
  }
  dnsLookupCallback(hostname, lookupOptions, callback);
};

/** Node's probe: `dns.lookup` (with `*.localhost` on loopback), and `https` (or `http` under `localhost`) with the name as SNI. `ca` and `lookup` are for tests. */
export const createPreviewDomainProbe = (options: { readonly ca?: string; readonly lookup?: LookupFunction; readonly timeoutMs?: number } = {}): PreviewDomainProbe => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const requestOf = (url: URL, headers: Readonly<Record<string, string>>) => {
    const common = { method: "GET", headers, timeout: timeoutMs, agent: false, lookup: options.lookup ?? localhostLookup };
    return url.protocol === "https:"
      ? httpsRequest(url, { ...common, servername: url.hostname, rejectUnauthorized: false, ...(options.ca === undefined ? {} : { ca: options.ca }) })
      : httpRequest(url, common);
  };
  return {
    resolve: async (hostname) => {
      if (options.lookup !== undefined) {
        const lookup = options.lookup;
        return new Promise((resolve) => {
          lookup(hostname, { all: true }, (error, addresses) => {
            resolve(error === null && Array.isArray(addresses) ? addresses.map((entry) => entry.address) : []);
          });
        });
      }
      try {
        return (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);
      } catch {
        return [];
      }
    },
    fetch: (url) =>
      new Promise((resolve) => {
        const call = requestOf(url, {});
        call.on("timeout", () => {
          call.destroy(new Error("timeout"));
        });
        call.on("error", (error) => {
          resolve({ ok: false, error: error.message === "timeout" ? "timeout" : codeOf(error) });
        });
        call.on("response", (answer: IncomingMessage) => {
          answer.resume();
          const socket = answer.socket;
          let certificate: ProbeCertificate | null = null;
          if (socket instanceof TLSSocket) {
            const tls = socket;
            const peer = tls.getPeerCertificate();
            // Node gives the reason's code as a string, and nothing when it's trusted, whatever its type says.
            const reason: unknown = tls.authorizationError;
            certificate = {
              authorized: tls.authorized,
              error: typeof reason === "string" ? reason : reason instanceof Error ? codeOf(reason) : null,
              names: typeof peer.subjectaltname === "string" ? peer.subjectaltname : null,
              validTo: typeof peer.valid_to === "string" ? peer.valid_to : null,
            };
          }
          const mark = answer.headers[PREVIEW_CHECK_HEADER];
          resolve({ ok: true, status: answer.statusCode ?? 0, mark: typeof mark === "string" ? mark : null, certificate });
        });
        call.end();
      }),
    upgrade: (url) =>
      new Promise((resolve) => {
        const call = requestOf(url, { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") });
        call.on("timeout", () => {
          call.destroy(new Error("timeout"));
        });
        call.on("error", (error) => {
          resolve({ ok: false, error: error.message === "timeout" ? "timeout" : codeOf(error) });
        });
        call.on("upgrade", (answer: IncomingMessage, socket) => {
          socket.destroy();
          resolve({ ok: true, status: answer.statusCode ?? 101 });
        });
        call.on("response", (answer: IncomingMessage) => {
          answer.resume();
          resolve({ ok: true, status: answer.statusCode ?? 0 });
        });
        call.end();
      }),
  };
};

/** A random label, so no cache along the way holds the answer. */
const randomLabel = (): string => `ostra-check-${randomBytes(6).toString("hex")}`;

/** Why this machine doesn't trust what the name presented: the names it covers, its end, or its chain. */
const certificateFailure = (certificate: ProbeCertificate, domain: string): PreviewCheckFailure => {
  switch (certificate.error ?? "") {
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "HOSTNAME_MISMATCH": {
      const names = (certificate.names ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.startsWith("DNS:"))
        .map((part) => part.slice(4));
      return { code: "certificate-names", domain, names };
    }
    case "CERT_HAS_EXPIRED":
      return { code: "certificate-expired", validTo: certificate.validTo };
    default:
      return { code: "certificate-untrusted" };
  }
};

/**
 * Runs the instance's preview domain check (ticket 25, for ticket 26's settings page): with no
 * domain, `not-set`. Otherwise a random name under it, resolved and compared with core's public
 * host; opened over core's public scheme and port, its certificate checked for the name; core's
 * mark on the answer; and a WebSocket upgrade on the same path. A row that needs one before it that
 * didn't pass is `skipped`. Under `localhost`, the record and the certificate aren't needed.
 */
export const checkPreviewDomain = async (
  deps: { readonly probe: PreviewDomainProbe; readonly mark: (host: string) => string; readonly clock: Clock },
  settings: { readonly domain: string | null; readonly corePublicUrl: string },
): Promise<PreviewDomainCheck> => {
  const domain = settings.domain;
  if (domain === null) {
    return { state: "not-set" };
  }
  const name = `${randomLabel()}.${domain}`;
  const origin: PreviewOrigin = previewOriginOf(settings.corePublicUrl);
  const url = new URL(`${origin.scheme}://${name}${origin.port === "" ? "" : `:${origin.port}`}/.ostra/check`);
  const local = isLocalhostDomain(domain);
  const coreHost = new URL(settings.corePublicUrl).hostname;

  let dns: PreviewCheckRow;
  if (local) {
    dns = { state: "not-needed", domain };
  } else {
    const addresses = await deps.probe.resolve(name);
    if (addresses.length === 0) {
      dns = { state: "failed", reason: { code: "dns-no-record", name } };
    } else {
      const coreAddresses = isAddress(coreHost) ? [coreHost] : await deps.probe.resolve(coreHost);
      const shared = coreAddresses.length === 0 || addresses.some((address) => coreAddresses.includes(address));
      dns = shared
        ? { state: "passed", detail: { code: "dns-resolves", name, coreHost, addresses: [...addresses] } }
        : { state: "failed", reason: { code: "dns-elsewhere", name, addresses: [...addresses], coreHost } };
    }
  }

  let certificate: PreviewCheckRow;
  let answer: ProbeAnswer | null = null;
  if (local) {
    certificate = { state: "not-needed", domain };
  } else if (origin.scheme === "http") {
    certificate = { state: "failed", reason: { code: "core-http" } };
  } else if (dns.state !== "passed") {
    certificate = { state: "skipped", needs: "dns" };
  } else {
    answer = await deps.probe.fetch(url);
    if (!answer.ok) {
      certificate = { state: "failed", reason: { code: "no-https-answer", name, error: answer.error } };
    } else if (answer.certificate === null) {
      certificate = { state: "failed", reason: { code: "no-certificate", name } };
    } else if (!answer.certificate.authorized) {
      certificate = { state: "failed", reason: certificateFailure(answer.certificate, domain) };
    } else {
      certificate = { state: "passed", detail: { code: "certificate-valid", domain, validTo: answer.certificate.validTo } };
    }
  }

  const reached = certificate.state === "passed" || certificate.state === "not-needed";
  let proxy: PreviewCheckRow;
  if (!reached) {
    proxy = { state: "skipped", needs: "certificate" };
  } else {
    answer ??= await deps.probe.fetch(url);
    if (!answer.ok) {
      proxy = { state: "failed", reason: { code: "no-answer", name, error: answer.error } };
    } else if (answer.mark !== null && sameMark(answer.mark, deps.mark(name))) {
      proxy = { state: "passed", detail: { code: "proxy-answered" } };
    } else {
      proxy = { state: "failed", reason: { code: "something-else" } };
    }
  }

  let upgrade: PreviewCheckRow;
  if (proxy.state !== "passed") {
    upgrade = { state: "skipped", needs: reached ? "proxy" : "certificate" };
  } else {
    const upgraded = await deps.probe.upgrade(url);
    upgrade = !upgraded.ok
      ? { state: "failed", reason: { code: "upgrade-failed", error: upgraded.error } }
      : upgraded.status === 101
        ? { state: "passed", detail: { code: "upgrade-through" } }
        : { state: "failed", reason: { code: "upgrade-refused", status: upgraded.status } };
  }

  const fine = (row: PreviewCheckRow): boolean => row.state === "passed" || row.state === "not-needed";
  return { state: "checked", name, at: deps.clock.now(), dns, certificate, proxy, upgrade, passed: [dns, certificate, proxy, upgrade].every(fine) };
};
