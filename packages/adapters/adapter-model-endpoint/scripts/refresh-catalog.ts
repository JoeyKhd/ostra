import { writeFile } from "node:fs/promises";

import { z } from "zod";

// Refreshes the bundled copy of the models.dev catalog: `pnpm catalog:refresh`. It keeps what
// ostra reads (a model's ID, name, limits, prices and, since F-137, its reasoning controls and
// reasoning price, and since F-148 its input modalities, as models.dev spells them; and each
// provider's `api` base URL since 2026-11-22, which says whose entry is an endpoint's own) for the models
// that call tools, which is what an agent needs, and writes the fetch date beside them. Run by a maintainer before a
// release; the running server fetches its own copy daily (ticket 28).

const SOURCE = "https://models.dev/api.json";
const OUT = new URL("../catalog/models-dev.json", import.meta.url);

const number = z.number().nullish();
const raw = z.record(
  z.string(),
  z.looseObject({
    id: z.string().nullish(),
    name: z.string().nullish(),
    npm: z.string().nullish(),
    // 2026-11-22: the provider's base URL, which tells which provider serves an endpoint.
    api: z.string().nullish(),
    models: z.record(
      z.string(),
      z.looseObject({
        id: z.string().min(1),
        name: z.string().nullish(),
        tool_call: z.boolean().nullish(),
        limit: z.looseObject({ context: number, output: number }).nullish(),
        cost: z.looseObject({ input: number, output: number, reasoning: z.unknown().optional() }).nullish(),
        // F-137: kept as models.dev has them; the catalog parse converts and checks them per model.
        reasoning: z.unknown().optional(),
        reasoning_options: z.unknown().optional(),
        // F-148 (ADR 0070): read loosely; only its list of inputs is kept.
        modalities: z.unknown().optional(),
      }),
    ),
  }),
);

const response = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000), headers: { "user-agent": "ostra-catalog-refresh" } });
if (!response.ok) {
  throw new Error(`models.dev answered ${String(response.status)}`);
}
const catalog = raw.parse(await response.json());

/** A model's `modalities.input` as models.dev lists it, or nothing without a list: the catalog's parse keeps the values ostra names. */
const inputModalities = (modalities: unknown): { readonly modalities: { readonly input: readonly string[] } } | Record<string, never> => {
  const parsed = z.looseObject({ input: z.array(z.unknown()) }).safeParse(modalities);
  return parsed.success ? { modalities: { input: parsed.data.input.filter((value) => typeof value === "string") } } : {};
};

const providers: Record<string, unknown> = {};
let models = 0;
for (const [providerId, provider] of Object.entries(catalog)) {
  const kept: Record<string, unknown> = {};
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (model.tool_call !== true) {
      continue;
    }
    kept[modelId] = {
      id: model.id,
      name: model.name ?? model.id,
      tool_call: true,
      ...(model.limit === undefined || model.limit === null ? {} : { limit: { context: model.limit.context ?? null, output: model.limit.output ?? null } }),
      ...(model.cost === undefined || model.cost === null
        ? {}
        : {
            cost: {
              input: model.cost.input ?? null,
              output: model.cost.output ?? null,
              ...(model.cost.reasoning === undefined ? {} : { reasoning: model.cost.reasoning }),
            },
          }),
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      ...(model.reasoning_options === undefined ? {} : { reasoning_options: model.reasoning_options }),
      ...inputModalities(model.modalities),
    };
    models += 1;
  }
  if (Object.keys(kept).length > 0) {
    providers[providerId] = { id: provider.id ?? providerId, name: provider.name ?? providerId, ...(typeof provider.api === "string" ? { api: provider.api } : {}), models: kept };
  }
}

await writeFile(OUT, `${JSON.stringify({ source: SOURCE, fetchedAt: new Date().toISOString(), providers })}\n`, "utf8");
console.log(`wrote ${String(Object.keys(providers).length)} providers and ${String(models)} models`);
