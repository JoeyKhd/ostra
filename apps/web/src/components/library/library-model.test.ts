import { describe, expect, it } from "vitest";

import { agentProfileIdSchema, gitShaSchema, libraryItemIdSchema, libraryItemVersionIdSchema, librarySourceIdSchema, memberIdSchema } from "@ostra/protocol";

import { diffCounts, hunksOf } from "./item-diff";
import {
  bandsOf,
  callsOutTo,
  frontMatterOf,
  itemTabOf,
  libraryChanges,
  limitRefusal,
  missingInputs,
  pickabilityOf,
  pickReason,
  pinText,
  profileCounts,
  resultStateOf,
  serverInputsOf,
  serverReference,
  serverRefusalOf,
  skillReference,
  skillRowsOf,
  sourceEntryText,
  sourceText,
  statusOf,
  suggestionAnswer,
  suggestionKind,
  tabCounts,
  updateRefusalText,
  usedByOf,
} from "./library-model";
import type { DraftLibrary, LibraryItem, ProfileForPicker, SearchResult, SearchState, ServerLook, SkillLook, SourceEntry } from "./library-model";

// F-145, F-146 (milestone 8, ticket 31): the library's screens as data. What the table, the install
// sheet, the item page, the profile editor's picker and the marketplace say, from the API's answers.
// The browser flow against the stack's fakes is `e2e/24-library.spec.ts`.

const id = (n: number): string => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const COMMIT = "4c81e0a3f9c1e7b20d4ae41c0f258d2b97a1b2c3";
const HASH = "9f2c7c1e00000000000000000000000000000000000000000000000000a71d";

const skillItem = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  itemId: libraryItemIdSchema.parse(id(1)),
  kind: "skill",
  name: "webapp-testing",
  source: { kind: "github", owner: "anthropics", repo: "skills", path: "skills/webapp-testing", ref: null },
  sourceAllowed: true,
  everyProfile: false,
  readOnly: false,
  installedAt: Date.UTC(2026, 10, 4),
  installedBy: { memberId: memberIdSchema.parse(id(90)), name: "Alex Kim" },
  pin: { versionId: libraryItemVersionIdSchema.parse(id(2)), number: 1, ref: null, commitSha: COMMIT, computedHash: HASH, registryVersion: null, fetchedAt: 0 },
  files: [{ path: "SKILL.md", size: 3900, executable: false }],
  server: null,
  profiles: [],
  update: null,
  ...over,
});

const serverItem = (over: Partial<LibraryItem> = {}): LibraryItem =>
  skillItem({
    itemId: libraryItemIdSchema.parse(id(3)),
    kind: "mcp_server",
    name: "incidents",
    source: { kind: "registry", registryUrl: "https://registry.example.test", name: "dev.globex/incidents" },
    pin: { versionId: libraryItemVersionIdSchema.parse(id(4)), number: 1, ref: null, commitSha: null, computedHash: null, registryVersion: "1.8.2", fetchedAt: 0 },
    files: [],
    server: {
      transport: "streamable-http",
      remoteUrl: "https://mcp.globex.dev/{region}/mcp",
      description: "Incidents and on-call",
      inputs: [{ kind: "header", name: "Authorization", secret: true, required: true, set: true }],
      fixedHeaders: [],
      toolNames: ["list_incidents"],
      needsOAuth: false,
    },
    ...over,
  });

