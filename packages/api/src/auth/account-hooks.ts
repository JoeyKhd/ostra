import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

import type { Db, Tx } from "@ostra/db";
import type { AuditLog, ChangeNotices, Clock, JobQueue } from "@ostra/domain";
import { organizationIdSchema, resetLinkGrantIdSchema, userIdSchema } from "@ostra/protocol";
import type { OrganizationId, ResetLinkGrantId, UserId } from "@ostra/protocol";

// What ostra adds around better-auth's account routes for milestone 4 (F-002, ADR 0053, ticket 22):
// the ports its hooks write through, the transaction a sign-up runs in, the sink an instance admin's
// reset link lands in, and the reset links' grants. `create-auth.ts` wires them into better-auth.

/** The request header the sign-up page sends the invitation's ID on: the link's secret, never logged. */
export const INVITATION_HEADER = "x-ostra-invitation";

/** The ports the account hooks write through, and whether the install's email is set up. */
export type AccountPorts = {
  /** The install's email is set up and ready: invitations verify the address, and resets go by mail. */
  readonly emailOn: () => Promise<boolean>;
  readonly jobs: JobQueue;
  readonly audit: AuditLog;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
};

/** A queue for a build that sends no account mail (core's device sessions): enqueuing is a bug there. */
export const refusingJobQueue: JobQueue = {
  enqueueInTx: () => Promise.reject(new Error("this server has no job queue for account mail")),
};

/**
 * Hands better-auth a client whose interactive transactions record their `tx` here, so a hook that
 * better-auth runs inside one (the account of a sign-up, a password's reset) writes ostra's rows in
 * the same transaction: they commit or roll back together.
 */
export const capturingTransactions = (db: Db, storage: AsyncLocalStorage<Tx>): Db =>
  new Proxy(db, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      if (property !== "$transaction") {
        const bound: unknown = value.bind(target);
        return bound;
      }
      return (first: unknown, ...rest: unknown[]): unknown => {
        if (typeof first !== "function") {
          const batched: unknown = Reflect.apply(value, target, [first, ...rest]);
          return batched;
        }
        const run = (tx: Tx): unknown => storage.run(tx, (): unknown => Reflect.apply(first, undefined, [tx]));
        const result: unknown = Reflect.apply(value, target, [run, ...rest]);
        return result;
      };
    },
  });

/** A new transaction storage for one auth instance. */
export const transactionStorage = (): AsyncLocalStorage<Tx> => new AsyncLocalStorage<Tx>();

/** The SHA-256 of a reset link's token: all a `ResetLinkGrant` keeps. */
export const hashResetToken = (token: string): string => createHash("sha256").update(token).digest("hex");

// ---------- the instance admin's reset link (ADR 0003's sink) ----------

/** Where better-auth's reset callback puts the link for the instance admin who asked for it. */
export type ResetLinkSink = { readonly createdBy: UserId; link: { readonly url: string; readonly token: string } | null };

const sinks = new AsyncLocalStorage<ResetLinkSink>();

/** The sink of the request that runs now, if an instance admin's "Create reset link" opened one. */
export const currentResetLinkSink = (): ResetLinkSink | undefined => sinks.getStore();

/** Runs `work` with a sink open: a reset link better-auth makes inside it lands there, not in a mail. */
export const collectResetLink = async <T>(createdBy: UserId, work: () => Promise<T>): Promise<{ readonly result: T; readonly sink: ResetLinkSink }> => {
  const sink: ResetLinkSink = { createdBy, link: null };
  const result = await sinks.run(sink, work);
  return { result, sink };
};

/** The organizations an account belongs to (active or waiting on its address): where its account's entries go. */
export const organizationsOfAccount = async (tx: Tx, userId: UserId): Promise<readonly { readonly organizationId: OrganizationId; readonly memberId: string }[]> =>
  (
    await tx.member.findMany({
      where: { userId, state: { in: ["active", "pending_verification"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, organizationId: true },
    })
  ).map((row) => ({ organizationId: organizationIdSchema.parse(row.organizationId), memberId: row.id }));

/**
 * Records a reset link made for an account: its grant by the token's hash, and an entry in each of
 * the account's organizations. A self-service one is mailed (`account-mail.send`, its grant's ID).
 */
export const recordResetLinkInTx = async (
  ports: Pick<AccountPorts, "jobs" | "audit" | "clock">,
  tx: Tx,
  input: {
    readonly userId: UserId;
    readonly token: string;
    readonly kind: "admin_link" | "self_service";
    readonly createdByUserId: UserId | null;
    readonly expiresAt: number;
  },
): Promise<{ readonly grantId: ResetLinkGrantId }> => {
  const grantId = resetLinkGrantIdSchema.parse(randomUUID());
  await tx.resetLinkGrant.create({
    data: {
      id: grantId,
      userId: input.userId,
      createdByUserId: input.createdByUserId,
      kind: input.kind,
      tokenHash: hashResetToken(input.token),
      expiresAt: new Date(input.expiresAt),
      createdAt: new Date(ports.clock.now()),
    },
  });
  const organizations = await organizationsOfAccount(tx, input.userId);
  for (const { organizationId, memberId } of organizations) {
    // The instance admin who made it, as their membership there; a self-service one is the account's own.
    const admin =
      input.createdByUserId === null
        ? null
        : await tx.member.findFirst({ where: { organizationId, userId: input.createdByUserId }, select: { id: true } });
    await ports.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: input.createdByUserId === null ? { kind: "member", id: memberId } : admin === null ? { kind: "system", id: null } : { kind: "member", id: admin.id },
      action: "reset-link.created",
      entity: "user",
      entityId: input.userId,
      data: { kind: input.kind, grantId },
    });
  }
  const first = organizations[0];
  if (input.kind === "self_service" && first !== undefined) {
    await ports.jobs.enqueueInTx(tx, "account-mail.send", { organizationId: first.organizationId, purpose: "password_reset", recordId: grantId });
  }
  return { grantId };
};

/**
 * A reset link was used, inside the reset's own transaction: its grant is marked used, the account's
 * CLI sessions are revoked (better-auth ends its login sessions), and each of its organizations gets
 * an entry. A token ostra made no grant for changes the password and nothing else.
 */
export const recordResetUsedInTx = async (ports: Pick<AccountPorts, "audit" | "clock">, tx: Tx, token: string): Promise<void> => {
  const now = new Date(ports.clock.now());
  const grant = await tx.resetLinkGrant.findUnique({ where: { tokenHash: hashResetToken(token) }, select: { id: true, userId: true, kind: true } });
  if (grant === null) {
    return;
  }
  await tx.resetLinkGrant.updateMany({ where: { id: grant.id, usedAt: null }, data: { usedAt: now } });
  const userId = userIdSchema.parse(grant.userId);
  const revoked = await tx.cliSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  for (const { organizationId, memberId } of await organizationsOfAccount(tx, userId)) {
    await ports.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: memberId },
      action: "reset-link.used",
      entity: "user",
      entityId: userId,
      data: { kind: grant.kind, grantId: grant.id, cliSessionsRevoked: revoked.count },
    });
  }
};
