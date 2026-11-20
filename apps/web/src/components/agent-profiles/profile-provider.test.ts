import { describe, expect, it } from "vitest";

import { modelNameSchema } from "@ostra/domain";
import { agentProfileIdSchema, modelIdSchema, providerIdSchema } from "@ostra/protocol";

import { draftFromDetail, draftProblem, isDirty, modelsOfProvider, newDraft, saveInputOf, withProvider } from "./editor-draft";
import { disambiguatorsOf } from "./model-picker-words";
import type { ModelOption } from "./model-picker";
import type { ProfileDetail } from "./profile-types";
import { defaultChoices } from "./project-defaults";

// The profile editor's provider (F-135, F-021; app-targets/m4/agent-profile-model.md, ADR 0065
// amended 2026-11-20): Agent, then Provider, then the Model that provider lists, then Effort. The
// picker gets only the chosen provider's models; changing the provider clears a model it doesn't
// list; the save sends the provider; a profile saved before asks for one.

const devEndpoint = providerIdSchema.parse("01900000-0000-7000-8000-00000000d0e1");
const clientB = providerIdSchema.parse("01900000-0000-7000-8000-00000000c11b");
const flash = modelNameSchema.parse({ kind: "catalog", catalogId: "deepseek/deepseek-v4.1-flash" });
const sonnet = modelNameSchema.parse({ kind: "catalog", catalogId: "anthropic/claude-sonnet-5-5" });
const inHouse = modelNameSchema.parse({ kind: "custom", endpointModelId: "acme/sql-coder-ft" });

const listing = (providerId: typeof devEndpoint, name: string, id: string, endpointModelId: string) => ({ providerId, name, modelId: modelIdSchema.parse(id), endpointModelId });
const option = (name: typeof flash, displayName: string, providers: ModelOption["providers"]): ModelOption => ({
  name,
  text: name.kind === "catalog" ? name.catalogId : name.endpointModelId,
  displayName,
  providers,
  projectsWithout: [],
  projects: [],
});
const options: readonly ModelOption[] = [
  option(flash, "DeepSeek V4.1 Flash", [listing(devEndpoint, "dev endpoint", "01900000-0000-7000-8000-000000000f01", "deepseek-v4.1-flash-1017"), listing(clientB, "client-b", "01900000-0000-7000-8000-000000000f02", "flash")]),
  option(sonnet, "Claude Sonnet 5.5", [listing(clientB, "client-b", "01900000-0000-7000-8000-000000000f03", "claude-sonnet-5-5")]),
  option(inHouse, "acme/sql-coder-ft", [listing(devEndpoint, "dev endpoint", "01900000-0000-7000-8000-000000000f04", "acme/sql-coder-ft")]),
];

