import { createHmac } from "node:crypto";

import { base64urlMacEqual } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { boxIdSchema, leaseEpochSchema, organizationIdSchema, parseJson, runnerIdSchema, TASK_TOKEN_PREFIX, taskIdSchema } from "@ostra/protocol";
import type { BoxId, LeaseEpoch, OrganizationId, RunnerId, TaskId } from "@ostra/protocol";
import { z } from "zod";

// The task token (ADR 0034, "The task token"; Q129, milestone 1's ticket 41): what a `docker` or
// `kubernetes` box's sidecar connects with, and reads its one task's spec and credentials with. An
// HMAC under core's own key over the organization, the task, the lease epoch, the box and the
// runner, so any replica checks it without a table. It has no clock: it's valid exactly while that
// lease is the task's current, active one, which every use reads (`checkTaskLease`). The
// `ostra-task-` prefix is one the log guard redacts. Never logged.

const claimsSchema = z.strictObject({
  v: z.literal(1),
  o: organizationIdSchema,
  t: taskIdSchema,
  e: leaseEpochSchema,
  b: boxIdSchema,
  r: runnerIdSchema,
});

export type TaskTokenClaims = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly leaseEpoch: LeaseEpoch;
  readonly boxId: BoxId;
  readonly runnerId: RunnerId;
};

export type TaskTokens = {
  readonly issue: (claims: TaskTokenClaims) => string;
  /** The token's claims, or `null` when it's forged or malformed. Whether its lease still holds is `checkTaskLease`'s. */
  readonly verify: (token: string) => TaskTokenClaims | null;
};

/** Whether a bearer token is a task token, by its prefix: a runner's access token is not. */
export const isTaskToken = (token: string): boolean => token.startsWith(TASK_TOKEN_PREFIX);

export const createTaskTokens = (key: Buffer): TaskTokens => {
  // Its own context in the MAC, so no other token core signs with this key can pass for one.
  const sign = (body: string): Buffer => createHmac("sha256", key).update(`task\n${body}`).digest();
  return {
    issue: (claims) => {
      const body = Buffer.from(
        JSON.stringify({ v: 1, o: claims.organizationId, t: claims.taskId, e: claims.leaseEpoch, b: claims.boxId, r: claims.runnerId }),
      ).toString("base64url");
      return `${TASK_TOKEN_PREFIX}${body}.${sign(body).toString("base64url")}`;
    },
    verify: (token) => {
      if (!isTaskToken(token) || token.length > 4096) {
        return null;
      }
      const [body, mac, ...rest] = token.slice(TASK_TOKEN_PREFIX.length).split(".");
      if (body === undefined || mac === undefined || rest.length > 0 || !base64urlMacEqual(sign(body), mac)) {
        return null;
      }
      const json = parseJson(Buffer.from(body, "base64url").toString("utf8"));
      const claims = json.ok ? claimsSchema.safeParse(json.value) : undefined;
      if (claims?.success !== true) {
        return null;
      }
      const { o, t, e, b, r } = claims.data;
      return { organizationId: o, taskId: t, leaseEpoch: e, boxId: b, runnerId: r };
    },
  };
};

export type TaskLeaseCheck =
  | { readonly ok: true; readonly projectId: string }
  | { readonly ok: false; readonly error: "not-found" }
  | { readonly ok: false; readonly error: "stale-lease"; readonly currentEpoch: number };

/**
 * Every use of a task token reads the lease: the token's epoch is the task's current one, that
 * lease is active, and its box and runner are the token's, on `docker` or `kubernetes`.
 */
export const checkTaskLease = async (db: Db | Tx, claims: TaskTokenClaims): Promise<TaskLeaseCheck> => {
  const task = await db.task.findFirst({
    where: { id: claims.taskId, organizationId: claims.organizationId },
    select: { leaseEpoch: true, projectId: true },
  });
  if (task === null) {
    return { ok: false, error: "not-found" };
  }
  const lease = await db.lease.findFirst({
    where: { taskId: claims.taskId, organizationId: claims.organizationId, epoch: claims.leaseEpoch },
    select: { state: true, runnerId: true, boxId: true, box: { select: { executor: true } } },
  });
  if (
    task.leaseEpoch !== claims.leaseEpoch ||
    lease?.state !== "active" ||
    lease.runnerId !== claims.runnerId ||
    lease.boxId !== claims.boxId ||
    lease.box.executor === "host"
  ) {
    return { ok: false, error: "stale-lease", currentEpoch: task.leaseEpoch };
  }
  return { ok: true, projectId: task.projectId };
};
