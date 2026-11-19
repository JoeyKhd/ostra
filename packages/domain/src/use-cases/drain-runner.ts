import type { Db, Tx } from "@ostra/db";
import { commandKindSupportedAt, poolIdSchema, projectIdSchema, runnerIdSchema, runnerLimits, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, RunnerId } from "@ostra/protocol";
import { z } from "zod";

import { requireOrganizationAdmin } from "../access.ts";
import { runnerFromColumns } from "../lifecycles/mapping.ts";
import { transitionRunner } from "../lifecycles/runner.ts";
import type { Ports } from "../ports.ts";
import type { DrainRunner, ResumeRunner } from "./m5-signatures.ts";
import { appendServerEvent } from "./server-events.ts";

// Drain and resume (F-092, ADR 0029 "Drain, resume and revoke", Q108; milestone 5's ticket 15).
//
// - A drain is an admin's hold on a runner: `draining`, with who and when, a `drain` command
//   through the outbox, the audit entry and the server-only `runner.drained` on the timeline of
//   each task the runner holds. Its running tasks finish; nothing offers it a task, because offers
//   go to `online` runners only, so the hold is the server's and needs nothing from the runner.
// - The hold is the row's: a disconnect, a reconnect, the runner's restart and every core
//   replica's restart leave it `draining` (the lifecycle's `disconnected` and `reconnected` keep
//   it, and `hello` applies only those).
// - A resume moves it to `online` when its connection is live and `offline` otherwise, sends
//   `resume` to a runner at minor 4 or later (a minor-3 runner has no such command, and takes
//   tasks again after it restarts), writes `runner.resumed`, and asks its pool's admission to run.
// - Admins only, for any runner of the organization: a member stops their own personal runner
//   instead.
//
// Locks: the runner's row, `FOR UPDATE`, as approve and revoke take it; the presence row is read
// after it without a lock, as approve does (`runner-approval.ts`), so a hello or a close that holds
// presence and waits for the runner's row can't deadlock with it.

/** What a drain or a resume needs: the signatures' `M5Deps`, of which they use these. */
export type DrainDeps = { readonly db: Db } & Pick<Ports, "notices" | "audit" | "clock" | "outbox" | "jobs">;

const lockedRunnerSchema = z.looseObject({
  state: z.enum(["joining", "online", "offline", "draining", "revoked"]),
  revokedAt: z.date().nullable(),
  kind: z.enum(["personal", "pool"]),
  poolId: z.string().nullable(),
  minor: z.number().int().nullable(),
});

