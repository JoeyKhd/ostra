import { describe, expect, it } from "vitest";

import { memberIdSchema, modelIdSchema, organizationIdSchema, projectIdSchema, providerIdSchema } from "@ostra/protocol";

import { canEditProviderLists, canSeeProjectProviders } from "./access.ts";
import type { MemberScope } from "./access.ts";
import { dispatchNoteFor, dispatchWaitSchema } from "./dispatch-wait.ts";
import { jobKey } from "./jobs.ts";
import { modelNameColumns, modelNameKey, modelNameOfColumns, modelNameOfModel, modelNameSchema } from "./providers/model-name.ts";
import { keepChoicesOnRefresh, planProviderChange, providerGate, resolveProjectModel } from "./providers/resolve.ts";
import type { ListedModel } from "./providers/resolve.ts";

// Keys per project's pure core (milestone 4's ticket 45, ADR 0065): the model by name, the
// resolution table, the keep rule, the turn-start gate, access and the wait codes.

const p1 = providerIdSchema.parse("p1-client-a");
const p2 = providerIdSchema.parse("p2-client-b");
const p3 = providerIdSchema.parse("p3-client-c");
const sonnet = modelNameSchema.parse({ kind: "catalog", catalogId: "anthropic/claude-sonnet" });
const custom = modelNameSchema.parse({ kind: "custom", endpointModelId: "in-house-7b" });
const row = (id: string, providerId: typeof p1, name: typeof sonnet, listed = true): ListedModel => ({ modelId: modelIdSchema.parse(id), providerId, name, listed });
const m1 = row("m1", p1, sonnet);
const m2 = row("m2", p2, sonnet);
const m3 = row("m3", p3, custom);

describe("the model by name", () => {
  it("names a row by its catalog ID, else its endpoint ID, and keys it", () => {
    const catalog = modelNameOfModel({ catalogId: "anthropic/claude-sonnet", endpointModelId: "claude-sonnet-4" });
    expect(catalog).toEqual({ kind: "catalog", catalogId: "anthropic/claude-sonnet" });
    expect(modelNameKey(catalog)).toBe("catalog:anthropic/claude-sonnet");
    const own = modelNameOfModel({ catalogId: null, endpointModelId: "in-house-7b" });
    expect(modelNameKey(own)).toBe("custom:in-house-7b");
    expect(modelNameOfColumns(modelNameColumns(own))).toEqual(own);
    expect(modelNameOfColumns({ modelCatalogId: null, modelCustomName: null })).toBeNull();
    expect(modelNameSchema.safeParse({ kind: "catalog", catalogId: "" }).success).toBe(false);
  });
});

