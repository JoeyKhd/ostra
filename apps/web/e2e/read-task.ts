// Reads what the database holds for one task, for the browser checks that need more than the page
// shows: the throwaway e2e database only. Run as `node e2e/read-task.ts '<json>'`; prints one JSON
// line. It reads IDs, states and counts, never a prompt's text.

import { createDb } from "@ostra/db";
import { taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.strictObject({ databaseUrl: z.string(), taskId: taskIdSchema });

const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const task = await db.task.findUniqueOrThrow({ where: { id: args.taskId }, include: { project: true, sessions: true } });
const facts = {
  source: task.source,
  kind: task.kind,
  state: task.state,
  ticketKey: task.ticketKey,
  ticketId: task.ticketId,
  projectSlug: task.project.slug,
  sessions: task.sessions.length,
  /** The agent profile it started with (F-021). */
  profileName: task.agentProfileId === null ? null : ((await db.agentProfile.findUnique({ where: { id: task.agentProfileId }, select: { name: true } }))?.name ?? null),
  projectBoards: await db.board.count({ where: { projectId: task.projectId } }),
  tickets: await db.ticket.count({ where: { organizationId: task.organizationId } }),
  ticketWrites: await db.ticketWrite.count({ where: { organizationId: task.organizationId } }),
  dispatchJobs: Number(
    (await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pgboss.job WHERE name = 'task.dispatch' AND data->>'taskId' = ${task.id}`)[0]?.n ?? 0n,
  ),
};
process.stdout.write(`${JSON.stringify(facts)}\n`);
await db.$disconnect();