/** The runner's row, locked, in its organization; `null` when it isn't there. */
const lockRunner = async (tx: Tx, organizationId: OrganizationId, runnerId: RunnerId) => {
  const rows = await tx.$queryRaw<readonly unknown[]>`
    SELECT "state", "revokedAt", "kind", "poolId", "minor" FROM "runner"
    WHERE "id" = ${runnerId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  return rows.length === 0 ? null : lockedRunnerSchema.parse(rows[0]);
};

/** A signature's arguments after its deps. */
type Rest<F> = F extends (deps: never, ...rest: infer R) => unknown ? R : never;

const ACTIVE_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

/** `runner.drained` or `runner.resumed` on the timeline of each task the runner holds a lease of. */
const recordOnTasks = async (
  tx: Tx,
  organizationId: OrganizationId,
  runnerId: RunnerId,
  event: { readonly kind: "runner.drained" | "runner.resumed"; readonly memberId: MemberId },
  at: number,
): Promise<number> => {
  const leases = await tx.lease.findMany({
    where: { runnerId, organizationId, state: "active" },
    select: { taskId: true, task: { select: { projectId: true } } },
    orderBy: { taskId: "asc" },
  });
  let written = 0;
  for (const lease of leases) {
    const session = await tx.session.findFirst({
      where: { taskId: lease.taskId, organizationId, state: { in: [...ACTIVE_SESSION_STATES] } },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (session === null) {
      continue;
    }
    await appendServerEvent(tx, {
      organizationId,
      projectId: projectIdSchema.parse(lease.task.projectId),
      taskId: taskIdSchema.parse(lease.taskId),
      sessionId: sessionIdSchema.parse(session.id),
      event,
      at,
    });
    written += 1;
  }
  return written;
};

/** An admin drains a runner: it takes no new task, and its running ones finish. */
export const drainRunner = (deps: DrainDeps, ...[scope, input]: Rest<DrainRunner>): ReturnType<DrainRunner> =>
  deps.db.$transaction(async (tx) => {
  const organizationId = scope.organizationId;
  const access = requireOrganizationAdmin(scope, organizationId);
  if (!access.ok) {
    return { ok: false, error: "forbidden", message: "Only an admin drains a runner; stop your own runner instead" };
  }
  const row = await lockRunner(tx, organizationId, input.runnerId);
  if (row === null) {
    return { ok: false, error: "not-found", message: "No such runner" };
  }
  const before = runnerFromColumns({ state: row.state });
  const moved = before.ok && row.revokedAt === null ? transitionRunner(before.value, { type: "drain" }) : null;
  if (moved?.ok !== true || moved.state.state !== "draining") {
    return { ok: false, error: "not-allowed-in-state", message: `The runner is ${row.state}: only an online or offline runner is drained` };
  }
  const now = deps.clock.now();
  await tx.runner.update({
    where: { id: input.runnerId },
    data: { state: "draining", drainedAt: new Date(now), drainedByMemberId: scope.memberId },
  });
  // Every minor has `drain`: the runner stops asking for work, and finishes what it holds.
  await deps.outbox.enqueueInTx(tx, organizationId, input.runnerId, {
    kind: "drain",
    body: {},
    notAfter: now + runnerLimits.offerTimeoutMs,
    task: null,
  });
  const tasks = await recordOnTasks(tx, organizationId, input.runnerId, { kind: "runner.drained", memberId: scope.memberId }, now);
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: null,
    actor: { kind: "member", id: scope.memberId },
    action: "runner.drained",
    entity: "runner",
    entityId: input.runnerId,
    data: { from: row.state, runningTasks: tasks },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner", entityId: input.runnerId });
  return { ok: true as const, state: "draining" as const };
  });

/** An admin lifts a drain: online when connected, offline otherwise, and its pool's queue is looked at again. */
export const resumeRunner = (deps: DrainDeps, ...[scope, input]: Rest<ResumeRunner>): ReturnType<ResumeRunner> =>
  deps.db.$transaction(async (tx) => {
  const organizationId = scope.organizationId;
  const access = requireOrganizationAdmin(scope, organizationId);
  if (!access.ok) {
    return { ok: false, error: "forbidden", message: "Only an admin resumes a runner" };
  }
  const row = await lockRunner(tx, organizationId, input.runnerId);
  if (row === null) {
    return { ok: false, error: "not-found", message: "No such runner" };
  }
  if (row.state !== "draining" || row.revokedAt !== null) {
    return { ok: false, error: "not-draining", message: `The runner is ${row.state}: only a draining runner is resumed` };
  }
  const presence = await tx.runnerPresence.findUnique({ where: { runnerId: input.runnerId }, select: { disconnectedAt: true, minor: true } });
  const connected = presence !== null && presence.disconnectedAt === null;
  const moved = transitionRunner({ state: "draining" }, { type: "resume", connected });
  if (!moved.ok || (moved.state.state !== "online" && moved.state.state !== "offline")) {
    throw new Error("a draining runner refused the resume");
  }
  const state = moved.state.state;
  const now = deps.clock.now();
  await tx.runner.update({
    where: { id: input.runnerId },
    data: { state, drainedAt: null, drainedByMemberId: null },
  });
  // The minor its newest connection spoke, or the one it last reported: a runner before minor 4
  // has no `resume`, and takes tasks again after it restarts.
  const minor = presence?.minor ?? row.minor ?? 0;
  const commandSent = commandKindSupportedAt("resume", minor);
  if (commandSent) {
    await deps.outbox.enqueueInTx(tx, organizationId, input.runnerId, {
      kind: "resume",
      body: {},
      notAfter: now + runnerLimits.offerTimeoutMs,
      task: null,
    });
  }
  await recordOnTasks(tx, organizationId, input.runnerId, { kind: "runner.resumed", memberId: scope.memberId }, now);
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: null,
    actor: { kind: "member", id: scope.memberId },
    action: "runner.resumed",
    entity: "runner",
    entityId: input.runnerId,
    data: { to: state, commandSent, minor },
  });
  // A runner back online is room: its pool's admission runs (ticket 13 works the job).
  if (row.kind === "pool" && row.poolId !== null) {
    await deps.jobs.enqueueInTx(tx, "queue.admit", { organizationId, poolId: poolIdSchema.parse(row.poolId) });
  }
  await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner", entityId: runnerIdSchema.parse(input.runnerId) });
  return { ok: true as const, state, commandSent };
  });
