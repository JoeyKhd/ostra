import type { Tx } from "@ostra/db";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { branchSlugFor } from "../branch-name.ts";

// A task's branch name, unique in its project (F-016, spec section 11, item 10; milestone 1's
// ticket 46). Moved here from `create-prompt-task.ts` with milestone 6's ticket 11, so the one start
// (`starts/start-task-body.ts`) and the prompt start can both use it; `create-prompt-task.ts`
// re-exports it.

/**
 * The same branch name in every repo of the task (spec section 11, item 10). The ID part is the
 * last 8 hex digits: a UUIDv7 starts with its timestamp, so its first 8 are the same for every task
 * made within about a minute, and the same prompt twice would get the same branch. `digits` is
 * longer only after a clash (`claimBranchNameInTx`).
 */
export const branchNameFor = (taskId: TaskId, title: string, digits = 8): string => {
  return `ostra/${taskId.replaceAll("-", "").slice(-digits)}-${branchSlugFor(title)}`;
};

/** The lengths of the ID part a create tries, in order, when a name is taken (ticket 46). */
export const BRANCH_ID_DIGITS = [8, 12, 16] as const;

/** The unique index that keeps two tasks of a project off one branch (F-016, Q136 item 10). */
export const BRANCH_INDEX = "task_project_branch_unique";

/** A refusal by `BRANCH_INDEX`, as Prisma and the pg driver carry it. The error is external data. */
const branchClashSchema = z.looseObject({
  meta: z.looseObject({
    driverAdapterError: z.looseObject({
      cause: z.looseObject({ originalCode: z.literal("23505"), originalMessage: z.string().includes(BRANCH_INDEX) }),
    }),
  }),
});

/**
 * Sets the task's branch name, unique in its project: the last 8 hex digits of its ID and the
 * title's slug, and on a clash with another task of the project 4 more digits (12, then 16), inside
 * the caller's transaction. Each try runs under a savepoint, so a clash doesn't abort the
 * transaction. `nameFor` is the naming, which a test fakes to force a clash.
 */
export const claimBranchNameInTx = async (
  tx: Tx,
  task: { readonly id: TaskId; readonly title: string },
  nameFor: (taskId: TaskId, title: string, digits: number) => string = branchNameFor,
): Promise<string> => {
  for (const digits of BRANCH_ID_DIGITS) {
    const name = nameFor(task.id, task.title, digits);
    await tx.$executeRaw`SAVEPOINT ostra_branch_name`;
    try {
      await tx.$executeRaw`UPDATE "task" SET "branchName" = ${name} WHERE "id" = ${task.id}`;
      await tx.$executeRaw`RELEASE SAVEPOINT ostra_branch_name`;
      return name;
    } catch (error) {
      if (!branchClashSchema.safeParse(error).success) {
        throw error;
      }
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT ostra_branch_name`;
    }
  }
  throw new Error(`the task's branch name clashed at ${String(BRANCH_ID_DIGITS.at(-1))} digits of its ID`);
};
