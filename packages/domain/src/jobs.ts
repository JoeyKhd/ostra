import { createHash } from "node:crypto";

import {
  agentActivityIdSchema,
  automationIdSchema,
  boardIdSchema,
  boxIdSchema,
  boxReleaseReasonSchema,
  budgetIdSchema,
  bulkStartItemIdSchema,
  connectionIdSchema,
  draftIdSchema,
  environmentProposalIdSchema,
  epochMsSchema,
  gitShaSchema,
  leaseEpochSchema,
  libraryItemIdSchema,
  needsYouItemIdSchema,
  notificationDeliveryIdSchema,
  notificationIdSchema,
  organizationIdSchema,
  projectIdSchema,
  poolIdSchema,
  providerIdSchema,
  registryIdSchema,
  repoIdSchema,
  reviewRunIdSchema,
  roundKindSchema,
  runnerIdSchema,
  sessionIdSchema,
  taskIdSchema,
  taskRepoIdSchema,
  taskSeqSchema,
  ticketIdSchema,
  ticketWriteIdSchema,
  webhookDeliveryIdSchema,
} from "@ostra/protocol";
import { z } from "zod";

// The job catalogue (ticket 08, ADR 0037): every background job's name, its payload (IDs only,
// never content) and its key. A key is fixed by what the job does, such as
// `task:<TaskId>:<transition>:<seq>`, so sending a job twice returns the existing one.
// `packages/jobs` implements the queue on pg-boss (ticket 23).

const taskScope = { organizationId: organizationIdSchema, taskId: taskIdSchema };

/** Every job's name. `jobPayloadSchemas` must hold exactly these: the compiler refuses a missing or an extra one. */
export const jobNames = [
  "task.dispatch",
  "task.offer-timeout",
  "task.grace",
  "task.session-ended",
  "task.open-pull-requests",
  "provider.refresh-models",
  "catalog.refresh",
  // ---- milestone 2 ----
  "webhook.process",
  "tracker.poll-board",
  "github.reconcile-prs",
  "linear.refresh-token",
  "ticket.fetch-context",
  "ticket.sync",
  "session.max-duration",
  "session.stall-sweep",
  "box.release",
  "box.release-after-idle",
  "retention.sweep",
  "blob.gc",
  // ---- milestone 3 (spec section 5.4) ----
  "notify.fanout",
  "notify.deliver",
  "diff.fetch",
  "task.reconcile-behind",
  "github.comment",
  "snapshot.schedule",
  "snapshot.nightly",
  "cli-session.expire",
  // ---- milestone 4 (spec section 5.4) ----
  "account-mail.send",
  "invitation.expire",
  "budget.check",
  "budget.release",
  // A new month lets every budget's held turns go (ticket 13): a schedule on the 1st at 00:05 UTC.
  "budget.new-month",
  "insights.compute",
  "search.backfill",
  "pr.link-related",
  "review.evaluate",
  // Keys per project (ticket 45).
  "providers.release-boxes",
  // ---- milestone 5 (spec section 5.4) ----
  "queue.admit",
  "runner.join-notice",
  "registry.check",
  // ---- milestone 6 (spec section 5.4) ----
  "scheduler.tick",
  "automation.occurrence",
  "intake.match",
  "bulk.start-item",
  "linear.agent-event",
  "linear.activity.send",
  "linear.heartbeat",
  "ci.evaluate",
  "round.start",
  "review.start",
  "review.post",
  "reviewers.refresh",
  "changes.reopen",
  "draft.apply",
  "environment.propose",
  "profiles.seed-built-in",
  // ---- milestone 8 (spec section 5.4, ADR 0069) ----
  "library.check-updates",
  "library.seed-sources",
  "library.cleanup",
  // ---- milestone 8 (spec section 5.4, ADR 0068): previews ----
  "preview.views-sweep",
  "preview.codes-sweep",
] as const;

export type JobName = (typeof jobNames)[number];

