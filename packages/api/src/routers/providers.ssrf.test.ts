import { ModelEndpointAdapter } from "@ostra/adapter-model-endpoint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// With the real model provider adapter behind the routers, an admin cannot aim the server at a
// private or metadata address: the answer says so, and the token never leaves the process.

const TOKEN = "sk-test-provider-token-0123456789abcdef";

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

/** A caller whose model provider is the real adapter, in its default (private networks refused) setting. */
const realAdapterCaller = async () => {
  const context = await harness.contextOf(harness.fixture.a.admin);
  const { deps } = context;
  return harness.callerFor({
    ...context,
    deps: { ...deps, ports: { ...deps.ports, adapters: { ...deps.ports.adapters, modelProvider: new ModelEndpointAdapter() } } },
  });
};

describe("providers, against private endpoints", () => {
  it.each(["http://169.254.169.254/latest", "http://127.0.0.1:8787/v1", "http://localhost:5432/v1", "http://10.0.0.5/v1", "http://metadata.google.internal/v1"])(
    "testConnection refuses %s with a clear answer",
    async (baseUrl) => {
      const admin = await realAdapterCaller();
      const result = await admin.providers.testConnection({ baseUrl, token: TOKEN });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-input");
        expect(result.message).toContain("private address refused");
      }
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    },
  );

  it("create refuses a private endpoint and adds no provider", async () => {
    const admin = await realAdapterCaller();
    const failure = await admin.providers
      .create({
        name: "Metadata",
        baseUrl: "http://169.254.169.254/latest",
        apiFormat: "openai-compatible",
        authScheme: "bearer",
        sessionsAtOnce: null,
        allowOnPersonalRunners: false,
        token: TOKEN,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({ code: "BAD_REQUEST" });
    expect(failure instanceof Error ? failure.message : "").toContain("private address refused");
    expect(await admin.providers.list()).toEqual([]);
  });
});
