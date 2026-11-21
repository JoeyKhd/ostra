import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

/** One row of the check, as the settings page shows it. */
export const previewCheckRowSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("passed"), detail: z.string() }),
  z.strictObject({ state: z.literal("failed"), reason: z.string() }),
  /** It needs a row before it that didn't pass. */
  z.strictObject({ state: z.literal("skipped"), needs: z.string() }),
  /** Under `localhost`: no record and no certificate to add. */
  z.strictObject({ state: z.literal("not-needed"), detail: z.string() }),
]);
export type PreviewCheckRow = z.infer<typeof previewCheckRowSchema>;

/** The check's answer (`instance.previewDomainCheck`): not set, or each row's result. */
export const previewDomainCheckSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not-set") }),
  z.strictObject({
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
  }),
]);
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

/** Node's probe: `dns.lookup`, and `https` (or `http` under `localhost`) with the name as SNI. `ca` and `lookup` are for tests. */
export const createPreviewDomainProbe = (options: { readonly ca?: string; readonly lookup?: LookupFunction; readonly timeoutMs?: number } = {}): PreviewDomainProbe => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const requestOf = (url: URL, headers: Readonly<Record<string, string>>) => {
    const common = { method: "GET", headers, timeout: timeoutMs, agent: false, ...(options.lookup === undefined ? {} : { lookup: options.lookup }) };
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

/** The certificate row's words for why this machine doesn't trust what the name presented. */
const certificateReason = (certificate: ProbeCertificate, domain: string): string => {
  switch (certificate.error ?? "") {
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "HOSTNAME_MISMATCH": {
      const names = (certificate.names ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.startsWith("DNS:"))
        .map((part) => part.slice(4))
        .join(", ");
      return names === "" ? `The certificate doesn't cover *.${domain}.` : `The certificate covers ${names} only, not *.${domain}.`;
    }
    case "CERT_HAS_EXPIRED":
      return certificate.validTo === null ? "It has expired." : `It expired on ${certificate.validTo}.`;
    default:
      return "Its chain isn't trusted.";
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
    dns = { state: "not-needed", detail: `Not needed for ${domain}: browsers send every *.localhost name to this machine.` };
  } else {
    const addresses = await deps.probe.resolve(name);
    if (addresses.length === 0) {
      dns = { state: "failed", reason: `${name} doesn't resolve.` };
    } else {
      const coreAddresses = isAddress(coreHost) ? [coreHost] : await deps.probe.resolve(coreHost);
      const shared = coreAddresses.length === 0 || addresses.some((address) => coreAddresses.includes(address));
      dns = shared ? { state: "passed", detail: `${name} → ${coreHost} · ${addresses.join(", ")}` } : { state: "failed", reason: `${name} resolves to ${addresses.join(", ")}, not ${coreHost}.` };
    }
  }

  let certificate: PreviewCheckRow;
  let answer: ProbeAnswer | null = null;
  if (local) {
    certificate = { state: "not-needed", detail: `Not needed for ${domain}: browsers keep a preview's cookie on http there.` };
  } else if (origin.scheme === "http") {
    certificate = { state: "failed", reason: "Core's public address (OSTRA_CORE_PUBLIC_URL) is http: browsers drop a preview's cookie on plain http, so it needs https." };
  } else if (dns.state !== "passed") {
    certificate = { state: "skipped", needs: "Not checked: it needs the DNS record." };
  } else {
    answer = await deps.probe.fetch(url);
    if (!answer.ok) {
      certificate = { state: "failed", reason: `${name} doesn't answer over https (${answer.error}).` };
    } else if (answer.certificate === null) {
      certificate = { state: "failed", reason: `${name} didn't present a certificate.` };
    } else if (!answer.certificate.authorized) {
      certificate = { state: "failed", reason: certificateReason(answer.certificate, domain) };
    } else {
      certificate = { state: "passed", detail: `*.${domain}${answer.certificate.validTo === null ? "" : `, valid until ${answer.certificate.validTo}`}` };
    }
  }

  const reached = certificate.state === "passed" || certificate.state === "not-needed";
  let proxy: PreviewCheckRow;
  if (!reached) {
    proxy = { state: "skipped", needs: "Not checked: it needs the certificate." };
  } else {
    answer ??= await deps.probe.fetch(url);
    if (!answer.ok) {
      proxy = { state: "failed", reason: `${name} doesn't answer (${answer.error}).` };
    } else if (answer.mark !== null && sameMark(answer.mark, deps.mark(name))) {
      proxy = { state: "passed", detail: "Core's preview proxy answered." };
    } else {
      proxy = { state: "failed", reason: "Something else answered: the ingress sends these hosts elsewhere." };
    }
  }

  let upgrade: PreviewCheckRow;
  if (proxy.state !== "passed") {
    upgrade = { state: "skipped", needs: reached ? "Not checked: it needs core's preview proxy." : "Not checked: it needs the certificate." };
  } else {
    const upgraded = await deps.probe.upgrade(url);
    upgrade = !upgraded.ok
      ? { state: "failed", reason: `The upgrade didn't go through (${upgraded.error}).` }
      : upgraded.status === 101
        ? { state: "passed", detail: "An upgrade went through." }
        : { state: "failed", reason: `The ingress refused the upgrade (${String(upgraded.status)}).` };
  }

  const fine = (row: PreviewCheckRow): boolean => row.state === "passed" || row.state === "not-needed";
  return { state: "checked", name, at: deps.clock.now(), dns, certificate, proxy, upgrade, passed: [dns, certificate, proxy, upgrade].every(fine) };
};
