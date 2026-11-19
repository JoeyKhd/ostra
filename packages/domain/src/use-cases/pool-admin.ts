import type { RunnerNoticeSubject } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { isReservedLabel, joinTokenIdSchema, memberIdSchema, notificationDeliveryIdSchema, organizationIdSchema, poolIdSchema, runnerIdSchema } from "@ostra/protocol";
import type { ExecutorKind, JoinTokenId, MemberId, OrganizationId, PoolId, RunnerId } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { JobPayload } from "../jobs.ts";
import { joinTokenExpiry, joinTokenFromColumns } from "../lifecycles/join-token.ts";
import { EMAIL_DELAY_SECONDS_DEFAULT, emailDueAt } from "../notifications/choices.ts";
import type { NotificationChannel } from "../notifications/choices.ts";
import type { Ports } from "../ports.ts";
import type { CreateJoinToken, CreatePool, PoolRunnerJoin, PoolSettings, RegisterPoolRunner, RevokeJoinToken, UpdatePool } from "./m5-signatures.ts";
import { generateJoinToken, hashJoinToken } from "./pools.ts";

// Pools, join tokens, a pool runner's join and the join's notices (F-091, ADR 0029, Q48, Q94, Q130;
// milestone 5's ticket 12). Each write is one transaction with its audit entry, its change notice
// and the jobs it enqueues (ADR 0011, ADR 0037).
//
// - A join token is random, prefixed so the log guard redacts it, stored as its SHA-256 and shown
//   once. Its lifetime is the admin's choice, else the pool's `joinTokenDays`, else
//   `OSTRA_JOIN_TOKEN_DAYS`; `0` days is none. Expiry is read from the `Clock`.
// - A join accepts any token of the pool that is neither expired nor revoked (Q130), counts the
//   use, records the token on the runner, makes the runner `joining`, writes `runner.joined` naming
//   the token, and enqueues `runner.join-notice`. A refused join writes nothing.
// - The join notice tells the organization's admins (`runner_joined`), and when the pool requires
//   approval opens `runner_awaiting_approval` for them, which the approval or the reject resolves.
//   A needs-you item belongs to a task (`NeedsYouItem.taskId` is required), and a joining runner
//   has none, so the awaiting notice is the admins' open item itself: its state is `open` until the
//   runner is approved or rejected. A runner notice's delivery key names the runner
//   (`runnerNoticeKey`), as a budget notice's names its notice, so the delivery reads the runner
//   when it's due.

/** What these use cases take: the signatures' `M5Deps`, of which they use these, and the setting. */
export type PoolAdminDeps = { readonly db: Db } & Pick<Ports, "audit" | "notices" | "clock" | "jobs"> & {
    /** `OSTRA_JOIN_TOKEN_DAYS`: a token's lifetime when neither the admin nor the pool names one. Default 30. */
    readonly joinTokenDays?: number;
  };

/** `OSTRA_JOIN_TOKEN_DAYS`' default. */
export const JOIN_TOKEN_DAYS_DEFAULT = 30;

const POOL_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

const validSettings = (input: Partial<PoolSettings>): boolean =>
  (input.name === undefined || POOL_NAME.test(input.name)) &&
  (input.maxBoxes === undefined || input.maxBoxes === null || (Number.isInteger(input.maxBoxes) && input.maxBoxes > 0 && input.maxBoxes <= 100_000)) &&
  (input.joinTokenDays === undefined || input.joinTokenDays === null || (Number.isInteger(input.joinTokenDays) && input.joinTokenDays >= 0 && input.joinTokenDays <= 3650));

