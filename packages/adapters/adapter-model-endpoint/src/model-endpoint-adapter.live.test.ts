import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ModelEndpointAdapter } from "./model-endpoint-adapter.ts";

// The live case, against the development endpoint: it runs only with `model.env` loaded
// (`set -a; . ~/.config/ostra-dev/model.env; set +a`) and skips otherwise. It prints neither the
// URL nor the token, and its failure messages name neither.

const env = z
  .object({
    OSTRA_DEV_MODEL_BASE_URL: z.url(),
    OSTRA_DEV_MODEL_API_KEY: z.string().min(1),
    OSTRA_DEV_MODEL_ID: z.string().min(1),
  })
  .safeParse(process.env);

describe.skipIf(!env.success)("the model endpoint adapter, live", () => {
  it("detects the endpoint's format and lists OSTRA_DEV_MODEL_ID", async () => {
    if (!env.success) {
      return;
    }
    const adapter = new ModelEndpointAdapter();
    const tested = await adapter.testConnection({ baseUrl: env.data.OSTRA_DEV_MODEL_BASE_URL, token: env.data.OSTRA_DEV_MODEL_API_KEY });
    expect(tested.ok, tested.ok ? "" : `testConnection failed: ${tested.error.code}`).toBe(true);
    if (!tested.ok) {
      return;
    }
    expect(["openai-compatible", "anthropic-messages"]).toContain(tested.value.apiFormat);
    const listed = tested.value.models.some((model) => model.endpointModelId === env.data.OSTRA_DEV_MODEL_ID);
    expect(listed, "the endpoint's model list holds OSTRA_DEV_MODEL_ID").toBe(true);
  }, 30_000);
});
