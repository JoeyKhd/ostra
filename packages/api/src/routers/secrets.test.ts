import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// "No router returns a secret, ever" (ticket 31): the credentials are stored through the secret
// store, then every procedure that could show one is called as an admin, and the whole output, the
// log and the audit trail are searched for the stored values and their references.

const TOKEN = "sk-sweep-provider-token-0123456789abcdef";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nSWEEP-KEY-BODY-0123456789\n-----END RSA PRIVATE KEY-----";
const WEBHOOK_SECRET = "whsec-sweep-0123456789";
const BASE_URL = "https://sweep.example.com/v1";

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
  harness.fakes.modelProvider.endpoints.set(BASE_URL, {
    token: TOKEN,
    apiFormat: "openai-compatible",
    authScheme: "bearer",
    models: [{ endpointModelId: "m1", displayName: null, contextWindow: null }],
  });
  harness.fakes.codeHost.apps.set("5821041", {
    privateKey: PEM,
    info: { appId: "5821041", slug: "sweep", name: "sweep", permissions: { checks: "write", actions: "read" }, events: [] },
    bot: { name: "sweep[bot]", email: "1+sweep[bot]@users.noreply.github.com" },
    installations: [{ installationId: "1", accountLogin: "sweep-org", accountKind: "organization", repositorySelection: "all" }],
    repos: new Map([["1", [{ hostRepoId: "7", fullName: "sweep-org/repo", defaultBranch: "main", private: true, cloneUrl: "https://github.example/x.git" }]]]),
  });
});

afterAll(async () => {
  await harness.dispose();
});

describe("what the routers return", () => {
  it("never holds a stored secret or a reference to one", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const outputs: unknown[] = [];

    outputs.push(await admin.providers.testConnection({ baseUrl: BASE_URL, token: TOKEN }));
    const created = await admin.providers.create({
      name: "Sweep",
      baseUrl: BASE_URL,
      apiFormat: "openai-compatible",
      authScheme: "bearer",
      sessionsAtOnce: null,
      allowOnPersonalRunners: false,
      token: TOKEN,
    });
    outputs.push(created);
    outputs.push(await admin.providers.list());
    outputs.push(await admin.providers.models({ providerId: created.providerId }));
    outputs.push(await admin.providers.update({ providerId: created.providerId, allowOnPersonalRunners: true }));
    outputs.push(await admin.providers.refresh({ providerId: created.providerId }));
    outputs.push(await admin.agentProfiles.list());

    outputs.push(await admin.github.connectExisting({ appId: "5821041", privateKey: PEM, webhookSecret: WEBHOOK_SECRET }));
    outputs.push(await admin.github.connection());
    outputs.push(await admin.github.installations());
    outputs.push(await admin.github.repos({ installationId: "1" }));
    outputs.push(await admin.github.startManifest({ ownerLogin: null }));

    outputs.push(await admin.setup.status());
    outputs.push(await admin.me.get());
    outputs.push(await admin.organization.get());
    outputs.push(await admin.organization.members());

    const stored = harness.fakes.secretStore.values();
    expect(stored).toEqual(expect.arrayContaining([TOKEN, PEM, WEBHOOK_SECRET]));
    const refs = [...harness.fakes.secretStore.entries.keys()];
    expect(refs.length).toBeGreaterThanOrEqual(3);

    const haystacks = {
      "the routers' output": JSON.stringify(outputs),
      "the log": JSON.stringify(harness.logs),
      "the audit trail": JSON.stringify(await harness.test.db.auditEntry.findMany()),
      "the change notices": JSON.stringify((await harness.test.db.changeNotice.findMany()).map((row) => ({ ...row, seq: Number(row.seq) }))),
    };
    for (const [where, haystack] of Object.entries(haystacks)) {
      for (const secret of [...stored, "SWEEP-KEY-BODY", ...refs]) {
        expect(haystack, `${where} holds a secret or its reference`).not.toContain(secret);
      }
    }
  });
});