/** A join token made in `tx`: the row, its audit entry and the pool's notice. The token is returned once. */
const makeJoinTokenInTx = async (
  deps: PoolAdminDeps,
  tx: Tx,
  scope: MemberScope,
  pool: { readonly id: PoolId; readonly joinTokenDays: number | null },
  input: { readonly label: string | null; readonly days?: number | null },
): Promise<{ readonly joinTokenId: JoinTokenId; readonly token: string; readonly expiresAt: number | null }> => {
  const now = deps.clock.now();
  const token = generateJoinToken();
  // The admin's choice wins (`null`: none); else the pool's lifetime, else the setting's.
  const expiresAt =
    input.days === undefined
      ? joinTokenExpiry(now, pool.joinTokenDays, deps.joinTokenDays ?? JOIN_TOKEN_DAYS_DEFAULT)
      : input.days === null
        ? null
        : joinTokenExpiry(now, input.days, 0);
  const row = await tx.joinToken.create({
    data: {
      organizationId: scope.organizationId,
      poolId: pool.id,
      tokenHash: hashJoinToken(token),
      label: input.label,
      createdByMemberId: scope.memberId,
      expiresAt,
    },
    select: { id: true },
  });
  const joinTokenId = joinTokenIdSchema.parse(row.id);
  await deps.audit.recordInTx(tx, {
    organizationId: scope.organizationId,
    projectId: null,
    actor: { kind: "member", id: scope.memberId },
    action: "join-token.created",
    entity: "join-token",
    entityId: joinTokenId,
    data: { poolId: pool.id, expiresAt: expiresAt === null ? null : expiresAt.getTime() },
  });
  await deps.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId: null, entity: "runner-pool", entityId: pool.id });
  return { joinTokenId, token, expiresAt: expiresAt === null ? null : expiresAt.getTime() };
};

/** An admin makes a pool, and its first join token, in one transaction. */
export const createPool = (async (deps: PoolAdminDeps, scope: MemberScope, input: PoolSettings) => {
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return { ok: false as const, error: "forbidden" as const, message: "Only an admin makes a pool" };
  }
  if (!validSettings(input)) {
    return { ok: false as const, error: "invalid-input" as const, message: "A pool's name, cap or token lifetime isn't valid" };
  }
  return deps.db.$transaction(async (tx) => {
    const organizationId = scope.organizationId;
    if ((await tx.runnerPool.count({ where: { organizationId, name: input.name } })) > 0) {
      return { ok: false as const, error: "name-taken" as const, message: "A pool with that name exists" };
    }
    const row = await tx.runnerPool.create({
      data: {
        organizationId,
        name: input.name,
        requiresApproval: input.requiresApproval,
        maxBoxes: input.maxBoxes,
        joinTokenDays: input.joinTokenDays,
        updatedByMemberId: scope.memberId,
      },
      select: { id: true },
    });
    const poolId = poolIdSchema.parse(row.id);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "pool.created",
      entity: "runner-pool",
      entityId: poolId,
      data: { requiresApproval: input.requiresApproval, maxBoxes: input.maxBoxes, joinTokenDays: input.joinTokenDays },
    });
    const joinToken = await makeJoinTokenInTx(deps, tx, scope, { id: poolId, joinTokenDays: input.joinTokenDays }, { label: null });
    return { ok: true as const, poolId, joinToken };
  });
}) satisfies CreatePool;

