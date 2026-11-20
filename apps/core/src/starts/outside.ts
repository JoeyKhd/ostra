import type { Tx } from "@ostra/db";
import {
  BUILT_IN_PROFILE_ADAPTER,
  claimBranchNameInTx,
  createNeedsYouItemInTx,
  foldAddress,
  matchTrackerUser,
  newTask,
  noProviderMessage,
  releaseQueuedTaskInTx,
  requireProjectAccess,
  resolveProfileModelInTx,
  signedCommitRefusal,
  startRuleFor,
  startTicketTask,
  taskToColumns,
  unsupportedRepos,
  writeTaskSearchEntries,
  appendServerEvent,
  branchSlugFor,
} from "@ostra/domain";
import type { MatchableMember, MemberScope, Ports, ProjectRole, StartRule, TrackerUser, TrackerUserMatch } from "@ostra/domain";
import { memberIdSchema, projectIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { AgentSessionId, MemberId, OrganizationId, ProjectId, SessionId, TaskId, TicketId } from "@ostra/protocol";

// A task a tracker user started (F-040, F-012; ADR 0057, milestone 6's ticket 14). Linear's agent
// mode calls this for each delegation: the Linear user is matched to a member by their address
// (`matchTrackerUser`). A match starts the task as that member's, on the project's default code
// profile, as their own start would. Anyone else starts an outside task: no member drives it, it
// runs on the project's default profile for its kind, whatever was asked, only on the project's
// pools (`poolOnly`), and, while the project's switch is on, it waits `awaiting_approval` with a
// needs-you item for the project's members until one approves it. Nothing in the path waits for a
// runner. Every write is in the caller's transaction.

/** What started it in the tracker: the user's ID and the name the tracker gave, kept for display. */
export type TrackerActor = { readonly externalId: string; readonly name: string };

export type TrackerStartInput = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly ticketId: TicketId;
  readonly actor: TrackerActor;
  /** The member the actor matched (`matchStarterInTx`), or `null` for someone outside. */
  readonly matchedMemberId: MemberId | null;
  /** The agent session the delegation made: the start's origin. */
  readonly agentSessionId: AgentSessionId;
};

export type TrackerStartResult =
  | {
      readonly ok: true;
      readonly taskId: TaskId;
      readonly sessionId: SessionId;
      readonly rule: StartRule;
      /** It waits for a member's approval. */
      readonly awaitingApproval: boolean;
    }
  /** The ticket already has an active code task: the one there is (a delegation of a busy ticket is a follow-up to it). */
  | { readonly ok: false; readonly error: "ticket-has-task"; readonly message: string; readonly taskId: TaskId }
  | {
      readonly ok: false;
      /** `has-sub-issues` (F-077, ticket 12): a parent ticket, whose leaves start instead; the parent never runs code. */
      readonly error: "not-found" | "no-agent-profile" | "no-repo" | "no-provider-for-model" | "repo-unsupported" | "forbidden" | "has-sub-issues";
      readonly message: string;
    };

export type TrackerStartDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  /** The panel's address, for the task's link on the ticket. */
  readonly publicUrl: string;
};

const TERMINAL_TASK_STATES = ["stopped", "merged", "done"] as const;

/** A member's scope, as their own request would carry it: their role and their project roles. `null` for one who isn't active. */
export const memberScopeInTx = async (tx: Tx, organizationId: OrganizationId, memberId: MemberId): Promise<MemberScope | null> => {
  const member = await tx.member.findFirst({ where: { id: memberId, organizationId, state: "active" }, select: { role: true } });
  if (member === null) {
    return null;
  }
  const listed = await tx.projectMember.findMany({ where: { memberId, organizationId }, select: { projectId: true, role: true } });
  const projectRoles = new Map<ProjectId, ProjectRole>(listed.map((row) => [projectIdSchema.parse(row.projectId), row.role] as const));
  const admin = member.role
    .split(",")
    .map((part) => part.trim())
    .includes("admin");
  return { organizationId, memberId, role: admin ? "admin" : "member", projectRoles };
};

/**
 * Matches a tracker user to a member for a project (ADR 0057): their address against the active
 * members' account addresses, folded, and the member's access to the project. Read for each event,
 * never kept as a link.
 */
