// What milestone 4's organization specs need (tickets 32 to 35), in the throwaway e2e database only.
// Run as `node e2e/seed-m4.ts '<json>'`; prints one JSON line.
//
// Scenarios:
// - `member`: an account and an active membership with the given username and the e2e password.
// - `world`: a member (`by`), a GitHub connection with one installation, a project on the repo
//   `fake-org/m4calc`, and two tasks in it, each with a turn: one by the admin whose agent message holds
//   `word` and which ran `pnpm test -- history` in a long folder, one by the member. Each task has its
//   search entries (ticket 11's backfill, as core runs it) and its `task.created` audit entry (ticket
//   10's port). Idempotent by the project's slug.

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { backfillTaskSearchEntries, recordAudit, seedMember } from "@ostra/domain";
import { memberIdSchema, organizationIdSchema, projectIdSchema, taskEventSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.discriminatedUnion("scenario", [
  z.strictObject({ scenario: z.literal("member"), databaseUrl: z.string(), password: z.string(), username: z.string() }),
  z.strictObject({ scenario: z.literal("world"), databaseUrl: z.string(), password: z.string(), by: z.string(), word: z.string(), folder: z.string() }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const member = async (username: string, password: string) => {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password, role: "member" });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${username} failed: ${seeded.error}`);
  const user = await db.user.findUniqueOrThrow({ where: { username } });
  const row = await db.member.findFirstOrThrow({ where: { userId: user.id } });
  return { memberId: row.id, userId: user.id, organizationId: row.organizationId };
};

const world = async (input: { readonly password: string; readonly by: string; readonly word: string; readonly folder: string }) => {
  const other = await member(input.by, input.password);
  const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
  const organizationId = admin.organizationId;
  const found = await db.project.findFirst({ where: { organizationId, slug: "m4calc" }, select: { id: true } });
  if (found !== null) {
    const tasks = await db.task.findMany({ where: { projectId: found.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
    return { projectId: found.id, taskId: tasks[0]?.id ?? "", otherTaskId: tasks[1]?.id ?? "", memberId: other.memberId };
  }

  const connection = await db.connection.create({ data: { organizationId, kind: "github", appId: `e2e-m4-${randomUUID().slice(0, 8)}` } });
  await db.codeHostInstallation.create({ data: { organizationId, connectionId: connection.id, installationId: "7001", accountLogin: "fake-org", accountKind: "organization" } });
  const project = await db.project.create({ data: { organizationId, name: "m4calc", slug: "m4calc", access: "open" } });
  const repo = await db.repo.create({
    data: { organizationId, projectId: project.id, connectionId: connection.id, installationId: "7001", hostRepoId: "7101", fullName: "fake-org/m4calc", defaultBranch: "main", checkoutDir: "m4calc" },
  });

  const makeTask = async (title: string, by: string, events: (turnId: string) => readonly object[]) => {
    const task = await db.task.create({
      data: { organizationId, projectId: project.id, kind: "code", source: "prompt", title, prompt: title, branchName: `ostra/${randomUUID().slice(0, 8)}-m4`, state: "stopped", stoppedReason: "requested", driverMemberId: by, creatorMemberId: by },
    });
    await db.taskRepo.create({ data: { organizationId, projectId: project.id, taskId: task.id, repoId: repo.id, branchName: task.branchName, baseBranch: "main" } });
    const session = await db.session.create({ data: { organizationId, projectId: project.id, taskId: task.id, origin: "new", state: "ended", outcome: "without_changes", endedAt: new Date() } });
    const turnId = randomUUID();
    const parsed: TaskEvent[] = [
      { kind: "user.message", memberId: by, clientMessageId: randomUUID(), text: title, delivery: "immediate" },
      { kind: "turn.started", turnId },
      ...events(turnId),
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
    ].map((event) => taskEventSchema.parse(event));
    const start = Date.now() - parsed.length * 1000;
    await db.event.createMany({
      data: parsed.map((event, i) => ({
        organizationId,
        projectId: project.id,
        taskId: task.id,
        seq: i + 1,
        sessionId: session.id,
        sessionSeq: i + 1,
        leaseEpoch: null,
        kind: event.kind,
        payload: event,
        occurredAt: new Date(start + i * 1000),
      })),
    });
    await db.turn.create({ data: { organizationId, projectId: project.id, taskId: task.id, sessionId: session.id, startSeq: 2, ordinal: 1 } });
    await db.task.update({ where: { id: task.id }, data: { eventSeq: parsed.length } });
    await db.session.update({ where: { id: session.id }, data: { ingestedSeq: parsed.length } });
    await backfillTaskSearchEntries(db, { organizationId: organizationIdSchema.parse(organizationId), taskId: taskIdSchema.parse(task.id) });
    await db.$transaction((tx) =>
      recordAudit(tx, {
        organizationId: organizationIdSchema.parse(organizationId),
        projectId: projectIdSchema.parse(project.id),
        actor: { kind: "member", id: memberIdSchema.parse(by) },
        action: "task.created",
        entity: "task",
        entityId: taskIdSchema.parse(task.id),
        data: { kind: "code", source: "prompt" },
      }),
    );
    return task.id;
  };

  const taskId = await makeTask("Fix the history view", admin.id, (turnId) => [
    { kind: "tool.called", turnId, toolCallId: "call-read-1", toolKind: "read", title: "read", input: { path: "src/history.ts" } },
    { kind: "tool.completed", toolCallId: "call-read-1", output: { content: "export const history = [];" } },
    { kind: "tool.called", turnId, toolCallId: "call-exec-1", toolKind: "execute", title: "pnpm test", input: { command: "pnpm test -- history", cwd: input.folder } },
    { kind: "tool.completed", toolCallId: "call-exec-1", output: { exitCode: 1, stdout: "1 failed" } },
    { kind: "agent.message", turnId, segmentId: "seg-m4", text: `The history test fails on the ${input.word} rounding; I fixed the formatter.` },
  ]);
  const otherTaskId = await makeTask("Tidy the changelog", other.memberId, (turnId) => [
    { kind: "agent.message", turnId, segmentId: "seg-m4-b", text: "The changelog now lists every release." },
  ]);
  return { projectId: project.id, taskId, otherTaskId, memberId: other.memberId };
};

switch (args.scenario) {
  case "member":
    process.stdout.write(`${JSON.stringify(await member(args.username, args.password))}\n`);
    break;
  case "world":
    process.stdout.write(`${JSON.stringify(await world(args))}\n`);
    break;
  default:
    args satisfies never;
}
await db.$disconnect();
