import { randomUUID } from "node:crypto";

import type { Tx } from "@ostra/db";
import {
  agentProfileIdSchema,
  clientMessageIdSchema,
  leaseEpochSchema,
  organizationIdSchema,
  projectIdSchema,
  sessionIdSchema,
  taskIdSchema,
  ticketKeySchema,
} from "@ostra/protocol";
import type { AgentProfileId, MemberId, OrganizationId, ProjectId, SessionId, TaskId, TaskKind } from "@ostra/protocol";

import type { MemberScope } from "../access.ts";
import { branchSlugFor, titleFromPrompt } from "../branch-name.ts";
import { taskToColumns } from "../lifecycles/mapping.ts";
import { newTask } from "../lifecycles/task.ts";
import { dispatchWaitColumns } from "../dispatch-wait.ts";
import { noProviderMessage, noProviderWait, raiseNoProviderInTx, resolveProfileModelInTx } from "../providers/session-model.ts";
import { modelNameOfColumns } from "../providers/model-name.ts";
import { writeTaskSearchEntries } from "../search/entries.ts";
import { writeTicketOutboxInTx } from "../tickets/ticket-outbox.ts";
import { openCachedChildrenInTx, writeParentProgressInTx } from "../tickets/parent-progress.ts";
import { branchNameFor, claimBranchNameInTx } from "../use-cases/branch-claim.ts";
import type { M6Deps, StartTask, StartTaskError, StartTaskInput, StartTaskResult } from "../use-cases/m6-signatures.ts";
import { createNeedsYouItemInTx } from "../use-cases/needs-you-items.ts";
import { signedCommitRefusal, unsupportedRepos } from "../use-cases/repo-checks.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { resolveStartProfileInTx } from "../use-cases/task-profile.ts";
import type { ResolveProfileResult, StartProfile } from "../use-cases/task-profile.ts";
import { noProviderStartFor, oneActiveTaskError, oneActiveTaskWords, startingMemberOf, startRuleFor, taskOriginOf } from "./start-task.ts";
import type { StartOrigin, StartRule } from "./start-task.ts";

// The one start (F-010, F-011, F-106, F-107, F-077; ADR 0056, milestone 6's ticket 11): every way a
// task starts goes through `startTask`, in the caller's transaction. A member's prompt start
// (`createPromptTask`), a member's ticket start (`startTicketTask`), an intake rule's match, a
// schedule's occurrence, a bulk start's item and a sub-issue's leaf all make the task here, so the
// one-active-task rule, the profile the origin allows, the pool labels and the queue (admission, a
// project's cap on a pool and the budget, all at the dispatch) apply to each alike. The task's text
// (a prompt, a ticket's) is data: never logged.

/** A ticket's active code task: anything not stopped, merged or done (the partial unique index's set). */
const TERMINAL_TASK_STATES = ["stopped", "merged", "done"] as const;

const refuse = (error: Exclude<StartTaskError, "ticket-has-active-task">, message: string): StartTaskResult => ({ ok: false, error, message });

/** The project's default profile column for a task kind. */
const projectDefaultFor = (
  project: { readonly defaultRefineProfileId: string | null; readonly defaultCodeProfileId: string | null; readonly defaultReviewProfileId: string | null },
  kind: TaskKind,
): string | null => {
  switch (kind) {
    case "refine":
      return project.defaultRefineProfileId;
    case "code":
      return project.defaultCodeProfileId;
    case "review":
      return project.defaultReviewProfileId;
    default:
      return kind satisfies never;
  }
};

const profileInclude = { model: { include: { provider: { select: { allowOnPersonalRunners: true } } } } } as const;

const NO_MODEL = "The task's agent profile has no model yet: an admin picks one under Models";

const withModel = (profile: StartProfile): ResolveProfileResult =>
  profile.model === null && modelNameOfColumns(profile) === null
    ? { ok: false, error: "no-agent-profile", message: NO_MODEL }
    : { ok: true, profile, profileId: agentProfileIdSchema.parse(profile.id) };

/**
 * The profile a start without a member runs (an automation's, an outside task's): the one the
 * origin names while it isn't archived, else the project's default for the kind, else the
 * organization's built-in profile. A project admin chose the automation's profile when saving it
 * (ticket 24 checks it then); an outside task always takes the project's default (ADR 0057).
 */
