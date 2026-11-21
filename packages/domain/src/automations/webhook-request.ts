import type { DbEnum, Tx } from "@ostra/db";
import { agentProfileIdSchema, automationIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import type { AutomationId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";

import { startTask } from "../starts/start-task-body.ts";
import type { StartPorts } from "../starts/start-task-body.ts";
import type { StartTaskOptions } from "../use-cases/m6-signatures.ts";
import { pauseAutomationInTx } from "./intake.ts";
import { hashIdempotencyKey } from "./webhook.ts";
import {
  matchesPayloadFilter,
  parsePayloadFilter,
  renderWebhookPrompt,
  renderWebhookTitle,
  WEBHOOK_IDEMPOTENCY_WINDOW_MS,
  WEBHOOK_PROMPT_MAX,
  WEBHOOK_REQUESTS_PER_MINUTE_DEFAULT,
  WEBHOOK_STARTS_PER_HOUR_DEFAULT,
} from "./webhook-template.ts";

// A webhook automation's request (F-139, ADR 0056 amended 2026-11-21), once core has verified it.
// One transaction, under a lock on the automation's row, so two requests of one automation are
// decided one after the other: the request rate (`OSTRA_WEBHOOK_REQUESTS_PER_MINUTE`, counted from
// its request runs of the last minute; past it nothing is written), a repeat of an idempotency key
// (spent by a request that started a task, for 24 hours), a pause, the filter, "skip while the last
// one is open", the hourly limit (`OSTRA_WEBHOOK_STARTS_PER_HOUR`, which pauses it as an intake
// rule's does), then the start through `startTask`, as every other start. Each request it takes is
// one `request` run. The body is data: its fields reach the task's prompt fenced, and nothing of it
// is logged, audited or stored but the key's hash and the rendered prompt and title on the task.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The states a task's work is over in. */
const CLOSED_TASK_STATES = ["merged", "done", "stopped"] as const;

export type WebhookRequestOptions = StartTaskOptions & {
  /** `OSTRA_WEBHOOK_STARTS_PER_HOUR`. */
  readonly webhookStartsPerHour?: number;
  /** `OSTRA_WEBHOOK_REQUESTS_PER_MINUTE`. */
  readonly webhookRequestsPerMinute?: number;
  /** The transaction's deadline: past it the request is answered 503, and the sender retries. */
  readonly timeoutMs?: number;
};

export type WebhookRequestInput = {
  readonly organizationId: OrganizationId;
  readonly automationId: AutomationId;
  /** The request's parsed body: untrusted, never logged. */
  readonly body: unknown;
  /** The request's idempotency key, or `null`. Only its hash is stored. */
  readonly idempotencyKey: string | null;
};

/** Why a request started nothing by the automation's own settings: answered 200, so the sender doesn't retry. */
export type WebhookSkip = "filtered" | "last-open" | "paused";

export type WebhookRequestOutcome =
  | { readonly kind: "started"; readonly runId: string; readonly projectId: ProjectId; readonly taskId: TaskId }
  /** A repeat of a key that started a task in the last 24 hours: the first task. */
  | { readonly kind: "duplicate"; readonly runId: string; readonly projectId: ProjectId; readonly taskId: TaskId }
  /** `taskId`: the open task a `last-open` skip waited for. */
  | { readonly kind: "skipped"; readonly runId: string; readonly projectId: ProjectId; readonly reason: WebhookSkip; readonly taskId: TaskId | null }
  /** Over the hourly limit: recorded, and the automation paused. */
  | { readonly kind: "hourly-limit"; readonly runId: string; readonly projectId: ProjectId }
  /** Over the request rate: nothing written. */
  | { readonly kind: "rate-limited"; readonly projectId: ProjectId; readonly retryAfterSeconds: number }
  /** The rendered prompt is over the limit: nothing written. */
  | { readonly kind: "prompt-too-long"; readonly projectId: ProjectId }
  /** The project's setup refused the start (no repo, no profile with a model): recorded `skipped: setup`. */
  | { readonly kind: "not-started"; readonly runId: string; readonly projectId: ProjectId; readonly error: string; readonly message: string }
  /** No such webhook automation, or a deleted one. */
  | { readonly kind: "not-found" };

const skipReasonOf = (reason: WebhookSkip): DbEnum.AutomationSkipReason => {
  switch (reason) {
    case "filtered":
      return "filtered";
    case "last-open":
      return "last_open";
    case "paused":
      return "paused";
    default:
      return reason satisfies never;
  }
};

/** The automation's starts in the hour before `now`: its request runs that hold a task. */
const startsInLastHourInTx = (tx: Tx, automationId: string, now: number): Promise<number> =>
  tx.automationRun.count({ where: { automationId, kind: "request", state: "started", taskId: { not: null }, createdAt: { gte: new Date(now - HOUR_MS) } } });

export const receiveWebhookRequest = async (deps: StartPorts & WebhookRequestOptions, input: WebhookRequestInput): Promise<WebhookRequestOutcome> =>
  deps.db.$transaction(
    async (tx): Promise<WebhookRequestOutcome> => {
      const locked = await tx.$queryRaw<readonly { readonly id: string }[]>`
        SELECT "id" FROM "automation"
        WHERE "id" = ${input.automationId} AND "organizationId" = ${input.organizationId} AND "kind"::text = 'webhook' AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (locked.length === 0) {
        return { kind: "not-found" };
      }
      const row = await tx.automation.findUniqueOrThrow({ where: { id: input.automationId } });
      const organizationId = input.organizationId;
      const projectId = projectIdSchema.parse(row.projectId);
      const automationId = automationIdSchema.parse(row.id);
      const now = deps.clock.now();
      const at = new Date(now);

      // The rate first: past it nothing is written, so a flood leaves no history to page through.
      const limit = deps.webhookRequestsPerMinute ?? WEBHOOK_REQUESTS_PER_MINUTE_DEFAULT;
      const lastMinute = await tx.automationRun.findMany({
        where: { automationId, kind: "request", createdAt: { gt: new Date(now - MINUTE_MS) } },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { createdAt: true },
      });
      const oldest = lastMinute.at(-1);
      if (lastMinute.length >= limit && oldest !== undefined) {
        return { kind: "rate-limited", projectId, retryAfterSeconds: Math.max(1, Math.ceil((oldest.createdAt.getTime() + MINUTE_MS - now) / 1000)) };
      }

      const prompt = renderWebhookPrompt(row.prompt ?? "", input.body);
      if (prompt.length > WEBHOOK_PROMPT_MAX) {
        return { kind: "prompt-too-long", projectId };
      }

      const keyHash = input.idempotencyKey === null ? null : hashIdempotencyKey(input.idempotencyKey);
      const record = async (state: "started" | "skipped", skipReason: DbEnum.AutomationSkipReason | null): Promise<string> => {
        const run = await tx.automationRun.create({
          data: { organizationId, projectId, automationId, kind: "request", state, skipReason, idempotencyKeyHash: keyHash, createdAt: at },
          select: { id: true },
        });
        await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
        return run.id;
      };

      // A key is spent by a request that started a task: its repeat within 24 hours starts nothing.
      if (keyHash !== null) {
        const first = await tx.automationRun.findFirst({
          where: { automationId, kind: "request", idempotencyKeyHash: keyHash, taskId: { not: null }, createdAt: { gte: new Date(now - WEBHOOK_IDEMPOTENCY_WINDOW_MS) } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { taskId: true },
        });
        if (first?.taskId !== null && first?.taskId !== undefined) {
          const runId = await record("skipped", "duplicate");
          return { kind: "duplicate", runId, projectId, taskId: taskIdSchema.parse(first.taskId) };
        }
      }

      const skip = async (reason: WebhookSkip, taskId: TaskId | null = null): Promise<WebhookRequestOutcome> => ({
        kind: "skipped",
        runId: await record("skipped", skipReasonOf(reason)),
        projectId,
        reason,
        taskId,
      });
      if (row.pausedAt !== null || !row.enabled) {
        return skip("paused");
      }
      // A stored filter that no longer reads starts nothing: it never starts on a guess.
      const filter = parsePayloadFilter(row.payloadFilter);
      if (!filter.ok || !matchesPayloadFilter(input.body, filter.filter)) {
        return skip("filtered");
      }
      if (row.skipWhileOpen) {
        const open = await tx.task.findFirst({
          where: { automationId, organizationId, state: { notIn: [...CLOSED_TASK_STATES] } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (open !== null) {
          return skip("last-open", taskIdSchema.parse(open.id));
        }
      }
      if ((await startsInLastHourInTx(tx, automationId, now)) >= (deps.webhookStartsPerHour ?? WEBHOOK_STARTS_PER_HOUR_DEFAULT)) {
        const runId = await record("skipped", "hourly_limit");
        await pauseAutomationInTx({ tx, audit: deps.audit, notices: deps.notices, clock: deps.clock }, { organizationId, projectId, automationId, reason: "hourly_limit", memberId: null });
        return { kind: "hourly-limit", runId, projectId };
      }

      const runId = await record("started", null);
      const started = await startTask(
        { tx, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, ...(deps.publicUrl === undefined ? {} : { publicUrl: deps.publicUrl }) },
        {
          organizationId,
          projectId,
          origin: { kind: "webhook", automationId, requireApproval: row.requireApproval },
          kind: row.taskKind,
          ticketId: null,
          prompt,
          title: renderWebhookTitle(row.title ?? "", input.body, row.name),
          agentProfileId: row.agentProfileId === null ? null : agentProfileIdSchema.parse(row.agentProfileId),
          poolLabels: row.poolLabels,
        },
      );
      if (!started.ok) {
        // The project's setup refused it: recorded, and the key isn't spent, so a retry once it's fixed starts.
        await tx.automationRun.update({ where: { id: runId }, data: { state: "skipped", skipReason: "setup" } });
        return { kind: "not-started", runId, projectId, error: started.error, message: started.message };
      }
      await tx.automationRun.update({ where: { id: runId }, data: { taskId: started.taskId } });
      return { kind: "started", runId, projectId, taskId: started.taskId };
    },
    { maxWait: deps.timeoutMs ?? 10_000, timeout: deps.timeoutMs ?? 10_000 },
  );
