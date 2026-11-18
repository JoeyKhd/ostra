import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppUserId } from "../ids.ts";
import { createUnavailableDriver } from "../turn-driver.ts";
import { buildManifest, checkPublicUrl, OSTRA_SCOPES, parseManifestLink, WEBHOOK_PATH } from "../manifest.ts";
import type { PublicUrlProblem } from "../manifest.ts";
import { compareWithPublishedSchema, countFacts, ourJsonSchema } from "../manifest-schema-check.ts";
import { createFakeLinear } from "../fake-linear/fake-linear.ts";
import { createClock } from "../clock.ts";
import { silentLogger } from "../log.ts";
import { createOstraServer, INSTALL_PATH, MANIFEST_PATH } from "../server.ts";
import type { OstraServer, PendingInstallLimits } from "../server.ts";
import { isRecord, stableStringify, until } from "../util.ts";
import { CALLBACK_PATH } from "../manifest.ts";
import { DEFAULT_TOKEN_PATH, loadToken, reuseSavedToken, saveToken } from "../token-store.ts";
import type { StoredToken } from "../token-store.ts";
import { createRig, DEFAULT_PUBLIC_URL, guarded, logText, readJson } from "./common.ts";
import type { Recorder, Rig, ScenarioReport } from "./common.ts";

type UrlCase = { readonly url: string; readonly expect: PublicUrlProblem | "ok" };

const URL_CASES: readonly UrlCase[] = [
  { url: "https://ostra-dev.example.com", expect: "ok" },
  { url: "https://my-box.tail1234.ts.net", expect: "ok" },
  { url: "https://203.0.113.9", expect: "ok" },
  { url: "http://ostra-dev.example.com", expect: "not-https" },
  { url: "https://localhost:3000", expect: "loopback" },
  { url: "https://127.0.0.1", expect: "loopback" },
  { url: "https://[::1]", expect: "loopback" },
  { url: "https://192.168.1.20", expect: "private-network" },
  { url: "https://10.0.0.5", expect: "private-network" },
  { url: "https://172.20.1.1", expect: "private-network" },
  { url: "https://100.64.0.7", expect: "private-network" },
  { url: "https://[fd00::1]", expect: "private-network" },
  { url: "https://ostra.local", expect: "private-network" },
  { url: "https://ostra", expect: "single-label-host" },
  { url: "https://hooks.linear.app", expect: "linear-host" },
  { url: "not a url", expect: "invalid-url" },
  { url: "ftp://ostra-dev.example.com", expect: "invalid-url" },
];

/** The five fields an installation summary may hold, and nothing else. */
const SUMMARY_KEYS = ["appUserId", "appUserName", "hasRefreshToken", "organizationId", "scopes"] as const;

/** A server with no fake Linear behind it: enough for routes that never call Linear. Its Linear endpoints are a dead port. */
const bareServer = async (options: { readonly publicUrl: string; readonly pendingInstalls?: PendingInstallLimits }): Promise<{ readonly server: OstraServer; readonly origin: string }> => {
  const dead = "http://127.0.0.1:1";
  const server = createOstraServer({
    publicUrl: options.publicUrl,
    linear: {
      clientId: "client-id-for-a-bare-server",
      clientSecret: "client-secret-for-a-bare-server",
      webhookSecret: "webhook-secret-for-a-bare-server",
      endpoints: { apiUrl: `${dead}/graphql`, authorizeUrl: `${dead}/oauth/authorize`, tokenUrl: `${dead}/oauth/token` },
    },
    agent: { firstActivityBudgetMs: 7_000, finalActivityBudgetMs: 30_000, hedgeAfterMs: 3_000, heartbeat: { kind: "off" } },
    driver: createUnavailableDriver("not used here"),
    log: silentLogger,
    ...(options.pendingInstalls === undefined ? {} : { pendingInstalls: options.pendingInstalls }),
  });
  const { port } = await server.listen();
  return { server, origin: `http://127.0.0.1:${String(port)}` };
};

/** A second server against the same fake Linear and the same app: what a later run is, with nothing in memory from the install. */
const laterServer = async (rig: Rig): Promise<OstraServer> => {
  const server = createOstraServer({
    publicUrl: DEFAULT_PUBLIC_URL,
    linear: { ...rig.credentials, endpoints: { apiUrl: rig.fake.apiUrl, authorizeUrl: rig.fake.authorizeUrl, tokenUrl: rig.fake.tokenUrl } },
    agent: { firstActivityBudgetMs: 7_000, finalActivityBudgetMs: 30_000, hedgeAfterMs: 3_000, heartbeat: { kind: "off" } },
    driver: createUnavailableDriver("not used here"),
    log: silentLogger,
  });
  await server.listen();
  return server;
};