export const matchStarterInTx = async (tx: Tx, organizationId: OrganizationId, projectId: ProjectId, user: TrackerUser): Promise<TrackerUserMatch> => {
  if (user.email === null || foldAddress(user.email) === "") {
    return { kind: "outside", reason: "no-address" };
  }
  const project = await tx.project.findFirst({ where: { id: projectId, organizationId }, select: { id: true, access: true } });
  const members = await tx.member.findMany({
    where: { organizationId },
    select: { id: true, state: true, user: { select: { email: true } } },
  });
  const candidates: MatchableMember[] = [];
  for (const member of members) {
    // Only those whose address could match are scoped: the folded compare is the rule's own.
    if (foldAddress(member.user.email) !== foldAddress(user.email)) {
      continue;
    }
    const memberId = memberIdSchema.parse(member.id);
    const scope = member.state === "active" ? await memberScopeInTx(tx, organizationId, memberId) : null;
    candidates.push({
      memberId,
      email: member.user.email,
      active: member.state === "active",
      canOpenProject:
        scope !== null && project !== null && requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read").ok,
    });
  }
  return matchTrackerUser(user, candidates);
};

/** A ticket task's branch: the ticket's key, the last digits of the task's ID, the title's slug (milestone 2). */
const ticketBranchWith = (key: string) => (taskId: TaskId, title: string, digits: number) =>
  `ostra/${key.toLowerCase()}-${taskId.replaceAll("-", "").slice(-digits)}-${branchSlugFor(title)}`;

/** The profile an outside task runs: the project's default for code, else the built-in one. Never the starter's pick. */
const outsideProfileInTx = async (tx: Tx, organizationId: OrganizationId, defaultCodeProfileId: string | null) => {
  if (defaultCodeProfileId !== null) {
    const chosen = await tx.agentProfile.findFirst({ where: { id: defaultCodeProfileId, organizationId, archivedAt: null }, select: { id: true, effort: true } });
    if (chosen !== null) {
      return chosen;
    }
  }
  return tx.agentProfile.findFirst({
    where: { organizationId, builtIn: true, adapter: BUILT_IN_PROFILE_ADAPTER },
    orderBy: { createdAt: "asc" },
    select: { id: true, effort: true },
  });
};

/** Records who in the tracker started it, on the task: for display, never a link to a member. */
const markTrackerOrigin = async (tx: Tx, taskId: TaskId, actor: TrackerActor): Promise<void> => {
  await tx.task.update({
    where: { id: taskId },
    data: { origin: "tracker", trackerActorId: actor.externalId.slice(0, 256), trackerActorName: actor.name.replace(/\s+/g, " ").trim().slice(0, 256) },
  });
};

/** A matched member's start: theirs, on the project's default code profile, as `startTicketTask` makes it. */
const startAsMember = async (deps: TrackerStartDeps, input: TrackerStartInput, memberId: MemberId): Promise<TrackerStartResult | null> => {
  const scope = await memberScopeInTx(deps.tx, input.organizationId, memberId);
  if (scope === null) {
    return null;
  }
  const started = await startTicketTask({ ...deps, scope }, { projectId: input.projectId, ticketId: input.ticketId, kind: "code" });
  if (!started.ok) {
    if (started.error === "ticket-has-task") {
      return started;
    }
    if (started.error === "runner-not-yours" || started.error === "provider-not-allowed-on-personal-runners") {
      return { ok: false, error: "forbidden", message: started.message };
    }
    return { ok: false, error: started.error, message: started.message };
  }
  await markTrackerOrigin(deps.tx, started.taskId, input.actor);
  const rule = startRuleFor({ kind: "linear", agentSessionId: input.agentSessionId, actor: input.actor, matchedMemberId: memberId }, { outsideApproval: true });
  return { ok: true, taskId: started.taskId, sessionId: started.sessionId, rule, awaitingApproval: false };
};

/**
 * Starts the task a tracker user asked for (agent mode's delegation), in the caller's transaction.
 * A matched member's start is theirs; anyone else's is an outside task (above).
 */
export const startFromTrackerInTx = async (deps: TrackerStartDeps, input: TrackerStartInput): Promise<TrackerStartResult> => {
  if (input.matchedMemberId !== null) {
    const asMember = await startAsMember(deps, input, input.matchedMemberId);
    if (asMember !== null) {
      return asMember;
    }
    // The member left between the match and the start: they're outside now.
  }
  return startOutsideInTx(deps, input);
};

