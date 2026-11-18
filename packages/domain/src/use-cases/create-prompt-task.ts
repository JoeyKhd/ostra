import type { Tx } from "@ostra/db";
import { projectIdSchema, runnerIdSchema } from "@ostra/protocol";
import type { SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-097: a member starts a code task in a project by typing a prompt. In one transaction: the task
// (queued), its first session (origin `new`), its task repos, the member as co-author, a change
// notice and a `task.dispatch` job. The branch name is `ostra/<first 8 of the task ID>-<slug of the
// title>` in every repo (spec section 11, item 10). Written by ticket 33.

export const createPromptTaskInputSchema = z.strictObject({
  projectId: projectIdSchema,
  /** The prompt: untrusted text, passed as data. Never logged. */
  prompt: z.string().trim().min(1).max(262_144),
  /** Defaults to the prompt's first line. */
  title: z.string().trim().min(1).max(512).optional(),
  /** The member's own personal runner, or unset to pick from the project's pools. */
  runnerId: runnerIdSchema.optional(),
});
export type CreatePromptTaskInput = z.infer<typeof createPromptTaskInputSchema>;

export type CreatePromptTaskResult = UseCaseResult<
  { readonly taskId: TaskId; readonly sessionId: SessionId; readonly branchName: string },
  | "not-found"
  | "forbidden"
  | "runner-not-yours"
  | "provider-not-allowed-on-personal-runners"
  | "no-agent-profile"
  | "no-repo"
>;

export type CreatePromptTaskDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type CreatePromptTask = (deps: CreatePromptTaskDeps, input: CreatePromptTaskInput) => Promise<CreatePromptTaskResult>;

export const createPromptTask: CreatePromptTask = () => notImplemented("33");