/** An admin changes a pool's settings. A changed cap or approval switch asks the pool's admission again. */
export const updatePool = (async (deps: PoolAdminDeps, scope: MemberScope, input: Parameters<UpdatePool>[2]): ReturnType<UpdatePool> => {
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return { ok: false, error: "forbidden", message: "Only an admin changes a pool" };
  }
  if (!validSettings(input)) {
    return { ok: false, error: "invalid-input", message: "A pool's name, cap or token lifetime isn't valid" };
  }
  return deps.db.$transaction(async (tx) => {
    const organizationId = scope.organizationId;
    const pool = await tx.runnerPool.findFirst({ where: { id: input.poolId, organizationId }, select: { id: true, maxBoxes: true, requiresApproval: true } });
    if (pool === null) {
      return { ok: false as const, error: "not-found" as const, message: "No such pool" };
    }
    if (input.name !== undefined && (await tx.runnerPool.count({ where: { organizationId, name: input.name, NOT: { id: pool.id } } })) > 0) {
      return { ok: false as const, error: "name-taken" as const, message: "A pool with that name exists" };
    }
    await tx.runnerPool.update({
      where: { id: pool.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.requiresApproval === undefined ? {} : { requiresApproval: input.requiresApproval }),
        ...(input.maxBoxes === undefined ? {} : { maxBoxes: input.maxBoxes }),
        ...(input.joinTokenDays === undefined ? {} : { joinTokenDays: input.joinTokenDays }),
        updatedByMemberId: scope.memberId,
      },
    });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "pool.updated",
      entity: "runner-pool",
      entityId: input.poolId,
    });
    const roomChanged =
      (input.maxBoxes !== undefined && input.maxBoxes !== pool.maxBoxes) || (input.requiresApproval !== undefined && input.requiresApproval !== pool.requiresApproval);
    if (roomChanged) {
      await deps.jobs.enqueueInTx(tx, "queue.admit", { organizationId, poolId: input.poolId });
    }
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner-pool", entityId: input.poolId });
    return { ok: true as const, poolId: input.poolId };
  });
}) satisfies UpdatePool;

/** An admin makes a join token. The token is in this answer and nowhere else, ever again. */
export const createJoinToken = (async (deps: PoolAdminDeps, scope: MemberScope, input: Parameters<CreateJoinToken>[2]): ReturnType<CreateJoinToken> => {
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return { ok: false, error: "forbidden", message: "Only an admin makes a join token" };
  }
  return deps.db.$transaction(async (tx) => {
    const pool = await tx.runnerPool.findFirst({ where: { id: input.poolId, organizationId: scope.organizationId }, select: { id: true, joinTokenDays: true } });
    if (pool === null) {
      return { ok: false as const, error: "not-found" as const, message: "No such pool" };
    }
    const made = await makeJoinTokenInTx(deps, tx, scope, { id: poolIdSchema.parse(pool.id), joinTokenDays: pool.joinTokenDays }, input);
    return { ok: true as const, ...made };
  });
}) satisfies CreateJoinToken;

