import path from "node:path";

import { z } from "zod";

import { devConfigDir, readEnvFile } from "./env-files.ts";

// The harness's settings (ticket 38): `linear.env` and `tunnel.env` from `~/.config/ostra-dev/`
// (docs/development.md), with this process's environment winning over a file. Holds secrets: never
// printed or logged whole.
//
// Without `LINEAR_REFRESH_TOKEN` (the refresh token ostra showed once when the maintainer pressed
// Authorize, ticket 40's step 1) the live run is skipped before anything touches Linear.

const liveSchema = z.object({
  LINEAR_REFRESH_TOKEN: z.string().min(1),
  LINEAR_CLIENT_ID: z.string().min(1),
  LINEAR_CLIENT_SECRET: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_TEST_TEAM_ID: z.string().min(1),
  /** The tunnel to the harness's core: the app's webhook URL starts with it. */
  OSTRA_DEV_PUBLIC_URL: z.url(),
  /** The connection ID in the app's webhook URL (`/webhooks/linear/<id>`), so Linear's events reach the harness's connection. */
  LINEAR_APP_CONNECTION_ID: z.uuid(),
  /** How many tickets the load bullet delegates. */
  OSTRA_HARNESS_DELEGATIONS: z.coerce.number().int().min(1).max(200).default(50),
  /** How long the stop bullet waits for a person to press Send stop request, in minutes. */
  OSTRA_HARNESS_STOP_WAIT_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
});

export type LiveSettings = z.infer<typeof liveSchema> & { readonly linearEnvFile: string };

export type HarnessSettings =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "incomplete"; readonly missing: readonly string[] }
  | { readonly kind: "live"; readonly settings: LiveSettings };

/** The files' values under this process's environment. */
export const loadHarnessEnv = async (env: Readonly<Record<string, string | undefined>>): Promise<{ readonly values: Readonly<Record<string, string | undefined>>; readonly linearEnvFile: string }> => {
  const dir = devConfigDir(env);
  const linearEnvFile = path.join(dir, "linear.env");
  const files = { ...(await readEnvFile(path.join(dir, "tunnel.env"))), ...(await readEnvFile(linearEnvFile)) };
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ""));
  return { values: { ...files, ...set }, linearEnvFile };
};

/** What the run can do: skip (no app token), say what's missing, or run live. */
export const harnessSettings = async (env: Readonly<Record<string, string | undefined>>): Promise<HarnessSettings> => {
  const { values, linearEnvFile } = await loadHarnessEnv(env);
  const token = values["LINEAR_REFRESH_TOKEN"];
  if (token === undefined || token.trim() === "") {
    return { kind: "skip", reason: "no app token" };
  }
  const parsed = liveSchema.safeParse(values);
  if (!parsed.success) {
    return { kind: "incomplete", missing: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))] };
  }
  return { kind: "live", settings: { ...parsed.data, OSTRA_DEV_PUBLIC_URL: parsed.data.OSTRA_DEV_PUBLIC_URL.replace(/\/+$/, ""), linearEnvFile } };
};
