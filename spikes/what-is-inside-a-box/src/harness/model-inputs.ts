// The spike's inputs, read from the environment and, for the model endpoint,
// from ~/.config/ostra-dev/model.env when the variables aren't set
// (docs/development.md). Values are never printed: only presence.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const MODEL_ENV_FILE = process.env["OSTRA_DEV_MODEL_ENV_FILE"] ?? path.join(os.homedir(), ".config", "ostra-dev", "model.env");

const modelSchema = z.strictObject({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  modelId: z.string().min(1),
  /** Optional. When unset, the format is detected from the endpoint's model list. */
  apiFormat: z.enum(["openai", "anthropic"]).optional(),
});

export type ModelEndpoint = z.infer<typeof modelSchema>;

export type Inputs = {
  readonly model: ModelEndpoint | undefined;
  /** Where each model value came from, or why it's missing. Never the value. */
  readonly modelSource: "environment" | "model.env" | "missing";
  readonly modelMissing: readonly string[];
  /** SPIKE_LONG=1: run the 20-minute turn and the 10-minute permission wait. */
  readonly long: boolean;
};

const MODEL_VARS = ["OSTRA_DEV_MODEL_BASE_URL", "OSTRA_DEV_MODEL_API_KEY", "OSTRA_DEV_MODEL_ID"] as const;

const parseEnvFile = (text: string): Record<string, string> => {
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
    long: process.env["SPIKE_LONG"] === "1",
  };
};

export const MODEL_INPUT_HINT = `OSTRA_DEV_MODEL_BASE_URL, OSTRA_DEV_MODEL_API_KEY and OSTRA_DEV_MODEL_ID (environment, or ${MODEL_ENV_FILE})`;

const modelList = z.looseObject({
  object: z.string().optional(),
  data: z.array(z.looseObject({ id: z.string(), type: z.string().optional() })).optional(),
  has_more: z.boolean().optional(),
});

/** Detects the endpoint's API format from its model list, the way ADR 0033's "Test connection" does. */
export const detectApiFormat = async (endpoint: ModelEndpoint): Promise<"openai" | "anthropic"> => {
  if (endpoint.apiFormat !== undefined) return endpoint.apiFormat;
  const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${endpoint.apiKey}`, "x-api-key": endpoint.apiKey, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = modelList.safeParse(await response.json().catch(() => undefined));
  if (body.success && (body.data.has_more !== undefined || body.data.data?.some((model) => model.type === "model") === true)) return "anthropic";
  return "openai";
};
