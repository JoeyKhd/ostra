import type { Db, Tx } from "@ostra/db";
import {
  cliSessionIdSchema,
  commandKindSupportedOn,
  loginSessionIdSchema,
  memberIdSchema,
  organizationIdSchema,
  previewKeySchema,
  previewLinkIdSchema,
  previewViewIdSchema,
  projectIdSchema,
  runnerLimits,
  taskIdSchema,
} from "@ostra/protocol";
import type { CliSessionId, LoginSessionId, MemberId, OrganizationId, PreviewKey, PreviewViewId, ProjectId, TaskId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { Clock, Ports } from "../ports.ts";
import type { PreviewSettings } from "../settings.ts";
import type { IssueCliTicket, RedeemCode } from "../use-cases/m8-preview-signatures.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { mayReach } from "./targets.ts";
import { checkPreviewCode, issuePreviewCode, previewCodeHash } from "./tokens.ts";
import type { PreviewCodeCheck, PreviewCodeRow, RandomBytes } from "./tokens.ts";
import { boxPreviewability, boxWarmHold, canOpenTaskInTx, previewBoxInTx, taskPreviewTargetsInTx, UNKNOWN_RESERVED } from "./views.ts";
import type { PreviewBox } from "./views.ts";

// `ostra preview`'s rows (milestone 8, ticket 23, F-143, ADR 0068 "`ostra preview`"): the ticket the
// web app gives a member's CLI session, its one use at core, which opens a view in `cli` mode with
// its event and sends `preview.open` in `tunnel` mode to the box's runner, and the check core makes
// again while the tunnel lasts. The bytes are core's (`apps/core/src/previews/`). A ticket is a
// bearer secret: kept only as its hash, never logged.

/** Whether the box's runner can carry a tunnel now: minor 7 over a WebSocket, and it says so. */
const canTunnel = (box: PreviewBox): boolean => {
  const can = boxPreviewability(box);
  return can.previewable && can.tunnel && commandKindSupportedOn("preview.open", box.minor, box.carrier);
};

// ---------- the ticket (the web app's CLI route) ----------

type IssueResult = Awaited<ReturnType<IssueCliTicket>>;
type IssueError = Extract<IssueResult, { readonly ok: false }>["error"];

const refusedTicket = (error: IssueError, message: string): IssueResult => ({ ok: false, error, message });

/**
 * A ticket for `ostra preview` (ADR 0068): the session's member can open the task; the task has a
 * live box whose runner can tunnel (minor 7, over a WebSocket); the port is one of its previews,
 * the primary's (else the first's) when none is given, and `mayReach` allows it. The ticket is
 * single use, lasts 60 s, and is bound to the member, the CLI session, the task, the port and the
 * lease epoch. It's shown in the answer once and stored as its hash.
 */
export const issueCliTicket = async (
  deps: Parameters<IssueCliTicket>[0] & { readonly random?: RandomBytes },
  scope: Parameters<IssueCliTicket>[1],
  input: Parameters<IssueCliTicket>[2],
): Promise<IssueResult> => {
  const now = deps.clock.now();
  const organizationId = scope.organizationId;
  return deps.db.$transaction(async (tx): Promise<IssueResult> => {
    const notFound = refusedTicket("not-found", "No task by that name that you can open");
    const session = await tx.cliSession.findFirst({ where: { id: input.cliSessionId, organizationId, memberId: scope.memberId, revokedAt: null }, select: { id: true } });
    const task = await tx.task.findFirst({ where: { id: input.taskId, organizationId }, select: { id: true, projectId: true, project: { select: { access: true } } } });
    if (session === null || task === null) {
      return notFound;
    }
    const taskId = taskIdSchema.parse(task.id);
    const projectId = projectIdSchema.parse(task.projectId);
    if (!requireProjectAccess(scope, { id: projectId, organizationId, access: task.project.access }, "read").ok) {
      return notFound;
    }
    const box = await previewBoxInTx(tx, organizationId, taskId);
    const boxSession = box?.sessionId ?? null;
    if (box === null || boxSession === null) {
      return refusedTicket("no-box", "Nothing runs for this task now: start its app first");
    }
    if (!canTunnel(box)) {
      return refusedTicket("runner-cannot-tunnel", "This task's runner can't open a tunnel: it needs protocol 1.7 or later, over a WebSocket");
    }
    const targets = await taskPreviewTargetsInTx(tx, { id: taskId, organizationId, projectId }, box.executor);
    const port = input.port ?? (targets.find((item) => item.primary) ?? targets[0])?.port ?? null;
    const target = port === null ? undefined : targets.find((item) => item.port === port);
    if (port === null || target === undefined || !mayReach(port, targets, UNKNOWN_RESERVED).ok) {
      return refusedTicket("port-not-allowed", "That port isn't one of this task's previews");
    }
    const issued = issuePreviewCode(
      { kind: "cli_ticket", taskId, key: target.key, port, leaseEpoch: box.leaseEpoch, viewer: { kind: "member", memberId: scope.memberId } },
      now,
      deps.random,
    );
    if (!issued.ok) {
      return notFound;
    }
    await tx.previewCode.create({
      data: {
        organizationId,
        projectId,
        kind: issued.row.kind,
        codeHash: issued.row.codeHash,
        taskId,
        key: issued.row.key,
        port: issued.row.port,
        memberId: issued.row.memberId,
        linkId: null,
        leaseEpoch: issued.row.leaseEpoch,
        expiresAt: issued.row.expiresAt,
        cliSessionId: input.cliSessionId,
      },
    });
    return { ok: true, ticket: issued.code, port, label: target.label, coreUrl: deps.coreUrl };
  });
};
issueCliTicket satisfies IssueCliTicket;

// ---------- a code's or a ticket's one use ----------

/** A code or a ticket redeemed: what `checkPreviewCode` gives, and the rows it's bound to. */
export type RedeemedPreviewCode =
  | (Extract<PreviewCodeCheck, { readonly ok: true }> & {
      readonly organizationId: OrganizationId;
      readonly projectId: ProjectId;
      readonly leaseEpoch: number;
      /** A CLI ticket's CLI session; `null` for a native preview's code. */
      readonly cliSessionId: CliSessionId | null;
      /** A native preview's code for a member: the panel login session it was minted in (ticket 25). */
      readonly loginSessionId: LoginSessionId | null;
    })
  | Extract<PreviewCodeCheck, { readonly ok: false }>;

/**
 * Redeems a code or a ticket in the caller's transaction (ADR 0068): `checkPreviewCode` against the
 * task's current lease epoch, then `usedAt` where it's still unused, so a second use, even a
 * concurrent one, is refused as `used`. The mark commits with the caller's transaction whatever it
 * refuses next: a ticket the server read is spent.
 */
export const redeemPreviewCodeInTx = async (tx: Tx, input: Parameters<RedeemCode>[1], now: number): Promise<RedeemedPreviewCode> => {
  const hash = previewCodeHash(input.code);
  const row = hash === null ? null : await tx.previewCode.findUnique({ where: { codeHash: hash } });
  if (row === null) {
    return { ok: false, reason: "unknown" };
  }
  const task = await tx.task.findFirst({ where: { id: row.taskId, organizationId: row.organizationId }, select: { leaseEpoch: true } });
  if (task === null) {
    return { ok: false, reason: "unknown" };
  }
  const codeRow: PreviewCodeRow = {
    kind: row.kind,
    codeHash: row.codeHash,
    taskId: taskIdSchema.parse(row.taskId),
    key: previewKeySchema.parse(row.key),
    port: row.port,
    memberId: row.memberId === null ? null : memberIdSchema.parse(row.memberId),
    linkId: null,
    leaseEpoch: row.leaseEpoch,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
  };
  const check = checkPreviewCode(input.code, row.linkId === null ? codeRow : { ...codeRow, linkId: previewLinkIdSchema.parse(row.linkId) }, {
    kind: input.kind,
    leaseEpoch: task.leaseEpoch,
    now,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.port === undefined ? {} : { port: input.port }),
  });
  if (!check.ok) {
    return check;
  }
  // The use mark: only a row still unused takes it, so it works once.
  const marked = await tx.previewCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date(now) } });
  if (marked.count === 0) {
    return { ok: false, reason: "used" };
  }
  return {
    ...check,
    organizationId: organizationIdSchema.parse(row.organizationId),
    projectId: projectIdSchema.parse(row.projectId),
    leaseEpoch: row.leaseEpoch,
    cliSessionId: row.cliSessionId === null ? null : cliSessionIdSchema.parse(row.cliSessionId),
    loginSessionId: row.authSessionId === null ? null : loginSessionIdSchema.parse(row.authSessionId),
  };
};

