import type { Tx } from "@ostra/db";
import { runnerIdSchema, taskCredentialsRequestSchema } from "@ostra/protocol";
import type { LeaseEpoch, TaskCredentials } from "@ostra/protocol";
import type { z } from "zod";

import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";

// ADR 0030, ADR 0034: `POST /runner/v1/tasks/:taskId/credentials`. Only for the runner that holds the
// task's active lease, at its current epoch, before the grace ends: then the model endpoint and its
// token from the secret store, a one-repo git token per repo from the code host, the environment's
// secrets per repo, and the task's MCP token. Each issue is an audit entry. Never logged. Written by
// ticket 26.

export const issueTaskCredentialsInputSchema = taskCredentialsRequestSchema.extend({ runnerId: runnerIdSchema });
export type IssueTaskCredentialsInput = z.infer<typeof issueTaskCredentialsInputSchema>;

/** Not a `UseCaseResult`: the stale-lease failure carries the task's current epoch. */
export type IssueTaskCredentialsResult =
  | { readonly ok: true; readonly credentials: TaskCredentials }
  | { readonly ok: false; readonly error: "not-found"; readonly message: string }
  | { readonly ok: false; readonly error: "stale-lease"; readonly message: string; readonly currentEpoch: LeaseEpoch }
  | { readonly ok: false; readonly error: "provider-not-allowed-on-personal-runners" | "token-mint-failed"; readonly message: string };

export type IssueTaskCredentialsDeps = Pick<Ports, "audit" | "clock" | "adapters"> & { readonly tx: Tx };

export type IssueTaskCredentials = (
  deps: IssueTaskCredentialsDeps,
  input: IssueTaskCredentialsInput,
) => Promise<IssueTaskCredentialsResult>;

export const issueTaskCredentials: IssueTaskCredentials = () => notImplemented("26");