/** Each job's payload. */
export const jobPayloadSchemas = {
  /** Lease the task to a runner and send the `dispatch` command (ticket 26). Keyed by the epoch it grants. */
  "task.dispatch": z.strictObject({ ...taskScope, sessionId: sessionIdSchema, leaseEpoch: leaseEpochSchema }),
  /** A dispatch not accepted within the offer timeout goes back to the queue (ADR 0034). */
  "task.offer-timeout": z.strictObject({ ...taskScope, leaseEpoch: leaseEpochSchema }),
  /** The peer was gone for the whole task grace: stop the task cleanly, refuse later writes (F-045). */
  "task.grace": z.strictObject({ ...taskScope, leaseEpoch: leaseEpochSchema }),
  /** React to a stored `session.ended` (ticket 27). Keyed by that event's task seq. */
  "task.session-ended": z.strictObject({ ...taskScope, sessionId: sessionIdSchema, eventSeq: taskSeqSchema }),
  /** Open one PR per changed repo, idempotent per task repo (F-030, ticket 27). */
  "task.open-pull-requests": z.strictObject({ ...taskScope, sessionId: sessionIdSchema, eventSeq: taskSeqSchema }),
  /** Refresh a provider's model list from its endpoint (F-088, ticket 28). */
  "provider.refresh-models": z.strictObject({ organizationId: organizationIdSchema, providerId: providerIdSchema }),
  /** The daily models.dev catalog fetch, unless `OSTRA_CATALOG_FETCH` is off (F-088, ticket 28). */
  "catalog.refresh": z.strictObject({}),

  // ---- milestone 2 ----
  /**
   * Act on a webhook the inbox saved (ticket 13): the delivery row, found by its connection and
   * the vendor's delivery ID. The body stays in the row; the payload holds IDs only.
   */
  "webhook.process": z.strictObject({
    organizationId: organizationIdSchema,
    connectionId: connectionIdSchema,
    deliveryId: webhookDeliveryIdSchema,
  }),
  /** One poll of a board's tickets updated since its cursor (F-042, ticket 14). An idempotent pass: a schedule. */
  "tracker.poll-board": z.strictObject({ organizationId: organizationIdSchema, boardId: boardIdSchema }),
  /** The PR states of a GitHub connection's task repos with an open PR (F-044, ticket 16). An idempotent pass. */
  "github.reconcile-prs": z.strictObject({ organizationId: organizationIdSchema, connectionId: connectionIdSchema }),
  /** Refresh a Linear connection's access token before it expires (F-005, ticket 08). */
  "linear.refresh-token": z.strictObject({ organizationId: organizationIdSchema, connectionId: connectionIdSchema }),
  /** Read a ticket task's context, copy its images, render its prompt, then dispatch (F-064, ticket 18). */
  "ticket.fetch-context": z.strictObject({ ...taskScope, sessionId: sessionIdSchema }),
  /** Apply one `TicketWrite` through the tracker adapter (F-031, ticket 15). */
  "ticket.sync": z.strictObject({ organizationId: organizationIdSchema, ticketWriteId: ticketWriteIdSchema }),
  /** A session's longest life (F-068, ticket 19): one delayed job per session, cancelled when it ends. */
  "session.max-duration": z.strictObject({ ...taskScope, sessionId: sessionIdSchema }),
  /** Once a minute: stop the running sessions with no agent event for the stall time (F-068, ticket 19). */
  "session.stall-sweep": z.strictObject({}),
  /** Send a box's runner the `release` command, and delete the task's hidden refs (F-079, ticket 20). */
  "box.release": z.strictObject({ ...taskScope, boxId: boxIdSchema, reason: boxReleaseReasonSchema }),
  /** A stopped box released after `OSTRA_BOX_RELEASE_IDLE_DAYS` (F-079, ticket 20): one delayed job per box. */
  "box.release-after-idle": z.strictObject({ ...taskScope, boxId: boxIdSchema }),
  /** Delete what the retention in effect no longer keeps (F-079, ticket 20). */
  "retention.sweep": z.strictObject({}),
  /** Delete blobs no task or session refers to any more (F-114, ticket 12). */
  "blob.gc": z.strictObject({}),

  // ---- milestone 3 ----
  /**
   * An item was created, answered or dismissed (F-036, ticket 20): resolve its audience, write the
   * notifications and their deliveries. A test mail has a notification and no item.
   */
  "notify.fanout": z.strictObject({
    organizationId: organizationIdSchema,
    needsYouItemId: needsYouItemIdSchema.nullable(),
    notificationId: notificationIdSchema.nullable(),
    change: z.enum(["created", "answered", "dismissed"]),
  }),
  /** Send one delivery through its channel's adapter (tickets 20, 21); email's is delayed by the setting. */
  "notify.deliver": z.strictObject({ organizationId: organizationIdSchema, deliveryId: notificationDeliveryIdSchema }),
  /**
   * Fetch and cache a repo's compare of a base and a head (F-027, ticket 22). `baseSha: null` (added
   * 2026-11-19, ticket 22) compares on the task repo's base branch, from the merge base the code host
   * finds: ostra keeps no base SHA, and a head's diff then never changes.
   */
  "diff.fetch": z.strictObject({ ...taskScope, repoId: repoIdSchema, baseSha: gitShaSchema.nullable(), headSha: gitShaSchema }),
  /** Recompute every open task repo's `behind` from the compare (F-070, ticket 24). An idempotent pass: a schedule. */
  "task.reconcile-behind": z.strictObject({}),
  /** Act on an `@ostra` PR comment the inbox saved (F-053, ticket 25), by its connection and the host's comment ID. */
  "github.comment": z.strictObject({
    organizationId: organizationIdSchema,
    connectionId: connectionIdSchema,
    commentId: z.string().min(1).max(64).regex(/^[0-9]+$/, "a code host's comment ID"),
  }),
  /**
   * Build a project's snapshot (F-051, ticket 26): the environment changed, a lockfile moved, the
   * nightly, or a project admin pressed Rebuild (`rebuild`, which the panel's "Why" names).
   */
  "snapshot.schedule": z.strictObject({
    organizationId: organizationIdSchema,
    projectId: projectIdSchema,
    reason: z.enum(["environment-changed", "lockfile-changed", "nightly", "rebuild"]),
  }),
  /** Once a night: schedule a snapshot for each project whose default branch moved (F-051, ticket 26). */
  "snapshot.nightly": z.strictObject({}),
  /** Revoke the CLI sessions past their expiry (F-103, ticket 39). */
  "cli-session.expire": z.strictObject({}),

  // ---- milestone 4 ----
  /**
   * Send one account mail (F-002, F-115, ticket 19): an invitation (its ID), a verification (the
   * membership's ID) or a reset (the reset link's ID). The link is made when it's sent, never stored here.
   */
  "account-mail.send": z.strictObject({
    organizationId: organizationIdSchema,
    purpose: z.enum(["invitation", "email_verification", "password_reset"]),
    recordId: z.string().min(1).max(64).regex(/^\S+$/, "an ID"),
  }),
  /** Mark the invitations past their expiry (F-002, ticket 22). A sweep. */
  "invitation.expire": z.strictObject({}),
  /** Send a budget's notice for a month and threshold, once (F-037, ticket 13). */
  "budget.check": z.strictObject({
    organizationId: organizationIdSchema,
    budgetId: budgetIdSchema,
    month: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
    threshold: z.enum(["warn", "reached"]),
  }),
  /** Release a budget's held turns and waiting tasks in the order they were held (F-037, ticket 13). */
  "budget.release": z.strictObject({ organizationId: organizationIdSchema, budgetId: budgetIdSchema, raisedAt: epochMsSchema }),
  /** A new month began: a `budget.release` for every budget (F-037, ticket 13). A schedule. */
  "budget.new-month": z.strictObject({}),
  /** Recompute every organization's last two days of Insights and any changed day (F-108, ticket 14). An idempotent pass: a schedule. */
  "insights.compute": z.strictObject({}),
  /** Write a task's search entries, idempotent per entry (F-080, ticket 11). */
  "search.backfill": z.strictObject(taskScope),
  /** Set the "Related" section of every PR of a task when one opens (F-098, ticket 17). */
  "pr.link-related": z.strictObject({ ...taskScope, repoId: repoIdSchema, prNumber: z.number().int().positive() }),
  /** Evaluate a task PR's independent-review check on its head (F-104, ticket 18). */
  "review.evaluate": z.strictObject({
    organizationId: organizationIdSchema,
    taskRepoId: taskRepoIdSchema,
    prNumber: z.number().int().positive(),
    headSha: gitShaSchema,
  }),
  /** Release a project's idle boxes that hold a key its list no longer allows (F-135, ticket 48). */
  "providers.release-boxes": z.strictObject({ organizationId: organizationIdSchema, projectId: projectIdSchema, changedAt: epochMsSchema }),

  // ---- milestone 5 ----
  /**
   * Admit what fits from a pool's queue (F-067, ticket 13): enqueued by every change that can free
   * or need room, plus a sweep every `OSTRA_QUEUE_SWEEP_SECONDS`, one per pool at a time.
   */
  "queue.admit": z.strictObject({ organizationId: organizationIdSchema, poolId: poolIdSchema }),
  /** Tell the organization's admins a runner joined, and whether it waits for approval (F-091, ticket 12). */
  "runner.join-notice": z.strictObject({ organizationId: organizationIdSchema, runnerId: runnerIdSchema }),
  /** Check the organization's registry with its settings at `version` (F-120, ticket 17): nothing is pushed. */
  "registry.check": z.strictObject({ organizationId: organizationIdSchema, registryId: registryIdSchema, version: epochMsSchema }),
  // ---- milestone 6 (spec section 5.4, ADR 0056 to 0058) ----
  /** One pass a minute over the due schedules (F-106): each occurrence a row, inserted once with its job. */
  "scheduler.tick": z.strictObject({}),
  /** An occurrence's start through `startTask`, or its skip. Keyed by the automation and the occurrence's time. */
  "automation.occurrence": z.strictObject({ organizationId: organizationIdSchema, automationId: automationIdSchema, occurrenceAt: epochMsSchema }),
  /** The enabled rules a ticket starts to match (F-011). Keyed by the ticket and the read that changed it. */
  "intake.match": z.strictObject({ organizationId: organizationIdSchema, ticketId: ticketIdSchema, trackerUpdatedAt: epochMsSchema }),
  /** One ticket of a bulk start, in its own transaction (F-107). */
  "bulk.start-item": z.strictObject({ organizationId: organizationIdSchema, bulkStartItemId: bulkStartItemIdSchema }),
  /** A Linear agent session's event, claimed before the 200 (F-012). The body stays in the delivery's row. */
  "linear.agent-event": z.strictObject({ organizationId: organizationIdSchema, connectionId: connectionIdSchema, deliveryId: webhookDeliveryIdSchema }),
  /** One outbox post to an agent session, with the app's token. */
  "linear.activity.send": z.strictObject({ organizationId: organizationIdSchema, agentActivityId: agentActivityIdSchema }),
  /** The heartbeat sweep, once a minute: a post for each session whose heartbeat is due. */
  "linear.heartbeat": z.strictObject({}),
  /**
   * A head's CI verdict (F-035), on a check webhook or the reconcile. `deadline`: the delayed
   * evaluation at the "no CI" deadline or the wait limit, keyed apart so a waiting timer never
   * holds back a webhook's evaluation under the queue's one-per-key rule.
   */
  "ci.evaluate": z.strictObject({ organizationId: organizationIdSchema, taskRepoId: taskRepoIdSchema, headSha: gitShaSchema, deadline: z.enum(["none", "wait"]).optional() }),
  /**
   * A fixing round (F-035, F-101, F-105). `causeRef` names what caused it: the head (CI), the review
   * run (findings) or the review (changes requested). An ID, never text.
   */
  "round.start": z.strictObject({ ...taskScope, kind: roundKindSchema, causeRef: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/) }),
  /** A code task's review round: its review task made or reopened (F-100). */
  "review.start": z.strictObject({ organizationId: organizationIdSchema, codeTaskId: taskIdSchema, round: z.number().int().positive() }),
  /** One comment-type review for one PR of a review run. */
  "review.post": z.strictObject({ organizationId: organizationIdSchema, reviewRunId: reviewRunIdSchema, repoId: repoIdSchema }),
  /** A PR's requested reviewers and code owners, matched through the GitHub link (F-102). */
  "reviewers.refresh": z.strictObject({ organizationId: organizationIdSchema, taskRepoId: taskRepoIdSchema }),
  /** A "changes requested" review that may reopen the task (F-105). `reviewId` is the code host's. */
  "changes.reopen": z.strictObject({ organizationId: organizationIdSchema, taskRepoId: taskRepoIdSchema, reviewId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) }),
  /** "Update ticket" with a draft's version, through the ticket outbox (F-099). */
  "draft.apply": z.strictObject({ organizationId: organizationIdSchema, draftId: draftIdSchema, version: z.number().int().positive() }),
  /** An environment proposal's notice to the project's admins (F-113). */
  "environment.propose": z.strictObject({ organizationId: organizationIdSchema, proposalId: environmentProposalIdSchema }),
  /** The built-in Refine and Review profiles, once per organization. */
  "profiles.seed-built-in": z.strictObject({ organizationId: organizationIdSchema }),
  // ---- milestone 8 (spec section 5.4, ADR 0069) ----
  /**
   * The library's update check (F-145): each item of an organization, once in each window of
   * `OSTRA_LIBRARY_UPDATE_HOURS` (`windowStart`, the window's first ms), or one item when an admin
   * presses "Check for updates" (`itemId`).
   */
  "library.check-updates": z.union([
    z.strictObject({ organizationId: organizationIdSchema, windowStart: epochMsSchema }),
    z.strictObject({ organizationId: organizationIdSchema, itemId: libraryItemIdSchema }),
  ]),
  /** GitHub's MCP registry on the organization's allowlist of sources (Q324): when it's seeded, and once for each existing one. */
  "library.seed-sources": z.strictObject({ organizationId: organizationIdSchema }),
  /**
   * Deletes the library files no version in use names, and the secret inputs of removed items and
   * of versions out of use, once a day, for every organization (ADR 0069, a follow-up to ticket 28).
   */
  "library.cleanup": z.strictObject({}),
  /** Closes the views with no heartbeat for 2 minutes (F-141), once a minute. */
  "preview.views-sweep": z.strictObject({}),
  /** Removes the used and expired one-time codes and CLI tickets (F-143, F-144), once a day. */
  "preview.codes-sweep": z.strictObject({}),
} as const satisfies Record<JobName, z.ZodType>;