/** A code's or a ticket's one use, in a transaction of its own (the native preview's handshake, ticket 25). */
export const redeemCode = async (deps: Parameters<RedeemCode>[0], input: Parameters<RedeemCode>[1]): Promise<RedeemedPreviewCode> =>
  deps.db.$transaction((tx) => redeemPreviewCodeInTx(tx, input, deps.clock.now()));
redeemCode satisfies RedeemCode;

// ---------- the ticket's view (core's `/cli/v1/tunnel`) ----------

/** What core's tunnel endpoint takes. */
export type CliTunnelDeps = Pick<Ports, "outbox" | "notices" | "clock"> & { readonly db: Db; readonly settings: Pick<PreviewSettings, "warmMinutes"> };

/** A `cli` view and what its tunnel is bound to. */
export type CliTunnelView = {
  readonly viewId: PreviewViewId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly key: PreviewKey;
  readonly port: number;
  readonly memberId: MemberId;
  readonly cliSessionId: CliSessionId;
  readonly leaseEpoch: number;
};

/** Why core refused the CLI's tunnel: the protocol's `cliTunnelErrorSchema` codes the rows decide. */
export type CliTunnelRefusal = "ticket-refused" | "not-found" | "port-not-allowed" | "runner-cannot-tunnel" | "no-box";

