import { randomUUID } from "node:crypto";

import type { Tx } from "@ostra/db";
import { agentProfileIdSchema, clientMessageIdSchema, leaseEpochSchema, projectIdSchema, runnerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import { branchSlugFor, titleFromPrompt } from "../branch-name.ts";
import type { MemberScope } from "../access.ts";
import { taskToColumns } from "../lifecycles/mapping.ts";
import { newTask } from "../lifecycles/task.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { signedCommitRefusal, unsupportedRepos } from "./repo-checks.ts";
import { writeTaskSearchEntries } from "../search/entries.ts";
import { appendServerEvent } from "./server-events.ts";
import { resolveStartProfileInTx } from "./task-profile.ts";
import { noProviderMessage, resolveProfileModelInTx } from "../providers/session-model.ts";

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
  /** Milestone 3 (F-021): the member's pick. Unset: the project's default for code tasks, else the built-in profile. */
  agentProfileId: agentProfileIdSchema.optional(),
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
>;

export type CreatePromptTaskDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
  /** The branch naming; a test fakes it to force two tasks onto one name. */
  readonly branchNameFor?: (taskId: TaskId, title: string, digits: number) => string;
};

export type CreatePromptTask = (deps: CreatePromptTaskDeps, input: CreatePromptTaskInput) => Promise<CreatePromptTaskResult>;

const refuse = (error: Exclude<CreatePromptTaskResult, { readonly ok: true }>["error"], message: string): CreatePromptTaskResult => ({
  ok: false,
  error,
  message,
});

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

export const createPromptTask: CreatePromptTask = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId } });
  if (project === null) {
    return refuse("not-found", "No such project");
  }
  // Anyone who can open the project may start a task in it.
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? refuse("not-found", "No such project") : refuse("forbidden", "You may not start a task in this project");
  }

  // F-021: the member's pick, else the project's default for code tasks, else the built-in profile.
  const resolved = await resolveStartProfileInTx(tx, scope, { project, kind: "code", chosen: input.agentProfileId });
  if (!resolved.ok) {
    return refuse(resolved.error, resolved.message);
  }
  const { profile } = resolved;
  // Milestone 4 (F-135, ADR 0065): the provider the project's list serves the profile's model from,
  // checked before anything is made. The session records it; nothing falls back to another key.
  const served = await resolveProfileModelInTx(tx, { organizationId, projectId: projectIdSchema.parse(project.id), profileId: profile.id });
  if (!served.ok) {
    return served.modelName === null
      ? refuse("no-agent-profile", "The task's agent profile has no model yet: an admin picks one under Models")
      : refuse("no-provider-for-model", noProviderMessage(served.modelName, served.provider));
  }
  const repos = await tx.repo.findMany({ where: { projectId: project.id, organizationId }, orderBy: { createdAt: "asc" } });
  if (repos.length === 0) {
    return refuse("no-repo", "The project has no repo");
  }

  // F-055: ostra's commits aren't signed, so a repo that requires signed commits can't take a task.
  // The router refreshed the stored check just before this transaction; `unknown` never refuses.
  const unsupported = await unsupportedRepos(tx, organizationId, projectIdSchema.parse(project.id));
  if (unsupported.length > 0) {
    return refuse("repo-unsupported", signedCommitRefusal(unsupported));
  }

  // "Run on": the member's own personal runner, or the project's pools (unset).
  if (input.runnerId !== undefined) {
    const runner = await tx.runner.findFirst({
      where: { id: input.runnerId, organizationId, kind: "personal", ownerMemberId: scope.memberId, state: { not: "revoked" } },
      select: { id: true },
    });
    if (runner === null) {
      return refuse("runner-not-yours", "That isn't one of your personal runners");
    }
    // A personal runner isn't isolated: a provider's token reaches it only when an admin allows it (Q47).
    if (!served.allowOnPersonalRunners) {
      return refuse(
        "provider-not-allowed-on-personal-runners",
        "The project's model provider isn't allowed on personal runners: an admin turns it on under Models",
      );
    }
  }

  const title = input.title ?? titleFromPrompt(input.prompt);
  const lifecycle = newTask("code", false);
  // The row first, for its ID (the database makes it): the branch name uses it, so it's set at once.
  const created = await tx.task.create({
    data: {
      organizationId,
      projectId: project.id,
      source: "prompt",
      title,
      prompt: input.prompt,
      branchName: "pending",
      driverMemberId: scope.memberId,
      creatorMemberId: scope.memberId,
      runnerId: input.runnerId ?? null,
      agentProfileId: profile.id,
      // F-137 (ADR 0066): the profile's level, copied once; a later edit of the profile changes new tasks only.
      effort: profile.effort,
      ...taskToColumns(lifecycle),
    },
    select: { id: true },
  });
  const taskId = taskIdSchema.parse(created.id);
  // Search (ticket 11): the task is found by its title and prompt from the moment it exists.
  await writeTaskSearchEntries(tx, { organizationId, projectId: projectIdSchema.parse(project.id), taskId, title, prompt: input.prompt, ticket: null, creatorMemberId: scope.memberId });
  const branchName = await claimBranchNameInTx(tx, { id: taskId, title }, deps.branchNameFor);
  await tx.taskRepo.createMany({
    data: repos.map((repo) => ({
      organizationId,
      projectId: project.id,
      taskId,
      repoId: repo.id,
      branchName,
      baseBranch: repo.defaultBranch,
    })),
  });

  // The member is the task's co-author: the commit trailer carries their ostra name and email
  // until the verified GitHub link (F-119, milestone 3) replaces it.
  const member = await tx.member.findFirstOrThrow({ where: { id: scope.memberId, organizationId }, select: { user: { select: { name: true, email: true } } } });
  await tx.taskCoAuthor.create({
    data: { organizationId, projectId: project.id, taskId, memberId: scope.memberId, name: member.user.name, email: member.user.email },
  });

  const session = await tx.session.create({
    data: { organizationId, projectId: project.id, taskId, agentProfileId: profile.id, origin: "new", state: "starting", providerId: served.providerId, modelId: served.modelId },
    select: { id: true },
  });
  const sessionId = sessionIdSchema.parse(session.id);
  const now = deps.clock.now();
  await appendServerEvent(tx, {
    organizationId,
    projectId: projectIdSchema.parse(project.id),
    taskId,
    sessionId,
    at: now,
    event: {
      kind: "user.message",
      memberId: scope.memberId,
      clientMessageId: clientMessageIdSchema.parse(randomUUID()),
      text: input.prompt,
      delivery: "immediate",
    },
  });

  // The first dispatch grants epoch 1 (ADR 0034): the job's key names it, so sending it twice is one job.
  await deps.jobs.enqueueInTx(tx, "task.dispatch", { organizationId, taskId, sessionId, leaseEpoch: leaseEpochSchema.parse(1) });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: projectIdSchema.parse(project.id),
    actor: { kind: "member", id: scope.memberId },
    action: "task.created",
    entity: "task",
    entityId: taskId,
    data: { kind: "code", source: "prompt", onPersonalRunner: input.runnerId !== undefined },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: projectIdSchema.parse(project.id), entity: "task", entityId: taskId });
  return { ok: true, taskId, sessionId, branchName };
};