export type JobPayload<N extends JobName> = z.infer<(typeof jobPayloadSchemas)[N]>;

/** Each job's key rule. */
const jobKeys: { readonly [N in JobName]: (payload: JobPayload<N>) => string } = {
  "task.dispatch": (payload) => `task:${payload.taskId}:dispatch:${String(payload.leaseEpoch)}`,
  "task.offer-timeout": (payload) => `task:${payload.taskId}:offer-timeout:${String(payload.leaseEpoch)}`,
  "task.grace": (payload) => `task:${payload.taskId}:grace:${String(payload.leaseEpoch)}`,
  "task.session-ended": (payload) => `task:${payload.taskId}:session-ended:${String(payload.eventSeq)}`,
  "task.open-pull-requests": (payload) => `task:${payload.taskId}:open-pull-requests:${String(payload.eventSeq)}`,
  "provider.refresh-models": (payload) => `provider:${payload.providerId}:refresh-models`,
  "catalog.refresh": () => "catalog:refresh",
  "webhook.process": (payload) => `webhook:${payload.connectionId}:${payload.deliveryId}`,
  "tracker.poll-board": (payload) => `board:${payload.boardId}:poll`,
  "github.reconcile-prs": (payload) => `connection:${payload.connectionId}:reconcile-prs`,
  "linear.refresh-token": (payload) => `connection:${payload.connectionId}:refresh-token`,
  "ticket.fetch-context": (payload) => `task:${payload.taskId}:fetch-context:${payload.sessionId}`,
  "ticket.sync": (payload) => `ticket:${payload.ticketWriteId}:sync`,
  "session.max-duration": (payload) => `session:${payload.sessionId}:max-duration`,
  "session.stall-sweep": () => "sessions:stall-sweep",
  "box.release": (payload) => `box:${payload.boxId}:release`,
  "box.release-after-idle": (payload) => `box:${payload.boxId}:release-after-idle`,
  "retention.sweep": () => "retention:sweep",
  "blob.gc": () => "blob:gc",
  "notify.fanout": (payload) =>
    payload.needsYouItemId === null
      ? `notification:${payload.notificationId ?? "none"}:fanout:${payload.change}`
      : `item:${payload.needsYouItemId}:fanout:${payload.change}`,
  "notify.deliver": (payload) => `delivery:${payload.deliveryId}:deliver`,
  "diff.fetch": (payload) => `repo:${payload.repoId}:diff:${payload.baseSha ?? "merge-base"}:${payload.headSha}`,
  "task.reconcile-behind": () => "tasks:reconcile-behind",
  "github.comment": (payload) => `connection:${payload.connectionId}:comment:${payload.commentId}`,
  "snapshot.schedule": (payload) => `project:${payload.projectId}:snapshot:${payload.reason}`,
  "snapshot.nightly": () => "snapshots:nightly",
  "cli-session.expire": () => "cli-sessions:expire",
  // An invitation's ID is its link's secret (ADR 0053), and a job's key reaches log lines: its hash.
  "account-mail.send": (payload) => `account-mail:${payload.purpose}:${createHash("sha256").update(payload.recordId).digest("hex").slice(0, 32)}`,
  "invitation.expire": () => "invitations:expire",
  "budget.check": (payload) => `budget:${payload.budgetId}:${payload.month}:${payload.threshold}`,
  "budget.release": (payload) => `budget:${payload.budgetId}:release:${String(payload.raisedAt)}`,
  "budget.new-month": () => "budget:new-month",
  "insights.compute": () => "insights:compute",
  "search.backfill": (payload) => `task:${payload.taskId}:search-backfill`,
  "pr.link-related": (payload) => `task:${payload.taskId}:link-related:${payload.repoId}:${String(payload.prNumber)}`,
  "review.evaluate": (payload) => `pr:${payload.taskRepoId}:${String(payload.prNumber)}:review:${payload.headSha}`,
  "providers.release-boxes": (payload) => `project:${payload.projectId}:release-boxes:${String(payload.changedAt)}`,
  "queue.admit": (payload) => `pool:${payload.poolId}:admit`,
  "runner.join-notice": (payload) => `runner:${payload.runnerId}:join-notice`,
  "registry.check": (payload) => `organization:${payload.organizationId}:registry-check:${String(payload.version)}`,
  "scheduler.tick": () => "scheduler:tick",
  "automation.occurrence": (payload) => `automation:${payload.automationId}:occurrence:${String(payload.occurrenceAt)}`,
  "intake.match": (payload) => `ticket:${payload.ticketId}:intake-match:${String(payload.trackerUpdatedAt)}`,
  "bulk.start-item": (payload) => `bulk-item:${payload.bulkStartItemId}:start`,
  "linear.agent-event": (payload) => `linear:${payload.connectionId}:agent-event:${payload.deliveryId}`,
  "linear.activity.send": (payload) => `activity:${payload.agentActivityId}:send`,
  "linear.heartbeat": () => "linear:heartbeat",
  "ci.evaluate": (payload) => `task-repo:${payload.taskRepoId}:ci:${payload.headSha}${payload.deadline === undefined ? "" : `:${payload.deadline}`}`,
  "round.start": (payload) => `task:${payload.taskId}:round:${payload.kind}:${payload.causeRef}`,
  "review.start": (payload) => `task:${payload.codeTaskId}:review:${String(payload.round)}`,
  "review.post": (payload) => `review-run:${payload.reviewRunId}:post:${payload.repoId}`,
  "reviewers.refresh": (payload) => `task-repo:${payload.taskRepoId}:reviewers`,
  "changes.reopen": (payload) => `task-repo:${payload.taskRepoId}:changes-reopen:${payload.reviewId}`,
  "draft.apply": (payload) => `draft:${payload.draftId}:apply:${String(payload.version)}`,
  "environment.propose": (payload) => `proposal:${payload.proposalId}:propose`,
  "profiles.seed-built-in": (payload) => `organization:${payload.organizationId}:seed-built-in-profiles`,
  "library.check-updates": (payload) =>
    "itemId" in payload ? `library-item:${payload.itemId}:check-updates` : `organization:${payload.organizationId}:library-check-updates:${String(payload.windowStart)}`,
  "library.seed-sources": (payload) => `organization:${payload.organizationId}:library-seed-sources`,
  "library.cleanup": () => "library:cleanup",
  "preview.views-sweep": () => "previews:views-sweep",
  "preview.codes-sweep": () => "previews:codes-sweep",
};

