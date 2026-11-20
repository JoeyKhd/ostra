import { describe, expect, it } from "vitest";

import { modelNameSchema, presetRules } from "@ostra/domain";
import { agentProfileIdSchema, memberIdSchema, providerIdSchema } from "@ostra/protocol";

import { draftProblem, isDirty, newDraft, pickedFileProblem, saveInputOf, serverProblem, skillDescription, skillProblem, withFile } from "./editor-draft";
import type { ProfileDraft, ServerDraft, SkillDraft, SkillFileDraft } from "./editor-draft";
import { defaultChoices } from "./project-defaults";
import { startFacts } from "./profile-picker";
import type { StartProfile } from "./profile-picker";
import { groupRules } from "./rule-drafts";

// F-021, F-026, F-063 (ticket 42): what the profile editor saves, what stops a save, what the start
// picker says of a profile, and which profiles a project may default to.

const MODEL = modelNameSchema.parse({ kind: "catalog", catalogId: "anthropic/claude-sonnet-5-5" });
const member = memberIdSchema.parse("01900000-0000-7000-8000-0000000000aa");
let next = 0;
const newId = (): string => `01900000-0000-7000-8000-${String(next++).padStart(12, "0")}`;

const PROVIDER = providerIdSchema.parse("01900000-0000-7000-8000-0000000000cc");
const filled = (over: Partial<ProfileDraft> = {}): ProfileDraft => ({ ...newDraft("opencode", MODEL, PROVIDER), name: "Careful", ...over });

