import type { Db, Tx } from "@ostra/db";
import { mapTask } from "@ostra/db";
import {
  budgetIdSchema,
  clientMessageIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  messageIntentSchema,
  notificationDeliveryIdSchema,
  organizationIdSchema,
  projectIdSchema,
  runnerIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { BudgetId, MemberId, OrganizationId, ProjectId } from "@ostra/protocol";
import { z } from "zod";

import { requireOrganizationAdmin, requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { budgetLevel, budgetMonthOf, budgetNoticesDue } from "../budget/gate.ts";
import type { BudgetMonth } from "../budget/gate.ts";
import { dispatchWaitColumns, dispatchWaitFromDb } from "../dispatch-wait.ts";
import type { JobPayload } from "../jobs.ts";
import { renderBudgetReachedMail, renderBudgetWarningMail } from "../mail/account-mails.ts";
import { EMAIL_DELAY_SECONDS_DEFAULT, emailDueAt } from "../notifications/choices.ts";
import type { NotificationChannel } from "../notifications/choices.ts";
import type { Ports } from "../ports.ts";
import { BUDGET_WARN_PERCENT_DEFAULT, budgetsForProjectInTx, checkBudget, monthSpendInTx, sessionModelIdInTx } from "./budgets.ts";
import type { M4Deps, SetBudget } from "./m4-signatures.ts";
import { planAnswerCommandInTx } from "./plans-questions.ts";
import { appendServerEvent } from "./server-events.ts";
import { releaseHeldRoundInTx } from "../review-loop/start-round.ts";

// Budget notices and their release (F-037, F-115, ADR 0055, ADR 0050; ticket 13). `budget.check`
// writes a budget's notice for a month and threshold once and fans it out, as milestone 3's moments
// are, to the admins of the budget's scope: in the panel and by mail. Saving a budget checks the
// current month at once, and a raise (or a new month) enqueues `budget.release`, which lets the
// budget's held turns go in the order they were held, each through the gate again.

// ---------- the notice's words ----------

export const budgetNotificationKindOf = (threshold: "warn" | "reached"): "budget_warning" | "budget_reached" =>
  threshold === "warn" ? "budget_warning" : "budget_reached";

/** Whether a stored notification's kind is a budget notice, which `notify.deliver` renders from its notice. */
export const isBudgetNoticeKind = (kind: string): kind is "budget_warning" | "budget_reached" => kind === "budget_warning" || kind === "budget_reached";

/** A budget delivery's key: the notice, the change (always `created`), the member and the channel. */
export const budgetDeliveryKey = (input: { readonly noticeId: string; readonly memberId: MemberId; readonly channel: NotificationChannel }): string =>
  `budget:${input.noticeId}:created:${input.memberId}:${input.channel}`;

/** The notice a budget delivery's key names, or `null` for any other key. */
export const budgetNoticeIdOfKey = (key: string): string | null => {
  const [prefix, noticeId] = key.split(":");
  return prefix === "budget" && noticeId !== undefined && noticeId !== "" ? noticeId : null;
};

/** Dollars with cents, from micro-USD (rounded down, so a share never reads more than it is). */
export const usdOfMicro = (micro: bigint): string => {
  const cents = micro / 10_000n;
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
};

/** The month's share in whole percent, rounded down: 99.6% reads 99%. A budget of 0 reads 100% at once. */
export const budgetPercent = (spent: bigint, budget: bigint): number => (budget === 0n ? 100 : Number((spent * 100n) / budget));

/** The Spend page a budget notice links to (the project's selected for a project budget). */
export const spendUrlOf = (publicUrl: string, projectId: ProjectId | null): string =>
  `${publicUrl.replace(/\/+$/, "")}/organization/spend${projectId === null ? "" : `?project=${encodeURIComponent(projectId)}`}`;

/** What a delivery of a budget notice says, read from its rows when it's due: never a task's content. */
export type BudgetNoticeView = {
  readonly kind: "budget_warning" | "budget_reached";
  readonly organizationName: string;
  /** The project's name, or the organization's for its own budget. */
  readonly budgetName: string;
  readonly projectId: ProjectId | null;
  readonly month: BudgetMonth;
  readonly spent: string;
  readonly budget: string;
  readonly percent: number;
};

export const loadBudgetNoticeView = async (db: Db | Tx, organizationId: OrganizationId, noticeId: string): Promise<BudgetNoticeView | null> => {
  const notice = await db.budgetNotice.findFirst({
    where: { id: noticeId, organizationId },
    select: { month: true, threshold: true, budget: { select: { projectId: true, monthlyMicroUsd: true, project: { select: { name: true } }, organization: { select: { name: true } } } } },
  });
  if (notice === null) {
    return null;
  }
  const projectId = notice.budget.projectId === null ? null : projectIdSchema.parse(notice.budget.projectId);
  const spent = await monthSpendInTx(db, { organizationId, projectId, month: notice.month });
  return {
    kind: budgetNotificationKindOf(notice.threshold),
    organizationName: notice.budget.organization.name,
    budgetName: notice.budget.project?.name ?? notice.budget.organization.name,
    projectId,
    month: notice.month,
    spent: usdOfMicro(spent),
    budget: usdOfMicro(notice.budget.monthlyMicroUsd),
    percent: budgetPercent(spent, notice.budget.monthlyMicroUsd),
  };
};

/** The panel's title and line of a budget notice. */
export const budgetNoticePanelWords = (view: BudgetNoticeView): { readonly title: string; readonly line: string } =>
  view.kind === "budget_warning"
    ? { title: `${view.budgetName} is at ${String(view.percent)}% of its budget`, line: `${view.spent} of ${view.budget} spent this month.` }
    : { title: `${view.budgetName} reached its budget`, line: `${view.spent} of ${view.budget} spent: new tasks wait and new turns are held.` };

/** The budget notice's mail, from the domain's renderers. */
export const renderBudgetNoticeMail = (view: BudgetNoticeView, publicUrl: string) => {
  const input = {
    organizationName: view.organizationName,
    budgetName: view.budgetName,
    month: view.month,
    percent: view.percent,
    spent: view.spent,
    budget: view.budget,
    link: spendUrlOf(publicUrl, view.projectId),
    publicUrl,
  };
  return view.kind === "budget_warning" ? renderBudgetWarningMail(input) : renderBudgetReachedMail(input);
};

// ---------- `budget.check` ----------

/** The members a budget's notice goes to: the organization's admins, and for a project budget that project's admins. */
export const budgetAudienceInTx = async (tx: Tx, organizationId: OrganizationId, projectId: ProjectId | null): Promise<readonly MemberId[]> => {
  const admins = await tx.member.findMany({ where: { organizationId, role: "admin", state: "active" }, select: { id: true } });
  const projectAdmins =
    projectId === null
      ? []
      : await tx.projectMember.findMany({ where: { organizationId, projectId, role: "admin", member: { state: "active" } }, select: { memberId: true } });
  return [...new Set([...admins.map((row) => row.id), ...projectAdmins.map((row) => row.memberId)])].sort().map((id) => memberIdSchema.parse(id));
};

export type BudgetCheckDeps = Pick<Ports, "jobs" | "notices" | "clock"> & {
  readonly db: Db;
  /** `OSTRA_BUDGET_WARN_PERCENT`. */
  readonly budgetWarnPercent?: number;
  /** `OSTRA_EMAIL_DELAY_SECONDS`, which the instance's saved delay overrides. */
  readonly emailDelaySeconds?: number;
};

export type BudgetCheckResult =
  | { readonly kind: "sent"; readonly notifications: number; readonly deliveries: number }
  /** The notice was already written: a replay, or a second crossing in one month. */
  | { readonly kind: "already-sent" }
  /** The month's spend isn't at the threshold now (a raise came first), or the budget is gone. */
  | { readonly kind: "not-due" };

/**
 * `budget.check`: the notice for the budget, month and threshold, once, and its fan-out in the same
 * transaction. The mail is a moment: on by default for both kinds, and each member's choice wins.
 */
export const checkBudgetNotice = async (deps: BudgetCheckDeps, payload: JobPayload<"budget.check">): Promise<BudgetCheckResult> =>
  deps.db.$transaction(async (tx): Promise<BudgetCheckResult> => {
    const budget = await tx.budget.findFirst({ where: { id: payload.budgetId, organizationId: payload.organizationId }, select: { id: true, projectId: true, monthlyMicroUsd: true } });
    if (budget === null) {
      return { kind: "not-due" };
    }
    const projectId = budget.projectId === null ? null : projectIdSchema.parse(budget.projectId);
    const spent = await monthSpendInTx(tx, { organizationId: payload.organizationId, projectId, month: payload.month });
    const level = budgetLevel(spent, budget.monthlyMicroUsd, deps.budgetWarnPercent ?? BUDGET_WARN_PERCENT_DEFAULT);
    if (level === "under" || (payload.threshold === "reached" && level !== "reached")) {
      return { kind: "not-due" };
    }
    const [notice] = await tx.budgetNotice.createManyAndReturn({
      data: [{ organizationId: payload.organizationId, budgetId: budget.id, month: payload.month, threshold: payload.threshold, sentAt: new Date(deps.clock.now()) }],
      skipDuplicates: true,
      select: { id: true },
    });
    if (notice === undefined) {
      return { kind: "already-sent" };
    }
    const kind = budgetNotificationKindOf(payload.threshold);
    const memberIds = await budgetAudienceInTx(tx, payload.organizationId, projectId);
    const now = deps.clock.now();
    const [preferences, saved] = await Promise.all([
      tx.notificationPreference.findMany({ where: { memberId: { in: [...memberIds] }, kind, channel: "email" }, select: { memberId: true, enabled: true } }),
      tx.instanceSetting.findUnique({ where: { id: "instance" }, select: { emailDelaySeconds: true } }),
    ]);
    const emailProvider = (await tx.emailSettings.findUnique({ where: { id: "instance" }, select: { provider: true } }))?.provider ?? "off";
    const delaySeconds = saved?.emailDelaySeconds ?? deps.emailDelaySeconds ?? EMAIL_DELAY_SECONDS_DEFAULT;
    let deliveries = 0;
    for (const memberId of memberIds) {
      const notification = await tx.notification.create({
        data: { organizationId: payload.organizationId, memberId, projectId, kind, state: "open" },
        select: { id: true },
      });
      // Mail is on by default for both budget kinds (ticket 13); a member who turned it off gets the panel only.
      const wantsMail = preferences.find((row) => row.memberId === memberId)?.enabled ?? true;
      const channels: readonly NotificationChannel[] = wantsMail ? ["panel", "email"] : ["panel"];
      for (const channel of channels) {
        const dueAt = channel === "email" ? emailDueAt(now, delaySeconds) : now;
        const delivery = await tx.notificationDelivery.create({
          data: {
            organizationId: payload.organizationId,
            notificationId: notification.id,
            channel,
            adapter: channel === "panel" ? "panel" : emailProvider === "off" ? "email" : emailProvider,
            idempotencyKey: budgetDeliveryKey({ noticeId: notice.id, memberId, channel }),
            dueAt: new Date(dueAt),
          },
          select: { id: true },
        });
        const wait = Math.max(0, dueAt - now);
        await deps.jobs.enqueueInTx(
          tx,
          "notify.deliver",
          { organizationId: payload.organizationId, deliveryId: notificationDeliveryIdSchema.parse(delivery.id) },
          wait === 0 ? undefined : { startAfterMs: wait },
        );
        deliveries += 1;
      }
      await deps.notices.emitInTx(tx, { organizationId: payload.organizationId, projectId: null, entity: "member", entityId: memberId });
    }
    return { kind: "sent", notifications: memberIds.length, deliveries };
  });

// ---------- saving a budget ----------

/** `budget.check` for each notice the month owes now, and `budget.release` when held turns may go. */
const afterBudgetChangeInTx = async (
  deps: Pick<Ports, "jobs">,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly budgetId: BudgetId; readonly projectId: ProjectId | null; readonly monthlyMicroUsd: bigint; readonly raised: boolean; readonly now: number; readonly warnPercent: number },
): Promise<void> => {
  const month = budgetMonthOf(input.now);
  const spent = await monthSpendInTx(tx, { organizationId: input.organizationId, projectId: input.projectId, month });
  const sent = await tx.budgetNotice.findMany({ where: { budgetId: input.budgetId, month }, select: { threshold: true } });
  const due = budgetNoticesDue(budgetLevel(spent, input.monthlyMicroUsd, input.warnPercent), new Set(sent.map((row) => row.threshold)));
  for (const threshold of due) {
    await deps.jobs.enqueueInTx(tx, "budget.check", { organizationId: input.organizationId, budgetId: input.budgetId, month, threshold });
  }
  if (input.raised && spent < input.monthlyMicroUsd) {
    await deps.jobs.enqueueInTx(tx, "budget.release", { organizationId: input.organizationId, budgetId: input.budgetId, raisedAt: input.now });
  }
};

/**
 * An admin sets, changes or removes (`null`) a monthly budget: the organization's (its admins) or
 * a project's (its admins and the organization's). In one transaction with its audit entry. The
 * current month is checked at once, so a budget set below what's spent warns or closes now; a raise
 * above the spend enqueues the release, and a removal lets its held turns go through the gate now.
 */
export const setBudget = async (
  deps: M4Deps & { readonly budgetWarnPercent?: number },
  scope: MemberScope,
  input: Parameters<SetBudget>[2],
): ReturnType<SetBudget> => {
  if (input.monthlyMicroUsd !== null && (input.monthlyMicroUsd < 0n || input.monthlyMicroUsd > 1_000_000_000_000_000n)) {
    return { ok: false, error: "invalid-input", message: "A budget is a whole number of micro-USD, from 0" };
  }
  return deps.db.$transaction(async (tx) => {
    const organizationId = scope.organizationId;
    let projectId: ProjectId | null = null;
    if (input.projectId === null) {
      const access = requireOrganizationAdmin(scope, organizationId);
      if (!access.ok) {
        return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such organization" } : { ok: false, error: "forbidden", message: "Only an organization admin sets its budget" };
      }
    } else {
      const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
      const access = project === null ? null : requireProjectAccess(scope, { id: input.projectId, organizationId, access: project.access }, "admin");
      if (access === null || (!access.ok && access.code === "not-found")) {
        return { ok: false, error: "not-found", message: "No such project" };
      }
      if (!access.ok) {
        return { ok: false, error: "forbidden", message: "Only an admin of the project sets its budget" };
      }
      projectId = input.projectId;
    }
    const now = deps.clock.now();
    const warnPercent = deps.budgetWarnPercent ?? BUDGET_WARN_PERCENT_DEFAULT;
    const existing = await tx.budget.findFirst({ where: { organizationId, projectId }, select: { id: true, monthlyMicroUsd: true } });
    const entityId = projectId ?? organizationId;
    if (input.monthlyMicroUsd === null) {
      if (existing === null) {
        return { ok: true, budgetId: null };
      }
      const budgetId = budgetIdSchema.parse(existing.id);
      // Its held turns go through the gate without it, before the row (and they with it) is deleted.
      await releaseHeldTurnsInTx(deps, tx, { organizationId, budgetId, ignoreBudgetId: budgetId });
      await tx.budget.delete({ where: { id: existing.id } });
      await deps.audit.recordInTx(tx, { organizationId, projectId, actor: { kind: "member", id: scope.memberId }, action: "budget.cleared", entity: "budget", entityId, data: { budgetId } });
      await deps.notices.emitInTx(tx, { organizationId, projectId, entity: projectId === null ? "organization" : "project", entityId });
      return { ok: true, budgetId: null };
    }
    const saved = await tx.budget.upsert({
      where: existing === null ? { id: "" } : { id: existing.id },
      create: { organizationId, projectId, monthlyMicroUsd: input.monthlyMicroUsd, updatedByMemberId: scope.memberId },
      update: { monthlyMicroUsd: input.monthlyMicroUsd, updatedByMemberId: scope.memberId },
      select: { id: true },
    });
    const budgetId = budgetIdSchema.parse(saved.id);
    await afterBudgetChangeInTx(deps, tx, {
      organizationId,
      budgetId,
      projectId,
      monthlyMicroUsd: input.monthlyMicroUsd,
      raised: existing !== null && input.monthlyMicroUsd > existing.monthlyMicroUsd,
      now,
      warnPercent,
    });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "budget.set",
      entity: "budget",
      entityId,
      data: { budgetId, monthlyMicroUsd: Number(input.monthlyMicroUsd), previousMicroUsd: existing === null ? null : Number(existing.monthlyMicroUsd) },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: projectId === null ? "organization" : "project", entityId });
    return { ok: true, budgetId };
  });
};

