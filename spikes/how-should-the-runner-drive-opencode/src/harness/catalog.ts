// The models.dev catalog, fetched by the harness the way ostra's server would
// (ADR 0033), cached in .runs/, and handed to OpenCode as a file through
// OPENCODE_MODELS_PATH, so the agent itself never fetches it.
// SPIKE_MODELS_JSON points at a local copy instead.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { StubFormat } from "../lib/stub-models/types.ts";

const catalogSchema = z.record(
  z.string(),
  z.looseObject({
    npm: z.string().optional(),
    models: z.record(z.string(), z.looseObject({ id: z.string(), release_date: z.string().optional(), tool_call: z.boolean().optional() })),
  }),
);

export type CatalogPick = { readonly file: string; readonly providerId: string; readonly npm: string; readonly models: readonly string[] };

/**
 * The catalog's `npm` field names the SDK package, which fixes the wire
 * format. `@ai-sdk/openai` is left out of "openai": it speaks OpenAI's
 * Responses API, and the stub serves Chat Completions.
 */
const PACKAGES_FOR_FORMAT: Readonly<Record<StubFormat, readonly string[]>> = {
  anthropic: ["@ai-sdk/anthropic"],
  openai: ["@ai-sdk/openai-compatible"],
};

/**
 * Picks the first catalog provider that speaks the given stub's API format,
 * with its tool-calling models newest first. The choice is by the provider's
 * wire format (its SDK package), never by a vendor's name.
 */
export const loadCatalog = async (runsDir: string, format: StubFormat): Promise<CatalogPick | { readonly error: string }> => {
  const file = process.env["SPIKE_MODELS_JSON"] ?? path.join(runsDir, "catalog", "models.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    try {
      const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return { error: `models.dev answered ${String(response.status)}` };
      text = await response.text();
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    } catch (error) {
      return { error: `no catalog copy and models.dev unreachable (${error instanceof Error ? error.message : "error"}); set SPIKE_MODELS_JSON` };
    }
  }
  const raw: unknown = JSON.parse(text);
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) return { error: "the catalog did not parse" };
  for (const [providerId, provider] of Object.entries(parsed.data)) {
    const npm = provider.npm ?? "";
    if (!PACKAGES_FOR_FORMAT[format].includes(npm)) continue;
    const models = Object.values(provider.models)
      .filter((m) => m.tool_call === true)
      .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
      .map((m) => m.id);
    if (models.length >= 2) return { file, providerId, npm, models };
  }
  return { error: `no catalog provider speaks the ${format} format with two tool-calling models` };
};