const skillLook = (over: Partial<SkillLook> = {}): SkillLook => ({
  kind: "skills",
  source: { kind: "github", owner: "globex", repo: "agent-skills" },
  commit: gitShaSchema.parse(COMMIT),
  skills: [
    {
      folder: "skills/db-seeding",
      check: { ok: true, name: "db-seeding", description: "Seed a local database from fixtures" },
      scripts: [{ path: "scripts/seed.sh", reasons: ["scripts-folder", "shebang"] }],
      files: [
        { path: "SKILL.md", size: 3900, sha256: "a".repeat(64), executable: false },
        { path: "scripts/seed.sh", size: 1400, sha256: "b".repeat(64), executable: false },
      ],
      computedHash: HASH,
    },
    {
      folder: "skills/legacy",
      check: { ok: false, problems: [{ code: "name-invalid", message: "A skill's name is at most 64 lowercase letters, digits and single dashes", path: "SKILL.md" }] },
      scripts: [],
      files: [{ path: "SKILL.md", size: 200, sha256: "c".repeat(64), executable: false }],
      computedHash: "d".repeat(64),
    },
  ],
  tooDeep: 0,
  allowed: { allowed: false },
  entryToAllow: { kind: "github_repo", value: "globex/agent-skills" },
  ...over,
});

const serverLook = (over: Partial<ServerLook> = {}): ServerLook => ({
  kind: "server",
  registryUrl: "https://registry.example.test",
  name: "dev.globex/incidents",
  version: "1.8.2",
  description: "Incidents",
  remoteUrl: "https://mcp.globex.dev/{region}/mcp",
  inputs: [
    { kind: "variable", name: "region", isSecret: false, isRequired: true, description: null },
    { kind: "header", name: "X-Team", isSecret: false, isRequired: false, description: null },
    { kind: "header", name: "Authorization", isSecret: true, isRequired: true, description: "Bearer <token>" },
  ],
  refusal: null,
  allowed: { allowed: true, entry: { kind: "registry", value: "https://registry.example.test", namespace: null } },
  entryToAllow: { kind: "registry", value: "https://registry.example.test", namespace: "dev.globex" },
  ...over,
});

const pickerProfile = (over: Partial<ProfileForPicker> = {}): ProfileForPicker => {
  const draft: DraftLibrary = { attached: [], inherited: [] };
  return {
    ownSkillNames: ["changelog"],
    ownServerNames: [],
    draft,
    counts: profileCounts({ skills: 1, servers: 0 }, draft, () => null),
    ...over,
  };
};

