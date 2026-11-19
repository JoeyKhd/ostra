import { createHash, randomBytes } from "node:crypto";

import type { Tx } from "@ostra/db";
import { poolIdSchema } from "@ostra/protocol";
import type { BoxSizeName, OrganizationId, PoolId } from "@ostra/protocol";

// The default runner pool (Q9, ADR 0029): every organization has exactly one, and a new project
// links to it (F-086). Runners join pools; the pool's name is the admin's to change.

export const DEFAULT_POOL_NAME = "default";

/** The organization's default pool, created on first use. Idempotent. */
export const ensureDefaultPool = async (tx: Tx, organizationId: OrganizationId): Promise<PoolId> => {
  const existing = await tx.runnerPool.findFirst({ where: { organizationId, isDefault: true }, select: { id: true } });
  if (existing !== null) {
    return poolIdSchema.parse(existing.id);
  }
  // The name is unique in the organization: an admin who made a pool called "default" first gets
  // the default pool under another name.
  const taken = await tx.runnerPool.findFirst({ where: { organizationId, name: DEFAULT_POOL_NAME }, select: { id: true } });
  const created = await tx.runnerPool.create({
    data: { organizationId, name: taken === null ? DEFAULT_POOL_NAME : "default pool", isDefault: true },
    select: { id: true },
  });
  return poolIdSchema.parse(created.id);
};

// ---------- join tokens (Q48, Q94, F-013) ----------

/** A join token's stored form: SHA-256, hex. The token itself is never stored (core checks the same hash). */
export const hashJoinToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** A new join token: `ostra-join-` and 32 random bytes. The log guard redacts the prefix's tokens. */
export const generateJoinToken = (): string => `ostra-join-${randomBytes(32).toString("base64url")}`;

// ---------- box sizes (F-095, ADR 0059) ----------

/** An organization's three sizes as they start: ADR 0029's working values, in millicores and MiB. */
export const DEFAULT_BOX_SIZES: Readonly<Record<BoxSizeName, { readonly cpuMillis: number; readonly memoryMiB: number }>> = {
  small: { cpuMillis: 2000, memoryMiB: 4096 },
  medium: { cpuMillis: 4000, memoryMiB: 8192 },
  large: { cpuMillis: 8000, memoryMiB: 16_384 },
};

/**
 * The organization's three box sizes, made with their defaults where missing (the milestone 5
 * migration inserts them for the organizations that existed then; the first admin's seed for an
 * install that starts after it). Idempotent: an admin's changed limits stay.
 */
export const ensureBoxSizes = async (tx: Tx, organizationId: OrganizationId): Promise<void> => {
  await tx.boxSize.createMany({
    data: Object.entries(DEFAULT_BOX_SIZES).map(([name, limits]) => ({ organizationId, name, ...limits })),
    skipDuplicates: true,
  });
};
