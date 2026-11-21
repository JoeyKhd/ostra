import type { Tx } from "@ostra/db";
import { agentProfileIdSchema, messageFileIdSchema, projectIdSchema, runnerIdSchema, runnerLimits } from "@ostra/protocol";
import type { SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import { titleFromPrompt } from "../branch-name.ts";
import type { MemberScope } from "../access.ts";
import { uploadsOfInTx } from "../files/message-files.ts";
import type { MessageFilesDeps } from "../files/message-files.ts";
import type { Ports } from "../ports.ts";
import { startTask } from "../starts/start-task-body.ts";
import type { UseCaseResult } from "./common.ts";

export { BRANCH_ID_DIGITS, BRANCH_INDEX, branchNameFor, claimBranchNameInTx } from "./branch-claim.ts";

// F-097: a member starts a code task in a project by typing a prompt. In one transaction: the task
// (queued), its first session (origin `new`), its task repos, the member as co-author, a change
// notice and a `task.dispatch` job. The branch name is `ostra/<first 8 of the task ID>-<slug of the
// title>` in every repo (spec section 11, item 10). Written by ticket 33. Milestone 6's ticket 11
// moved the body onto the one start (`starts/start-task-body.ts`): this checks the member's access
// and hands it over.

export const createPromptTaskInputSchema = z.strictObject({
  projectId: projectIdSchema,
  /** The prompt: untrusted text, passed as data. Never logged. Milestone 9: may be empty when files come. */
  prompt: z.string().trim().max(262_144),
  /** Defaults to the prompt's first line. */
  title: z.string().trim().min(1).max(512).optional(),
  /** The member's own personal runner, or unset to pick from the project's pools. */
  runnerId: runnerIdSchema.optional(),
  /** Milestone 3 (F-021): the member's pick. Unset: the project's default for code tasks, else the built-in profile. */
  agentProfileId: agentProfileIdSchema.optional(),
  /** Defaults to `code`. Milestone 6 (F-099, ticket 34): `refine`, a draft of a new ticket ("Create ticket" applies it). */
  kind: z.enum(["code", "refine"]).optional(),
  /** Milestone 9 (F-148): the member's uploads sent with the prompt, in their order. */
  fileIds: z.array(messageFileIdSchema).max(runnerLimits.messageFilesMax).optional(),
});
export type CreatePromptTaskInput = z.infer<typeof createPromptTaskInputSchema>;

export type CreatePromptTaskResult = UseCaseResult<
  { readonly taskId: TaskId; readonly sessionId: SessionId; readonly branchName: string },
  | "not-found"
  | "forbidden"
  | "runner-not-yours"
  | "provider-not-allowed-on-personal-runners"
  /** Milestone 4 (F-135): no provider on the project's list serves the profile's model. */
  | "no-provider-for-model"
  | "no-agent-profile"
  | "no-repo"
  /** A repo's default branch requires signed commits (F-055, ticket 31). */
  | "repo-unsupported"
  /** Milestone 9: neither words nor files. */
  | "prompt-required"
  /** Milestone 9: a file that isn't one of the member's unsent uploads in the project. */
  | "file-not-found"
>;

export type CreatePromptTaskDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
  /** The branch naming; a test fakes it to force two tasks onto one name. */
  readonly branchNameFor?: (taskId: TaskId, title: string, digits: number) => string;
  /** Milestone 9 (F-148): the message files' limits and which agents take images. */
  readonly files?: MessageFilesDeps;
};

export type CreatePromptTask = (deps: CreatePromptTaskDeps, input: CreatePromptTaskInput) => Promise<CreatePromptTaskResult>;

const refuse = (error: Exclude<CreatePromptTaskResult, { readonly ok: true }>["error"], message: string): CreatePromptTaskResult => ({
  ok: false,
  error,
  message,
});

export const createPromptTask: CreatePromptTask = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return refuse("not-found", "No such project");
  }
  // Anyone who can open the project may start a task in it.
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? refuse("not-found", "No such project") : refuse("forbidden", "You may not start a task in this project");
  }
  // Milestone 9 (F-148/c1): files alone make a message; neither words nor files don't.
  const fileIds = input.fileIds ?? [];
  if (input.prompt === "" && fileIds.length === 0) {
    return refuse("prompt-required", "Say what the agent should do, or attach a file");
  }
  // The files are the member's own unsent uploads of the project, checked before anything is made.
  const uploads = await uploadsOfInTx(tx, scope, projectIdSchema.parse(project.id), fileIds);
  if (uploads === null) {
    return refuse("file-not-found", "One of the files isn't one of your unsent uploads in this project");
  }
  const title = input.title ?? (input.prompt === "" ? (uploads[0]?.name ?? "Files") : titleFromPrompt(input.prompt));
  // Milestone 6 (ticket 11): the one start every origin goes through.
  const started = await startTask(
    {
      tx,
      jobs: deps.jobs,
      notices: deps.notices,
      audit: deps.audit,
      clock: deps.clock,
      scope,
      ...(deps.branchNameFor === undefined ? {} : { branchNameFor: deps.branchNameFor }),
      ...(deps.files === undefined ? {} : { files: deps.files }),
    },
    {
      organizationId,
      projectId: projectIdSchema.parse(project.id),
      origin: { kind: "member", memberId: scope.memberId },
      kind: input.kind ?? "code",
      ticketId: null,
      prompt: input.prompt,
      title,
      agentProfileId: input.agentProfileId ?? null,
      poolLabels: [],
      runnerId: input.runnerId ?? null,
      fileIds,
    },
  );
  if (started.ok) {
    return { ok: true, taskId: started.taskId, sessionId: started.sessionId, branchName: started.branchName };
  }
  switch (started.error) {
    case "not-found":
    case "forbidden":
    case "runner-not-yours":
    case "provider-not-allowed-on-personal-runners":
    case "no-provider-for-model":
    case "no-agent-profile":
    case "no-repo":
    case "repo-unsupported":
      return refuse(started.error, started.message);
    // A prompt start names no ticket and has its prompt: neither comes back for it.
    case "invalid-input":
    case "no-default-profile":
    case "ticket-has-active-task":
    case "has-sub-issues":
      return refuse("not-found", started.message);
    default:
      return started satisfies never;
  }
};