export type OpenCliViewResult =
  | { readonly ok: true; readonly view: CliTunnelView }
  /** `reason` is the ticket's refusal, for the log: never the ticket. */
  | { readonly ok: false; readonly error: CliTunnelRefusal; readonly reason: string };

const refusedView = (error: CliTunnelRefusal, reason: string = error): OpenCliViewResult => ({ ok: false, error, reason });

/**
 * Redeems a CLI ticket and opens its view (ADR 0068, "`ostra preview`"), in one transaction: the
 * ticket's one use; the CLI session still good and its member still able to open the task; the
 * task's live box under the ticket's lease epoch, short of the warm cap, on a runner that can
 * tunnel; the ticket's port still one of the task's previews. Then the `PreviewView` in `cli` mode
 * (`opening`), its `preview.opened` event, and `preview.open` in `tunnel` mode to the box's runner.
 * The ticket is spent whatever it refuses after the use mark.
 */
export const openCliView = async (deps: CliTunnelDeps, input: { readonly ticket: string }): Promise<OpenCliViewResult> => {
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx): Promise<OpenCliViewResult> => {
    const redeemed = await redeemPreviewCodeInTx(tx, { code: input.ticket, kind: "cli_ticket" }, now);
    if (!redeemed.ok) {
      return refusedView("ticket-refused", redeemed.reason);
    }
    if (redeemed.viewer.kind !== "member" || redeemed.cliSessionId === null) {
      return refusedView("ticket-refused", "wrong-binding");
    }
    const { organizationId, projectId, taskId, key, port, cliSessionId } = redeemed;
    const memberId = redeemed.viewer.memberId;
    const session = await cliSessionInTx(tx, cliSessionId, memberId, now);
    if (session !== "good") {
      return refusedView("ticket-refused", session);
    }
    if (!(await canOpenTaskInTx(tx, organizationId, memberId, projectId))) {
      return refusedView("not-found");
    }
    const box = await previewBoxInTx(tx, organizationId, taskId);
    const sessionId = box?.sessionId ?? null;
    if (box === null || sessionId === null) {
      return refusedView("no-box");
    }
    if (box.leaseEpoch !== redeemed.leaseEpoch) {
      return refusedView("ticket-refused", "stale-lease");
    }
    if (!canTunnel(box)) {
      return refusedView("runner-cannot-tunnel");
    }
    // Past the warm cap the box idles out (ADR 0068): a new view doesn't hold it again.
    const hold = boxWarmHold(box, now, deps.settings.warmMinutes);
    if (!hold.hold && hold.reason === "past-the-cap") {
      return refusedView("no-box", "past-the-cap");
    }
    const targets = await taskPreviewTargetsInTx(tx, { id: taskId, organizationId, projectId }, box.executor);
    const target = targets.find((item) => item.key === key && item.port === port);
    if (target === undefined || !mayReach(port, targets, UNKNOWN_RESERVED).ok) {
      return refusedView("port-not-allowed");
    }
    const created = await tx.previewView.create({
      data: {
        organizationId,
        projectId,
        taskId,
        key,
        mode: "cli",
        openedByMemberId: memberId,
        linkId: null,
        leaseId: box.leaseId,
        leaseEpoch: box.leaseEpoch,
        state: "opening",
        openedAt: new Date(now),
        lastHeartbeatAt: new Date(now),
      },
      select: { id: true },
    });
    const viewId = previewViewIdSchema.parse(created.id);
    await appendServerEvent(tx, { organizationId, projectId, taskId, sessionId, at: now, event: { kind: "preview.opened", viewId, key, mode: "cli", by: { kind: "member", memberId } } });
    await deps.outbox.enqueueInTx(tx, organizationId, box.runnerId, {
      kind: "preview.open",
      body: { sessionId, viewId, key, mode: "tunnel", viewport: null },
      notAfter: now + runnerLimits.offerTimeoutMs,
      task: { taskId, projectId },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
    return { ok: true, view: { viewId, organizationId, projectId, taskId, key, port, memberId, cliSessionId, leaseEpoch: box.leaseEpoch } };
  });
};