const startOutsideInTx = async (deps: TrackerStartDeps, input: TrackerStartInput): Promise<TrackerStartResult> => {
  const { tx } = deps;
  const organizationId = input.organizationId;
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such project" };
  }
  const projectId = projectIdSchema.parse(project.id);
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT "id" FROM "ticket" WHERE "id" = ${input.ticketId} AND "projectId" = ${project.id} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: "not-found", message: "No such ticket in this project" };
  }
  const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: input.ticketId } });
  const board = await tx.board.findFirst({ where: { id: ticket.boardId, projectId: project.id, organizationId }, include: { connection: { select: { state: true } } } });
  if (ticket.removedAt !== null || board?.detachedAt !== null || board.connection.state === "revoked") {
    return { ok: false, error: "not-found", message: "That ticket's board is detached, or the ticket left it: no new task starts from it" };
  }
  const existing = await tx.task.findFirst({
    where: { projectId: project.id, organizationId, ticketId: ticket.id, kind: "code", state: { notIn: [...TERMINAL_TASK_STATES] } },
    select: { id: true },
  });
  if (existing !== null) {
    const taskId = taskIdSchema.parse(existing.id);
    return { ok: false, error: "ticket-has-task", message: `This ticket already has an active task, ${taskId}.`, taskId };
  }

  const rule = startRuleFor({ kind: "linear", agentSessionId: input.agentSessionId, actor: input.actor, matchedMemberId: null }, project);
  const profile = await outsideProfileInTx(tx, organizationId, project.defaultCodeProfileId);
  if (profile === null) {
    return { ok: false, error: "no-agent-profile", message: "The project has no agent profile for code tasks" };
  }
  const served = await resolveProfileModelInTx(tx, { organizationId, projectId, profileId: profile.id });
  if (!served.ok) {
    return served.modelName === null
      ? { ok: false, error: "no-agent-profile", message: "The task's agent profile has no model yet: an admin picks one under Models" }
      : { ok: false, error: "no-provider-for-model", message: noProviderMessage(served.modelName, served.provider) };
  }
  const repos = await tx.repo.findMany({ where: { projectId: project.id, organizationId }, orderBy: { createdAt: "asc" } });
  if (repos.length === 0) {
    return { ok: false, error: "no-repo", message: "The project has no repo" };
  }
  const unsupported = await unsupportedRepos(tx, organizationId, projectId);
  if (unsupported.length > 0) {
    return { ok: false, error: "repo-unsupported", message: signedCommitRefusal(unsupported) };
  }

  const title = ticket.title.replace(/\s+/g, " ").trim().slice(0, 512) || ticket.key;
  const created = await tx.task.create({
    data: {
      organizationId,
      projectId: project.id,
      source: "ticket",
      title,
      branchName: "pending",
      ticketId: ticket.id,
      ticketKey: ticket.key,
      boardId: board.id,
      // No member drives it, and none created it: its moments go to the project's members.
      driverMemberId: null,
      creatorMemberId: null,
      runnerId: null,
      agentProfileId: profile.id,
      effort: profile.effort,
      origin: "tracker",
      trackerActorId: input.actor.externalId.slice(0, 256),
      trackerActorName: input.actor.name.replace(/\s+/g, " ").trim().slice(0, 256),
      poolOnly: rule.poolOnly,
      ...taskToColumns(newTask("code", rule.needsApproval)),
    },
    select: { id: true, leaseEpoch: true },
  });
  const taskId = taskIdSchema.parse(created.id);
  await writeTaskSearchEntries(tx, { organizationId, projectId, taskId, title, prompt: null, ticket: { key: ticket.key, title: ticket.title }, creatorMemberId: null });
  const branchName = await claimBranchNameInTx(tx, { id: taskId, title }, ticketBranchWith(ticket.key));
  await tx.taskRepo.createMany({
    data: repos.map((repo) => ({ organizationId, projectId: project.id, taskId, repoId: repo.id, branchName, baseBranch: repo.defaultBranch })),
  });
  const session = await tx.session.create({
    data: { organizationId, projectId: project.id, taskId, agentProfileId: profile.id, origin: "new", state: "starting", providerId: served.providerId, modelId: served.modelId },
    select: { id: true },
  });
  const sessionId = sessionIdSchema.parse(session.id);
  const now = deps.clock.now();

  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "system", id: null },
    action: "task.created",
    entity: "task",
    entityId: taskId,
    data: { kind: "code", source: "ticket", origin: "tracker", outside: true, awaitingApproval: rule.needsApproval },
  });
  if (rule.needsApproval) {
    // Nothing runs until a member of the project answers: no prompt, no dispatch, no ticket writes.
    await appendServerEvent(tx, {
      organizationId,
      projectId,
      taskId,
      sessionId,
      at: now,
      event: { kind: "task.approval_requested", by: { kind: "tracker-user", name: input.actor.name.replace(/\s+/g, " ").trim().slice(0, 256) || "someone" } },
    });
    await createNeedsYouItemInTx(deps, tx, { organizationId, projectId, taskId, reason: "awaiting_approval", audience: "project_members" });
  } else {
    await releaseQueuedTaskInTx(
      deps,
      tx,
      { id: taskId, organizationId, projectId, title, ticketId: ticket.id, boardId: board.id, prompt: null, leaseEpoch: created.leaseEpoch },
      deps,
    );
  }
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
  return { ok: true, taskId, sessionId, rule, awaitingApproval: rule.needsApproval };
};
