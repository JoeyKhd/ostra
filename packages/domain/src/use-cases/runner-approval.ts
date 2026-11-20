import type { Tx } from "@ostra/db";
import { commandKindSupportedAt, runnerLimits } from "@ostra/protocol";
import type { MemberId, OrganizationId, RunnerId } from "@ostra/protocol";

import { runnerFromColumns } from "../lifecycles/mapping.ts";
import { transitionRunner } from "../lifecycles/runner.ts";
import { notifyRunnerInTx, postgresCommandOutbox } from "../postgres-outbox.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { resolveRunnerApprovalNoticesInTx } from "./pool-admin.ts";

// F-091, Q130 (milestone 1's ticket 42): a pool that requires approval keeps a joined runner
// `joining`, with no task, until an admin approves it. Core's `hello` applies the lifecycle's
// `accept` only when `awaitsApproval` is false; an admin's approve or reject is here.
//
// Locks, so an approve and a connection's hello or close can't miss each other: each takes the
// runner's row `FOR UPDATE`. Core's hello and close take the presence row first and the runner's
// row second, and an approve reads presence without a lock after it holds the runner's row, so the
// two orders can't deadlock, and whichever commits second sees what the first wrote.

/** What decides whether a runner may go online. */
export type ApprovalFacts = {
  readonly kind: "personal" | "pool";
  readonly approvedAt: Date | null;
  readonly poolRequiresApproval: boolean;
};

/** Whether a runner waits for an admin's approval before it may go online. */
export const awaitsApproval = (facts: ApprovalFacts): boolean =>
  facts.kind === "pool" && facts.poolRequiresApproval && facts.approvedAt === null;

export type RunnerDecisionDeps = Pick<Ports, "notices" | "audit" | "clock"> & { readonly tx: Tx };

export type RunnerDecisionInput = {
  readonly organizationId: OrganizationId;
  readonly runnerId: RunnerId;
  readonly memberId: MemberId;
};

export type ApproveRunnerResult = UseCaseResult<{ readonly state: "joining" | "online" }, "not-found" | "not-joining">;
export type RejectRunnerResult = UseCaseResult<{ readonly state: "revoked"; readonly wasConnected: boolean }, "not-found" | "not-joining">;

/** The runner's row, locked, in its organization; `null` when it isn't there. */
const lockRunner = async (tx: Tx, organizationId: OrganizationId, runnerId: RunnerId) => {
  await tx.$queryRaw`SELECT 1 FROM "runner" WHERE "id" = ${runnerId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  return tx.runner.findFirst({
    where: { id: runnerId, organizationId },
    select: { state: true, revokedAt: true, approvedAt: true },
  });
};

/** Whether the runner has a live connection, as the presence table says, and the minor it speaks. */
const connectionOf = async (tx: Tx, runnerId: RunnerId): Promise<{ readonly connected: boolean; readonly minor: number }> => {
  const presence = await tx.runnerPresence.findUnique({ where: { runnerId }, select: { disconnectedAt: true, minor: true } });
  return { connected: presence !== null && presence.disconnectedAt === null, minor: presence?.minor ?? 0 };
};

/** Whether the runner has a live connection, as the presence table says. */
const isConnected = async (tx: Tx, runnerId: RunnerId): Promise<boolean> => (await connectionOf(tx, runnerId)).connected;

/** An admin approves a joining runner: online now when it's connected, else at its next hello. */
export const approveRunner = async (deps: RunnerDecisionDeps, input: RunnerDecisionInput): Promise<ApproveRunnerResult> => {
  const { tx } = deps;
  const row = await lockRunner(tx, input.organizationId, input.runnerId);
  if (row === null) {
    return { ok: false, error: "not-found", message: "No such runner" };
  }
  if (row.state !== "joining" || row.revokedAt !== null) {
    return { ok: false, error: "not-joining", message: `The runner is ${row.state}: only a joining runner is approved` };
  }
  const now = new Date(deps.clock.now());
  let state: "joining" | "online" = "joining";
  const connection = await connectionOf(tx, input.runnerId);
  if (connection.connected) {
    const before = runnerFromColumns({ state: row.state });
    const moved = before.ok ? transitionRunner(before.value, { type: "accept" }) : null;
    if (moved?.ok === true && moved.state.state === "online") {
      state = "online";
    }
  }
  await tx.runner.update({
    where: { id: input.runnerId },
    data: { approvedAt: row.approvedAt ?? now, approvedByMemberId: input.memberId, state },
  });
  // Milestone 5 (ticket 19): a connected runner at minor 4 hears it at once. Its welcome said it
  // waited for approval; `resume` lifts that hold, as it lifts a drain. An older runner, or one
  // that isn't connected, hears it in its next welcome.
  if (state === "online" && commandKindSupportedAt("resume", connection.minor)) {
    await postgresCommandOutbox.enqueueInTx(tx, input.organizationId, input.runnerId, {
      kind: "resume",
      body: {},
      notAfter: deps.clock.now() + runnerLimits.offerTimeoutMs,
      task: null,
    });
  }
  // The admins' open approval notice is answered (milestone 5, ticket 12).
  await resolveRunnerApprovalNoticesInTx(tx, deps, { organizationId: input.organizationId, runnerId: input.runnerId });
  await deps.audit.recordInTx(tx, {
    organizationId: input.organizationId,
    projectId: null,
    actor: { kind: "member", id: input.memberId },
    action: "runner.approved",
    entity: "runner",
    entityId: input.runnerId,
    data: { online: state === "online" },
  });
  await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "runner", entityId: input.runnerId });
  return { ok: true, state };
};

/** An admin rejects a joining runner: revoked, and evicted with 4403 when it's connected. */
export const rejectRunner = async (deps: RunnerDecisionDeps, input: RunnerDecisionInput): Promise<RejectRunnerResult> => {
  const { tx } = deps;
  const row = await lockRunner(tx, input.organizationId, input.runnerId);
  if (row === null) {
    return { ok: false, error: "not-found", message: "No such runner" };
  }
  const before = runnerFromColumns({ state: row.state });
  const moved = before.ok ? transitionRunner(before.value, { type: "reject" }) : null;
  if (moved?.ok !== true || row.revokedAt !== null) {
    return { ok: false, error: "not-joining", message: `The runner is ${row.state}: only a joining runner is rejected` };
  }
  const wasConnected = await isConnected(tx, input.runnerId);
  await tx.runner.update({
    where: { id: input.runnerId },
    data: { state: moved.state.state, revokedAt: new Date(deps.clock.now()) },
  });
  // Every replica that holds its connection sends `evict` and closes with 4403.
  await notifyRunnerInTx(tx, { kind: "revoked", runnerId: input.runnerId });
  await resolveRunnerApprovalNoticesInTx(tx, deps, { organizationId: input.organizationId, runnerId: input.runnerId });
  await deps.audit.recordInTx(tx, {
    organizationId: input.organizationId,
    projectId: null,
    actor: { kind: "member", id: input.memberId },
    action: "runner.rejected",
    entity: "runner",
    entityId: input.runnerId,
    data: { connected: wasConnected },
  });
  await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "runner", entityId: input.runnerId });
  return { ok: true, state: "revoked", wasConnected };
};
