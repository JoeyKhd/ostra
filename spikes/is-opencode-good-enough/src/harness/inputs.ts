// The spike's inputs, read from the environment and, for the model endpoint,
// from ~/.config/ostra-dev/model.env when the variables aren't set
// (docs/development.md). Values are never printed: only presence.
//
// The model endpoint is three variables (OSTRA_DEV_MODEL_BASE_URL, _API_KEY and
// _ID). Everything else is optional and belongs to this spike:
//   OSTRA_DEV_MODEL_ENV_FILE          where to read those three from when they are not in the environment (default ~/.config/ostra-dev/model.env)
//   OSTRA_DEV_MODEL_API_FORMAT        openai | anthropic; detected from GET /models when unset
//   OSTRA_SPIKE_PRICE_INPUT/_OUTPUT   USD per million tokens, to price the proxy's token counts
//   OSTRA_SPIKE_PRICE_CACHE_READ/_CACHE_WRITE
//   OSTRA_SPIKE_MODEL_CONTEXT/_OUTPUT the model's context window and output limit, in tokens

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Pricing } from "../runner/pricing.ts";

export const MODEL_ENV_FILE = process.env["OSTRA_DEV_MODEL_ENV_FILE"] ?? path.join(os.homedir(), ".config", "ostra-dev", "model.env");

const modelSchema = z.strictObject({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  modelId: z.string().min(1),
  /** Optional. When unset, the format is detected from the endpoint's model list. */
  apiFormat: z.enum(["openai", "anthropic"]).optional(),
});

export type ModelEndpoint = z.infer<typeof modelSchema>;

export type ModelLimits = { readonly context: number; readonly output: number };

export type Inputs = {
  readonly model: ModelEndpoint | undefined;
  /** Where each model value came from, or why it's missing. Never the value. */
  readonly modelSource: "environment" | "model.env" | "missing";
  readonly modelMissing: readonly string[];
  /** Undefined when no price is set: spend is then reported in tokens only. */
  readonly pricing: Pricing | undefined;
  /** Which price variables are set, by name. */
  readonly priceVarsSet: readonly string[];
  readonly limits: ModelLimits;
  readonly limitVarsSet: readonly string[];
};

const MODEL_VARS = ["OSTRA_DEV_MODEL_BASE_URL", "OSTRA_DEV_MODEL_API_KEY", "OSTRA_DEV_MODEL_ID"] as const;
const PRICE_VARS = ["OSTRA_SPIKE_PRICE_INPUT", "OSTRA_SPIKE_PRICE_OUTPUT", "OSTRA_SPIKE_PRICE_CACHE_READ", "OSTRA_SPIKE_PRICE_CACHE_WRITE"] as const;
const LIMIT_VARS = ["OSTRA_SPIKE_MODEL_CONTEXT", "OSTRA_SPIKE_MODEL_OUTPUT"] as const;

export const DEFAULT_LIMITS: ModelLimits = { context: 128_000, output: 16_000 };

export const parseEnvFile = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
};

const amount = z.coerce.number().nonnegative();
const tokens = z.coerce.number().int().positive();

const pricingFrom = (source: Readonly<Record<string, string | undefined>>): Pricing | undefined => {
  const input = source["OSTRA_SPIKE_PRICE_INPUT"];
  const output = source["OSTRA_SPIKE_PRICE_OUTPUT"];
  if ((input ?? "") === "" || (output ?? "") === "") return undefined;
  const parsed = z
    .strictObject({
      inputPerMTok: amount,
      outputPerMTok: amount,
      cacheReadPerMTok: amount.optional(),
      cacheWritePerMTok: amount.optional(),
    })
    .safeParse({
      inputPerMTok: input,
      outputPerMTok: output,
      ...((source["OSTRA_SPIKE_PRICE_CACHE_READ"] ?? "") === "" ? {} : { cacheReadPerMTok: source["OSTRA_SPIKE_PRICE_CACHE_READ"] }),
      ...((source["OSTRA_SPIKE_PRICE_CACHE_WRITE"] ?? "") === "" ? {} : { cacheWritePerMTok: source["OSTRA_SPIKE_PRICE_CACHE_WRITE"] }),
    });
  if (!parsed.success) return undefined;
  // A cache price left unset is the input price: the dearest honest guess.
  return {
    source: "configured",
    inputPerMTok: parsed.data.inputPerMTok,
    outputPerMTok: parsed.data.outputPerMTok,
    cacheReadPerMTok: parsed.data.cacheReadPerMTok ?? parsed.data.inputPerMTok,
    cacheWritePerMTok: parsed.data.cacheWritePerMTok ?? parsed.data.inputPerMTok,
  };
};