describe("the library's table (F-145)", () => {
  it("F-145/c1: a skill's row shows its source, its commit pin and the profiles it's on; a server's its registry name and version", () => {
    const skill = skillItem({ profiles: [{ profileId: agentProfileIdSchema.parse(id(10)), name: "Careful", attachedAt: 0 }] });
    expect(sourceText(skill)).toBe("anthropics/skills@webapp-testing");
    expect(pinText(skill.pin)).toBe("4c81e0a");
    expect(usedByOf(skill)).toEqual({ kind: "profiles", count: 1 });
    expect(usedByOf(skillItem({ everyProfile: true }))).toEqual({ kind: "every-profile" });
    expect(sourceText(serverItem())).toBe("dev.globex/incidents");
    expect(pinText(serverItem().pin)).toBe("v1.8.2");
    expect(sourceText(skillItem({ source: { kind: "well_known", url: "https://skills.example.test", skill: "release-notes" } }))).toBe("skills.example.test@release-notes");
  });

  it("F-145/c10: an update waiting shows as a neutral chip with its file count (a server's, its version), and the Updates tab counts it", () => {
    const update = { versionId: libraryItemVersionIdSchema.parse(id(5)), number: 2, fetchedAt: 0, commitSha: "9b2d4f0" + "0".repeat(33), registryVersion: null, refusal: null, files: [{ path: "SKILL.md", change: "changed" as const }, { path: "a.md", change: "added" as const }, { path: "b.md", change: "removed" as const }], test: null, missingInputs: [], diff: null };
    expect(statusOf(skillItem({ update }))).toEqual({ kind: "update", text: "Update · 3 files" });
    expect(statusOf(serverItem({ update: { ...update, commitSha: null, registryVersion: "0.22.0", files: [] } }))).toEqual({ kind: "update", text: "v0.22.0" });
    expect(statusOf(skillItem())).toEqual({ kind: "up-to-date" });
    expect(tabCounts([skillItem({ update }), serverItem()])).toEqual({ all: 2, skills: 1, mcp: 1, updates: 1 });
    expect(itemTabOf(skillItem({ update }), null)).toBe("update");
    expect(itemTabOf(skillItem(), null)).toBe("skill");
    expect(itemTabOf(serverItem(), "update")).toBe("server");
    expect(updateRefusalText(null, "x")).toBeNull();
    expect(updateRefusalText("not-allowed", "github.com/anthropics/skills")).toContain("no longer on the allowlist");
  });

  it("F-145/c6: an item whose source left the allowlist says so in its last cell, and the policy lists each entry by its source", () => {
    expect(statusOf(skillItem({ sourceAllowed: false }))).toEqual({ kind: "source-not-allowed" });
    const entry = (over: Partial<SourceEntry>): SourceEntry => ({ sourceId: librarySourceIdSchema.parse(id(20)), kind: "github_owner", value: "acme", namespace: null, addedBy: null, createdAt: 0, items: 0, ...over });
    expect(sourceEntryText(entry({}))).toBe("github.com/acme/*");
    expect(sourceEntryText(entry({ kind: "github_repo", value: "anthropics/skills" }))).toBe("github.com/anthropics/skills");
    expect(sourceEntryText(entry({ kind: "registry", value: "https://api.mcp.github.com", namespace: "io.sentry" }))).toBe("registry api.mcp.github.com io.sentry/*");
  });

  it("F-145/c1: the All tab shows each band's first rows and the rest on Show more; the other tabs show every row", () => {
    const skills = [1, 2, 3, 4, 5, 6].map((n) => skillItem({ itemId: libraryItemIdSchema.parse(id(100 + n)), name: `skill-${String(n)}` }));
    const [band] = bandsOf(skills, "all", new Set());
    expect(band).toMatchObject({ kind: "skills", shown: 4 });
    expect(bandsOf(skills, "all", new Set(["skills"]))[0]?.shown).toBe(6);
    expect(bandsOf(skills, "skills", new Set())[0]?.shown).toBe(6);
    expect(bandsOf(skills, "mcp", new Set())).toEqual([]);
  });
});

describe("install by reference (F-145)", () => {
  it("F-145/c1: the look's skills are rows with their files, sizes and hash; a skill that breaks a rule can't be picked and says why; one installed already shows its pin", () => {
    const rows = skillRowsOf(skillLook(), []);
    expect(rows.map((row) => [row.name, row.files, row.size, row.problem])).toEqual([
      ["db-seeding", 2, 5300, null],
      ["legacy", 1, 200, "Can't install: A skill's name is at most 64 lowercase letters, digits and single dashes"],
    ]);
    expect(rows[0]?.skill.scripts).toEqual([{ path: "scripts/seed.sh", reasons: ["scripts-folder", "shebang"] }]);
    const installed = skillItem({ name: "db-seeding", source: { kind: "github", owner: "Globex", repo: "agent-skills", path: "skills/db-seeding", ref: null } });
    expect(skillRowsOf(skillLook(), [installed])[0]?.inLibrary).toBe("4c81e0a");
    expect(skillReference("globex/agent-skills", "main")).toBe("globex/agent-skills#main");
    expect(skillReference("globex/agent-skills", "")).toBe("globex/agent-skills");
  });

  it("F-145/c4: a server's inputs go to the install by kind, a secret one as a secret, an empty one left out; a required one left empty holds Install", () => {
    const look = serverLook();
    expect(serverReference("dev.globex/incidents", look.registryUrl)).toBe("registry:dev.globex/incidents@https://registry.example.test");
    const values = { "variable:region": "eu", "header:Authorization": "Bearer t0ken" };
    expect(serverInputsOf(look.inputs, values)).toEqual({
      variables: { region: { kind: "plain", value: "eu" } },
      headers: { Authorization: { kind: "secret", value: "Bearer t0ken" } },
    });
    expect(missingInputs(look.inputs, { "variable:region": "eu" })).toEqual(["Authorization"]);
    expect(missingInputs(look.inputs, values)).toEqual([]);
  });

  it("F-145/c5: a packages-only entry and an SSE-only one are refused in the target's words; a server that asks for a sign-in is marked in the table", () => {
    expect(serverRefusalOf(serverLook())).toBeNull();
    expect(serverRefusalOf(serverLook({ refusal: "packages-only", remoteUrl: null }))).toMatchObject({ kind: "packages-only", title: "Not installable yet: incidents runs only as a package." });
    expect(serverRefusalOf(serverLook({ refusal: "sse-only", remoteUrl: null }))?.title).toBe("Not installable: its only remote uses SSE, which MCP deprecated.");
    const signIn = serverItem({ server: { ...(serverItem().server ?? { transport: "streamable-http", remoteUrl: "", description: null, inputs: [], fixedHeaders: [], toolNames: [], needsOAuth: true }), needsOAuth: true } });
    expect(statusOf(signIn)).toEqual({ kind: "needs-sign-in" });
  });
});