/** An admin revokes a token: no runner joins with it again; the runners that joined with it stay. */
export const revokeJoinToken = (async (deps: PoolAdminDeps, scope: MemberScope, input: Parameters<RevokeJoinToken>[2]): ReturnType<RevokeJoinToken> => {
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return { ok: false, error: "forbidden", message: "Only an admin revokes a join token" };
  }
  return deps.db.$transaction(async (tx) => {
    const organizationId = scope.organizationId;
    const row = await tx.joinToken.findFirst({ where: { id: input.joinTokenId, organizationId }, select: { id: true, poolId: true, revokedAt: true } });
    if (row === null) {
      return { ok: false as const, error: "not-found" as const, message: "No such join token" };
    }
    if (row.revokedAt !== null) {
      return { ok: false as const, error: "already-revoked" as const, message: "The join token is revoked already" };
    }
    const revokedAt = new Date(deps.clock.now());
    await tx.joinToken.update({ where: { id: row.id }, data: { revokedAt, revokedByMemberId: scope.memberId } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "join-token.revoked",
      entity: "join-token",
      entityId: input.joinTokenId,
      data: { poolId: row.poolId },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner-pool", entityId: poolIdSchema.parse(row.poolId) });
    return { ok: true as const, revokedAt: revokedAt.getTime() };
  });
}) satisfies RevokeJoinToken;

// ---------- the join ----------

/**
 * A runner joins a pool with a token of it. One transaction: the runner (`joining`), the token's
 * use, the audit entry naming the token and the join notice's job. A refused token writes nothing.
 */
export const registerPoolRunner = (deps: PoolAdminDeps, input: PoolRunnerJoin): ReturnType<RegisterPoolRunner> =>
  deps.db.$transaction(async (tx) => {
    const now = deps.clock.now();
    const token = await tx.joinToken.findUnique({
      where: { tokenHash: hashJoinToken(input.token) },
      select: { id: true, organizationId: true, poolId: true, expiresAt: true, revokedAt: true, bootstrap: true },
    });
    if (token === null) {
      return { ok: false as const, error: "token-unknown" as const, message: "the join token is not one this server knows" };
    }
    const state = joinTokenFromColumns(token, now).state;
    switch (state) {
      case "expired":
        return { ok: false as const, error: "token-expired" as const, message: "the join token has expired; ask an admin for a new one" };
      case "revoked":
        return { ok: false as const, error: "token-revoked" as const, message: "the join token was revoked; ask an admin for a new one" };
      case "active":
        break;
      default:
        return state satisfies never;
    }
    const organizationId = organizationIdSchema.parse(token.organizationId);
    const poolId = poolIdSchema.parse(token.poolId);
    // Joins into one pool take its row in turn, so of two that race with one name, the second reads
    // the first's runner below and is refused.
    await tx.$queryRaw`SELECT 1 FROM "runner_pool" WHERE "id" = ${poolId} AND "organizationId" = ${organizationId} FOR NO KEY UPDATE`;
    const pool = await tx.runnerPool.findFirst({ where: { id: poolId, organizationId }, select: { requiresApproval: true } });
    if (pool === null) {
      return { ok: false as const, error: "token-unknown" as const, message: "the join token is not one this server knows" };
    }
    const sameName = await tx.runner.findFirst({ where: { organizationId, poolId, name: input.name, revokedAt: null }, select: { id: true } });
    if (sameName !== null) {
      return { ok: false as const, error: "name-taken" as const, message: "a runner of this name already joined this pool" };
    }
    if ((await tx.runner.findUnique({ where: { publicKey: input.publicKey }, select: { id: true } })) !== null) {
      return { ok: false as const, error: "key-taken" as const, message: "a runner with this key exists; make a new key pair" };
    }
    // The built-in labels are ostra's to set (`executor:`, `os:`, `arch:`): a runner's own are dropped.
    const labels = input.labels.filter((label) => !isReservedLabel(label));
    const runner = await tx.runner.create({
      data: {
        organizationId,
        kind: "pool",
        poolId,
        name: input.name,
        publicKey: input.publicKey,
        executor: input.executor,
        capacity: input.capacity ?? 1,
        labels,
        version: input.version,
        install: input.install,
        ...(input.os === undefined ? {} : { os: { platform: input.os.platform, arch: input.os.arch, release: input.os.release } }),
        joinTokenId: token.id,
        state: "joining",
      },
      select: { id: true },
    });
    const runnerId = runnerIdSchema.parse(runner.id);
    await tx.joinToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date(now), useCount: { increment: 1 } } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "runner", id: runnerId },
      action: "runner.joined",
      entity: "runner",
      entityId: runnerId,
      data: { kind: "pool", poolId, executor: input.executor, capacity: input.capacity ?? 1, joinTokenId: token.id, bootstrap: token.bootstrap, awaitsApproval: pool.requiresApproval },
    });
    await deps.jobs.enqueueInTx(tx, "runner.join-notice", { organizationId, runnerId });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner", entityId: runnerId });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner-pool", entityId: poolId });
    return { ok: true as const, runnerId, poolId, organizationId, awaitsApproval: pool.requiresApproval };
  });

// ---------- the join's notices ----------

type RunnerNoticeKind = "runner_joined" | "runner_awaiting_approval";

const runnerNoticeKinds: readonly RunnerNoticeKind[] = ["runner_joined", "runner_awaiting_approval"];

/** A runner notice delivery's key: the kind, the runner, the change (always `created`), the member and the channel. */
export const runnerNoticeKey = (input: { readonly kind: RunnerNoticeKind; readonly runnerId: RunnerId; readonly memberId: MemberId; readonly channel: NotificationChannel }): string =>
  `${input.kind}:${input.runnerId}:created:${input.memberId}:${input.channel}`;

