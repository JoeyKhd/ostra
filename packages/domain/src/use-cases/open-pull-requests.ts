import type { Db } from "@ostra/db";
import type { RepoId } from "@ostra/protocol";

import type { JobPayload } from "../jobs.ts";
import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-030, F-078, ADR 0040: the `task.open-pull-requests` job. One PR per changed repo, opened by the
// App: the title from the prompt, the body from the agent's `pr.text_set` (following the repo's PR
// template), with links to the task. Idempotent per task repo: `findPullRequest` first, and the
// idempotency key `task:<TaskId>:open-pr:<RepoId>`. Then a `pr.opened` event per PR, and the task
// moves to in review. Calls the code host, so it takes the client and opens its own transactions
// around each call. Written by ticket 27.

export type OpenPullRequestsInput = JobPayload<"task.open-pull-requests">;

export type OpenedPullRequest = { readonly repoId: RepoId; readonly number: number; readonly url: string; readonly reused: boolean };

export type OpenPullRequestsResult = UseCaseResult<
  { readonly opened: readonly OpenedPullRequest[] },
  "stale" | "not-found" | "code-host-failed"
>;

export type OpenPullRequestsDeps = Pick<Ports, "notices" | "audit" | "clock" | "adapters"> & { readonly db: Db };

export type OpenPullRequests = (deps: OpenPullRequestsDeps, input: OpenPullRequestsInput) => Promise<OpenPullRequestsResult>;

export const openPullRequests: OpenPullRequests = () => notImplemented("27");