describe("a profile's library items (F-145)", () => {
  it("F-145/c7: the picker attaches an attachable item, detaches an attached one, and leaves every-profile ones alone; attaching applies on Save", () => {
    const skill = skillItem();
    expect(pickabilityOf(skill, pickerProfile())).toEqual({ kind: "attachable" });
    expect(pickabilityOf(skill, pickerProfile({ draft: { attached: [skill.itemId], inherited: [] } }))).toEqual({ kind: "attached" });
    expect(pickabilityOf(skillItem({ everyProfile: true }), pickerProfile())).toEqual({ kind: "every-profile" });
    expect(libraryChanges([id(1), id(2)], [id(2), id(3)])).toEqual({ attach: [id(3)], detach: [id(1)] });
  });

  it("F-145/c7: a profile at 20 MCP servers refuses one more, naming the profile and the counts by origin", () => {
    const attached = Array.from({ length: 15 }, (_, n) => id(200 + n));
    const inherited = [id(300), id(301)];
    const counts = profileCounts({ skills: 1, servers: 3 }, { attached, inherited }, () => "mcp_server");
    expect(counts.servers).toEqual({ own: 3, library: 15, every: 2, total: 20 });
    const profile = pickerProfile({ draft: { attached, inherited }, counts });
    expect(pickabilityOf(serverItem(), profile)).toEqual({ kind: "at-limit" });
    expect(limitRefusal("mcp_server", "incidents", "Careful", counts)).toBe(
      "incidents wasn't attached. Careful already has 20 MCP servers, the most a profile holds: 3 of its own, 15 from the library and 2 on every profile. Detach one first.",
    );
  });

  it("F-145/c8: a library item named like one of the profile's own is refused in the picker, naming the profile", () => {
    const changelog = skillItem({ name: "changelog" });
    const pick = pickabilityOf(changelog, pickerProfile());
    expect(pick).toEqual({ kind: "name-taken" });
    expect(pickReason(pick, "Careful", "changelog", "skill")).toBe("Careful has its own changelog. Rename or remove it first.");
  });

  it("F-145/c5, F-145/c6: a server that needs sign-in and an item whose source left the list can't be attached anew", () => {
    const signIn = serverItem({ server: { transport: "streamable-http", remoteUrl: "https://x", description: null, inputs: [], fixedHeaders: [], toolNames: [], needsOAuth: true } });
    expect(pickabilityOf(signIn, pickerProfile())).toEqual({ kind: "needs-sign-in" });
    expect(pickabilityOf(skillItem({ sourceAllowed: false }), pickerProfile())).toEqual({ kind: "source-not-allowed" });
  });
});

