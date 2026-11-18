import type { PrismaClient } from "../generated/prisma/client.ts";
import type { UserId } from "../ids.ts";

// A fixed key for the advisory lock that serialises "who is the first account".
const FIRST_ACCOUNT_LOCK_KEY = 4_270_901;

/**
 * Q102: the first account on an install is the instance admin.
 *
 * Counting accounts in the create hook would let two simultaneous first
 * sign-ups both see zero admins. The advisory lock makes the second one wait
 * until the first commits, and a statement that starts after the lock sees it.
 */
export const promoteFirstAccount = async (prisma: PrismaClient, userId: UserId): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    // $executeRaw, not $queryRaw: Prisma 7 with the pg driver adapter cannot read the `void` column
    // this function returns, and $queryRaw fails with "Failed to deserialize column of type void".
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_LOCK_KEY})`;
    const admins = await tx.user.count({ where: { role: "admin" } });
    if (admins === 0) {
      await tx.user.update({ where: { id: userId }, data: { role: "admin" } });
    }
  });
};
