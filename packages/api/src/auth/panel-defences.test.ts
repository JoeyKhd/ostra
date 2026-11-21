import { previewCheckMark, previewHost } from "@ostra/domain";
import type { PreviewDomainProbe } from "@ostra/domain";
import { previewIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBareHarness, cookieHeaderFrom, PREVIEW_SECRET, TEST_PASSWORD } from "../testing/index.ts";
import type { BareHarness } from "../testing/index.ts";
import { createContext } from "../trpc/context.ts";
import { handleTrpcRequest } from "../trpc/http.ts";
import { ensureFirstAdmin } from "./first-admin.ts";
import { handleAuthRequest } from "./http.ts";

// Milestone 8's ticket 25 (F-144, ADR 0068 "The panel's own defences"): what keeps a page on a
// preview host away from the panel, each case run as a request from a preview host's origin.
// - The panel's session cookie is host-only: a browser sends it to the panel's host and to no name
//   under it or beside it, such as a preview's.
// - A request that changes something on the panel names the panel's own origin, or it's refused:
//   tRPC's mutations (`handleTrpcRequest`) and better-auth's own routes.
// And the instance's preview domain check, as the settings page asks for it (ticket 26).

const panelUrl = "http://localhost:3000";
/** A preview host beside the panel's, the layout where the browser would send a `SameSite=Lax` cookie along. */
const previewOrigin = `http://${previewHost(5173, previewIdSchema.parse("k3f7d2abcdefghijklmnopqrst"), "preview.localhost")}:8787`;

let harness: BareHarness;
let session: Headers;

/**
 * Whether a browser sends a cookie the panel set to a request for `host` (RFC 6265 §5.4): a
 * host-only cookie (no `Domain`) to the host that set it alone; one with a `Domain` to that domain
 * and every name under it.
 */
const sentTo = (setCookie: string, setBy: string, host: string): boolean => {
  const domain = setCookie
    .split(";")
    .slice(1)
    .map((part) => part.trim().split("="))
    .find(([name]) => name?.toLowerCase() === "domain")?.[1]
    ?.toLowerCase()
    .replace(/^\./, "");
  return domain === undefined ? host === setBy : host === domain || host.endsWith(`.${domain}`);
};

beforeAll(async () => {
  harness = await createBareHarness();
  const seeded = await ensureFirstAdmin({
    db: harness.test.db,
    settings: { firstAdmin: { username: "ada", email: "ada@example.com", password: TEST_PASSWORD, organizationName: "Calculator Co" } },
    hashPassword: harness.deps.hashPassword,
    ports: harness.deps.ports,
    logger: harness.deps.logger,
  });
  expect(seeded).not.toBeNull();
  const { headers } = await harness.auth.api.signInUsername({ body: { username: "ada", password: TEST_PASSWORD }, returnHeaders: true });
  session = headers;
});

afterAll(async () => {
  await harness.dispose();
});

const setTheme = (theme: "light" | "dark", headers: Readonly<Record<string, string>>): Promise<Response> =>
  handleTrpcRequest(
    harness.deps,
    new Request(`${panelUrl}/api/trpc/account.setTheme`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeaderFrom(session).get("cookie") ?? "", ...headers },
      body: JSON.stringify({ theme }),
    }),
  );

const themeOf = async (): Promise<string> => (await harness.test.db.user.findFirstOrThrow({ where: { username: "ada" }, select: { theme: true } })).theme;