describe("the resolution", () => {
  it("F-135: resolves by the choice, else the only provider, and refuses none, two with no choice, and a chosen row no longer listed", () => {
    const cases = [
      { name: "a choice", list: [p1, p2], choices: [{ modelKey: modelNameKey(sonnet), modelId: m2.modelId }], models: [m1, m2], expected: { ok: true, providerId: p2, modelId: m2.modelId } },
      { name: "the only provider", list: [p1], choices: [], models: [m1, m2], expected: { ok: true, providerId: p1, modelId: m1.modelId } },
      { name: "none on the list", list: [p3], choices: [], models: [m1, m2, m3], expected: { ok: false, reason: "no-provider" } },
      { name: "an empty list", list: [], choices: [], models: [m1], expected: { ok: false, reason: "no-provider" } },
      { name: "two with no choice", list: [p1, p2], choices: [], models: [m1, m2], expected: { ok: false, reason: "no-provider" } },
      {
        name: "a chosen row its provider no longer lists",
        list: [p1, p2],
        choices: [{ modelKey: modelNameKey(sonnet), modelId: m2.modelId }],
        models: [m1, { ...m2, listed: false }],
        // Never the other provider that still lists it.
        expected: { ok: false, reason: "not-listed" },
      },
      { name: "a chosen row whose provider left the list", list: [p1], choices: [{ modelKey: modelNameKey(sonnet), modelId: m2.modelId }], models: [m1, m2], expected: { ok: false, reason: "not-listed" } },
      { name: "an unlisted row with no choice", list: [p1], choices: [], models: [{ ...m1, listed: false }], expected: { ok: false, reason: "no-provider" } },
    ] as const;
    for (const entry of cases) {
      expect(resolveProjectModel(entry.list, entry.choices, entry.models, sonnet), entry.name).toEqual(entry.expected);
    }
    expect(resolveProjectModel([p3], [], [m1, m3], custom)).toEqual({ ok: true, providerId: p3, modelId: m3.modelId });
  });

  it("F-135: the keep rule records the provider serving a model when a list gains a second one", () => {
    const plan = planProviderChange({ list: [p1], choices: [] }, [p1, p2], [m1, m2]);
    expect(plan.keep).toEqual([{ modelKey: modelNameKey(sonnet), modelId: m1.modelId }]);
    expect(plan.lines).toEqual([{ name: sonnet, before: { providerId: p1, modelId: m1.modelId }, after: { providerId: p1, modelId: m1.modelId }, change: "keeps" }]);
    // Removing the serving provider moves the model to the only one left, and drops its choice.
    const moved = planProviderChange({ list: [p1, p2], choices: [{ modelKey: modelNameKey(sonnet), modelId: m1.modelId }] }, [p2], [m1, m2]);
    expect(moved.lines).toEqual([{ name: sonnet, before: { providerId: p1, modelId: m1.modelId }, after: { providerId: p2, modelId: m2.modelId }, change: "moves" }]);
    expect(moved.drop).toEqual([modelNameKey(sonnet)]);
    expect(moved.keep).toEqual([]);
    // Removing the last one leaves the model with none; adding a new model's provider gains one.
    expect(planProviderChange({ list: [p1], choices: [] }, [], [m1]).lines.map((line) => line.change)).toEqual(["loses"]);
    expect(planProviderChange({ list: [p1], choices: [] }, [p1, p3], [m1, m3]).lines.map((line) => [modelNameKey(line.name), line.change])).toEqual([
      ["catalog:anthropic/claude-sonnet", "keeps"],
      ["custom:in-house-7b", "gains"],
    ]);
  });

  it("F-135: the keep rule holds on a provider's refresh that starts listing a model another provider serves", () => {
    const lists = [{ id: "default", list: [p1, p2], choices: [] }, { id: "own", list: [p2], choices: [] }] as const;
    // Before the refresh only p1 listed it; after it, p2 does too.
    const result = keepChoicesOnRefresh(lists, [m1], [m1, m2]);
    expect(result.map((entry) => [entry.list.id, entry.keep])).toEqual([
      ["default", [{ modelKey: modelNameKey(sonnet), modelId: m1.modelId }]],
      ["own", []],
    ]);
  });

  it("F-135: checks every turn start: open, moved to another provider, or none", () => {
    const session = { providerId: p1, modelId: m1.modelId, modelName: sonnet };
    expect(providerGate(session, { list: [p1], choices: [], models: [m1, m2] })).toEqual({ kind: "open" });
    expect(providerGate(session, { list: [p2], choices: [], models: [m1, m2] })).toEqual({ kind: "moved", providerId: p2, modelId: m2.modelId });
    expect(providerGate(session, { list: [p3], choices: [], models: [m1, m2, m3] })).toEqual({ kind: "none", modelName: sonnet });
  });
});

describe("access and waits", () => {
  const organizationId = organizationIdSchema.parse("org-a");
  const project = { id: projectIdSchema.parse("project-r"), organizationId, access: "restricted" } as const;
  const scope = (role: "admin" | "member", listed: boolean): MemberScope => ({
    organizationId,
    memberId: memberIdSchema.parse(`${role}-1`),
    role,
    projectRoles: listed ? new Map([[project.id, "admin"]]) : new Map(),
  });

  it("F-135: only an organization admin edits the lists; anyone who can open the project sees its providers", () => {
    expect(canEditProviderLists(scope("admin", false), organizationId)).toBe(true);
    expect(canEditProviderLists(scope("member", true), organizationId)).toBe(false);
    expect(canEditProviderLists(scope("admin", false), organizationIdSchema.parse("org-b"))).toBe(false);
    expect(canSeeProjectProviders(scope("member", true), project)).toBe(true);
    expect(canSeeProjectProviders(scope("member", false), project)).toBe(false);
  });

  it("F-135: says a task waits for a provider of its model, or because its provider isn't allowed", () => {
    const noProvider = dispatchWaitSchema.parse({ code: "no-provider-for-model", modelName: "anthropic/claude-sonnet" });
    expect(dispatchNoteFor(noProvider)).toContain("anthropic/claude-sonnet");
    expect(dispatchNoteFor(dispatchWaitSchema.parse({ code: "provider-not-allowed" }))).toContain("no longer allowed");
    expect(dispatchWaitSchema.safeParse({ code: "no-provider-for-model" }).success).toBe(false);
    expect(jobKey("providers.release-boxes", { organizationId, projectId: project.id, changedAt: 5 })).toBe("project:project-r:release-boxes:5");
  });
});