// ---------- `budget.release` ----------

const steerPayloadSchema = z.looseObject({ kind: z.literal("user.message"), clientMessageId: clientMessageIdSchema, text: z.string(), intent: messageIntentSchema.optional() });

const GOING_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

export type ReleaseDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "clock">;

/**
 * The budget's held turns, oldest first, each through the gate again in its task's lock: one that
 * passes is released (`turn.released`) and goes: a held reopen is dispatched, a held message is
 * steered into its session when it's still going. One the gate still holds stays held, under the
 * budget that holds it now. Then the queued tasks waiting on a closed gate are re-offered.
 */
export const releaseHeldTurnsInTx = async (
  deps: ReleaseDeps,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly budgetId: BudgetId; readonly ignoreBudgetId?: BudgetId },
): Promise<{ readonly released: number; readonly stillHeld: number; readonly reoffered: number }> => {
  const now = deps.clock.now();
  const held = await tx.heldTurn.findMany({
    where: { organizationId: input.organizationId, budgetId: input.budgetId, releasedAt: null },
    orderBy: [{ heldAt: "asc" }, { id: "asc" }],
  });
  let released = 0;
  let stillHeld = 0;
  for (const turn of held) {
    await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${turn.taskId} FOR UPDATE`;
    const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: turn.taskId } }));
    const projectId = projectIdSchema.parse(task.projectId);
    const session = await tx.session.findFirst({ where: { taskId: task.id, state: { in: [...GOING_SESSION_STATES] } }, orderBy: { startedAt: "desc" } });
    const modelId = session === null ? null : await sessionModelIdInTx(tx, task.organizationId, { agentProfileId: session.agentProfileId, modelId: session.modelId });
    const gate = await gateIgnoring(tx, { organizationId: input.organizationId, projectId, modelId, now, ignoreBudgetId: input.ignoreBudgetId ?? null });
    if (gate.kind === "held") {
      stillHeld += 1;
      if (gate.budgetId !== turn.budgetId) {
        await tx.heldTurn.update({ where: { id: turn.id }, data: { budgetId: gate.budgetId } });
      }
      continue;
    }
    await tx.heldTurn.update({ where: { id: turn.id }, data: { releasedAt: new Date(now) } });
    released += 1;
    const sessionId = session === null ? null : sessionIdSchema.parse(session.id);
    if (sessionId !== null) {
      await appendServerEvent(tx, { organizationId: input.organizationId, projectId, taskId: task.id, sessionId, at: now, event: { kind: "turn.released", budgetId: input.budgetId } });
    }
    if (task.state === "queued" && session?.state === "starting") {
      // A held reopen: its new session waits for its dispatch, through the gate again there.
      await tx.task.update({ where: { id: task.id }, data: dispatchWaitColumns(null) });
      await deps.jobs.enqueueInTx(tx, "task.dispatch", { organizationId: input.organizationId, taskId: task.id, sessionId: sessionIdSchema.parse(session.id), leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1) });
    } else if (turn.origin === "automatic_round" && (await releaseHeldRoundInTx(deps, tx, { taskId: taskIdSchema.parse(task.id), pendingMessageSeq: turn.pendingMessageSeq }))) {
      // Milestone 6 (F-101, ADR 0041): a held round starts now, as an automatic turn, its counters with it.
    } else if (turn.pendingMessageSeq !== null && session !== null) {
      // A held message to a session that's still going: steered now, as it would have been.
      const [lease, event] = await Promise.all([
        tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { runnerId: true } }),
        tx.event.findFirst({ where: { taskId: task.id, seq: turn.pendingMessageSeq }, select: { payload: true } }),
      ]);
      const message = steerPayloadSchema.safeParse(event?.payload);
      // A held plan answer (F-063): sent as the answer it was, so the session leaves plan mode.
      const answer = message.success ? null : await planAnswerCommandInTx(tx, task.id, event?.payload);
      if (lease !== null && answer !== null) {
        await deps.outbox.enqueueInTx(tx, input.organizationId, runnerIdSchema.parse(lease.runnerId), {
          kind: "plan-answer",
          body: { sessionId: sessionIdSchema.parse(session.id), decision: answer.decision, text: answer.text },
          notAfter: now + runnerLimits.offerTimeoutMs,
          task: { taskId: task.id, projectId },
        });
      } else if (lease !== null && message.success) {
        await deps.outbox.enqueueInTx(tx, input.organizationId, runnerIdSchema.parse(lease.runnerId), {
          kind: "steer",
          body: {
            sessionId: sessionIdSchema.parse(session.id),
            clientMessageId: message.data.clientMessageId,
            text: message.data.text.slice(0, runnerLimits.steerTextMaxChars),
            delivery: "queue",
            ...(message.data.intent === undefined ? {} : { intent: message.data.intent }),
            // Milestone 6: a round's message is an automatic turn, whatever released it.
            ...(message.data.intent === "fix-ci" || message.data.intent === "fix-findings" ? { automatic: true } : {}),
          },
          notAfter: now + runnerLimits.offerTimeoutMs,
          task: { taskId: task.id, projectId },
        });
      }
      // A session gone meanwhile leaves the message unanswered: the next reopen replays it (F-047).
    }
    await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId, entity: "task", entityId: taskIdSchema.parse(task.id) });
  }
  // Queued tasks a closed gate left waiting (new tasks have no held turn): offered again now.
  const waiting = await tx.task.findMany({
    where: { organizationId: input.organizationId, state: "queued", leases: { none: { state: "active" } } },
    select: { id: true, leaseEpoch: true, dispatchWait: true, sessions: { where: { state: "starting" }, select: { id: true }, take: 1 } },
    orderBy: { createdAt: "asc" },
  });
  let reoffered = 0;
  for (const task of waiting) {
    const wait = dispatchWaitFromDb(task.dispatchWait);
    const [session] = task.sessions;
    if (session === undefined || (wait?.code !== "budget-reached" && wait?.code !== "model-unpriced")) {
      continue;
    }
    await deps.jobs.enqueueInTx(tx, "task.dispatch", { organizationId: input.organizationId, taskId: taskIdSchema.parse(task.id), sessionId: sessionIdSchema.parse(session.id), leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1) });
    reoffered += 1;
  }
  return { released, stillHeld, reoffered };
};

/** The gate as `checkBudget` runs it, with one budget left out (a removal's), for the release. */
const gateIgnoring = async (
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly modelId: Parameters<typeof checkBudget>[1]["modelId"]; readonly now: number; readonly ignoreBudgetId: BudgetId | null },
) => {
  if (input.ignoreBudgetId === null) {
    return checkBudget(tx, { organizationId: input.organizationId, projectId: input.projectId, modelId: input.modelId, origin: "reopen", now: input.now });
  }
  const budgets = await budgetsForProjectInTx(tx, input.organizationId, input.projectId);
  const ignored = (budget: (typeof budgets)["project"]) => (budget?.budgetId === input.ignoreBudgetId ? null : budget);
  if (ignored(budgets.project) === null && ignored(budgets.organization) === null) {
    return { kind: "open" } as const;
  }
  const result = await checkBudget(tx, { organizationId: input.organizationId, projectId: input.projectId, modelId: input.modelId, origin: "reopen", now: input.now });
  return result.kind === "held" && result.budgetId === input.ignoreBudgetId ? ({ kind: "open" } as const) : result;
};

/** `budget.release`: a raise or a new month, in one transaction. */
export const releaseHeldTurns = async (
  deps: ReleaseDeps & { readonly db: Db },
  input: { readonly organizationId: OrganizationId; readonly budgetId: BudgetId },
): Promise<{ readonly released: number; readonly stillHeld: number; readonly reoffered: number }> => deps.db.$transaction((tx) => releaseHeldTurnsInTx(deps, tx, input), { timeout: 60_000 });

/** A new month: every budget with a held turn, or a queued task waiting on a gate, gets its release. */
export const releaseForNewMonth = async (deps: Pick<Ports, "jobs" | "clock"> & { readonly db: Db }): Promise<number> => {
  const now = deps.clock.now();
  const budgets = await deps.db.budget.findMany({ select: { id: true, organizationId: true } });
  let sent = 0;
  for (const budget of budgets) {
    await deps.db.$transaction((tx) =>
      deps.jobs.enqueueInTx(tx, "budget.release", { organizationId: organizationIdSchema.parse(budget.organizationId), budgetId: budgetIdSchema.parse(budget.id), raisedAt: now }),
    );
    sent += 1;
  }
  return sent;
};
