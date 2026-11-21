import type { Db } from "@ostra/db";
import type { OrganizationId } from "@ostra/protocol";

// F-076 (2026-11-21, the maintainer's "all yes"): an organization's setup is done for good once
// every required step of Home's checklist was done at one time. `setup.status` keeps the moment the
// first time it sees it; from then on Home never shows the checklist again, and says so in a notice
// while no runner is online instead.

/**
 * Keeps when the organization's setup was first complete, once, and answers the time that holds: an
 * earlier one when another request kept it first. Idempotent. No audit entry: nobody acted.
 */
export const recordSetupComplete = async (db: Pick<Db, "organizationSetting">, organizationId: OrganizationId, now: number): Promise<number> => {
  const at = new Date(now);
  await db.organizationSetting.createMany({ data: [{ organizationId, setupCompletedAt: at }], skipDuplicates: true });
  await db.organizationSetting.updateMany({ where: { organizationId, setupCompletedAt: null }, data: { setupCompletedAt: at } });
  const row = await db.organizationSetting.findUnique({ where: { organizationId }, select: { setupCompletedAt: true } });
  return row?.setupCompletedAt?.getTime() ?? now;
};
