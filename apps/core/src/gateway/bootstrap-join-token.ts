import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { postgresAuditLog } from "@ostra/domain";
import { joinTokenIdSchema, organizationIdSchema } from "@ostra/protocol";

import { readDataFile, writeOwnerOnly } from "./keys.ts";

// The bootstrap join token (F-013, ticket 24): one join token for the first organization's default
// pool, made by core at first start, so the compose file's pool runner (ticket 22) can join with
// no one at the panel. It's stored hashed, written once to OSTRA_DATA_DIR for that runner to read,
// and shown nowhere else. Managing join tokens is F-091 (milestone 5).
//
// A fresh install has no organization until the first admin creates one, so core tries again
// until there is one (`ensureBootstrapJoinToken` returns `waiting`).
//
// It's made once: when an admin has revoked the latest one, core makes no other, and
// `OSTRA_BOOTSTRAP_JOIN_TOKEN=false` (the Helm chart's setting) makes none at all. Making one, and
// replacing one whose file is gone, are audit entries of the system's.

export const BOOTSTRAP_JOIN_TOKEN_FILE = "bootstrap-join-token";

/** A join token's stored form: SHA-256, hex. The token itself is never stored. */
export const hashJoinToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export type BootstrapOutcome = "ready" | "created" | "waiting";

export const ensureBootstrapJoinToken = async (db: Db, dataDir: string, logger: Logger): Promise<BootstrapOutcome> => {
  const organization = await db.organization.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (organization === null) {
    return "waiting";
  }
  const onDisk = await readDataFile(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE);
  // The latest bootstrap token, revoked or not: one an admin revoked stays revoked.
  const latest = await db.joinToken.findFirst({
    where: { organizationId: organization.id, bootstrap: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, tokenHash: true, revokedAt: true },
  });
  if (latest !== null && latest.revokedAt !== null) {
    return "ready";
  }
  if (latest !== null && onDisk !== null && hashJoinToken(onDisk) === latest.tokenHash) {
    return "ready";
  }
  // The file is gone or doesn't match (the data folder was restored, say): the stored token can't
  // be read back, so it's replaced by a new one.
  const organizationId = organizationIdSchema.parse(organization.id);
  const token = `ostra-join-${randomBytes(32).toString("base64url")}`;
  await db.$transaction(async (tx) => {
    let pool = await tx.runnerPool.findFirst({
      where: { organizationId, isDefault: true },
      select: { id: true },
    });
    pool ??= await tx.runnerPool.create({
      data: { organizationId, name: "default", isDefault: true },
      select: { id: true },
    });
    const live = await tx.joinToken.findMany({ where: { organizationId, bootstrap: true, revokedAt: null }, select: { id: true, poolId: true } });
    for (const old of live) {
      await tx.joinToken.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
      await postgresAuditLog.recordInTx(tx, {
        organizationId,
        projectId: null,
        actor: { kind: "system", id: null },
        action: "join-token.revoked",
        entity: "join-token",
        entityId: joinTokenIdSchema.parse(old.id),
        data: { poolId: old.poolId, bootstrap: true },
      });
    }
    const made = await tx.joinToken.create({
      data: {
        organizationId,
        poolId: pool.id,
        tokenHash: hashJoinToken(token),
        label: "bootstrap",
        bootstrap: true,
      },
      select: { id: true },
    });
    await postgresAuditLog.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "system", id: null },
      action: "join-token.created",
      entity: "join-token",
      entityId: joinTokenIdSchema.parse(made.id),
      data: { poolId: pool.id, expiresAt: null, bootstrap: true },
    });
  });
  await rm(path.join(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE), { force: true });
  await writeOwnerOnly(path.join(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE), token);
  logger.info("bootstrap-join-token.created", { organizationId: organization.id, file: BOOTSTRAP_JOIN_TOKEN_FILE });
  return "created";
};