describe("an update's diff (F-145)", () => {
  it("F-145/c10: the diff's lines fall into hunks where the numbers jump, and its counts are the added and removed lines", () => {
    const lines = [
      { kind: "context" as const, oldLine: 1, newLine: 1, text: "---" },
      { kind: "del" as const, oldLine: 2, newLine: null, text: "description: old" },
      { kind: "add" as const, oldLine: null, newLine: 2, text: "description: new" },
      { kind: "context" as const, oldLine: 31, newLine: 31, text: "## Screenshots" },
      { kind: "add" as const, oldLine: null, newLine: 32, text: "Take one per viewport." },
    ];
    expect(hunksOf(lines).map((hunk) => hunk.length)).toEqual([3, 2]);
    expect(diffCounts({ files: [{ path: "SKILL.md", change: "changed", binary: false, lines, truncated: false }], truncated: false })).toEqual({ added: 2, removed: 1 });
    expect(frontMatterOf("---\nname: pdf\ndescription: Reads\n  PDF forms.\n---\n\n# PDF\n")).toEqual({ fields: [{ key: "name", value: "pdf" }, { key: "description", value: "Reads PDF forms." }], body: "# PDF\n" });
  });
});

describe("suggestions (F-145)", () => {
  it("F-145/c9: a member reads each of their suggestions' answers, and a registry reference is a server's suggestion", () => {
    const now = Date.UTC(2026, 10, 21, 12);
    const admin = { memberId: memberIdSchema.parse(id(91)), name: "Priya Shah" };
    expect(suggestionAnswer({ state: "open", createdAt: now - 3 * 86_400_000, decidedAt: null, decidedBy: null }, now)).toBe("Open · sent 3 days ago");
    expect(suggestionAnswer({ state: "installed", createdAt: 0, decidedAt: Date.UTC(2026, 10, 4), decidedBy: admin }, now)).toBe("Installed by Priya Shah · 4 Nov");
    expect(suggestionAnswer({ state: "dismissed", createdAt: 0, decidedAt: Date.UTC(2026, 10, 4), decidedBy: admin }, now)).toBe("Dismissed by Priya Shah · 4 Nov");
    expect(suggestionKind("registry:io.example/notes")).toBe("mcp_server");
    expect(suggestionKind("globex/agent-skills@db-seeding")).toBe("skill");
  });
});

describe("the marketplace (F-146)", () => {
  const skillResult = (over: Partial<Extract<SearchResult, { kind: "skill" }>> = {}): SearchResult => ({ kind: "skill", reference: "anthropics/skills@webapp-testing", source: "anthropics/skills", skill: "webapp-testing", name: "webapp-testing", installs: 41_200, sourceAllowed: true, ...over });

  it("F-146/c2: each result is in the library already, its source not allowed, a server ostra can't install yet, or installable", () => {
    expect(resultStateOf(skillResult(), [skillItem()])).toMatchObject({ kind: "in-library" });
    expect(resultStateOf(skillResult({ skill: "e2e-writer", reference: "anthropics/skills@e2e-writer" }), [skillItem()])).toEqual({ kind: "installable" });
    expect(resultStateOf(skillResult({ skill: "visual-diff", sourceAllowed: false }), [])).toEqual({ kind: "not-allowed" });
    const server: SearchResult = { kind: "server", reference: "registry:io.example/local-notes@https://registry.example.test", registryUrl: "https://registry.example.test", name: "io.example/local-notes", title: null, version: "0.3.0", description: null, refusal: "packages-only", sourceAllowed: true };
    expect(resultStateOf(server, [])).toEqual({ kind: "refused", refusal: "packages-only" });
  });

  it("F-146/c3: the policy names every host a search or an install calls out to, from the switch's state and the sources", () => {
    const state: SearchState = { enabled: true, organizationOn: true, instanceAllows: true, off: null, sendsTo: { skills: "skills.sh", registries: ["https://api.mcp.github.com"] }, offWords: null, sendsWords: "" };
    const github: SourceEntry = { sourceId: librarySourceIdSchema.parse(id(20)), kind: "github_owner", value: "acme", namespace: null, addedBy: null, createdAt: 0, items: 0 };
    expect(callsOutTo(state, [github])).toEqual(["skills.sh", "api.mcp.github.com", "github.com"]);
  });
});
