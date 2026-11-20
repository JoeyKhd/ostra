import { describe, expect, it } from "vitest";

import { modelIdSchema, providerIdSchema } from "@ostra/protocol";

import { dispatchNoteFor, dispatchWaitFromDb, dispatchWaitSchema } from "./dispatch-wait.ts";
import { modelNameSchema } from "./providers/model-name.ts";
import { providerGate, resolveProfileModel, resolveProjectModel } from "./providers/resolve.ts";
import type { ListedModel } from "./providers/resolve.ts";
import { noProviderMessage } from "./providers/session-model.ts";

// The profile's provider, pure (F-135, F-021; ADR 0065 amended 2026-11-20): a profile on a
// provider runs on that provider alone, wherever the project's list allows it; a profile with none
// resolves by name as before; the turn-start gate keeps a pinned session on its provider.

const a = providerIdSchema.parse("pa-client-a");
const b = providerIdSchema.parse("pb-client-b");
const sonnet = modelNameSchema.parse({ kind: "catalog", catalogId: "anthropic/claude-sonnet" });
const row = (id: string, providerId: typeof a, listed = true, endpointModelId = `endpoint-${id}`): ListedModel => ({
  modelId: modelIdSchema.parse(id),
  providerId,
  name: sonnet,
  endpointModelId,
  listed,
});
const onA = row("ma", a);
const onB = row("mb", b);
const choiceA = [{ modelKey: "catalog:anthropic/claude-sonnet", modelId: onA.modelId }];

describe("a profile's model on its own provider", () => {
  it("F-135/c4,c5, F-021: runs on the profile's provider even where the list chose another for the name, and never falls back", () => {
    // The list allows both and chose A for the name: the profile on B still runs on B.
    expect(resolveProfileModel([a, b], choiceA, [onA, onB], sonnet, b)).toEqual({ ok: true, providerId: b, modelId: onB.modelId });
    // By name (no provider), the list's choice serves it: today's rule, unchanged.
    expect(resolveProfileModel([a, b], choiceA, [onA, onB], sonnet, null)).toEqual(resolveProjectModel([a, b], choiceA, [onA, onB], sonnet));
    expect(resolveProfileModel([a, b], choiceA, [onA, onB], sonnet, null)).toEqual({ ok: true, providerId: a, modelId: onA.modelId });
    // The list doesn't allow B: refused, though A serves the same name here.
    expect(resolveProfileModel([a], choiceA, [onA, onB], sonnet, b)).toEqual({ ok: false, reason: "not-allowed" });
    // B allowed, but its row is unlisted, or it lists the name not at all: refused, never A.
    expect(resolveProfileModel([a, b], choiceA, [onA, row("mb", b, false)], sonnet, b)).toEqual({ ok: false, reason: "not-listed" });
    expect(resolveProfileModel([a, b], choiceA, [onA], sonnet, b)).toEqual({ ok: false, reason: "not-listed" });
    // One provider listing the name twice (`x` and `x:batch`) serves it from its plain row.
    const batch = row("mb0", b, true, "claude-sonnet:batch");
    expect(resolveProfileModel([b], [], [batch, row("mb9", b, true, "claude-sonnet")], sonnet, b)).toMatchObject({ ok: true, modelId: "mb9" });
  });

  it("F-135/c4, F-021: the turn-start gate keeps a pinned session on its provider: open while allowed and listed, else none, never moved", () => {
    const session = { providerId: b, modelId: onB.modelId, modelName: sonnet, pinned: true };
    const project = { list: [a, b], choices: choiceA, models: [onA, onB] };
    expect(providerGate(session, project)).toEqual({ kind: "open" });
    // Not pinned, the same session moves to the project's choice: the by-name rule.
    expect(providerGate({ ...session, pinned: false }, project)).toEqual({ kind: "moved", providerId: a, modelId: onA.modelId });
    expect(providerGate(session, { ...project, list: [a] })).toEqual({ kind: "none", modelName: sonnet });
    expect(providerGate(session, { ...project, models: [onA] })).toEqual({ kind: "none", modelName: sonnet });
  });

  it("F-135/c4, F-021: the no-key wait names the profile's provider and why, and a wait without one still parses", () => {
    const wait = dispatchWaitSchema.parse({ code: "no-provider-for-model", modelName: "anthropic/claude-sonnet", provider: { name: "dev endpoint", reason: "not-allowed" } });
    expect(dispatchNoteFor(wait)).toBe("The profile runs on dev endpoint, which this project's list doesn't allow: an organization admin adds it in Models and keys.");
    expect(dispatchNoteFor(dispatchWaitSchema.parse({ code: "no-provider-for-model", modelName: "anthropic/claude-sonnet", provider: { name: "dev endpoint", reason: "not-listed" } }))).toBe(
      "dev endpoint, the profile's provider, no longer lists anthropic/claude-sonnet: an organization admin picks another model for the profile.",
    );
    expect(dispatchWaitFromDb({ code: "no-provider-for-model", modelName: "anthropic/claude-sonnet" })).toEqual({ code: "no-provider-for-model", modelName: "anthropic/claude-sonnet" });
    expect(dispatchWaitSchema.safeParse({ code: "no-provider-for-model", modelName: "x", provider: { name: "dev endpoint", reason: "gone" } }).success).toBe(false);
    expect(noProviderMessage(sonnet)).toBe("No provider on this project's list serves anthropic/claude-sonnet: an organization admin adds one under Models");
    expect(noProviderMessage(sonnet, { providerId: b, name: "dev endpoint", reason: "not-allowed" })).toContain("dev endpoint, which this project's list doesn't allow");
  });
});
