// Reads what an action of the keyboard specs changed on one task (F-081): the throwaway e2e
// database only. Run as `node e2e/read-keys.ts '<json>'`; prints one JSON line of IDs, states and
// counts, never a message's text.

import { createDb } from "@ostra/db";
import { z } from "zod";

const args = z.strictObject({ databaseUrl: z.string(), taskId: z.string() }).parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const task = await db.task.findUniqueOrThrow({ where: { id: args.taskId } });
const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const approvals = await db.approval.findMany({ where: { taskId: task.id }, select: { state: true, decision: true } });
const kinds = await db.event.groupBy({ by: ["kind"], where: { taskId: task.id }, _count: { _all: true } });
const facts = {
  state: task.state,
  drivenByAdmin: task.driverMemberId === admin.id,
  approvals,
  openItems: await db.needsYouItem.count({ where: { taskId: task.id, state: "open" } }),
  events: Object.fromEntries(kinds.map((row) => [row.kind, row._count._all])),
};
process.stdout.write(`${JSON.stringify(facts)}\n`);
await db.$disconnect();
