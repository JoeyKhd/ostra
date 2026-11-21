import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:https";
import type { LookupFunction } from "node:net";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { makeSelfSignedCert } from "@ostra/adapter-sdk/testing";
import { loginSessionIdSchema, memberIdSchema, organizationIdSchema, previewIdSchema, previewKeySchema, previewLinkIdSchema, taskIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkPreviewDomain, createPreviewDomainProbe, PREVIEW_CHECK_HEADER, previewCheckMark } from "./previews/domain-check.ts";
import type { PreviewDomainProbe } from "./previews/domain-check.ts";
import {
  isPreviewDomainHost,
  PREVIEW_COOKIE,
  PREVIEW_COOKIE_MAX_MS,
  previewCookieHeader,
  previewCookieValue,
  previewFrameSource,
  previewHost,
  previewHostOrigin,
  previewOriginOf,
  previewRedirectPath,
  previewSiteLayout,
  rewriteRequest,
  rewriteResponse,
} from "./previews/host.ts";
import { newPreviewId } from "./previews/native.ts";
import { createPreviewCookies } from "./previews/tokens.ts";
import type { PreviewCookieClaims } from "./previews/tokens.ts";
import { parseServerSettings } from "./settings.ts";

// Milestone 8's ticket 25 (F-144, ADR 0068 "The native preview"): the pure parts of the preview
// domain. The site layout that picks the cookie's `SameSite`, the cookie's own attributes and its
// value (an HMAC under the secrets key), where a preview host is and how a browser reaches it, the
// handshake's redirect, the strips the proxy adds, and the instance's domain check, against fakes
// and against a real TLS server on loopback. Core's proxy itself is `apps/core/src/previews/native.test.ts`.

const at = Date.UTC(2026, 10, 21, 12);
const previewId = previewIdSchema.parse("k3f7d2abcdefghijklmnopqrst");