const limitsFrom = (source: Readonly<Record<string, string | undefined>>): ModelLimits => {
  const context = tokens.safeParse(source["OSTRA_SPIKE_MODEL_CONTEXT"]);
  const output = tokens.safeParse(source["OSTRA_SPIKE_MODEL_OUTPUT"]);
  return { context: context.success ? context.data : DEFAULT_LIMITS.context, output: output.success ? output.data : DEFAULT_LIMITS.output };
};

export const loadInputs = async (): Promise<Inputs> => {
  let source: Record<string, string | undefined> = process.env;
  let modelSource: Inputs["modelSource"] = "environment";
  if (MODEL_VARS.some((name) => (process.env[name] ?? "") === "")) {
    try {
      source = { ...parseEnvFile(await readFile(MODEL_ENV_FILE, "utf8")), ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")) };
      modelSource = "model.env";
    } catch {
      modelSource = "missing";
    }
  }
  const missing = MODEL_VARS.filter((name) => (source[name] ?? "") === "");
  const format = source["OSTRA_DEV_MODEL_API_FORMAT"];
  const parsed = modelSchema.safeParse({
    baseUrl: source["OSTRA_DEV_MODEL_BASE_URL"],
    apiKey: source["OSTRA_DEV_MODEL_API_KEY"],
    modelId: source["OSTRA_DEV_MODEL_ID"],
    ...(format === undefined || format === "" ? {} : { apiFormat: format }),
  });
  return {
    model: parsed.success ? parsed.data : undefined,
    modelSource: parsed.success ? modelSource : "missing",
    modelMissing: parsed.success ? [] : missing.length > 0 ? missing : ["a valid OSTRA_DEV_MODEL_* set (a value did not parse)"],
    pricing: pricingFrom(source),
    priceVarsSet: PRICE_VARS.filter((name) => (source[name] ?? "") !== ""),
    limits: limitsFrom(source),
    limitVarsSet: LIMIT_VARS.filter((name) => (source[name] ?? "") !== ""),
  };
};

export const MODEL_INPUT_HINT = `OSTRA_DEV_MODEL_BASE_URL, OSTRA_DEV_MODEL_API_KEY and OSTRA_DEV_MODEL_ID (environment, or ${MODEL_ENV_FILE})`;

const modelList = z.looseObject({
  object: z.string().optional(),
  data: z.array(z.looseObject({ id: z.string(), type: z.string().optional() })),
  has_more: z.boolean().optional(),
});

/**
 * Which API format a `GET /models` answer is in, or undefined when it is neither:
 * Anthropic's list says `has_more` and types its entries `model`; an
 * OpenAI-compatible one is a list of `data` entries with an `id`. A body that is
 * not a model list at all (an error page, a JSON error object) is not a format.
 */
export const formatFromModelList = (body: unknown): "openai" | "anthropic" | undefined => {
  const parsed = modelList.safeParse(body);
  if (!parsed.success) return undefined;
  return parsed.data.has_more !== undefined || parsed.data.data.some((model) => model.type === "model") ? "anthropic" : "openai";
};

/**
 * Detects the endpoint's API format from its model list, the way ADR 0033's
 * "Test connection" does. It fails loudly, never guesses: a 401, a 5xx or a
 * body that is not a model list would otherwise read as the OpenAI format, and
 * a whole set of runs would then fail fast against the wrong one.
 */
export const detectApiFormat = async (endpoint: ModelEndpoint): Promise<"openai" | "anthropic"> => {
  if (endpoint.apiFormat !== undefined) return endpoint.apiFormat;
  const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${endpoint.apiKey}`, "x-api-key": endpoint.apiKey, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GET /models answered ${String(response.status)}: check the endpoint and the key, or set OSTRA_DEV_MODEL_API_FORMAT`);
  const format = formatFromModelList(await response.json().catch(() => undefined));
  if (format === undefined) throw new Error("GET /models did not answer with a model list in either API format: set OSTRA_DEV_MODEL_API_FORMAT to openai or anthropic");
  return format;
};
