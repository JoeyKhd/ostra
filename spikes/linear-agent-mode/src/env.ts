import { z } from "zod";
import { INPUTS, INPUT_NAMES } from "./criteria.ts";
import type { CriterionId, InputName } from "./criteria.ts";
import { criterionSpec } from "./criteria.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** An input is present when it is set to something other than whitespace. Values are never returned. */
export const presentInputs = (env: Env): Readonly<Record<InputName, boolean>> => {
  const result: Record<InputName, boolean> = {
    OSTRA_DEV_PUBLIC_URL: false,
    LINEAR_CLIENT_ID: false,
    LINEAR_CLIENT_SECRET: false,
    LINEAR_WEBHOOK_SECRET: false,
    LINEAR_API_KEY: false,
    LINEAR_TEST_TEAM_KEY: false,
  };
  for (const name of INPUT_NAMES) {
    result[name] = (env[name] ?? "").trim().length > 0;
  }
  return result;
};

export const missingForCriterion = (env: Env, id: CriterionId): readonly InputName[] => {
  const present = presentInputs(env);
  return criterionSpec(id).realInputs.filter((name) => !present[name]);
};

export const optionalInputsMissing = (env: Env): readonly InputName[] => {
  const present = presentInputs(env);
  return INPUTS.filter((spec) => spec.optional && !present[spec.name]).map((spec) => spec.name);
};

export type LinearEndpoints = {
  readonly apiUrl: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
};

const endpointsSchema = z.object({
  LINEAR_API_URL: z.url().default("https://api.linear.app/graphql"),
  LINEAR_OAUTH_AUTHORIZE_URL: z.url().default("https://linear.app/oauth/authorize"),
  LINEAR_OAUTH_TOKEN_URL: z.url().default("https://api.linear.app/oauth/token"),
});

/** Real Linear by default. Overridable only so the fake Linear can stand in for it. */
export const linearEndpoints = (env: Env): LinearEndpoints => {
  const parsed = endpointsSchema.parse({
    LINEAR_API_URL: env["LINEAR_API_URL"],
    LINEAR_OAUTH_AUTHORIZE_URL: env["LINEAR_OAUTH_AUTHORIZE_URL"],
    LINEAR_OAUTH_TOKEN_URL: env["LINEAR_OAUTH_TOKEN_URL"],
  });
  return { apiUrl: parsed.LINEAR_API_URL, authorizeUrl: parsed.LINEAR_OAUTH_AUTHORIZE_URL, tokenUrl: parsed.LINEAR_OAUTH_TOKEN_URL };
};
