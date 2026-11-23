// Milestone 10, ticket 14 (F-151/c6): the code host's CI on a seeded task's PR head finishes, as
// core records a verdict: every job of the head's `CiRun` gets its conclusion, the run its state,
// and the task's change notice tells the page to read `tasks.get` again. Run as
// `node e2e/seed-thread-ci.ts '<json>'` with the stack's database and the task; prints one JSON line.

import { createDb } from "@ostra/db";
import { postgresChangeNotices } from "@ostra/domain";
import { organizationIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

const args = z
  .strictObject({ databaseUrl: z.string(), taskId: z.string(), state: z.enum(["passed", "failed"]), failing: z.array(z.string()).default([]) })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const task = await db.task.findUniqueOrThrow({ where: { id: args.taskId }, select: { id: true, organizationId: true, projectId: true } });
const repos = await db.taskRepo.findMany({ where: { taskId: task.id, prNumber: { not: null } }, select: { id: true, headSha: true } });
const jobsSchema = z.array(z.looseObject({ name: z.string(), conclusion: z.string().nullable().optional() }));
let jobs = 0;
for (const repo of repos) {
  if (repo.headSha === null) continue;
  const run = await db.ciRun.findFirst({ where: { taskRepoId: repo.id, headSha: repo.headSha }, orderBy: { firstSeenAt: "desc" } });
  if (run === null) continue;
  const checks = jobsSchema.parse(run.checks).map((job) => ({ ...job, conclusion: args.failing.includes(job.name) ? "failure" : "success" }));
  jobs += checks.length;
  await db.ciRun.update({ where: { id: run.id }, data: { state: args.state, checks, completedAt: new Date() } });
}
await db.$transaction((tx) =>
  postgresChangeNotices.emitInTx(tx, { organizationId: organizationIdSchema.parse(task.organizationId), projectId: projectIdSchema.parse(task.projectId), entity: "task", entityId: taskIdSchema.parse(task.id) }),
);
console.log(JSON.stringify({ jobs }));
await db.$disconnect();