describe("the profile editor's draft", () => {
  it("F-021/c1, F-063: saves the name, model, plan first, the listed members and the preset's rules as the router takes them", () => {
    const rules = groupRules(presetRules("dependency", newId));
    const input = saveInputOf(filled({ planFirst: true, access: "listed", members: [member], rules, instructions: "  " }), null, newId);
    expect(input).toMatchObject({ name: "Careful", adapter: "opencode", modelId: null, modelName: MODEL, planFirst: true, instructions: null, access: { kind: "listed", members: [member] } });
    expect(input).not.toHaveProperty("profileId");
    expect(input.approvalRules).toHaveLength(presetRules("dependency", newId).length);
    expect(new Set(input.approvalRules.map((rule) => rule.preset))).toEqual(new Set(["dependency"]));
    const profileId = agentProfileIdSchema.parse("01900000-0000-7000-8000-0000000000bb");
    expect(saveInputOf(filled(), profileId, newId)).toMatchObject({ profileId, access: { kind: "everyone" } });
  });

  it("F-021/c1: a stored header keeps its secret unless a new value is typed; nothing else is sent for it", () => {
    const server: ServerDraft = {
      key: "s",
      transport: "http",
      name: "release-names",
      url: " https://names.acme.internal/mcp ",
      readOnly: true,
      headers: [
        { key: "h1", name: "Authorization", value: "", stored: true },
        { key: "h2", name: "X-Team", value: "typed now", stored: true },
        { key: "h3", name: " ", value: "dropped", stored: false },
      ],
    };
    const [saved] = saveInputOf(filled({ servers: [server] }), null, newId).mcpServers;
    expect(saved).toEqual({ name: "release-names", transport: "http", url: "https://names.acme.internal/mcp", readOnly: true, headers: [{ name: "Authorization", value: null }, { name: "X-Team", value: "typed now" }] });
  });

  it("F-063/c3: a new profile starts with plan first off, open to everyone, with the built-in profile's model", () => {
    expect(newDraft("opencode", MODEL)).toMatchObject({ planFirst: false, access: "everyone", members: [], model: MODEL, rules: [], skills: [], servers: [] });
    expect(saveInputOf(filled(), null, newId).planFirst).toBe(false);
  });

  it("F-021: Save profile waits for a name, a model, a listed member and valid rules", () => {
    expect(draftProblem(filled({ name: " " }))).toBe("agentProfiles.editor.name");
    expect(draftProblem(filled({ providerId: null }))).toBe("agentProfiles.editor.pickProviderPlaceholder");
    expect(draftProblem(filled({ model: null }))).toBe("agentProfiles.editor.pickModelPlaceholder");
    expect(draftProblem(filled({ access: "listed" }))).toBe("agentProfiles.props.nobodyListed");
    expect(draftProblem(filled({ access: "listed", members: [member] }))).toBeNull();
    expect(draftProblem(filled({ rules: [{ key: "r", ruleIds: [], name: "", tool: "edit", matchKind: "path-glob", text: "a/**", preset: null }] }))).toBe("agentProfiles.rules.errorName");
  });

  it("F-021: is dirty only when something it would save changed, not when React's keys or spacing did", () => {
    const saved = filled({ skills: [{ key: "a", name: "changelog", body: "x", files: [] }] });
    expect(isDirty({ ...saved, skills: [{ key: "b", name: "changelog", body: "x", files: [] }], name: "Careful " }, saved)).toBe(false);
    expect(isDirty({ ...saved, planFirst: true }, saved)).toBe(true);
    expect(isDirty({ ...saved, skills: [] }, saved)).toBe(true);
  });

  it("F-021: a skill's name is a slug, unique, with a SKILL.md, and its description comes from the front matter", () => {
    const skill: SkillDraft = { key: "a", name: "changelog", body: "---\nname: changelog\ndescription: How a changelog line reads\n---\n\nBody", files: [] };
    expect(skillProblem(skill, [skill])).toBeNull();
    expect(skillProblem({ ...skill, name: "Change Log" }, [])?.key).toBe("agentProfiles.skill.errorName");
    expect(skillProblem(skill, [{ ...skill, key: "b" }])?.key).toBe("agentProfiles.skill.errorTaken");
    expect(skillProblem({ ...skill, files: [{ path: "big.bin", size: 2 * 1024 * 1024, blobId: "b" }] }, [])).toEqual({ field: "files", key: "agentProfiles.skill.errorSize", path: "big.bin" });
    expect(skillDescription(skill.body)).toBe("How a changelog line reads");
    expect(skillDescription("# Releases\n\nHow we cut one")).toBe("Releases");
  });

  it("F-021: an MCP server needs a slug name, an http(s) URL or a command", () => {
    const http: ServerDraft = { key: "s", transport: "http", name: "docs", url: "ftp://x", headers: [], readOnly: false };
    expect(serverProblem(http, [])?.key).toBe("agentProfiles.server.errorUrl");
    expect(serverProblem({ ...http, url: "https://docs.internal/mcp" }, [])).toBeNull();
    expect(serverProblem({ key: "t", transport: "stdio", name: "rg", command: " ", args: "", env: [], readOnly: true }, [])?.key).toBe("agentProfiles.server.errorCommand");
  });
});

describe("the start picker and the project's defaults", () => {
  const offered = (over: Partial<StartProfile>): StartProfile => ({
    profileId: agentProfileIdSchema.parse("01900000-0000-7000-8000-0000000000cc"),
    name: "Careful",
    builtIn: false,
    planFirst: false,
    ruleCount: 0,
    isDefault: false,
    agentName: "OpenCode",
    modelName: "Claude Opus 5.5",
    ...over,
  });

  it("F-021, F-063: a profile's facts under its name: the model, plan first and its rules", () => {
    expect(startFacts(offered({ planFirst: true, ruleCount: 3 }))).toBe("Claude Opus 5.5 · plan first · 3 rules");
    expect(startFacts(offered({ ruleCount: 1 }))).toBe("Claude Opus 5.5 · 1 rule");
    expect(startFacts(offered({ modelName: null }))).toBe("no model yet · no rules");
  });

  it("F-021/c3: a project may default only to an active profile open to everyone, or the one it has", () => {
    const row = (id: string, access: "everyone" | "listed", archivedAt: number | null = null) => ({
      id: agentProfileIdSchema.parse(`01900000-0000-7000-8000-${id.padStart(12, "0")}`),
      access: access === "everyone" ? ({ kind: "everyone" } as const) : ({ kind: "listed", members: [] } as const),
      archivedAt,
    });
    const profiles = [row("1", "everyone"), row("2", "listed"), row("3", "everyone", 1), row("4", "listed")];
    const ids = (current: string | null) => defaultChoices(profiles, current).map((profile) => profile.id.slice(-1));
    expect(ids(null)).toEqual(["1"]);
    expect(ids(profiles[3]?.id ?? null)).toEqual(["1", "4"]);
  });
});

