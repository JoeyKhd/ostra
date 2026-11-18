// What a handler asks of the code host: find a pull request again by its branch, and create it.
// The calls have GitHub's shape (`GET /repos/<owner>/<repo>/pulls?head=<owner>:<branch>`), so the
// check-first logic here is the logic the real adapter will use. The branch is the marker: it is
// derived from the effect's key, and it survives a crash that loses everything else.

import { z } from "zod";
import type { EffectKey } from "./ids.ts";

export const FAKE_OWNER = "ostra-test";
export const FAKE_REPO = "spike";
export const PULLS_PATH = `/repos/${FAKE_OWNER}/${FAKE_REPO}/pulls`;
export const BRANCH_PREFIX = "ostra/";

export const branchFor = (key: EffectKey): string => `${BRANCH_PREFIX}${key}`;

// A vendor owns this format, so the schema tolerates fields it does not read.
const pullListSchema = z.array(z.object({ number: z.number().int() }));

/** True if a pull request with this key's branch already exists. */
export const pullExists = async (baseUrl: string, key: EffectKey): Promise<boolean> => {
  const query = new URLSearchParams({ head: `${FAKE_OWNER}:${branchFor(key)}`, state: "all" });
  const response = await fetch(`${baseUrl}${PULLS_PATH}?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`pull request lookup failed with ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  return pullListSchema.parse(body).length > 0;
};

export type CreatePullOptions = {
  /** Harness knobs: how long the fake holds the request before counting it, and the response after. */
  readonly beforeCountHoldMs: number;
  readonly afterCountHoldMs: number;
};

/** GitHub answers 201 for a new pull request and 422 when one already exists for the head branch. */
export type CreatePullOutcome = "created" | "exists";

export const createPull = async (baseUrl: string, key: EffectKey, hold: CreatePullOptions): Promise<CreatePullOutcome> => {
  const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": key };
  if (hold.beforeCountHoldMs > 0) {
    headers["x-hold-before-ms"] = String(hold.beforeCountHoldMs);
  }
  if (hold.afterCountHoldMs > 0) {
    headers["x-hold-ms"] = String(hold.afterCountHoldMs);
  }
  const response = await fetch(`${baseUrl}${PULLS_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: `ostra ${key}`, head: branchFor(key), base: "main" }),
  });
  if (response.status === 201) {
    return "created";
  }
  if (response.status === 422) {
    return "exists";
  }
  throw new Error(`pull request creation failed with ${String(response.status)}`);
};
