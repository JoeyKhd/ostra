import { describe, expect, it } from "vitest";

import { presetRules } from "@ostra/domain";
import { agentProfileIdSchema, memberIdSchema } from "@ostra/protocol";

import { draftProblem, isDirty, newDraft, saveInputOf, serverProblem, skillDescription, skillProblem } from "./editor-draft";
import type { ProfileDraft, ServerDraft, SkillDraft } from "./editor-draft";
import { defaultChoices } from "./project-defaults";
import { startFacts } from "./profile-picker";
import type { StartProfile } from "./profile-picker";
import { groupRules } from "./rule-drafts";

// F-021, F-026, F-063 (ticket 42): what the profile editor saves, what stops a save, what the start
// picker says of a profile, and which profiles a project may default to.

const MODEL = "01900000-0000-7000-8000-00000000a0de";
const member = memberIdSchema.parse("01900000-0000-7000-8000-0000000000aa");
let next = 0;
const newId = (): string => `01900000-0000-7000-8000-${String(next++).padStart(12, "0")}`;

const filled = (over: Partial<ProfileDraft> = {}): ProfileDraft => ({ ...newDraft("opencode", MODEL), name: "Careful", ...over });

describe("the profile editor's draft", () => {
  it("F-021, F-063: saves the name, model, plan first, the listed members and the preset's rules as the router takes them", () => {
    const rules = groupRules(presetRules("dependency", newId));
    const input = saveInputOf(filled({ planFirst: true, access: "listed", members: [member], rules, instructions: "  " }), null, newId, new Map());
    expect(input).toMatchObject({ name: "Careful", adapter: "opencode", modelId: MODEL, planFirst: true, instructions: null, access: { kind: "listed", members: [member] } });
    expect(input).not.toHaveProperty("profileId");
    expect(input.approvalRules).toHaveLength(presetRules("dependency", newId).length);
    expect(new Set(input.approvalRules.map((rule) => rule.preset))).toEqual(new Set(["dependency"]));
    const profileId = agentProfileIdSchema.parse("01900000-0000-7000-8000-0000000000bb");
    expect(saveInputOf(filled(), profileId, newId, new Map())).toMatchObject({ profileId, access: { kind: "everyone" } });
  });

  it("F-021: a stored header keeps its secret unless a new value is typed; nothing else is sent for it", () => {
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
    const [saved] = saveInputOf(filled({ servers: [server] }), null, newId, new Map()).mcpServers;
    expect(saved).toEqual({ name: "release-names", transport: "http", url: "https://names.acme.internal/mcp", readOnly: true, headers: [{ name: "Authorization", value: null }, { name: "X-Team", value: "typed now" }] });
  });

  it("F-063: a new profile starts with plan first off, open to everyone, with the built-in profile's model", () => {
    expect(newDraft("opencode", MODEL)).toMatchObject({ planFirst: false, access: "everyone", members: [], modelId: MODEL, rules: [], skills: [], servers: [] });
    expect(saveInputOf(filled(), null, newId, new Map()).planFirst).toBe(false);
  });

  it("F-021: Save profile waits for a name, a model, a listed member and valid rules", () => {
    expect(draftProblem(filled({ name: " " }))).toBe("agentProfiles.editor.name");
    expect(draftProblem(filled({ modelId: null }))).toBe("agentProfiles.editor.pickModelPlaceholder");
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
    expect(skillProblem({ ...skill, files: [{ path: "big.bin", size: 2 * 1024 * 1024, kind: "stored", blobId: "b" }] }, [])).toEqual({ field: "files", key: "agentProfiles.skill.errorSize", path: "big.bin" });
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

  it("F-021: a project may default only to an active profile open to everyone, or the one it has", () => {
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
