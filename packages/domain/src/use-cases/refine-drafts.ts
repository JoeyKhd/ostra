import type { Tx } from "@ostra/db";
import { mapTask } from "@ostra/db";
import {
  agentProfileIdSchema,
  connectionIdSchema,
  draftIdSchema,
  projectIdSchema,
  refineDraftSchema,
  sessionIdSchema,
  taskIdSchema,
  ticketWriteIdSchema,
} from "@ostra/protocol";
import type {
  AgentProfileId,
  MemberId,
  OrganizationId,
  ProjectId,
  RefineDraft,
  TaskId,
} from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { parseBoardMapping } from "../tickets/board-mapping.ts";
import { ticketWriteKey } from "../tickets/contracts.ts";
import { BUILT_IN_PROFILE_ADAPTER, ensureBuiltInAgentProfile } from "./agent-profiles.ts";
import type { UseCaseResult } from "./common.ts";
import type {
  ApplyDraft,
  EditDraft,
  M6TxDeps,
  MarkTicketReady,
  SaveDraft,
  SeedBuiltInProfiles,
} from "./m6-signatures.ts";
import { moveTaskInTx } from "./moves.ts";
import { createNeedsYouItemInTx, resolveNeedsYouItemsInTx } from "./needs-you-items.ts";
import { appendServerEvent } from "./server-events.ts";

// Refine drafts (F-099, F-036, ADR 0028 amended; milestone 6's ticket 15). A refine task's agent
// hands in its draft of the ticket through the sidecar's `submit_draft` (`saveDraft`, one version
// each call); at the turn's end, a draft from that turn puts the task in front of its owner
// (`draft_ready`: the driver, else the project's members). A member edits it (`editDraft`, a new
// version), then "Update ticket" (`applyDraft`: the tracker writes go out through `draft.apply`,
// once per version) or "Mark ready" (`markTicketReady`: the board's `ready` status, through
// milestone 2's ticket outbox). Either moves the task to done. Nothing of a draft reaches the
// tracker before a member acts, and a draft's text never reaches a log line.

/** How many versions one refine task's drafts may have: the agent's and the members' (a working value). */
export const DRAFT_VERSIONS_MAX = 50;

/** The built-in profiles' names, as the panel shows them. */
export const BUILT_IN_REFINE_NAME = "Refine";
export const BUILT_IN_REVIEW_NAME = "Review";

const BUILT_IN_INSTRUCTIONS = {
  refine: "Read the ticket and the code, then hand in a draft of the ticket. Change no file.",
  review: "Read the pull requests against the ticket, then hand in your findings. Change no file.",
} as const;

// ---------- the built-in Refine and Review profiles ----------

/**
 * `profiles.seed-built-in`: the organization's built-in Refine and Review profiles, on the model of
 * its built-in OpenCode profile (the organization's default), and each project's default for those
 * kinds where it has none of its own (none set, or the generic built-in). Idempotent.
 */
export const seedBuiltInProfiles: SeedBuiltInProfiles = (deps, input) =>
  ensureBuiltInKindProfilesInTx(deps.tx, input.organizationId);