export const resolveOriginProfileInTx = async (
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly project: { readonly defaultRefineProfileId: string | null; readonly defaultCodeProfileId: string | null; readonly defaultReviewProfileId: string | null };
    readonly kind: TaskKind;
    readonly chosen: AgentProfileId | null;
  },
): Promise<ResolveProfileResult> => {
  const find = (id: string) => tx.agentProfile.findFirst({ where: { id, organizationId: input.organizationId, archivedAt: null }, include: profileInclude });
  if (input.chosen !== null) {
    const chosen = await find(input.chosen);
    if (chosen !== null) {
      return withModel(chosen);
    }
  }
  const defaultId = projectDefaultFor(input.project, input.kind);
  if (defaultId !== null) {
    const fallback = await find(defaultId);
    if (fallback !== null) {
      return withModel(fallback);
    }
  }
  const builtIn = await tx.agentProfile.findFirst({
    where: { organizationId: input.organizationId, builtIn: true, archivedAt: null },
    include: profileInclude,
    orderBy: { createdAt: "asc" },
  });
  return builtIn === null ? { ok: false, error: "no-agent-profile", message: NO_MODEL } : withModel(builtIn);
};

/** A ticket task's branch: the ticket's key, the last digits of the task's ID, the title's slug (spec section 11, item 5). */
const ticketBranchWith = (key: string) => (taskId: TaskId, title: string, digits: number) =>
  `ostra/${key.toLowerCase()}-${taskId.replaceAll("-", "").slice(-digits)}-${branchSlugFor(title)}`;

/** The origin's columns on the task row (spec section 5.3). */
const originColumns = (origin: StartOrigin) => {
  switch (origin.kind) {
    case "intake-rule":
    case "occurrence":
    case "webhook":
      return { automationId: origin.automationId };
    case "bulk-item":
      return { bulkStartId: origin.bulkStartId, automationId: origin.automationId };
    case "sub-issue":
      return { parentTicketId: origin.parentTicketId };
    case "linear":
      return { trackerActorId: origin.matchedMemberId === null ? origin.actor.externalId : null, trackerActorName: origin.matchedMemberId === null ? origin.actor.name.slice(0, 256) : null };
    case "member":
      return {};
    case "onboarding":
      return { onboarding: true };
    default:
      return origin satisfies never;
  }
};

/** The audit entry's actor: the member a start is on behalf of, else ostra itself. */
const actorOf = (member: MemberId | null) => (member === null ? { kind: "system" as const, id: null } : { kind: "member" as const, id: member });

/** The automation that started a task and the occurrence's time, for the `automation.started` event. */
const automationOf = (origin: StartOrigin): { readonly automationId: NonNullable<ReturnType<typeof originColumns>["automationId"]>; readonly occurrenceAt: number | null } | null => {
  switch (origin.kind) {
    case "intake-rule":
    case "webhook":
      return { automationId: origin.automationId, occurrenceAt: null };
    case "occurrence":
      return { automationId: origin.automationId, occurrenceAt: origin.occurrenceAt };
    case "bulk-item":
      return origin.automationId === null ? null : { automationId: origin.automationId, occurrenceAt: null };
    case "member":
    case "sub-issue":
    case "linear":
    case "onboarding":
      return null;
    default:
      return origin satisfies never;
  }
};

/** The work a queued task's start owes: what `startTask` sends, and what an approval sends later. */
export type StartWork = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly title: string;
  /** A ticket task's ticket and board; `null` for a prompt task. */
  readonly ticket: { readonly ticketId: string; readonly boardId: string; readonly connectionId: string } | null;
};

/**
 * The work a task that may run now owes, in the caller's transaction: a ticket task's "started"
 * writes (the move, one comment with the task's link, the link attachment) and its
 * `ticket.fetch-context`, which renders the prompt and dispatches; a prompt task's first
 * `task.dispatch`. A task that waits for approval owes none of it until it's approved (ticket 14
 * calls this then).
 */
