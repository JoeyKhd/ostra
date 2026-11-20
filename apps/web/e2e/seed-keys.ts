// Seeds the tasks the keyboard specs act on (F-081, milestone 7, tickets 13, 16 and 17), in the
// throwaway e2e database only. Run as `node e2e/seed-keys.ts '<json>'`; prints one JSON line.
// Each call makes one new task in the project `keys`, titled as asked, written the way core writes
// them: the task, its session, its events numbered per task, and its open needs-you item.
//
// Scenarios:
// - `approval`: "needs you" for an approval the admin may answer (approve once, for this task, deny).
// - `question`: "needs you" for a question of one choice list, which the admin, its driver, answers.
// - `running-other`: a running task driven by another member, which the admin may take over.
// - `stopped`: a task the admin stopped, which they may reopen.

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb, notifyChannels } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { taskEventSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.strictObject({
  databaseUrl: z.string(),
  password: z.string(),
  scenario: z.enum(["approval", "question", "running-other", "stopped"]),
  title: z.string().min(1),
});
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const OPTIONS = [
  { optionId: "o-once", label: "Approve once", kind: "allow-once", decision: "allow_once" },
  { optionId: "o-task", label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
  { optionId: "o-deny", label: "Deny", kind: "reject-once", decision: "deny" },
] as const;

const otherDriver = async (): Promise<string> => {
  const username = "e2e-keys-driver";
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role: "member" });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${username} failed: ${seeded.error}`);
  const user = await db.user.findUniqueOrThrow({ where: { username } });
  return (await db.member.findFirstOrThrow({ where: { userId: user.id } })).id;
};

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;
const project =
  (await db.project.findFirst({ where: { organizationId, slug: "keys" } })) ?? (await db.project.create({ data: { organizationId, name: "keys", slug: "keys", access: "open" } }));

type Shape = {
  readonly state: "needs_you" | "running" | "stopped";
  readonly needsYouReason?: "approval" | "question";
  readonly driver: string;
  readonly session: "waiting" | "running" | "ended";
};

const shapes = {
  approval: { state: "needs_you", needsYouReason: "approval", driver: admin.id, session: "waiting" },
  question: { state: "needs_you", needsYouReason: "question", driver: admin.id, session: "waiting" },
  "running-other": { state: "running", driver: "other", session: "running" },
  stopped: { state: "stopped", driver: admin.id, session: "ended" },
} as const satisfies Record<z.infer<typeof argsSchema>["scenario"], Shape>;

const shape = shapes[args.scenario];
const driver = shape.driver === "other" ? await otherDriver() : shape.driver;
const task = await db.task.create({
  data: {
    organizationId,
    projectId: project.id,
    kind: "code",
    source: "prompt",
    title: args.title,
    prompt: args.title,
    branchName: `ostra/${randomUUID().slice(0, 8)}-keys`,
    state: shape.state,
    ...("needsYouReason" in shape ? { needsYouReason: shape.needsYouReason } : {}),
    ...(shape.state === "stopped" ? { stoppedReason: "requested" as const } : {}),
    driverMemberId: driver,
    creatorMemberId: driver,
  },
});
const session = await db.session.create({
  data: {
    organizationId,
    projectId: project.id,
    taskId: task.id,
    origin: "new",
    state: shape.session,
    ...(shape.session === "ended" ? { outcome: "without_changes" as const, endedAt: new Date() } : {}),
  },
});

const turnId = randomUUID();
const events: TaskEvent[] = [
  taskEventSchema.parse({ kind: "user.message", memberId: driver, clientMessageId: randomUUID(), text: args.title, delivery: "immediate" }),
  taskEventSchema.parse({ kind: "turn.started", turnId }),
  taskEventSchema.parse({ kind: "agent.message", turnId, segmentId: `seg-${task.id}`, text: "I read the README first." }),
];

let approvalId: string | null = null;
let questionId: string | null = null;
if (args.scenario === "approval") {
  const approval = await db.approval.create({
    data: { organizationId, projectId: project.id, taskId: task.id, sessionId: session.id, toolCallId: `tool-${task.id}`, options: [...OPTIONS], subjectKind: "command", subjectValue: "pnpm add left-pad" },
  });
  approvalId = approval.id;
  events.push(
    taskEventSchema.parse({ kind: "tool.called", turnId, toolCallId: `tool-${task.id}`, toolKind: "execute", title: "pnpm add left-pad", input: { command: "pnpm add left-pad" } }),
    taskEventSchema.parse({ kind: "approval.requested", turnId, approvalId: approval.id, toolCallId: `tool-${task.id}`, options: [...OPTIONS], subject: { kind: "command", value: "pnpm add left-pad" } }),
  );
} else if (args.scenario === "question") {
  questionId = `question-${randomUUID()}`;
  events.push(taskEventSchema.parse({ kind: "question.asked", turnId, questionId, message: "Which test runner?", fields: [{ id: "runner", label: "Runner", type: "select", options: ["vitest", "jest"] }] }));
} else if (args.scenario === "stopped") {
  events.push(taskEventSchema.parse({ kind: "turn.ended", turnId, stopReason: "cancelled" }));
}

const start = Date.now() - events.length * 1000;
await db.event.createMany({
  data: events.map((event, i) => ({
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
await db.task.update({ where: { id: task.id }, data: { eventSeq: events.length } });
await db.session.update({ where: { id: session.id }, data: { ingestedSeq: events.length } });
if (args.scenario === "approval" || args.scenario === "question") {
  await db.needsYouItem.create({
    data: { organizationId, projectId: project.id, taskId: task.id, reason: args.scenario, audience: "driver", ...(approvalId === null ? {} : { approvalId }), ...(questionId === null ? {} : { questionId }) },
  });
}
await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId: task.id, seq: events.length })})`;

process.stdout.write(`${JSON.stringify({ taskId: task.id, key: task.id.replaceAll("-", "").slice(-8), approvalId, questionId })}\n`);
await db.$disconnect();