/** `seedBuiltInProfiles`'s body, for the first admin's seeding and a new organization's, in their transaction. */
export const ensureBuiltInKindProfilesInTx = async (
  tx: Tx,
  organizationId: OrganizationId,
): Promise<{
  readonly refine: AgentProfileId;
  readonly review: AgentProfileId;
  readonly created: number;
}> => {
  const openCodeId = await ensureBuiltInAgentProfile(tx, organizationId);
  const base = await tx.agentProfile.findUniqueOrThrow({
    where: { id: openCodeId },
    select: {
      modelId: true,
      modelCatalogId: true,
      modelCustomName: true,
      providerId: true,
      effort: true,
    },
  });
  let created = 0;
  const ensure = async (kind: "refine" | "review"): Promise<AgentProfileId> => {
    const existing = await tx.agentProfile.findFirst({
      where: { organizationId, builtInKind: kind },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing !== null) {
      // Seeded before the admin picked the default model: it takes the model now.
      await tx.agentProfile.updateMany({
        where: { id: existing.id, modelId: null, modelCatalogId: null, modelCustomName: null },
        data: {
          modelId: base.modelId,
          modelCatalogId: base.modelCatalogId,
          modelCustomName: base.modelCustomName,
          providerId: base.providerId,
        },
      });
      return agentProfileIdSchema.parse(existing.id);
    }
    const row = await tx.agentProfile.create({
      data: {
        organizationId,
        name: kind === "refine" ? BUILT_IN_REFINE_NAME : BUILT_IN_REVIEW_NAME,
        adapter: BUILT_IN_PROFILE_ADAPTER,
        builtInKind: kind,
        instructions: BUILT_IN_INSTRUCTIONS[kind],
        modelId: base.modelId,
        modelCatalogId: base.modelCatalogId,
        modelCustomName: base.modelCustomName,
        providerId: base.providerId,
        effort: base.effort,
      },
      select: { id: true },
    });
    created += 1;
    return agentProfileIdSchema.parse(row.id);
  };
  const refine = await ensure("refine");
  const review = await ensure("review");
  await tx.project.updateMany({
    where: {
      organizationId,
      OR: [{ defaultRefineProfileId: null }, { defaultRefineProfileId: openCodeId }],
    },
    data: { defaultRefineProfileId: refine },
  });
  await tx.project.updateMany({
    where: {
      organizationId,
      OR: [{ defaultReviewProfileId: null }, { defaultReviewProfileId: openCodeId }],
    },
    data: { defaultReviewProfileId: review },
  });
  return { refine, review, created };
};

/** The built-in profile of a kind, if the organization has it yet. */
export const builtInProfileOfKindInTx = async (
  tx: Tx,
  organizationId: OrganizationId,
  kind: "refine" | "review",
): Promise<AgentProfileId | null> => {
  const row = await tx.agentProfile.findFirst({
    where: { organizationId, builtInKind: kind, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return row === null ? null : agentProfileIdSchema.parse(row.id);
};

// ---------- the agent's draft ----------

/** A draft's typed fields as the row stores them. */
const draftColumns = (draft: RefineDraft) => ({
  description: draft.description,
  acceptanceCriteria: [...draft.acceptanceCriteria],
  edgeCases: [...draft.edgeCases],
  openQuestions: [...draft.openQuestions],
  subTickets: draft.subTickets.map((sub) => ({ title: sub.title, description: sub.description })),
});

/** A stored version, read back through the protocol's schema. */
export const draftOfRow = (row: {
  readonly description: string;
  readonly acceptanceCriteria: unknown;
  readonly edgeCases: unknown;
  readonly openQuestions: unknown;
  readonly subTickets: unknown;
}): RefineDraft | null => {
  const parsed = refineDraftSchema.safeParse({
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    edgeCases: row.edgeCases,
    openQuestions: row.openQuestions,
    subTickets: row.subTickets,
  });
  return parsed.success ? parsed.data : null;
};

const nextVersionInTx = async (tx: Tx, taskId: string): Promise<number> => {
  const latest = await tx.refineDraft.findFirst({
    where: { taskId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return (latest?.version ?? 0) + 1;
};

/** `POST /runner/v1/tasks/:taskId/draft`'s use case: a refine task's next version, from its agent. */
export const saveDraft: SaveDraft = async (deps, input) => {
  const { tx } = deps;
  const locked = await tx.$queryRaw<
    readonly unknown[]
  >`SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: "wrong-kind", message: "No such task" };
  }
  const task = await tx.task.findUniqueOrThrow({
    where: { id: input.taskId },
    select: { id: true, kind: true, projectId: true },
  });
  if (task.kind !== "refine") {
    return { ok: false, error: "wrong-kind", message: "Only a refine task hands in a draft" };
  }
  const draft = refineDraftSchema.safeParse(input.draft);
  if (!draft.success) {
    return { ok: false, error: "invalid", message: "The draft doesn't fit the draft's shape" };
  }
  const version = await nextVersionInTx(tx, task.id);
  if (version > DRAFT_VERSIONS_MAX) {
    return {
      ok: false,
      error: "limit-reached",
      message: `The task has ${String(DRAFT_VERSIONS_MAX)} drafts already`,
    };
  }
  const projectId = projectIdSchema.parse(task.projectId);
  const row = await tx.refineDraft.create({
    data: {
      organizationId: input.organizationId,
      projectId,
      taskId: task.id,
      version,
      source: "agent",
      ...draftColumns(draft.data),
    },
    select: { id: true },
  });
  const draftId = draftIdSchema.parse(row.id);
  const session = await tx.session.findFirst({
    where: { taskId: task.id },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (session !== null) {
    await appendServerEvent(tx, {
      organizationId: input.organizationId,
      projectId,
      taskId: input.taskId,
      sessionId: sessionIdSchema.parse(session.id),
      at: deps.clock.now(),
      event: { kind: "draft.submitted", draftId, version },
    });
  }
  await deps.notices.emitInTx(tx, {
    organizationId: input.organizationId,
    projectId,
    entity: "task",
    entityId: input.taskId,
  });
  return { ok: true, draftId, version };
};

/**
 * At a refine task's turn's end (its `session.saved`): a draft handed in during the turn moves the
 * task to needs you (`draft_ready`) for its owner, the driver, else the project's members. `false`
 * when the turn handed in none.
 */
export const handInDraftInTx = async (
  deps: Pick<M6TxDeps, "notices" | "jobs" | "clock">,
  tx: Tx,
  input: { readonly taskId: TaskId; readonly savedSeq: number },
): Promise<boolean> => {
  const before = await tx.event.findFirst({
    where: { taskId: input.taskId, kind: "session.saved", seq: { lt: input.savedSeq } },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const submitted = await tx.event.findFirst({
    where: {
      taskId: input.taskId,
      kind: "draft.submitted",
      seq: { gt: before?.seq ?? 0, lt: input.savedSeq },
    },
    select: { seq: true },
  });
  if (submitted === null) {
    return false;
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  const moved = await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs }, task, {
    type: "draft_handed_in",
  });
  if (moved) {
    await createNeedsYouItemInTx(deps, tx, {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      reason: "draft_ready",
      audience: task.driverMemberId === null ? "project_members" : "driver",
    });
  }
  return moved;
};

// ---------- a member's edit and their actions ----------

type DraftTask = {
  readonly id: TaskId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly ticketId: string | null;
  readonly boardId: string | null;
};

/** The refine task, locked, and the scope's right to it: any member who can open its project. */
const lockRefineTaskInTx = async (
  tx: Tx,
  scope: MemberScope,
  taskId: TaskId,
): Promise<
  | { readonly ok: true; readonly task: DraftTask }
  | { readonly ok: false; readonly error: "forbidden" | "not-found"; readonly message: string }
> => {
  const locked = await tx.$queryRaw<
    readonly unknown[]
  >`SELECT 1 FROM "task" WHERE "id" = ${taskId} AND "organizationId" = ${scope.organizationId} FOR UPDATE`;
  const task =
    locked.length === 0
      ? null
      : await tx.task.findUnique({
          where: { id: taskId },
          select: {
            id: true,
            kind: true,
            projectId: true,
            ticketId: true,
            boardId: true,
            project: { select: { access: true } },
          },
        });
  if (task?.kind !== "refine") {
    return { ok: false, error: "not-found", message: "No such refine task" };
  }
  const projectId = projectIdSchema.parse(task.projectId);
  const access = requireProjectAccess(
    scope,
    { id: projectId, organizationId: scope.organizationId, access: task.project.access },
    "read",
  );
  if (!access.ok) {
    return access.code === "not-found"
      ? { ok: false, error: "not-found", message: "No such refine task" }
      : { ok: false, error: "forbidden", message: "You may not change this draft" };
  }
  return {
    ok: true,
    task: {
      id: taskIdSchema.parse(task.id),
      organizationId: scope.organizationId,
      projectId,
      ticketId: task.ticketId,
      boardId: task.boardId,
    },
  };
};

const latestDraftInTx = (tx: Tx, taskId: string) =>
  tx.refineDraft.findFirst({ where: { taskId }, orderBy: { version: "desc" } });

/** A member's version of the draft, on the latest one they read (`baseVersion`). */
export const editDraft: EditDraft = (deps, scope, input) =>
  deps.db.$transaction(async (tx) => {
    const found = await lockRefineTaskInTx(tx, scope, input.taskId);
    if (!found.ok) return found;
    const latest = await latestDraftInTx(tx, found.task.id);
    if (latest?.version !== input.baseVersion) {
      return {
        ok: false,
        error: "conflict",
        message: "The draft changed since you opened it: reload it",
      };
    }
    const draft = refineDraftSchema.safeParse(input.draft);
    if (!draft.success) {
      return {
        ok: false,
        error: "invalid-input",
        message: "The draft doesn't fit the draft's shape",
      };
    }
    if (latest.version + 1 > DRAFT_VERSIONS_MAX) {
      return {
        ok: false,
        error: "conflict",
        message: `The task has ${String(DRAFT_VERSIONS_MAX)} drafts already`,
      };
    }
    const row = await tx.refineDraft.create({
      data: {
        organizationId: scope.organizationId,
        projectId: found.task.projectId,
        taskId: found.task.id,
        version: latest.version + 1,
        source: "member",
        editedByMemberId: scope.memberId,
        ...draftColumns(draft.data),
      },
      select: { id: true, version: true },
    });
    // The images stay with the draft: the new version carries the ones the old one had.
    const images = await tx.refineDraftImage.findMany({
      where: { draftId: latest.id },
      select: { blobId: true, name: true, contentType: true, size: true },
    });
    if (images.length > 0) {
      await tx.refineDraftImage.createMany({
        data: images.map((image) => ({
          ...image,
          organizationId: scope.organizationId,
          projectId: found.task.projectId,
          draftId: row.id,
        })),
      });
    }
    await deps.audit.recordInTx(tx, {
      organizationId: scope.organizationId,
      projectId: found.task.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "draft.edited",
      entity: "task",
      entityId: found.task.id,
      data: { version: row.version },
    });
    await deps.notices.emitInTx(tx, {
      organizationId: scope.organizationId,
      projectId: found.task.projectId,
      entity: "task",
      entityId: found.task.id,
    });
    return { ok: true, draftId: draftIdSchema.parse(row.id), version: row.version };
  });

/** An image a member adds to the latest version: a blob already stored (milestone 2's), at most `max` a draft. */
export const addDraftImage = (
  deps: Pick<M6TxDeps, "notices"> & {
    readonly db: { readonly $transaction: <T>(run: (tx: Tx) => Promise<T>) => Promise<T> };
  },
  scope: MemberScope,
  input: {
    readonly taskId: TaskId;
    readonly blobId: string;
    readonly name: string;
    readonly contentType: string;
    readonly size: number;
  },
  limits: { readonly max: number },
): Promise<
  UseCaseResult<{ readonly version: number }, "forbidden" | "not-found" | "limit-reached">
> =>
  deps.db.$transaction(async (tx) => {
    const found = await lockRefineTaskInTx(tx, scope, input.taskId);
    if (!found.ok) return found;
    const latest = await latestDraftInTx(tx, found.task.id);
    const blob = await tx.blob.findFirst({
      where: { id: input.blobId, organizationId: scope.organizationId },
      select: { id: true },
    });
    if (latest === null || blob === null) {
      return { ok: false, error: "not-found", message: "No such draft or file" };
    }
    if ((await tx.refineDraftImage.count({ where: { draftId: latest.id } })) >= limits.max) {
      return {
        ok: false,
        error: "limit-reached",
        message: `A draft holds at most ${String(limits.max)} images`,
      };
    }
    await tx.refineDraftImage.create({
      data: {
        organizationId: scope.organizationId,
        projectId: found.task.projectId,
        draftId: latest.id,
        blobId: blob.id,
        name: input.name.slice(0, 200),
        contentType: input.contentType.slice(0, 100),
        size: input.size,
      },
    });
    await deps.notices.emitInTx(tx, {
      organizationId: scope.organizationId,
      projectId: found.task.projectId,
      entity: "task",
      entityId: found.task.id,
    });
    return { ok: true, version: latest.version };
  });

/** The member's action closes what the task waited on: its item answered, the task done. */
const finishRefineInTx = async (
  deps: Pick<M6TxDeps, "notices" | "jobs" | "clock">,
  tx: Tx,
  taskId: TaskId,
  memberId: MemberId,
): Promise<void> => {
  const at = new Date(deps.clock.now());
  await resolveNeedsYouItemsInTx(
    deps,
    tx,
    { taskId, reason: "draft_ready" },
    { state: "answered", at, byMemberId: memberId },
  );
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: taskId } }));
  await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs }, task, {
    type: "draft_accepted",
  });
  await tx.task.update({ where: { id: taskId }, data: { lastPersonActionAt: at } });
};

/** "Update ticket": the version goes to the ticket through `draft.apply`, once per version. */
export const applyDraft: ApplyDraft = (deps, scope, input) =>
  deps.db.$transaction(async (tx) => {
    const found = await lockRefineTaskInTx(tx, scope, input.taskId);
    if (!found.ok) return found;
    const latest = await latestDraftInTx(tx, found.task.id);
    if (latest?.version !== input.version) {
      return {
        ok: false,
        error: "stale-version",
        message: "A newer version of the draft exists: review it first",
      };
    }
    if (found.task.ticketId === null || found.task.boardId === null) {
      return {
        ok: false,
        error: "no-ticket",
        message: "This draft has no ticket: create one from it instead",
      };
    }
    const now = deps.clock.now();
    if (latest.appliedAt === null) {
      await tx.refineDraft.update({
        where: { id: latest.id },
        data: { appliedAt: new Date(now), appliedByMemberId: scope.memberId },
      });
    }
    await deps.jobs.enqueueInTx(tx, "draft.apply", {
      organizationId: scope.organizationId,
      draftId: draftIdSchema.parse(latest.id),
      version: latest.version,
    });
    await deps.audit.recordInTx(tx, {
      organizationId: scope.organizationId,
      projectId: found.task.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "draft.applied",
      entity: "task",
      entityId: found.task.id,
      data: { version: latest.version },
    });
    await finishRefineInTx(deps, tx, found.task.id, scope.memberId);
    await deps.notices.emitInTx(tx, {
      organizationId: scope.organizationId,
      projectId: found.task.projectId,
      entity: "task",
      entityId: found.task.id,
    });
    return { ok: true, appliedAt: latest.appliedAt?.getTime() ?? now };
  });

/** "Mark ready": the ticket moves to the board's `ready` status, through milestone 2's ticket outbox. */
export const markTicketReady: MarkTicketReady = (deps, scope, input) =>
  deps.db.$transaction(async (tx) => {
    const found = await lockRefineTaskInTx(tx, scope, input.taskId);
    if (!found.ok) return found;
    const latest = await latestDraftInTx(tx, found.task.id);
    if (latest === null) {
      return { ok: false, error: "not-applied", message: "There's no draft yet" };
    }
    if (found.task.ticketId === null || found.task.boardId === null) {
      return { ok: false, error: "not-found", message: "This draft has no ticket" };
    }
    const board = await tx.board.findFirst({
      where: { id: found.task.boardId, organizationId: scope.organizationId },
      select: { id: true, connectionId: true, statusMap: true },
    });
    const mapping = board === null ? null : parseBoardMapping(board.statusMap);
    if (board === null || mapping?.ready === undefined) {
      return {
        ok: false,
        error: "no-ready-status",
        message: "The board has no status for a ready ticket: a project admin picks one",
      };
    }
    const now = deps.clock.now();
    const written = await tx.ticketWrite.createManyAndReturn({
      data: [
        {
          organizationId: scope.organizationId,
          projectId: found.task.projectId,
          taskId: found.task.id,
          boardId: board.id,
          ticketId: found.task.ticketId,
          kind: "move",
          payload: { kind: "move", target: "ready" },
          idempotencyKey: ticketWriteKey(found.task.id, { kind: "move", target: "ready" }),
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    for (const row of written) {
      await deps.jobs.enqueueInTx(
        tx,
        "ticket.sync",
        { organizationId: scope.organizationId, ticketWriteId: ticketWriteIdSchema.parse(row.id) },
        { group: { id: connectionIdSchema.parse(board.connectionId) } },
      );
    }
    if (latest.readyAt === null) {
      await tx.refineDraft.update({ where: { id: latest.id }, data: { readyAt: new Date(now) } });
    }
    await deps.audit.recordInTx(tx, {
      organizationId: scope.organizationId,
      projectId: found.task.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "draft.marked-ready",
      entity: "task",
      entityId: found.task.id,
      data: { version: latest.version },
    });
    await finishRefineInTx(deps, tx, found.task.id, scope.memberId);
    await deps.notices.emitInTx(tx, {
      organizationId: scope.organizationId,
      projectId: found.task.projectId,
      entity: "task",
      entityId: found.task.id,
    });
    return { ok: true, readyAt: latest.readyAt?.getTime() ?? now };
  });