export const enqueueStartWorkInTx = async (deps: { readonly tx: Tx; readonly publicUrl?: string } & Pick<StartTaskDepsPorts, "jobs">, work: StartWork): Promise<void> => {
  const { tx } = deps;
  if (work.ticket === null) {
    // The first dispatch grants epoch 1 (ADR 0034): the job's key names it, so sending it twice is one job.
    await deps.jobs.enqueueInTx(tx, "task.dispatch", { organizationId: work.organizationId, taskId: work.taskId, sessionId: work.sessionId, leaseEpoch: leaseEpochSchema.parse(1) });
    return;
  }
  const at = { organizationId: work.organizationId, projectId: work.projectId, taskId: work.taskId, ...work.ticket };
  const taskUrl = `${(deps.publicUrl ?? "").replace(/\/+$/, "")}/tasks/${work.taskId}`;
  // Milestone 6 (F-099): a refine task writes nothing to its ticket until a member acts on its draft.
  const kind = (await tx.task.findUnique({ where: { id: work.taskId }, select: { kind: true } }))?.kind;
  if (kind !== "refine") {
    await writeTicketOutboxInTx(deps, at, { kind: "move", target: "started" }, { kind: "move", target: "started" });
    await writeTicketOutboxInTx(deps, at, { kind: "comment" }, { kind: "comment", markdown: `ostra is working on this: ${taskUrl}` });
    await writeTicketOutboxInTx(deps, at, { kind: "link_task" }, { kind: "link_task", url: taskUrl, title: `ostra task: ${work.title}`.slice(0, 256), subtitle: null });
    // A sub-issue's start shows on its parent's comment (F-077).
    await writeParentProgressInTx({ tx, jobs: deps.jobs }, { taskId: work.taskId, revision: "started" });
  }
  // The prompt is rendered from the ticket's full context, which the job reads: it then dispatches.
  await deps.jobs.enqueueInTx(tx, "ticket.fetch-context", { organizationId: work.organizationId, taskId: work.taskId, sessionId: work.sessionId });
};

type StartTaskDepsPorts = Parameters<StartTask>[0];

/** What milestone 6's start use cases read beyond a transaction: the database and four ports, not the adapters. */
export type StartPorts = Pick<M6Deps, "db" | "jobs" | "notices" | "audit" | "clock">;

/** The longest title a task keeps. */
const TITLE_MAX = 512;