describe("a file picked for a skill", () => {
  const stored = (path: string): SkillFileDraft => ({ path, size: 3, blobId: "b" });

  it("F-021/c1: SKILL.md, an empty file, a file over 1 MiB and a 21st file are each refused with their own message", () => {
    expect(pickedFileProblem([], { name: "SKILL.md", size: 5 })?.key).toBe("agentProfiles.skill.errorReserved");
    expect(pickedFileProblem([], { name: "a.txt", size: 0 })?.key).toBe("agentProfiles.skill.errorEmpty");
    expect(pickedFileProblem([], { name: "a.txt", size: 1024 * 1024 })).toBeNull();
    expect(pickedFileProblem([], { name: "a.txt", size: 1024 * 1024 + 1 })).toEqual({ field: "files", key: "agentProfiles.skill.errorSize", path: "a.txt" });
    const twenty = Array.from({ length: 20 }, (_, index) => stored(`f${String(index)}`));
    expect(pickedFileProblem(twenty, { name: "extra", size: 1 })?.key).toBe("agentProfiles.skill.errorCount");
    // A file with the path of one already there replaces it, so it is no 21st.
    expect(pickedFileProblem(twenty, { name: "f3", size: 1 })).toBeNull();
  });

  it("F-021: a new file is added, and one with a path already in the skill takes its place", () => {
    const first = stored("a.txt");
    const second = { path: "b.txt", size: 9, blobId: "c" };
    expect(withFile([first], second)).toEqual([first, second]);
    expect(withFile([first, second], { path: "a.txt", size: 7, blobId: "d" })).toEqual([{ path: "a.txt", size: 7, blobId: "d" }, second]);
  });

  it("F-021: the profile's save names each file's blob, whether it was stored before or picked now", () => {
    const blob = "01900000-0000-7000-8000-0000000000ee";
    const skill: SkillDraft = { key: "a", name: "changelog", body: "# x", files: [{ path: "examples/one.md", size: 3, blobId: blob }] };
    expect(saveInputOf(filled({ skills: [skill] }), null, newId).skills).toEqual([{ name: "changelog", body: "# x", files: [{ path: "examples/one.md", blobId: blob }] }]);
  });
});

describe("the profile's effort in the save", () => {
  it("F-137/c1: a chosen level is saved; an unchanged stored level is left out, so the model lacking it keeps it", () => {
    expect(saveInputOf(filled({ effort: "high" }), null, newId).effort).toBe("high");
    expect(saveInputOf(filled(), null, newId)).not.toHaveProperty("effort");
    expect(saveInputOf(filled({ effort: "xhigh" }), null, newId, "xhigh")).not.toHaveProperty("effort");
    expect(saveInputOf(filled({ effort: "max" }), null, newId, "xhigh").effort).toBe("max");
  });

describe("the closing turn (F-111)", () => {
  it("F-111/c6: Ask what the next task should know saves with the profile, off for a new one", () => {
    expect(newDraft("opencode", MODEL).closingTurn).toBe(false);
    expect(saveInputOf({ ...newDraft("opencode", MODEL), name: "Careful", closingTurn: true }, null, () => "id").closingTurn).toBe(true);
    const saved = newDraft("opencode", MODEL);
    expect(isDirty({ ...saved, closingTurn: true }, saved)).toBe(true);
  });
});

});
