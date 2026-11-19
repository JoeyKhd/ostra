import { randomUUID } from "node:crypto";

import type { Tx } from "@ostra/db";
import { clientMessageIdSchema, leaseEpochSchema, projectIdSchema, runnerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { taskToColumns } from "../lifecycles/mapping.ts";
import { newTask } from "../lifecycles/task.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { slugify } from "./create-first-admin.ts";
import { appendServerEvent } from "./server-events.ts";

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

const refuse = (error: Exclude<CreatePromptTaskResult, { readonly ok: true }>["error"], message: string): CreatePromptTaskResult => ({
  ok: false,
  error,
  message,
});

/** The task's title when the member gave none: the prompt's first non-empty line, kept short. */
export const titleFromPrompt = (prompt: string): string => {
  const first = prompt.split(/\r?\n/).find((line) => line.trim() !== "") ?? prompt;
  const trimmed = first.trim().replace(/\s+/g, " ");
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117).trimEnd()}...`;
};

/**
 * The same branch name in every repo of the task (spec section 11, item 10). The ID part is the
 * last 8 hex digits: a UUIDv7 starts with its timestamp, so its first 8 are the same for every task
 * made within about a minute, and the same prompt twice would get the same branch.
 */
export const branchNameFor = (taskId: TaskId, title: string): string => {
  const slug = slugify(title, "task").slice(0, 40).replace(/-+$/g, "");
  return `ostra/${taskId.replaceAll("-", "").slice(-8)}-${slug === "" ? "task" : slug}`;
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

  const profile =
    project.defaultCodeProfileId === null
      ? null
      : await tx.agentProfile.findFirst({
          where: { id: project.defaultCodeProfileId, organizationId },
          include: { model: { include: { provider: { select: { allowOnPersonalRunners: true } } } } },
        });
  const noModel = "The project's default code profile has no model yet: an admin picks one under Models";
  if (profile === null) {
    return refuse("no-agent-profile", noModel);
  }
  const { model } = profile;
  if (model === null) {
    return refuse("no-agent-profile", noModel);
  }
  const repos = await tx.repo.findMany({ where: { projectId: project.id, organizationId }, orderBy: { createdAt: "asc" } });
  if (repos.length === 0) {
    return refuse("no-repo", "The project has no repo");
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
    if (!model.provider.allowOnPersonalRunners) {
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
      ...taskToColumns(lifecycle),
    },
    select: { id: true },
  });
  const taskId = taskIdSchema.parse(created.id);
  const branchName = branchNameFor(taskId, title);
  await tx.task.update({ where: { id: taskId }, data: { branchName } });
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
    data: { organizationId, projectId: project.id, taskId, agentProfileId: profile.id, origin: "new", state: "starting" },
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
