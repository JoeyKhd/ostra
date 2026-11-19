import type { DbEnum, Tx } from "@ostra/db";
import { needsYouItemIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { NeedsYouItemId, OrganizationId } from "@ostra/protocol";

import type { NotificationKind } from "../notifications/choices.ts";
import type { JobQueue } from "../ports.ts";

// The one place that writes a needs-you item (F-036, ADR 0050, ADR 0011). Every creation, answer
// and dismissal goes through these functions, which enqueue `notify.fanout` in the caller's
// transaction, keyed by the item and the change, so no item changes without its notifications being
// owed, and no notification is owed for a change that didn't commit. A test fails when any other
// file writes the table (`needs-you-writers.test.ts`).

/**
 * The notification a needs-you reason sends (ADR 0050): the reason of the same name, except that a
 * ready draft PR is `pr_ready`. Reasons with no moment of their own (a round cap, a reviewer's wait,
 * an environment proposal, a restore conflict, an unstorable event, files left outside the repos)
 * notify nobody in milestone 3: their item shows in the panel, and fan-out writes nothing for it.
 */
export const notificationKindOfReason = (reason: DbEnum.NeedsYouReason): NotificationKind | null => {
  switch (reason) {
    case "question":
    case "approval":
    case "plan":
    case "no_changes":
    case "stalled":
    case "spend_cap":
    case "crashed":
    case "setup_failed":
    case "ticket_closed":
      return reason;
    case "draft_ready":
      return "pr_ready";
    case "round_cap":
    case "waiting_for_reviewer":
    case "environment_proposal":
    case "restore_conflict":
    case "unstorable_event":
    case "files_outside_repos":
      return null;
    default:
      return reason satisfies never;
  }
};

/** What changed about an item: the key of its fan-out job. */
export type ItemChange = "created" | "answered" | "dismissed";

/** Enqueues the fan-out of one item's change, in the caller's transaction. Idempotent by its key. */
export const enqueueNotifyFanoutInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly itemId: NeedsYouItemId; readonly change: ItemChange },
): Promise<void> => {
  await deps.jobs.enqueueInTx(tx, "notify.fanout", {
    organizationId: input.organizationId,
    needsYouItemId: input.itemId,
    notificationId: null,
    change: input.change,
  });
};

export type NewNeedsYouItem = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly reason: DbEnum.NeedsYouReason;
  readonly audience: DbEnum.NeedsYouAudience;
  readonly summary?: string | null;
  readonly approvalId?: string | null;
  readonly questionId?: string | null;
  readonly planTurnId?: string | null;
};

/** Creates an item and owes its fan-out, in the caller's transaction. */
export const createNeedsYouItemInTx = async (deps: { readonly jobs: JobQueue }, tx: Tx, item: NewNeedsYouItem): Promise<NeedsYouItemId> => {
  const row = await tx.needsYouItem.create({
    data: {
      organizationId: item.organizationId,
      projectId: item.projectId,
      taskId: item.taskId,
      reason: item.reason,
      audience: item.audience,
      ...(item.summary === undefined ? {} : { summary: item.summary }),
      ...(item.approvalId === undefined ? {} : { approvalId: item.approvalId }),
      ...(item.questionId === undefined ? {} : { questionId: item.questionId }),
      ...(item.planTurnId === undefined ? {} : { planTurnId: item.planTurnId }),
    },
    select: { id: true },
  });
  const itemId = needsYouItemIdSchema.parse(row.id);
  await enqueueNotifyFanoutInTx(deps, tx, { organizationId: organizationIdSchema.parse(item.organizationId), itemId, change: "created" });
  return itemId;
};

/** Which open items an answer or a dismissal closes. At least one field narrows it. */
export type OpenItemsWhere = {
  readonly id?: string;
  readonly taskId?: string;
  readonly approvalId?: string;
  readonly questionId?: string;
  readonly reason?: DbEnum.NeedsYouReason;
  readonly reasonNotIn?: readonly DbEnum.NeedsYouReason[];
};

export type ItemResolution = {
  readonly state: "answered" | "dismissed";
  readonly at: Date;
  /** `null` when ostra itself resolved it (a file moved, a restore conflict cleared). */
  readonly byMemberId: string | null;
};

/**
 * Answers or dismisses the open items that match, and owes each one's fan-out, in the caller's
 * transaction. Returns the IDs it closed; an item already closed by another is left as it is.
 */
export const resolveNeedsYouItemsInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  where: OpenItemsWhere,
  resolution: ItemResolution,
): Promise<readonly NeedsYouItemId[]> => {
  const open = await tx.needsYouItem.findMany({
    where: {
      state: "open",
      ...(where.id === undefined ? {} : { id: where.id }),
      ...(where.taskId === undefined ? {} : { taskId: where.taskId }),
      ...(where.approvalId === undefined ? {} : { approvalId: where.approvalId }),
      ...(where.questionId === undefined ? {} : { questionId: where.questionId }),
      ...(where.reason === undefined ? {} : { reason: where.reason }),
      ...(where.reasonNotIn === undefined ? {} : { reason: { notIn: [...where.reasonNotIn] } }),
    },
    select: { id: true, organizationId: true },
  });
  const closed: NeedsYouItemId[] = [];
  for (const item of open) {
    // The compare-and-set: of two writers closing one item, one update matches.
    const won = await tx.needsYouItem.updateMany({
      where: { id: item.id, state: "open" },
      data: { state: resolution.state, resolvedAt: resolution.at, resolvedByMemberId: resolution.byMemberId },
    });
    if (won.count !== 1) {
      continue;
    }
    const itemId = needsYouItemIdSchema.parse(item.id);
    await enqueueNotifyFanoutInTx(deps, tx, { organizationId: organizationIdSchema.parse(item.organizationId), itemId, change: resolution.state });
    closed.push(itemId);
  }
  return closed;
};

/** Rewrites an open item's summary. Not a moment: it enqueues nothing. */
export const setNeedsYouSummaryInTx = async (tx: Tx, itemId: string, summary: string): Promise<void> => {
  await tx.needsYouItem.update({ where: { id: itemId }, data: { summary } });
};
