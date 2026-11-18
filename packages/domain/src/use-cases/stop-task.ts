import type { Tx } from "@ostra/db";
import { taskIdSchema } from "@ostra/protocol";
import type { CommandId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-025: a member stops a task. In the panel's transaction: the task moves to stopped, a `stop`
// command goes to the outbox for the runner holding its lease (the panel never calls core, ADR
// 0016), and a change notice. The runner ends the agent, and pushes the branch and the hidden ref,
// which keep the unfinished work on GitHub. Written by ticket 27 (the router is ticket 33's).

export const stopTaskInputSchema = z.strictObject({ taskId: taskIdSchema });
export type StopTaskInput = z.infer<typeof stopTaskInputSchema>;

export type StopTaskResult = UseCaseResult<
  { readonly commandId: CommandId | null },
  "not-found" | "forbidden" | "already-stopped"
>;

export type StopTaskDeps = Pick<Ports, "outbox" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type StopTask = (deps: StopTaskDeps, input: StopTaskInput) => Promise<StopTaskResult>;

export const stopTask: StopTask = () => notImplemented("27");