/** How a job is sent (ADR 0037, as amended after spike 8). */
export type JobSending = {
  /**
   * `event`: sent in the transaction of what caused it. `schedule`: an idempotent pass a pg-boss
   * schedule may send, with `singletonSeconds` so a tick isn't sent twice. `timer`: one delayed
   * job per key, cancelled when its subject ends.
   */
  readonly kind: "event" | "schedule" | "timer";
  /** The group a job's concurrency is throttled by, per connection: a throttle, never a budget. */
  readonly throttle?: "connection";
};

export const jobSending: Readonly<Record<JobName, JobSending>> = {
  "task.dispatch": { kind: "event" },
  "task.offer-timeout": { kind: "timer" },
  "task.grace": { kind: "timer" },
  "task.session-ended": { kind: "event" },
  "task.open-pull-requests": { kind: "event" },
  "provider.refresh-models": { kind: "event" },
  "catalog.refresh": { kind: "schedule" },
  "webhook.process": { kind: "event" },
  "tracker.poll-board": { kind: "schedule", throttle: "connection" },
  "github.reconcile-prs": { kind: "schedule", throttle: "connection" },
  "linear.refresh-token": { kind: "timer" },
  "ticket.fetch-context": { kind: "event" },
  "ticket.sync": { kind: "event", throttle: "connection" },
  "session.max-duration": { kind: "timer" },
  "session.stall-sweep": { kind: "schedule" },
  "box.release": { kind: "event" },
  "box.release-after-idle": { kind: "timer" },
  "retention.sweep": { kind: "schedule" },
  "blob.gc": { kind: "schedule" },
  "notify.fanout": { kind: "event" },
  // Email's delivery waits OSTRA_EMAIL_DELAY_SECONDS: sent with that delay, in the fan-out's transaction.
  "notify.deliver": { kind: "event" },
  "diff.fetch": { kind: "event", throttle: "connection" },
  "task.reconcile-behind": { kind: "schedule" },
  "github.comment": { kind: "event" },
  // Several reasons a minute apart build once (`snapshotScheduleSingletonSeconds`).
  "snapshot.schedule": { kind: "event" },
  "snapshot.nightly": { kind: "schedule" },
  "cli-session.expire": { kind: "schedule" },
  "account-mail.send": { kind: "event" },
  "invitation.expire": { kind: "schedule" },
  "budget.check": { kind: "event" },
  "budget.release": { kind: "event" },
  "budget.new-month": { kind: "schedule" },
  "insights.compute": { kind: "schedule" },
  "search.backfill": { kind: "event" },
  "pr.link-related": { kind: "event", throttle: "connection" },
  // Reviews, a push and a link a moment apart evaluate once (`reviewEvaluateSingletonSeconds`).
  "review.evaluate": { kind: "event", throttle: "connection" },
  "providers.release-boxes": { kind: "event" },
  // Sent by every change that can free or need room, one per pool a second
  // (`queueAdmitSingletonSeconds`); the sweep sends it on a schedule as well.
  "queue.admit": { kind: "event" },
  "runner.join-notice": { kind: "event" },
  "registry.check": { kind: "event" },
  // A pg-boss schedule every minute; the tick is idempotent, each occurrence a unique row.
  "scheduler.tick": { kind: "schedule" },
  "automation.occurrence": { kind: "event" },
  "intake.match": { kind: "event" },
  "bulk.start-item": { kind: "event" },
  "linear.agent-event": { kind: "event" },
  "linear.activity.send": { kind: "event", throttle: "connection" },
  "linear.heartbeat": { kind: "schedule" },
  // A head's check events a moment apart evaluate once (`ciEvaluateSingletonSeconds`).
  "ci.evaluate": { kind: "event", throttle: "connection" },
  "round.start": { kind: "event" },
  "review.start": { kind: "event" },
  "review.post": { kind: "event", throttle: "connection" },
  // Reviewer changes a moment apart refresh once (`reviewersRefreshSingletonSeconds`).
  "reviewers.refresh": { kind: "event", throttle: "connection" },
  "changes.reopen": { kind: "event" },
  "draft.apply": { kind: "event" },
  "environment.propose": { kind: "event" },
  "profiles.seed-built-in": { kind: "event" },
  // Sent per organization by a pass over the windows, and per item by an admin.
  "library.check-updates": { kind: "event" },
  "library.seed-sources": { kind: "event" },
  // A pg-boss schedule once a day: an idempotent pass.
  "library.cleanup": { kind: "schedule" },
  // A pg-boss schedule every minute (`EVERY_MINUTE_CRON`), and one a day: idempotent passes.
  "preview.views-sweep": { kind: "schedule" },
  "preview.codes-sweep": { kind: "schedule" },
};

