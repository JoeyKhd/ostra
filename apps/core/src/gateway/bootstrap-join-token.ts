import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";

import { readDataFile, writeOwnerOnly } from "./keys.ts";

// The bootstrap join token (F-013, ticket 24): one join token for the first organization's default
// pool, made by core at first start, so the compose file's pool runner (ticket 22) can join with
// no one at the panel. It's stored hashed, written once to OSTRA_DATA_DIR for that runner to read,
// and shown nowhere else. Managing join tokens is F-091 (milestone 5).
//
// A fresh install has no organization until the first admin creates one, so core tries again
// until there is one (`ensureBootstrapJoinToken` returns `waiting`).

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
  const existing = await db.joinToken.findFirst({
    where: { organizationId: organization.id, bootstrap: true, revokedAt: null },
    select: { id: true, tokenHash: true },
  });
  if (existing !== null && onDisk !== null && hashJoinToken(onDisk) === existing.tokenHash) {
    return "ready";
  }
  // The file is gone or doesn't match (the data folder was restored, say): the stored token can't
  // be read back, so it's replaced by a new one.
  const token = `ostra-join-${randomBytes(32).toString("base64url")}`;
  await db.$transaction(async (tx) => {
    let pool = await tx.runnerPool.findFirst({
      where: { organizationId: organization.id, isDefault: true },
      select: { id: true },
    });
    pool ??= await tx.runnerPool.create({
      data: { organizationId: organization.id, name: "default", isDefault: true },
      select: { id: true },
    });
    await tx.joinToken.updateMany({
      where: { organizationId: organization.id, bootstrap: true, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.joinToken.create({
      data: {
        organizationId: organization.id,
        poolId: pool.id,
        tokenHash: hashJoinToken(token),
        label: "bootstrap",
        bootstrap: true,
      },
    });
  });
  await rm(path.join(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE), { force: true });
  await writeOwnerOnly(path.join(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE), token);
  logger.info("bootstrap-join-token.created", { organizationId: organization.id, file: BOOTSTRAP_JOIN_TOKEN_FILE });
  return "created";
};
