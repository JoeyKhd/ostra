import assert from "node:assert/strict";
import type { ProvisionedDatabase } from "../db/provision-database.ts";
import { expectRefused, signUp } from "./support.ts";
import { accountSpec, openWorld } from "./world.ts";

const CONCURRENT_SIGN_UPS = 6;

/**
 * Q102, beyond the pass bar: the first account on an install is the instance
 * admin. Needs an empty database, so it opens a second one next to the main run.
 * Several people reaching a brand-new install at the same moment must still
 * produce exactly one admin.
 */
export const firstAccountScenario = async (database: ProvisionedDatabase): Promise<string> => {
  const { world, close } = await openWorld({ database });
  try {
    assert.equal(await world.prisma.user.count(), 0, "this scenario needs an empty install");

    const attempts = await Promise.allSettled(
      Array.from({ length: CONCURRENT_SIGN_UPS }, (_, index) => signUp(world.auth, accountSpec(world, `first${String(index)}`))),
    );
    const created = attempts.filter((attempt) => attempt.status === "fulfilled").length;
    assert.ok(created >= 1, "at least one sign-up succeeds on an empty install");

    const admins = await world.prisma.user.findMany({ where: { role: "admin" }, select: { id: true } });
    assert.equal(admins.length, 1, `exactly one instance admin, not ${String(admins.length)}`);
    assert.equal(await world.prisma.user.count(), created);

    // From here on the install is closed to strangers.
    const late = await expectRefused(() => signUp(world.auth, accountSpec(world, "latecomer")));
    assert.equal(late.code, "SIGN_UP_CLOSED");

    // The session of that account says admin; every other account is a plain user. (The sign-up
    // response itself still says "user": the promotion runs in the after-create hook, so a panel
    // reads the session after sign-up, it does not trust the sign-up response.)
    const accounts = attempts.flatMap((attempt) => (attempt.status === "fulfilled" ? [attempt.value] : []));
    const adminId = admins[0]?.id;
    assert.ok(adminId !== undefined);
    for (const account of accounts) {
      const session = await world.auth.api.getSession({ headers: account.headers });
      assert.equal(session?.user.role, account.userId === adminId ? "admin" : "user");
    }

    return `${String(CONCURRENT_SIGN_UPS)} simultaneous sign-ups on an empty install: ${String(created)} accounts created, exactly 1 instance admin; sign-up closed to strangers afterwards`;
  } finally {
    await close();
  }
};