/** The runner a runner notice delivery's key names, or `null` for any other key. */
export const runnerIdOfNoticeKey = (key: string): RunnerId | null => {
  const [kind, runnerId] = key.split(":");
  if (!runnerNoticeKinds.some((candidate) => candidate === kind) || runnerId === undefined) {
    return null;
  }
  const parsed = runnerIdSchema.safeParse(runnerId);
  return parsed.success ? parsed.data : null;
};

/** What a runner notice delivery says, read from the runner's rows when it's due: never a token or a key. */
export type RunnerNoticeView = {
  readonly organizationName: string;
  readonly runnerId: RunnerId;
  readonly runnerName: string;
  readonly poolName: string;
  readonly executor: ExecutorKind;
  readonly tokenLabel: string | null;
};

export const loadRunnerNoticeView = async (db: Pick<Db, "runner">, organizationId: OrganizationId, runnerId: RunnerId): Promise<RunnerNoticeView | null> => {
  const row = await db.runner.findFirst({
    where: { id: runnerId, organizationId, kind: "pool" },
    select: { name: true, executor: true, pool: { select: { name: true } }, joinToken: { select: { label: true } }, organization: { select: { name: true } } },
  });
  if (row?.pool === null || row === null) {
    return null;
  }
  return {
    organizationName: row.organization.name,
    runnerId,
    runnerName: row.name,
    poolName: row.pool.name,
    executor: row.executor,
    tokenLabel: row.joinToken?.label ?? null,
  };
};

/** The runner's page in the panel: the Runners page, with the runner open. */
export const runnerPageUrl = (publicUrl: string, runnerId: RunnerId): string =>
  `${publicUrl.replace(/\/+$/, "")}/organization/runners?runner=${encodeURIComponent(runnerId)}`;

/** What a runner notice names: the runner, its pool, its executor, the token's label and its page. */
export const runnerNoticeSubject = (view: RunnerNoticeView, publicUrl: string): RunnerNoticeSubject => ({
  runnerId: view.runnerId,
  runnerName: view.runnerName,
  poolName: view.poolName,
  executor: view.executor,
  tokenLabel: view.tokenLabel,
  url: runnerPageUrl(publicUrl, view.runnerId),
});

export type RunnerJoinNoticeDeps = { readonly db: Db } & Pick<Ports, "jobs" | "notices" | "clock"> & {
    /** `OSTRA_EMAIL_DELAY_SECONDS`, which the instance's saved delay overrides. */
    readonly emailDelaySeconds?: number;
  };

export type RunnerJoinNoticeResult =
  | { readonly kind: "sent"; readonly notices: readonly RunnerNoticeKind[]; readonly notifications: number; readonly deliveries: number }
  /** The runner is gone or revoked: nothing to say. */
  | { readonly kind: "gone" };

/**
 * `runner.join-notice`: `runner_joined` to the organization's admins, and `runner_awaiting_approval`
 * when the runner waits for one, in the panel and by mail (each admin's choice wins). A replay sends
 * nothing twice: a member's notice of a kind is made once.
 */