describe("the panel's own defences", () => {
  it("F-144/c7: the panel's session cookie is host-only, so a preview host, beside the panel or under it, never gets it", () => {
    const cookies = session.getSetCookie();
    expect(cookies.some((line) => line.includes("session_token="))).toBe(true);
    for (const line of cookies) {
      expect(line.toLowerCase(), line.split("=")[0]).not.toMatch(/;\s*domain=/);
      expect(sentTo(line, "localhost", "localhost")).toBe(true);
      for (const host of [new URL(previewOrigin).hostname, "preview.localhost", "app.localhost"]) {
        expect(sentTo(line, "localhost", host), host).toBe(false);
      }
    }
  });

  it("F-144/c7: a tRPC mutation from a preview host's origin is refused with the member's cookie, and the same one from the panel's goes through", async () => {
    expect(await themeOf()).toBe("dark");
    const fromPreview = await setTheme("light", { origin: previewOrigin });
    expect(fromPreview.status).toBe(403);
    expect(await fromPreview.json()).toEqual({ error: { code: "forbidden", message: "A change to ostra must come from ostra's own pages." } });
    // A page that names no origin but whose browser says it's another site's, too.
    expect((await setTheme("light", { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await setTheme("light", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await themeOf()).toBe("dark");
    const fromPanel = await setTheme("light", { origin: panelUrl, "sec-fetch-site": "same-origin" });
    expect(fromPanel.status).toBe(200);
    expect(await themeOf()).toBe("light");
    // A query reads nothing for another origin's page: the browser keeps the answer from it.
    const read = await handleTrpcRequest(harness.deps, new Request(`${panelUrl}/api/trpc/account.get`, { headers: { origin: previewOrigin, cookie: cookieHeaderFrom(session).get("cookie") ?? "" } }));
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("F-144/c7: better-auth's routes refuse a state-changing request from a preview host's origin before it's read, and the session stands", async () => {
    const signOut = await handleAuthRequest(
      harness.deps,
      new Request(`${panelUrl}/api/auth/sign-out`, { method: "POST", headers: { origin: previewOrigin, cookie: cookieHeaderFrom(session).get("cookie") ?? "", "content-type": "application/json" }, body: "{}" }),
    );
    expect(signOut.status).toBe(403);
    expect(await harness.auth.api.getSession({ headers: cookieHeaderFrom(session) })).not.toBeNull();
    // Its reads aren't changes: the session's own route answers whoever asks, as before.
    const read = await handleAuthRequest(harness.deps, new Request(`${panelUrl}/api/auth/get-session`, { headers: { origin: previewOrigin } }));
    expect(read.status).toBe(200);
  });
});

describe("the instance's preview domain check", () => {
  it("F-144/c8: an instance admin checks the preview domain: not set when there's none (public hosts, or off), and each row's result once it's set", async () => {
    const context = await createContext(harness.deps, { headers: cookieHeaderFrom(session), resHeaders: new Headers() });
    expect(context.user?.instanceAdmin).toBe(true);
    expect(await harness.callerFor(context).instance.previewDomainCheck()).toEqual({ state: "not-set" });
    // With a domain: a probe where the record, the certificate, core's mark and the upgrade all answer.
    const asked: string[] = [];
    const probe: PreviewDomainProbe = {
      resolve: (hostname) => {
        asked.push(hostname);
        return Promise.resolve(["203.0.113.24"]);
      },
      fetch: (url) => Promise.resolve({ ok: true, status: 200, mark: previewCheckMark(PREVIEW_SECRET, url.hostname), certificate: { authorized: true, error: null, names: "DNS:*.preview.acme.dev", validTo: "Feb 19 12:00:00 2027 GMT" } }),
      upgrade: () => Promise.resolve({ ok: true, status: 101 }),
    };
    const deps = { ...harness.deps, settings: { ...harness.deps.settings, corePublicUrl: "https://core.acme.dev", previews: { ...harness.deps.settings.previews, domain: "preview.acme.dev" } }, previews: { ...harness.deps.previews, domainProbe: probe } };
    const checked = await harness.callerFor({ ...context, deps }).instance.previewDomainCheck();
    expect(checked).toMatchObject({ state: "checked", passed: true, dns: { state: "passed" }, certificate: { state: "passed" }, proxy: { state: "passed" }, upgrade: { state: "passed" } });
    expect(asked).toEqual([expect.stringMatching(/^ostra-check-[0-9a-f]{12}\.preview\.acme\.dev$/), "core.acme.dev"]);
  });
});