/**
 * The token an install leaves in a file, and what a later run does with it: take it only when Linear confirms it is the app
 * user, with the right scopes, and run the install again otherwise. The file is in a temporary directory, never the real one.
 */
const checkSavedToken = async (r: Recorder): Promise<void> => {
  const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
  r.check(
    "the default token file is outside the repo, which is public",
    relative(repoRoot, DEFAULT_TOKEN_PATH).startsWith("..") && DEFAULT_TOKEN_PATH.endsWith(join(".config", "ostra-dev", "linear-app-token.json")),
  );
  const dir = await mkdtemp(join(tmpdir(), "ostra-spike-token-"));
  const file = join(dir, "linear-app-token.json");
  const rig = await createRig({ driver: createUnavailableDriver("not used here"), onInstalled: (token) => saveToken(file, token) });
  const servers: OstraServer[] = [];
  const later = async (): Promise<OstraServer> => {
    const server = await laterServer(rig);
    servers.push(server);
    return server;
  };
  /** Writes `token` as the saved file and tries to reuse it on a server that has no install. Returns the outcome and that server. */
  const tryWith = async (token: StoredToken): Promise<{ readonly outcome: Awaited<ReturnType<typeof reuseSavedToken>>; readonly server: OstraServer }> => {
    await saveToken(file, token);
    const server = await later();
    return { outcome: await reuseSavedToken(server, file), server };
  };
  const why = (outcome: Awaited<ReturnType<typeof reuseSavedToken>>): string => (outcome.kind === "reused" ? "" : outcome.why);
  const nothing = (server: OstraServer): boolean => server.installations().length === 0;
  try {
    await rig.install();
    const loaded = await loadToken(file);
    const appUser = rig.fake.appUser();
    r.check(
      "an install leaves the app's token in the file, with the app user, the workspace and the scopes it was issued with",
      loaded.ok && loaded.token.appUserId === appUser?.id && loaded.token.organizationId === rig.fake.organizationId && OSTRA_SCOPES.every((scope) => loaded.token.scopes.includes(scope)),
    );
    r.check("and nothing else is left beside it (the write is by rename, so no half-written file)", stableStringify(await readdir(dir)) === stableStringify(["linear-app-token.json"]));
    if (!loaded.ok) return;
    const saved = loaded.token;
    r.check("the token is in the file only: not in a log line, not in the installation summary", !logText(rig.logs).includes(saved.accessToken) && !JSON.stringify(rig.server.installations()).includes(saved.accessToken));

    // A later run, nothing in memory.
    const reuse = await tryWith(saved);
    const reused = reuse.server.installations();
    r.check(
      "a later server takes the saved token as the install, after Linear confirms the user",
      reuse.outcome.kind === "reused" && reused.length === 1 && reused[0]?.appUserId === appUser?.id && reused[0]?.scopes.length === saved.scopes.length,
      why(reuse.outcome),
    );
    const viewer = await reuse.server.api(saved.organizationId)?.viewer();
    r.check("and the API it builds from that token works, as the app user", viewer?.isApp === true && viewer.appUserId === appUser?.id);

    // Refused, each for its own reason, and nothing is installed.
    await rm(file);
    const none = await later();
    const gone = await reuseSavedToken(none, file);
    r.check("no file: not reused, and it says there is no saved token", gone.kind === "not-reused" && gone.why.includes("no token is saved") && nothing(none), why(gone));
    for (const [name, text] of [
      ["not JSON", "{ this is not json"],
      ["one with a field it does not know (the format is ostra's own, so it is closed)", JSON.stringify({ ...saved, extra: true })],
      ["one with an empty token", JSON.stringify({ ...saved, accessToken: "" })],
      ["of another version", JSON.stringify({ ...saved, version: 2 })],
    ] as const) {
      await writeFile(file, text);
      const server = await later();
      const outcome = await reuseSavedToken(server, file);
      r.check(`a file that is ${name}: not reused`, outcome.kind === "not-reused" && outcome.why.includes("not in the expected format") && nothing(server), why(outcome));
    }
    const refused = await tryWith({ ...saved, accessToken: `lin_oauth_${"0".repeat(48)}` });
    r.check("a token Linear does not know (an expired or revoked one): refused, and the install flow is what is left", refused.outcome.kind === "not-reused" && refused.outcome.why.includes("refused") && nothing(refused.server), why(refused.outcome));
    const person = await tryWith({ ...saved, accessToken: rig.fake.mintToken("person") });
    r.check("a token that is a person's, not the app's: refused", person.outcome.kind === "not-reused" && person.outcome.why.includes("person") && nothing(person.server), why(person.outcome));
    const viewerCallsBefore = rig.fake.apiCalls()["viewer"] ?? 0;
    const narrow = await tryWith({ ...saved, scopes: ["read", "write"] });
    r.check(
      "a token issued without the agent scopes: refused, before any request is made with it",
      narrow.outcome.kind === "not-reused" && narrow.outcome.why.includes("scopes") && nothing(narrow.server) && (rig.fake.apiCalls()["viewer"] ?? 0) === viewerCallsBefore,
      why(narrow.outcome),
    );
    const other = await tryWith({ ...saved, appUserId: AppUserId.parse("some-other-app-user") });
    r.check("an app user that is not the one the token was saved for: refused", other.outcome.kind === "not-reused" && other.outcome.why.includes("another user") && nothing(other.server), why(other.outcome));
    const dead = await bareServer({ publicUrl: DEFAULT_PUBLIC_URL });
    servers.push(dead.server);
    await saveToken(file, saved);
    const unreachable = await reuseSavedToken(dead.server, file);
    r.check("Linear unreachable: not reused, and said apart from a refusal", unreachable.kind === "not-reused" && unreachable.why.includes("could not be reached") && nothing(dead.server), why(unreachable));
    r.check("the token reached no log line of the server that installed, after all of that", !logText(rig.logs).includes(saved.accessToken));
  } finally {
    for (const server of servers) await server.close();
    await rig.close();
    await rm(dir, { recursive: true, force: true });
  }
};

