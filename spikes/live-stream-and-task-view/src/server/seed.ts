import { exec, type Db } from "./db.ts";
import { schemaSql } from "./schema.ts";

export const migrate = async (db: Db): Promise<void> => {
  await exec(db, schemaSql);
};

export type SeedMember = { readonly memberId: string; readonly role: "member" | "viewer" };

export const seedMembers = async (db: Db, members: readonly SeedMember[]): Promise<void> => {
  for (const member of members) {
    await exec(
      db,
      "INSERT INTO members (member_id, role) VALUES ($1, $2) ON CONFLICT (member_id) DO UPDATE SET role = EXCLUDED.role",
      [member.memberId, member.role],
    );
  }
};

export const seedTasks = async (db: Db, taskIds: readonly string[], driverMemberId: string | null): Promise<void> => {
  if (taskIds.length === 0) return;
  await exec(
    db,
    `INSERT INTO tasks (task_id, driver_member_id) SELECT t, $2 FROM unnest($1::text[]) AS t ON CONFLICT (task_id) DO NOTHING`,
    [taskIds, driverMemberId],
  );
  await exec(
    db,
    `INSERT INTO task_counters (task_id) SELECT t FROM unnest($1::text[]) AS t ON CONFLICT (task_id) DO NOTHING`,
    [taskIds],
  );
};
