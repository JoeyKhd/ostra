// The budget facts the spend-and-budgets spec checks in the database (F-037): a task's held turns
// and whether each was released, and its dispatch wait. The throwaway e2e database only.
// Run as `node e2e/read-budget.ts '<json>'`; prints one JSON line.

import { createDb } from "@ostra/db";
import { z } from "zod";

const args = z.strictObject({ databaseUrl: z.string(), taskId: z.string() }).parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);
const task = await db.task.findUniqueOrThrow({ where: { id: args.taskId }, select: { state: true, dispatchWait: true } });
const held = await db.heldTurn.findMany({ where: { taskId: args.taskId }, select: { origin: true, releasedAt: true } });
process.stdout.write(`${JSON.stringify({ state: task.state, dispatchWait: task.dispatchWait, held: held.map((row) => ({ origin: row.origin, released: row.releasedAt !== null })) })}\n`);
await db.$disconnect();