const checkAgainstPublishedSchema = async (r: Recorder): Promise<void> => {
  const raw = await readFile(new URL("../../snapshots/linear-oauth-app-manifest.schema.json", import.meta.url), "utf8");
  const published: unknown = JSON.parse(raw);
  const ours = ourJsonSchema();
  const differences = compareWithPublishedSchema(published, ours);
  const facts = countFacts(published);
  r.check(
    "the Zod copy agrees with the snapshot of Linear's published schema on required fields, enums, constants, closed objects and limits",
    differences.length === 0 && facts >= 20,
    differences.length === 0 ? `${String(facts)} facts compared` : differences.slice(0, 3).join(" | "),
  );
  // The control: a snapshot that disagrees must be noticed, or the check above could not fail.
  const doctored: unknown = JSON.parse(raw.replace('"AgentSessionEvent",', ""));
  r.check(
    "(control) the comparison notices when an enum value is missing from the snapshot",
    compareWithPublishedSchema(doctored, ours).length > 0,
  );
  const conditional = isRecord(published) && Array.isArray(published["allOf"]) && JSON.stringify(published["allOf"]).includes("client_uri");
  const publicWithoutUri = parseManifestLink(
    `https://linear.app/settings/api/applications/new?manifest=${encodeURIComponent(
      JSON.stringify({ schemaVersion: "1.0.0", distribution: "public", developer: { name: "ostra" }, oauth: { client_name: "ostra", redirect_uris: ["https://ostra-dev.example.com/cb"] } }),
    )}`,
  );
  r.check(
    "the snapshot's conditional (a public app needs client_uri) is there, and the copy enforces it too",
    conditional && !publicWithoutUri.ok,
    publicWithoutUri.ok ? "the copy accepted a public app with no client_uri" : "",
  );
};