/** The window of `OSTRA_LIBRARY_UPDATE_HOURS` a time falls in: its first ms, which keys an organization's check. */
export const libraryUpdateWindowStart = (now: number, updateHours: number): number => {
  const window = updateHours * 3_600_000;
  return Math.floor(now / window) * window;
};

/** `review.evaluate`'s singleton window (spec section 5.4): one evaluation per PR and head in 10 s. */
export const reviewEvaluateSingletonSeconds = 10;

/** `snapshot.schedule`'s singleton window (spec section 5.4): one build per project and reason a minute. */
export const snapshotScheduleSingletonSeconds = 60;

/** `queue.admit`'s singleton window (spec section 5.4): one admission per pool a second. */
export const queueAdmitSingletonSeconds = 1;

/** `ci.evaluate`'s singleton window (milestone 6's spec section 5.4): one verdict per task repo and head in 10 s. */
export const ciEvaluateSingletonSeconds = 10;

/** `reviewers.refresh`'s singleton window: one refresh per task repo in 10 s. */
export const reviewersRefreshSingletonSeconds = 10;

/** `scheduler.tick`'s and `linear.heartbeat`'s pg-boss schedule: every minute. */
export const EVERY_MINUTE_CRON = "* * * * *";

const typedSchemas: { readonly [N in JobName]: z.ZodType<JobPayload<N>> } = jobPayloadSchemas;

/** A job's key, from its payload. */
export const jobKey = <N extends JobName>(job: N, payload: JobPayload<N>): string => jobKeys[job](payload);

/** Parses a job's payload as it comes off the queue (external data: storage). */
export const parseJobPayload = <N extends JobName>(
  job: N,
  payload: unknown,
): { readonly ok: true; readonly payload: JobPayload<N> } | { readonly ok: false } => {
  const parsed = typedSchemas[job].safeParse(payload);
  return parsed.success ? { ok: true, payload: parsed.data } : { ok: false };
};