describe("the site layout and the cookie (F-144/c3)", () => {
  it("F-144/c3: the preview domain is the panel's site, or another, as a browser reads the two hosts", () => {
    const cases: readonly (readonly [string, string, "same-site" | "cross-site"])[] = [
      // Spike 08's two layouts on this machine: `localhost` is a suffix of its own.
      ["http://localhost:3000", "preview.localhost", "cross-site"],
      ["http://ostra.localhost:3000", "preview.ostra.localhost", "same-site"],
      ["http://ostra.localhost:3000", "preview.localhost", "cross-site"],
      // A subdomain beside the panel's (Q307: allowed, with a warning), and under the panel's own host.
      ["https://ostra.acme.dev", "preview.acme.dev", "same-site"],
      ["https://acme.dev", "preview.acme.dev", "same-site"],
      ["https://ostra.acme.dev", "previews.ostra.acme.dev", "same-site"],
      // A domain of its own (recommended), and a panel on an address.
      ["https://ostra.acme.dev", "acme-preview.dev", "cross-site"],
      ["https://ostra.acme.dev", "preview.other.dev", "cross-site"],
      ["http://127.0.0.1:3000", "preview.localhost", "cross-site"],
      ["http://[::1]:3000", "preview.localhost", "cross-site"],
    ];
    for (const [panel, domain, layout] of cases) {
      expect(previewSiteLayout(panel, domain), `${panel} and ${domain}`).toBe(layout);
    }
  });

  it("F-144/c3: the cookie is __Host-, host-only, Secure and HttpOnly, partitioned across sites and Lax on the panel's site, and its lifetime is its Max-Age", () => {
    const cross = previewCookieHeader("v", "cross-site", 3600.7);
    expect(cross).toBe(`${PREVIEW_COOKIE}=v; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=3600`);
    const same = previewCookieHeader("v", "same-site", 43_200);
    expect(same).toBe(`${PREVIEW_COOKIE}=v; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`);
    for (const header of [cross, same]) {
      expect(header.startsWith("__Host-")).toBe(true);
      expect(header.toLowerCase()).not.toContain("domain=");
    }
    expect(previewCookieHeader("", "same-site", -5)).toContain("Max-Age=0");
    expect(PREVIEW_COOKIE_MAX_MS).toBe(12 * 60 * 60_000);
    // The value a request carries, among the app's own cookies.
    expect(previewCookieValue(`theme=dark; ${PREVIEW_COOKIE}=abc.def; sid=1`)).toBe("abc.def");
    expect(previewCookieValue("theme=dark")).toBeNull();
    expect(previewCookieValue(undefined)).toBeNull();
  });

  it("F-144/c3: the cookie's value is an HMAC under the secrets key over the preview and its viewer, refused forged, for another key, past its deadline or beyond 12 hours", () => {
    const cookies = createPreviewCookies("the-secrets-key");
    const claims: PreviewCookieClaims = {
      grantId: cookies.newGrantId(),
      organizationId: organizationIdSchema.parse(randomUUID()),
      taskId: taskIdSchema.parse(randomUUID()),
      key: previewKeySchema.parse("app-web"),
      port: 5173,
      viewer: { kind: "member", memberId: memberIdSchema.parse(randomUUID()), loginSessionId: loginSessionIdSchema.parse("login-1") },
      expiresAt: at + 3_600_000,
    };
    const value = cookies.issue(claims);
    expect(value).toMatch(/^ostra-preview-cookie-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(cookies.verify(value, at)).toEqual(claims);
    const link: PreviewCookieClaims = { ...claims, viewer: { kind: "link", linkId: previewLinkIdSchema.parse(randomUUID()) } };
    expect(cookies.verify(cookies.issue(link), at)).toEqual(link);
    // Past its deadline, or further ahead than 12 hours (and a minute's slack).
    expect(cookies.verify(value, claims.expiresAt)).toBeNull();
    expect(cookies.verify(cookies.issue({ ...claims, expiresAt: at + PREVIEW_COOKIE_MAX_MS + 120_000 }), at)).toBeNull();
    // Another key's, a changed body, a changed MAC, and junk.
    expect(createPreviewCookies("another-key").verify(value, at)).toBeNull();
    const [body = "", mac = ""] = value.slice("ostra-preview-cookie-".length).split(".");
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), p: 3001 })).toString("base64url");
    expect(cookies.verify(`ostra-preview-cookie-${tampered}.${mac}`, at)).toBeNull();
    expect(cookies.verify(`${value.slice(0, -2)}AA`, at)).toBeNull();
    for (const junk of ["", "ostra-preview-cookie-", "ostra-preview-cookie-a.b.c", `x${value}`]) {
      expect(cookies.verify(junk, at), junk).toBeNull();
    }
  });

  it("F-144/c3: a preview cookie reaches no log line: the log guard redacts its value", () => {
    const records: LogRecord[] = [];
    const logger = createLogger((record) => records.push(record));
    const cookies = createPreviewCookies("the-secrets-key");
    const value = cookies.issue({
      grantId: cookies.newGrantId(),
      organizationId: organizationIdSchema.parse(randomUUID()),
      taskId: taskIdSchema.parse(randomUUID()),
      key: previewKeySchema.parse("app-web"),
      port: 5173,
      viewer: { kind: "link", linkId: previewLinkIdSchema.parse(randomUUID()) },
      expiresAt: at + 60_000,
    });
    logger.info(`a request with ${value}`, { cookie: value });
    expect(JSON.stringify(records)).not.toContain(value.slice(21, 60));
  });
});

