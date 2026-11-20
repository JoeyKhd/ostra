import { loadProviderList, modelNameKey, modelNameSchema, resolveProjectModel } from "@ostra/domain";
import { providerIdSchema } from "@ostra/protocol";
import type { ProviderId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-135 (ADR 0065): the keep rule on a provider's model refresh, through the panel's Refresh and
// the real `syncProviderModels`. When a refresh makes a second provider on a list serve a model
// the first already serves, the first is recorded as the choice, so nothing but an admin's save
// moves the model. Proved with two fake endpoints (the live two-client run is ticket 55's).

const URL_A = "https://keep-a-models.example.com/v1";
const URL_B = "https://keep-b-models.example.com/v1";
const TOKEN_A = "sk-keep-a-token-0123456789abcdefABCDEF";
const TOKEN_B = "sk-keep-b-token-0123456789abcdefABCDEF";
const SHARED = modelNameSchema.parse({ kind: "custom", endpointModelId: "shared-model" });

let harness: ApiHarness;
let providerA: ProviderId;
let providerB: ProviderId;

const endpoint = (token: string, models: readonly string[]) => ({
  token,
  apiFormat: "openai-compatible" as const,
  authScheme: "bearer" as const,
  models: models.map((id) => ({ endpointModelId: id, displayName: id, contextWindow: 100_000 })),
});

beforeAll(async () => {
  harness = await createApiHarness();
  harness.fakes.modelProvider.endpoints.set(URL_A, endpoint(TOKEN_A, ["shared-model"]));
  harness.fakes.modelProvider.endpoints.set(URL_B, endpoint(TOKEN_B, ["b-only"]));
  const admin = await harness.as(harness.fixture.a.admin);
  const create = async (name: string, baseUrl: string, token: string) =>
    providerIdSchema.parse((await admin.providers.create({ name, baseUrl, apiFormat: "openai-compatible", authScheme: "bearer", sessionsAtOnce: null, allowOnPersonalRunners: true, token })).providerId);
  providerA = await create("Client A", URL_A, TOKEN_A);
  providerB = await create("Client B", URL_B, TOKEN_B);
  // Both on the default list: B serves nothing A does yet, so the save needs no choice.
  const preview = await admin.providers.previewDefaultList({ providerIds: [providerA, providerB] });
  await admin.providers.setDefaultList({ providerIds: [providerA, providerB], version: preview.version });
});

afterAll(async () => {
  await harness.dispose();
});

describe("the keep rule on a provider's refresh", () => {
  it("F-135: a refresh that makes a second provider on the list serve a model keeps the one serving it, recorded as kept", async () => {
    const { a } = harness.fixture;
    const organizationId = a.organization.id;
    const admin = await harness.as(a.admin);
    const shared = await harness.test.db.model.findFirstOrThrow({ where: { organizationId, providerId: providerA, endpointModelId: "shared-model" } });
    expect(await harness.test.db.modelChoice.count({ where: { organizationId, modelKey: modelNameKey(SHARED) } })).toBe(0);

    // B's endpoint starts listing the shared model; the admin presses Refresh on B.
    harness.fakes.modelProvider.endpoints.set(URL_B, endpoint(TOKEN_B, ["b-only", "shared-model"]));
    expect(await admin.providers.refresh({ providerId: providerB })).toMatchObject({ listed: 2 });
    expect(await harness.test.db.model.count({ where: { organizationId, providerId: providerB, endpointModelId: "shared-model", listed: true } })).toBe(1);

    // The default list keeps A for the shared model, as a kept choice nobody made.
    const choice = await harness.test.db.modelChoice.findFirstOrThrow({ where: { organizationId, projectId: null, modelKey: modelNameKey(SHARED) } });
    expect(choice).toMatchObject({ modelId: shared.id, reason: "kept", chosenByMemberId: null, needsConfirm: false });
    // A project that follows the default list resolves the model to A's row, not to "choose one".
    const list = await harness.test.db.$transaction((tx) => loadProviderList(tx, organizationId, a.openProject.id));
    expect(list).not.toBeNull();
    if (list === null) return;
    expect(resolveProjectModel(list.list, list.choices, list.models, SHARED)).toEqual({ ok: true, providerId: providerA, modelId: shared.id });
    // A second refresh records nothing new.
    await admin.providers.refresh({ providerId: providerB });
    expect(await harness.test.db.modelChoice.count({ where: { organizationId, modelKey: modelNameKey(SHARED) } })).toBe(1);
  });
});