export const runInstallScenario = (): Promise<ScenarioReport> =>
  guarded("install", async (r) => {
    // 1. The manifest link
    const manifest = buildManifest({ publicUrl: DEFAULT_PUBLIC_URL, developerName: "ostra" });
    r.check("a manifest is built for a public https address", manifest.ok);
    if (!manifest.ok) return;
    const fromJson = parseManifestLink(manifest.links.json);
    const fromParams = parseManifestLink(manifest.links.params);
    r.check("the JSON-form link validates against the spike's Zod copy of Linear's manifest schema (unverified against Linear)", fromJson.ok, fromJson.ok ? "" : fromJson.problems.join("; "));
    r.check("the dot-notation link validates against the same copy", fromParams.ok, fromParams.ok ? "" : fromParams.problems.join("; "));
    if (fromJson.ok && fromParams.ok) {
      const jsonManifest = Object.fromEntries(Object.entries(fromJson.manifest).filter(([key]) => key !== "$schema"));
      r.check(
        "both forms describe the same app",
        stableStringify(jsonManifest) === stableStringify(fromParams.manifest),
      );
    }
    await checkAgainstPublishedSchema(r);
    const m = manifest.manifest;
    r.check(
      "the webhook and callback URLs are this deployment's, over https",
      m.webhook?.url === `${DEFAULT_PUBLIC_URL}${WEBHOOK_PATH}` && m.oauth.redirect_uris[0] === `${DEFAULT_PUBLIC_URL}${CALLBACK_PATH}`,
    );
    r.check(
      "agent mode's stream is subscribed",
      m.webhook?.resourceTypes.includes("AgentSessionEvent") === true && m.webhook.resourceTypes.includes("OAuthAuthorization"),
    );
    r.check("the app is private and uses the authorization-code grant only", m.distribution === "private" && m.oauth.grant_types?.join() === "authorization_code");
    r.check("the app name does not contain Linear", !/linear/i.test(m.oauth.client_name), m.oauth.client_name);
    const awkward = buildManifest({ publicUrl: "https://linear.acme.com", developerName: "ostra" });
    r.check(
      "a host that contains 'linear' falls back to a valid app name",
      awkward.ok && awkward.manifest.oauth.client_name === "ostra",
      awkward.ok ? awkward.manifest.oauth.client_name : awkward.problems.join("; "),
    );

    // 2. An address Linear cannot reach is reported before the admin pastes anything
    const wrong = URL_CASES.filter((c) => {
      const check = checkPublicUrl(c.url);
      return c.expect === "ok" ? !check.ok : check.ok || check.problem !== c.expect;
    });
    r.check(
      `public-address pre-check classifies ${String(URL_CASES.length)} sample addresses`,
      wrong.length === 0,
      wrong.map((c) => c.url).join(", "),
    );
    const refused = buildManifest({ publicUrl: "https://localhost:3000", developerName: "ostra" });
    r.check("no manifest is built for a loopback address", !refused.ok && refused.problems.some((p) => p.includes("loopback")));

    // 3. The fake Linear (playing the admin's click on Create) takes the manifest through the same Zod copy, so these
    //    two checks show the flow works. They cannot disagree with the code that built the manifest.
    const probe = await createFakeLinear({ clock: createClock(1) });
    try {
      const plain = new URL(manifest.links.json);
      const raw = plain.searchParams.get("manifest") ?? "";
      const http = raw.replace(`${DEFAULT_PUBLIC_URL}${WEBHOOK_PATH}`, `http://ostra-dev.example.com${WEBHOOK_PATH}`);
      plain.searchParams.set("manifest", http);
      const bad = probe.createAppFromLink(plain.toString(), "http://127.0.0.1:1/unused");
      r.check("the fake (same Zod copy, so circular) refuses a manifest with an http webhook", !bad.ok, bad.ok ? "" : bad.problems.join("; "));
      const good = probe.createAppFromLink(manifest.links.json, "http://127.0.0.1:1/unused");
      r.check("the fake (same Zod copy, so circular) accepts the generated manifest and yields client ID, secret and webhook secret", good.ok);
    } finally {
      await probe.close();
    }

    // 4. The install, as an admin would do it
    const rig = await createRig({ driver: createUnavailableDriver("not used here") });
    try {
      const outcome = await rig.install();
      r.check("Authorize ends in an installation", outcome.kind === "installed", outcome.kind === "installed" ? "" : JSON.stringify(outcome));
      const appUser = rig.fake.appUser();
      if (outcome.kind === "installed" && appUser !== undefined) {
        r.check("the token's user is the app's own workspace user (viewer.app is true)", outcome.appUserId === appUser.id);
        r.check("that user is not the admin who clicked Authorize", outcome.appUserId !== rig.fake.admin.id);
        r.check("the install is in the admin's workspace", outcome.organizationId === rig.fake.organizationId);
        r.check(
          `the agent scopes were granted (${OSTRA_SCOPES.join(", ")})`,
          OSTRA_SCOPES.every((scope) => outcome.scopes.includes(scope)),
          outcome.scopes.join(","),
        );
      }
      const authorization = rig.fake.authorizations().at(-1);
      r.check("the authorize request asked for actor=app, with PKCE", authorization?.actor === "app" && authorization.pkce);
      r.check(
        "it asked for exactly the agent scopes",
        authorization !== undefined && OSTRA_SCOPES.every((s) => authorization.scopes.includes(s)) && authorization.scopes.length === OSTRA_SCOPES.length,
        authorization?.scopes.join(",") ?? "",
      );
      const installs = rig.server.installations();
      r.check("one installation is stored, with a refresh token", installs.length === 1 && installs[0]?.hasRefreshToken === true);
      r.check(
        "the installation summary is an allow-list of five fields: no token of any kind can be in it",
        installs.every((i) => stableStringify(Object.keys(i).sort()) === stableStringify(SUMMARY_KEYS)) && !JSON.stringify(installs).includes("lin_"),
        installs[0] === undefined ? "" : Object.keys(installs[0]).sort().join(","),
      );

      // 5. Hostile callbacks
      const tokenCallsBefore = rig.fake.apiCalls()["oauth/token"] ?? 0;
      const forged = await fetch(`${rig.localOrigin}${CALLBACK_PATH}?code=forged&state=forged`);
      await forged.arrayBuffer();
      r.check("a callback with an unknown state is refused without calling the token endpoint", forged.status === 400 && (rig.fake.apiCalls()["oauth/token"] ?? 0) === tokenCallsBefore, `status ${String(forged.status)}`);

      // 6. A token that is a person's, not an app's, must not be taken as an install
      rig.fake.setHonorActorApp(false);
      const before = rig.server.installations();
      const person = await rig.install();
      r.check(
        "a token that is not an app user is refused",
        person.kind === "refused" && person.error === "token-is-not-an-app-user",
        JSON.stringify(person),
      );
      r.check("and it replaces nothing", JSON.stringify(rig.server.installations()) === JSON.stringify(before));
      rig.fake.setHonorActorApp(true);

      // 7. The route that hands an admin the manifest link, on an https address
      const handOut = await fetch(`${rig.localOrigin}${MANIFEST_PATH}`, { redirect: "manual" });
      await handOut.arrayBuffer();
      const handOutLink = handOut.headers.get("location");
      const handedOut = handOutLink === null ? undefined : parseManifestLink(handOutLink);
      r.check(
        "GET the manifest route on an https public URL answers 302 to a link whose manifest parses and is this deployment's",
        handOut.status === 302 && handedOut?.ok === true && stableStringify(handedOut.manifest) === stableStringify(m),
        `status ${String(handOut.status)}`,
      );

      const text = logText(rig.logs);
      r.check(
        "no token or secret reached a log line",
        !text.includes("lin_oauth_") && !text.includes("lin_refresh_") && !text.includes(rig.credentials.clientSecret) && !text.includes(rig.credentials.webhookSecret),
      );
    } finally {
      await rig.close();
    }

    // 8. The same route on an address Linear cannot reach: no link is handed out
    const loopback = await bareServer({ publicUrl: "https://localhost:3000" });
    try {
      const answer = await fetch(`${loopback.origin}${MANIFEST_PATH}`, { redirect: "manual" });
      const body = await readJson(answer);
      r.check(
        "GET the manifest route on a loopback public URL answers 409 and no redirect",
        answer.status === 409 && answer.headers.get("location") === null && isRecord(body) && body["error"] === "agent-mode-unavailable",
        `status ${String(answer.status)}`,
      );
    } finally {
      await loopback.server.close();
    }

    // 9. The install routes are open on the public address: what they hold is bounded
    const limits: PendingInstallLimits = { max: 5, ttlMs: 150, sweepMs: 40 };
    const open = await bareServer({ publicUrl: DEFAULT_PUBLIC_URL, pendingInstalls: limits });
    try {
      const states: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        const start = await fetch(`${open.origin}${INSTALL_PATH}`, { redirect: "manual" });
        const location = start.headers.get("location");
        const state = location === null ? null : new URL(location).searchParams.get("state");
        if (state !== null) states.push(state);
      }
      r.check(`12 install starts in a burst leave at most ${String(limits.max)} held`, states.length === 12 && open.server.pendingInstallCount() <= limits.max, `${String(open.server.pendingInstallCount())} held`);
      const evicted = states[0];
      const staleCallback = evicted === undefined ? undefined : await fetch(`${open.origin}${CALLBACK_PATH}?code=whatever&state=${encodeURIComponent(evicted)}`);
      await staleCallback?.arrayBuffer();
      r.check("the oldest start was evicted, so its callback is refused", staleCallback?.status === 400, `status ${String(staleCallback?.status)}`);
      const swept = await until(() => open.server.pendingInstallCount() === 0, { timeoutMs: 3_000, pollMs: 25 });
      r.check("with no further request, a timer forgets the rest after the TTL", swept, `${String(open.server.pendingInstallCount())} still held`);
    } finally {
      await open.server.close();
    }

    // 10. The token an install leaves behind, and its reuse
    await checkSavedToken(r);

    r.note("A person has not clicked Create or Authorize here: the fake plays both. Linear's real manifest handling is untested. The Zod copy was compared with a snapshot of Linear's published schema (snapshots/), which shows the copy matches the document, not that Linear's server enforces it.");
  });