describe("the preview hosts (F-144/c1)", () => {
  it("F-144/c1: a host is the preview domain's at any depth, and nothing else", () => {
    const domain = "preview.localhost";
    for (const host of [`5173-${previewId}.preview.localhost:8787`, "preview.localhost", "a.b.preview.localhost", "PREVIEW.LOCALHOST.", `5173-${previewId}.Preview.Localhost`]) {
      expect(isPreviewDomainHost(host, domain), host).toBe(true);
    }
    for (const host of [undefined, "localhost:8787", "127.0.0.1:8787", "preview.localhost.evil.example", "notpreview.localhost", "xpreview.localhost", `${"a".repeat(260)}.preview.localhost`]) {
      expect(isPreviewDomainHost(host, domain), String(host)).toBe(false);
    }
  });

  it("F-144/c1: a preview's host is reached on core's public scheme and port, and the panel frames only those hosts", () => {
    expect(previewOriginOf("https://core.acme.dev")).toEqual({ scheme: "https", port: "" });
    expect(previewOriginOf("http://localhost:8787")).toEqual({ scheme: "http", port: "8787" });
    const host = previewHost(5173, previewId, "previews.acme.dev");
    expect(previewHostOrigin(host, previewOriginOf("https://core.acme.dev"))).toBe(`https://5173-${previewId}.previews.acme.dev`);
    expect(previewHostOrigin(`${host}:443`, previewOriginOf("https://core.acme.dev:8443"))).toBe(`https://5173-${previewId}.previews.acme.dev:8443`);
    expect(previewFrameSource("previews.acme.dev", "https://core.acme.dev")).toBe("https://*.previews.acme.dev");
    expect(previewFrameSource("preview.localhost", "http://localhost:8787")).toBe("http://*.preview.localhost:8787");
  });

  it("F-144/c1: a task's preview ID is 128 random bits in lower-case base32", () => {
    const id = newPreviewId();
    expect(id).toMatch(/^[a-z2-7]{26}$/);
    expect(newPreviewId((size) => new Uint8Array(size).fill(0))).toBe("a".repeat(26));
    expect(newPreviewId((size) => new Uint8Array(size).fill(255))).toBe(`${"7".repeat(25)}4`);
    expect(newPreviewId()).not.toBe(id);
  });

  it("F-144/c3: the handshake redirects to a path on the preview's own host only", () => {
    for (const path of ["/", "/settings?tab=1", "/a/b#c"]) {
      expect(previewRedirectPath(path)).toBe(path);
    }
    for (const path of [null, undefined, "", "//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "/a b", `/${"a".repeat(2048)}`]) {
      expect(previewRedirectPath(path), String(path)).toBe("/");
    }
  });

  it("F-144: a server whose core is under the preview domain refuses to start, as one whose panel is", () => {
    expect(parseServerSettings({ OSTRA_PREVIEW_DOMAIN: "preview.localhost" }).ok).toBe(true);
    const refused = parseServerSettings({ OSTRA_PREVIEW_DOMAIN: "acme.dev", OSTRA_CORE_PUBLIC_URL: "https://core.acme.dev" });
    expect(refused.ok ? [] : refused.errors).toEqual([expect.stringContaining("can't hold core's own host")]);
  });
});

describe("the proxy's strips, added by ticket 25 (F-144/c4)", () => {
  const host = `${previewHost(5173, previewId, "preview.localhost")}:8787`;

  it("F-144/c4: no client names another port to the box, and the scheme is the one the browser used", () => {
    const out = rewriteRequest(
      { host, origin: `http://${host}`, "ostra-target-port": "3001", "ostra-anything": "x", "x-ostra-member": "m" },
      { port: 5173, previewHost: host, hostRewrite: true, outsideLink: false, scheme: "http" },
    );
    expect(out).toEqual({ ok: true, headers: { host: "localhost:5173", origin: "http://localhost:5173" } });
    const off = rewriteRequest({ host }, { port: 5173, previewHost: host, hostRewrite: false, outsideLink: false, scheme: "http" });
    expect(off).toEqual({ ok: true, headers: { host, "x-forwarded-host": host, "x-forwarded-proto": "http" } });
    // An upgrade from `https://` on a preview served over `http` isn't its own origin.
    expect(rewriteRequest({ host, origin: `https://${host}`, upgrade: "websocket" }, { port: 5173, previewHost: host, hostRewrite: true, outsideLink: false, scheme: "http" })).toEqual({
      ok: false,
      reason: "bad-origin",
    });
  });

  it("F-144/c4: the app can't set or clear the preview's own cookie, and Location follows the scheme", () => {
    const out = rewriteResponse(
      { "set-cookie": [`${PREVIEW_COOKIE}=forged; Path=/`, "sid=1; Path=/"], location: "http://localhost:5173/next" },
      { panelOrigin: "http://localhost:3000", previewHost: host, port: 5173, scheme: "http" },
    );
    expect(out.headers).toEqual({ "set-cookie": ["sid=1; Path=/"], location: `http://${host}/next`, "content-security-policy": "frame-ancestors http://localhost:3000" });
    expect(rewriteResponse({ "set-cookie": `${PREVIEW_COOKIE}=forged` }, { panelOrigin: "http://localhost:3000", previewHost: host, port: 5173 }).headers["set-cookie"]).toBeUndefined();
  });
});

describe("the instance's preview domain check (F-144/c8)", () => {
  const corePublicUrl = "https://core.acme.dev";
  const secret = "the-secrets-key";
  const clock = { now: () => at };
  const mark = (host: string): string => previewCheckMark(secret, host);

  /** A probe where every name under the domain resolves to core's address, answering as `answer` says. */
  const probeOf = (options: { readonly resolves?: boolean; readonly coreAt?: string; readonly authorized?: boolean; readonly error?: string | null; readonly marked?: boolean; readonly upgrade?: number }): PreviewDomainProbe => ({
    resolve: (hostname) => Promise.resolve(hostname === "core.acme.dev" ? [options.coreAt ?? "203.0.113.24"] : options.resolves === false ? [] : ["203.0.113.24"]),
    fetch: (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        mark: options.marked === false ? "not-ours" : mark(url.hostname),
        certificate: { authorized: options.authorized ?? true, error: options.error ?? null, names: "DNS:core.acme.dev", validTo: "Feb 19 12:00:00 2027 GMT" },
      }),
    upgrade: () => Promise.resolve({ ok: true, status: options.upgrade ?? 101 }),
  });

  it("F-144/c8: with no domain it reports not set, and with a working one every row passes", async () => {
    expect(await checkPreviewDomain({ probe: probeOf({}), mark, clock }, { domain: null, corePublicUrl })).toEqual({ state: "not-set" });
    const check = await checkPreviewDomain({ probe: probeOf({}), mark, clock }, { domain: "preview.acme.dev", corePublicUrl });
    expect(check).toMatchObject({
      state: "checked",
      at,
      passed: true,
      dns: { state: "passed" },
      certificate: { state: "passed", detail: "*.preview.acme.dev, valid until Feb 19 12:00:00 2027 GMT" },
      proxy: { state: "passed" },
      upgrade: { state: "passed" },
    });
    expect(check.state === "checked" ? check.name : "").toMatch(/^ostra-check-[0-9a-f]{12}\.preview\.acme\.dev$/);
  });

  it("F-144/c8: a missing record, a record elsewhere, a certificate for core only, another server and a refused upgrade each fail their row, and what needs them doesn't run", async () => {
    const missing = await checkPreviewDomain({ probe: probeOf({ resolves: false }), mark, clock }, { domain: "preview.acme.dev", corePublicUrl });
    expect(missing).toMatchObject({ passed: false, dns: { state: "failed" }, certificate: { state: "skipped" }, proxy: { state: "skipped" }, upgrade: { state: "skipped" } });
    expect(missing.state === "checked" && missing.dns.state === "failed" ? missing.dns.reason : "").toMatch(/doesn't resolve\.$/);
    const elsewhere = await checkPreviewDomain({ probe: probeOf({ coreAt: "198.51.100.7" }), mark, clock }, { domain: "preview.acme.dev", corePublicUrl });
    expect(elsewhere.state === "checked" && elsewhere.dns.state === "failed" ? elsewhere.dns.reason : "").toMatch(/resolves to 203\.0\.113\.24, not core\.acme\.dev\.$/);
    const coreOnly = await checkPreviewDomain({ probe: probeOf({ authorized: false, error: "ERR_TLS_CERT_ALTNAME_INVALID" }), mark, clock }, { domain: "preview.acme.dev", corePublicUrl });
    expect(coreOnly).toMatchObject({ certificate: { state: "failed", reason: "The certificate covers core.acme.dev only, not *.preview.acme.dev." }, proxy: { state: "skipped" }, upgrade: { state: "skipped" } });
    const expired = await checkPreviewDomain({ probe: probeOf({ authorized: false, error: "CERT_HAS_EXPIRED" }), mark, clock }, { domain: "preview.acme.dev", corePublicUrl });
    expect(expired).toMatchObject({ certificate: { state: "failed", reason: "It expired on Feb 19 12:00:00 2027 GMT." } });
    const untrusted = await checkPreviewDomain({ probe: probeOf({ authorized: false, error: "SELF_SIGNED_CERT_IN_CHAIN" }), mark, clock }, { domain: "preview.acme.dev", corePublicUrl });
    expect(untrusted).toMatchObject({ certificate: { state: "failed", reason: "Its chain isn't trusted." } });
    const other = await checkPreviewDomain({ probe: probeOf({ marked: false }), mark, clock }, { domain: "preview.acme.dev", corePublicUrl });
    expect(other).toMatchObject({ proxy: { state: "failed", reason: "Something else answered: the ingress sends these hosts elsewhere." }, upgrade: { state: "skipped" } });
    const noUpgrade = await checkPreviewDomain({ probe: probeOf({ upgrade: 400 }), mark, clock }, { domain: "preview.acme.dev", corePublicUrl });
    expect(noUpgrade).toMatchObject({ passed: false, upgrade: { state: "failed", reason: "The ingress refused the upgrade (400)." } });
    // A plain-http core can't serve a real preview domain: browsers drop the cookie.
    const plain = await checkPreviewDomain({ probe: probeOf({}), mark, clock }, { domain: "preview.acme.dev", corePublicUrl: "http://core.acme.dev" });
    expect(plain).toMatchObject({ passed: false, certificate: { state: "failed" } });
  });

  it("F-144/c8: under localhost no record or certificate is needed, and only the last two rows run, over http", async () => {
    const urls: string[] = [];
    const probe: PreviewDomainProbe = {
      resolve: () => Promise.reject(new Error("not asked")),
      fetch: (url) => {
        urls.push(url.toString());
        return Promise.resolve({ ok: true, status: 200, mark: mark(url.hostname), certificate: null });
      },
      upgrade: () => Promise.resolve({ ok: true, status: 101 }),
    };
    const check = await checkPreviewDomain({ probe, mark, clock }, { domain: "preview.localhost", corePublicUrl: "http://localhost:8787" });
    expect(check).toMatchObject({ passed: true, dns: { state: "not-needed" }, certificate: { state: "not-needed" }, proxy: { state: "passed" }, upgrade: { state: "passed" } });
    expect(urls).toEqual([expect.stringMatching(/^http:\/\/ostra-check-[0-9a-f]{12}\.preview\.localhost:8787\/\.ostra\/check$/)]);
  });

  describe("Node's own probe, against a TLS server on loopback", () => {
    let wildcard: Server;
    let coreOnly: Server;
    let ca = "";
    let coreCa = "";
    /** Every name resolves to this machine, as the wildcard record would to core's ingress. */
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      } else {
        callback(null, "127.0.0.1", 4);
      }
    };

    const listen = (server: Server): Promise<number> =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      });

    beforeAll(async () => {
      const wild = await makeSelfSignedCert(new Date(), undefined, ["*.preview.example.test"]);
      const core = await makeSelfSignedCert(new Date(), undefined, ["core.example.test"]);
      ca = wild.cert;
      coreCa = core.cert;
      const handler = (request: IncomingMessage, response: ServerResponse): void => {
        response.writeHead(200, { [PREVIEW_CHECK_HEADER]: mark(request.headers.host ?? "") });
        response.end("ostra preview proxy\n");
      };
      wildcard = createHttpsServer({ key: wild.key, cert: wild.cert }, handler);
      coreOnly = createHttpsServer({ key: core.key, cert: core.cert }, handler);
    });

    afterAll(async () => {
      await Promise.all([wildcard, coreOnly].map((server) => new Promise((resolve) => server.close(resolve))));
    });

    it("F-144/c8: a wildcard certificate this machine trusts passes, and one for core's name only fails with the names it covers", async () => {
      const wildPort = await listen(wildcard);
      const good = await checkPreviewDomain(
        { probe: createPreviewDomainProbe({ ca, lookup, timeoutMs: 3_000 }), mark, clock },
        { domain: "preview.example.test", corePublicUrl: `https://127.0.0.1:${String(wildPort)}` },
      );
      expect(good).toMatchObject({ dns: { state: "passed" }, certificate: { state: "passed" }, proxy: { state: "passed" }, upgrade: { state: "failed" } });
      const corePort = await listen(coreOnly);
      const bad = await checkPreviewDomain(
        { probe: createPreviewDomainProbe({ ca: coreCa, lookup, timeoutMs: 3_000 }), mark, clock },
        { domain: "preview.example.test", corePublicUrl: `https://127.0.0.1:${String(corePort)}` },
      );
      expect(bad).toMatchObject({ certificate: { state: "failed", reason: "The certificate covers core.example.test only, not *.preview.example.test." }, proxy: { state: "skipped" } });
      // Without the CA, the same wildcard isn't trusted here.
      const untrusted = await checkPreviewDomain(
        { probe: createPreviewDomainProbe({ lookup, timeoutMs: 3_000 }), mark, clock },
        { domain: "preview.example.test", corePublicUrl: `https://127.0.0.1:${String(wildPort)}` },
      );
      expect(untrusted).toMatchObject({ certificate: { state: "failed", reason: "Its chain isn't trusted." } });
    });
  });
});