// ---------- the check while the tunnel lasts ----------

type CliSessionState = "good" | "session-revoked" | "session-expired";

const cliSessionInTx = async (tx: Tx, cliSessionId: CliSessionId, memberId: MemberId, now: number): Promise<CliSessionState> => {
  const session = await tx.cliSession.findUnique({ where: { id: cliSessionId }, select: { memberId: true, revokedAt: true, expiresAt: true } });
  if (session?.memberId !== memberId || session.revokedAt !== null) {
    return "session-revoked";
  }
  return session.expiresAt.getTime() <= now ? "session-expired" : "good";
};

export type CliTunnelCheck = { readonly ok: true } | { readonly ok: false; readonly reason: "session-revoked" | "session-expired" | "not-allowed" };

/**
 * Whether a CLI's tunnel may go on (ticket 23): its CLI session is neither revoked nor expired, and
 * its member can still open the task. Core asks every 5 minutes, and ends the tunnel on a refusal.
 */
export const checkCliTunnel = async (deps: { readonly db: Db; readonly clock: Clock }, view: Pick<CliTunnelView, "cliSessionId" | "memberId" | "organizationId" | "projectId">): Promise<CliTunnelCheck> =>
  deps.db.$transaction(async (tx): Promise<CliTunnelCheck> => {
    const session = await cliSessionInTx(tx, view.cliSessionId, view.memberId, deps.clock.now());
    if (session !== "good") {
      return { ok: false, reason: session };
    }
    return (await canOpenTaskInTx(tx, view.organizationId, view.memberId, view.projectId)) ? { ok: true } : { ok: false, reason: "not-allowed" };
  });