export const startTask: StartTask = async (deps, input: StartTaskInput) => {
  const { tx } = deps;
  const organizationId = input.organizationId;
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId } });
  if (project === null) {
    return refuse("not-found", "No such project");
  }
  const projectId = projectIdSchema.parse(project.id);
  const rule: StartRule = startRuleFor(input.origin, { outsideApproval: project.outsideApproval });
  const member = startingMemberOf(input.origin);
  // A member's own start checks the profile against what they may use (ADR 0049).
  const scope: MemberScope | null = deps.scope !== undefined && member !== null && deps.scope.memberId === member ? deps.scope : null;

  // The ticket row is locked for this transaction: two starts of the same ticket at once queue up
  // here, and the second finds the first one's task (the partial unique index is the backstop).
  let ticket: { readonly id: string; readonly key: string; readonly title: string; readonly boardId: string; readonly connectionId: string } | null = null;
  if (input.ticketId !== null) {
    const locked: unknown = await tx.$queryRaw`
      SELECT "id" FROM "ticket" WHERE "id" = ${input.ticketId} AND "projectId" = ${project.id} AND "organizationId" = ${organizationId} FOR UPDATE`;
    if (!Array.isArray(locked) || locked.length === 0) {
      return refuse("not-found", "No such ticket in this project");
    }
    const row = await tx.ticket.findUniqueOrThrow({ where: { id: input.ticketId } });
    const board = await tx.board.findFirst({ where: { id: row.boardId, projectId: project.id, organizationId }, include: { connection: { select: { state: true } } } });
    if (row.removedAt !== null || board?.detachedAt !== null || board.connection.state === "revoked") {
      return refuse("not-found", "That ticket's board is detached, or the ticket left it: no new task starts from it");
    }
    if (input.kind === "code") {
      // F-077: the parent of open sub-issues never runs code; its leaves start instead
      // (`startSubIssues`). A refine start refines the parent itself.
      const children = await openCachedChildrenInTx(tx, row);
      if (children > 0) {
        return refuse("has-sub-issues", `${row.key} has ${String(children)} open sub-issues: start them instead`);
      }
      const existing = await tx.task.findFirst({
        where: { projectId: project.id, organizationId, ticketId: row.id, kind: "code", state: { notIn: [...TERMINAL_TASK_STATES] } },
        select: { id: true },
      });
      if (existing !== null) {
        const error = oneActiveTaskError(ticketKeySchema.parse(row.key), taskIdSchema.parse(existing.id));
        return { ok: false, error: error.code, message: oneActiveTaskWords(error), taskId: error.taskId };
      }
    }
    ticket = { id: row.id, key: row.key, title: row.title, boardId: board.id, connectionId: board.connectionId };
  } else if (input.prompt === null || input.prompt.trim() === "") {
    return refuse("invalid-input", "A task starts from a ticket or a prompt");
  }

  // F-021: the member's pick, else the project's default for the kind, else the built-in profile.
  // An outside task always runs the project's default (ADR 0057); an automation its own profile.
  const chosen = rule.profile === "requested" ? input.agentProfileId : null;
  const resolved =
    scope !== null
      ? await resolveStartProfileInTx(tx, scope, { project, kind: input.kind, chosen: chosen ?? undefined })
      : await resolveOriginProfileInTx(tx, { organizationId, project, kind: input.kind, chosen });
  if (!resolved.ok) {
    return refuse(resolved.error, resolved.message);
  }
  const { profile } = resolved;
  // Milestone 4 (F-135, ADR 0065): the provider the project's list serves the profile's model from,
  // checked before anything is made. The session records it; nothing falls back to another key.
  const served = await resolveProfileModelInTx(tx, { organizationId, projectId, profileId: profile.id });
  if (!served.ok && served.modelName === null) {
    return refuse("no-agent-profile", NO_MODEL);
  }
  // No provider serves it: a start someone pressed is refused with the reason; an automation's is
  // made and waits queued with it (`noProviderStartFor`), its session recording no provider yet.
  const unserved = served.ok || served.modelName === null ? null : { modelName: served.modelName, provider: served.provider };
  if (unserved !== null && noProviderStartFor(input.origin) === "refuse") {
    return refuse("no-provider-for-model", noProviderMessage(unserved.modelName, unserved.provider));
  }
  const row = served.ok ? served : null;
  const repos = await tx.repo.findMany({ where: { projectId: project.id, organizationId }, orderBy: { createdAt: "asc" } });
  if (repos.length === 0) {
    return refuse("no-repo", "The project has no repo");
  }
  // F-055: ostra's commits aren't signed, so a repo that requires signed commits can't take a task.
  // The router refreshed the stored check just before this transaction; `unknown` never refuses.
  const unsupported = await unsupportedRepos(tx, organizationId, projectId);
  if (unsupported.length > 0) {
    return refuse("repo-unsupported", signedCommitRefusal(unsupported));
  }
  // "Run on": the member's own personal runner, or the project's pools (unset). Never for a pool-only task.
  const runnerId = input.runnerId ?? null;
  if (runnerId !== null) {
    if (member === null || rule.poolOnly) {
      return refuse("runner-not-yours", "That isn't one of your personal runners");
    }
    const runner = await tx.runner.findFirst({
      where: { id: runnerId, organizationId, kind: "personal", ownerMemberId: member, state: { not: "revoked" } },
      select: { id: true },
    });
    if (runner === null) {
      return refuse("runner-not-yours", "That isn't one of your personal runners");
    }
    // A personal runner isn't isolated: a provider's token reaches it only when an admin allows it (Q47).
    if (row?.allowOnPersonalRunners !== true) {
      return refuse(
        "provider-not-allowed-on-personal-runners",
        "The project's model provider isn't allowed on personal runners: an admin turns it on under Models",
      );
    }
  }

  const prompt = ticket === null ? input.prompt : null;
  const given = input.title === null ? "" : input.title.trim().slice(0, TITLE_MAX);
  const title =
    given !== ""
      ? given
      : ticket === null
        ? titleFromPrompt(input.prompt ?? "")
        : ticket.title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || ticket.key;
  const lifecycle = newTask(input.kind, rule.needsApproval);
  // The row first, for its ID (the database makes it): the branch name uses it, so it's set at once.
  const created = await tx.task.create({
    data: {
      organizationId,
      projectId: project.id,
      source: ticket === null ? "prompt" : "ticket",
      title,
      prompt,
      branchName: "pending",
      ...(ticket === null ? {} : { ticketId: ticket.id, ticketKey: ticket.key, boardId: ticket.boardId }),
      driverMemberId: member,
      creatorMemberId: member,
      runnerId,
      agentProfileId: profile.id,
      // F-137 (ADR 0066): the profile's level, copied once; a later edit of the profile changes new tasks only.
      effort: profile.effort,
      // Milestone 6: where it came from, and the labels its runner needs besides its profile's.
      origin: taskOriginOf(input.origin),
      poolOnly: rule.poolOnly,
      requiredLabels: [...new Set(input.poolLabels)].sort(),
      ...originColumns(input.origin),
      ...taskToColumns(lifecycle),
    },
    select: { id: true },
  });
  const taskId = taskIdSchema.parse(created.id);
  // Search (ticket 11): the task is found by its title and prompt, or its ticket's key and title, at once.
  await writeTaskSearchEntries(tx, {
    organizationId,
    projectId,
    taskId,
    title,
    prompt,
    ticket: ticket === null ? null : { key: ticket.key, title: ticket.title },
    creatorMemberId: member,
  });
  const branchName = await claimBranchNameInTx(tx, { id: taskId, title }, ticket === null ? (deps.branchNameFor ?? branchNameFor) : ticketBranchWith(ticket.key));
  await tx.taskRepo.createMany({
    data: repos.map((repo) => ({ organizationId, projectId: project.id, taskId, repoId: repo.id, branchName, baseBranch: repo.defaultBranch })),
  });
  // The member is the task's co-author: the commit trailer carries their ostra name and email
  // until the verified GitHub link (F-119, milestone 3) replaces it. An automation's task has none.
  if (member !== null) {
    const account = await tx.member.findFirstOrThrow({ where: { id: member, organizationId }, select: { user: { select: { name: true, email: true } } } });
    await tx.taskCoAuthor.create({ data: { organizationId, projectId: project.id, taskId, memberId: member, name: account.user.name, email: account.user.email } });
  }
  const session = await tx.session.create({
    // With no provider serving the model, none yet: the dispatch resolves and records it once one does.
    data: { organizationId, projectId: project.id, taskId, agentProfileId: profile.id, origin: "new", state: "starting", providerId: row?.providerId ?? null, modelId: row?.modelId ?? null },
    select: { id: true },
  });
  const sessionId = sessionIdSchema.parse(session.id);
  const now = deps.clock.now();
  // A prompt task's first message is its prompt; a ticket task's is written by `ticket.fetch-context`.
  if (prompt !== null && member !== null) {
    await appendServerEvent(tx, {
      organizationId,
      projectId,
      taskId,
      sessionId,
      at: now,
      event: { kind: "user.message", memberId: member, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: prompt, delivery: "immediate" },
    });
  }
  const automation = automationOf(input.origin);
  if (automation !== null) {
    // The thread says which automation started it (F-011, F-106): IDs and the time only.
    await appendServerEvent(tx, { organizationId, projectId, taskId, sessionId, at: now, event: { kind: "automation.started", ...automation } });
  }

  const work: StartWork = {
    organizationId,
    projectId,
    taskId,
    sessionId,
    title,
    ticket: ticket === null ? null : { ticketId: ticket.id, boardId: ticket.boardId, connectionId: ticket.connectionId },
  };
  if (unserved !== null) {
    // F-135: an automation's task that no provider serves waits queued with the reason, as the
    // dispatch leaves one whose provider went away, and the organization's admins, who alone edit
    // the lists, get its needs-you item. Its dispatch keeps it waiting until a provider serves it.
    if (!rule.needsApproval) {
      await tx.task.update({ where: { id: taskId }, data: dispatchWaitColumns(noProviderWait(unserved.modelName, unserved.provider)) });
    }
    await raiseNoProviderInTx(deps, tx, { organizationId, projectId, id: taskId }, unserved.modelName);
  }
  if (rule.needsApproval) {
    // F-040 and a rule's "wait for approval": the project's members approve it (ticket 14's path),
    // and its start's work is sent then.
    await createNeedsYouItemInTx(deps, tx, { organizationId, projectId, taskId, reason: "awaiting_approval", audience: "project_members" });
  } else {
    await enqueueStartWorkInTx(deps, work);
  }
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: actorOf(member),
    action: "task.created",
    entity: "task",
    entityId: taskId,
    data: {
      kind: input.kind,
      source: ticket === null ? "prompt" : "ticket",
      onPersonalRunner: runnerId !== null,
      // Milestone 6: the origin's kind, never its text.
      ...(input.origin.kind === "member" ? {} : { origin: input.origin.kind, awaitingApproval: rule.needsApproval }),
    },
  });
  await deps.notices.emitInTx(tx, { organizationId: organizationIdSchema.parse(organizationId), projectId, entity: "task", entityId: taskId });
  return { ok: true, taskId, sessionId, branchName, rule };
};