describe("the profile editor's provider", () => {
  it("F-135/c3, F-021: the model picker offers only the chosen provider's models, each with that provider's listing alone", () => {
    const onDev = modelsOfProvider(options, devEndpoint);
    expect(onDev.map((entry) => entry.text)).toEqual(["deepseek/deepseek-v4.1-flash", "acme/sql-coder-ft"]);
    expect(onDev.flatMap((entry) => entry.providers.map((provider) => provider.providerId))).toEqual([devEndpoint, devEndpoint]);
    // The effort reads the levels of the chosen provider's own row of the model.
    expect(onDev[0]?.providers[0]?.endpointModelId).toBe("deepseek-v4.1-flash-1017");
    expect(modelsOfProvider(options, clientB).map((entry) => entry.text)).toEqual(["deepseek/deepseek-v4.1-flash", "anthropic/claude-sonnet-5-5"]);
    // No provider picked yet: no model to pick.
    expect(modelsOfProvider(options, null)).toEqual([]);
    // Two models of one name on the chosen provider still show their endpoint IDs (F-088).
    const twice = [
      option(modelNameSchema.parse({ kind: "catalog", catalogId: "deepseek/flash-a" }), "Flash", [listing(devEndpoint, "dev endpoint", "01900000-0000-7000-8000-000000000f05", "flash-a")]),
      option(modelNameSchema.parse({ kind: "catalog", catalogId: "deepseek/flash-b" }), "Flash", [listing(devEndpoint, "dev endpoint", "01900000-0000-7000-8000-000000000f06", "flash-b")]),
    ];
    expect([...disambiguatorsOf(modelsOfProvider(twice, devEndpoint)).values()]).toEqual(["flash-a", "flash-b"]);
  });

  it("F-135/c3, F-021: changing the provider keeps a model it lists and clears one it doesn't; the save sends the provider", () => {
    const draft = { ...newDraft("opencode", flash, devEndpoint), name: "Builder" };
    expect(withProvider(draft, clientB, options)).toMatchObject({ providerId: clientB, model: flash });
    const onInHouse = { ...draft, model: inHouse };
    expect(withProvider(onInHouse, clientB, options)).toMatchObject({ providerId: clientB, model: null });
    expect(draftProblem(withProvider(onInHouse, clientB, options))).toBe("agentProfiles.editor.pickModelPlaceholder");
    expect(saveInputOf(draft, null, () => "01900000-0000-7000-8000-000000000001")).toMatchObject({ providerId: devEndpoint, modelName: flash, modelId: null });
    expect(isDirty(withProvider(draft, clientB, options), draft)).toBe(true);
  });

  it("F-135/c3, F-021: a profile saved before, with no provider, loads with none and can't be saved until one is picked", () => {
    const detail: ProfileDetail = {
      id: agentProfileIdSchema.parse("01900000-0000-7000-8000-0000000000a1"),
      name: "Old",
      adapter: "opencode",
      agentName: "OpenCode",
      builtIn: false,
      model: null,
      modelName: flash,
      provider: null,
      effort: "default",
      planFirst: false,
      closingTurn: false,
      runnerLabels: [],
      access: { kind: "everyone" },
      archivedAt: null,
      createdAt: 0,
      rules: [],
      defaults: [],
      lastEdit: null,
      instructions: null,
      skills: [],
      mcpServers: [],
      usedBy: 0,
      createdBy: { name: null, at: 0 },
      archivedBy: null,
      canEdit: true,
      effortOptions: { levels: [], runsAt: "default", adjusted: false, reasoningSource: null, customModel: false, agentTakesEffort: true },
    };
    const loaded = draftFromDetail(detail);
    expect(loaded).toMatchObject({ providerId: null, model: flash });
    expect(draftProblem(loaded)).toBe("agentProfiles.editor.pickProviderPlaceholder");
    expect(draftProblem(withProvider(loaded, devEndpoint, options))).toBeNull();
  });

  it("F-135/c4, F-021: a project's default choices leave out a profile on a provider its list doesn't allow", () => {
    const row = (id: string, providerId: typeof devEndpoint | null) => ({
      id: agentProfileIdSchema.parse(`01900000-0000-7000-8000-${id.padStart(12, "0")}`),
      access: { kind: "everyone" } as const,
      archivedAt: null,
      provider: providerId === null ? null : { providerId },
    });
    const profiles = [row("1", devEndpoint), row("2", clientB), row("3", null)];
    const ids = (allowed: ReadonlySet<string> | null, current: string | null = null) => defaultChoices(profiles, current, allowed).map((profile) => profile.id.slice(-1));
    expect(ids(new Set([devEndpoint]))).toEqual(["1", "3"]);
    expect(ids(new Set([devEndpoint, clientB]))).toEqual(["1", "2", "3"]);
    // The one a project already has stays shown, so the select names it.
    expect(ids(new Set([devEndpoint]), profiles[1]?.id ?? null)).toEqual(["1", "2", "3"]);
    // Before the project's list loads, nothing is left out.
    expect(ids(null)).toEqual(["1", "2", "3"]);
  });
});