export const sendRunnerJoinNotice = (deps: RunnerJoinNoticeDeps, payload: JobPayload<"runner.join-notice">): Promise<RunnerJoinNoticeResult> =>
  deps.db.$transaction(async (tx): Promise<RunnerJoinNoticeResult> => {
    const { organizationId, runnerId } = payload;
    const runner = await tx.runner.findFirst({
      where: { id: runnerId, organizationId, kind: "pool" },
      select: { state: true, revokedAt: true, approvedAt: true, pool: { select: { requiresApproval: true } } },
    });
    if (runner?.revokedAt !== null || runner.state === "revoked") {
      return { kind: "gone" };
    }
    const awaits = runner.pool?.requiresApproval === true && runner.state === "joining" && runner.approvedAt === null;
    const kinds: readonly RunnerNoticeKind[] = awaits ? ["runner_joined", "runner_awaiting_approval"] : ["runner_joined"];
    const admins = await tx.member.findMany({ where: { organizationId, role: "admin", state: "active" }, select: { id: true }, orderBy: { id: "asc" } });
    const memberIds = admins.map((row) => memberIdSchema.parse(row.id));
    const now = deps.clock.now();
    const [preferences, saved] = await Promise.all([
      tx.notificationPreference.findMany({ where: { memberId: { in: [...memberIds] }, kind: { in: [...kinds] }, channel: "email" }, select: { memberId: true, kind: true, enabled: true } }),
      tx.instanceSetting.findUnique({ where: { id: "instance" }, select: { emailDelaySeconds: true } }),
    ]);
    const emailProvider = (await tx.emailSettings.findUnique({ where: { id: "instance" }, select: { provider: true } }))?.provider ?? "off";
    const delaySeconds = saved?.emailDelaySeconds ?? deps.emailDelaySeconds ?? EMAIL_DELAY_SECONDS_DEFAULT;
    let notifications = 0;
    let deliveries = 0;
    for (const memberId of memberIds) {
      let made = false;
      for (const kind of kinds) {
        const panelKey = runnerNoticeKey({ kind, runnerId, memberId, channel: "panel" });
        if ((await tx.notificationDelivery.count({ where: { idempotencyKey: panelKey } })) > 0) {
          continue;
        }
        const notification = await tx.notification.create({ data: { organizationId, memberId, kind, state: "open" }, select: { id: true } });
        notifications += 1;
        made = true;
        // Mail is on by default for both runner notices; an admin who turned it off gets the panel only.
        const wantsMail = preferences.find((row) => row.memberId === memberId && row.kind === kind)?.enabled ?? true;
        const channels: readonly NotificationChannel[] = wantsMail ? ["panel", "email"] : ["panel"];
        for (const channel of channels) {
          const dueAt = channel === "email" ? emailDueAt(now, delaySeconds) : now;
          const delivery = await tx.notificationDelivery.create({
            data: {
              organizationId,
              notificationId: notification.id,
              channel,
              adapter: channel === "panel" ? "panel" : emailProvider === "off" ? "email" : emailProvider,
              idempotencyKey: runnerNoticeKey({ kind, runnerId, memberId, channel }),
              dueAt: new Date(dueAt),
            },
            select: { id: true },
          });
          const wait = Math.max(0, dueAt - now);
          await deps.jobs.enqueueInTx(
            tx,
            "notify.deliver",
            { organizationId, deliveryId: notificationDeliveryIdSchema.parse(delivery.id) },
            wait === 0 ? undefined : { startAfterMs: wait },
          );
          deliveries += 1;
        }
      }
      if (made) {
        await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: memberId });
      }
    }
    return { kind: "sent", notices: kinds, notifications, deliveries };
  });

/**
 * Resolves the admins' open `runner_awaiting_approval` notices of a runner, in the approval's or the
 * reject's transaction: the item is answered, and a mail not yet sent is skipped.
 */
export const resolveRunnerApprovalNoticesInTx = async (
  tx: Tx,
  deps: Pick<Ports, "notices">,
  input: { readonly organizationId: OrganizationId; readonly runnerId: RunnerId },
): Promise<number> => {
  const open = await tx.notification.findMany({
    where: {
      organizationId: input.organizationId,
      kind: "runner_awaiting_approval",
      state: "open",
      deliveries: { some: { idempotencyKey: { startsWith: `runner_awaiting_approval:${input.runnerId}:` } } },
    },
    select: { id: true, memberId: true },
  });
  if (open.length === 0) {
    return 0;
  }
  await tx.notification.updateMany({ where: { id: { in: open.map((row) => row.id) }, organizationId: input.organizationId }, data: { state: "answered" } });
  for (const memberId of new Set(open.map((row) => row.memberId))) {
    await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "member", entityId: memberIdSchema.parse(memberId) });
  }
  return open.length;
};
