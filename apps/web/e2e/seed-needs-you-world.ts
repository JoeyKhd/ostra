// Ticket 44 (F-062, F-036): the world `21-needs-you.spec.ts` opens as Sam, a member who isn't an
// admin. Two open projects: in the first, an approval the admin's task raised; in the second, a task
// in review and one finished, for the board. Each approval is written the way core writes one: the
// task, its session, its events, the open item and Sam's notification (fan-out's row). The throwaway
// e2e database only. Run as `node e2e/seed-needs-you-world.ts '<json>'`; prints one JSON line.
//
// Steps:
// - `world`: Sam, the two projects, the first approval, the board's tasks, and setup finished.
// - `approval`: one more approval, raised now in the second project (the count rises live).

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb, notifyChannels } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { taskEventSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { z } from "zod";

const args = z
  .discriminatedUnion("step", [
    z.strictObject({ step: z.literal("world"), databaseUrl: z.string(), password: z.string(), tag: z.string().regex(/^[a-z0-9-]{1,24}$/) }),
    z.strictObject({ step: z.literal("approval"), databaseUrl: z.string(), tag: z.string().regex(/^[a-z0-9-]{1,24}$/), title: z.string().min(1) }),
  ])
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;
const samUsername = `sam-${args.tag}`;

const projectOf = async (slug: string) =>
  (await db.project.findFirst({ where: { organizationId, slug } })) ?? (await db.project.create({ data: { organizationId, name: slug, slug, access: "open" } }));

const OPTIONS = [
  { optionId: "o-once", label: "Approve once", kind: "allow-once", decision: "allow_once" },
  { optionId: "o-task", label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
  { optionId: "o-deny", label: "Deny", kind: "reject-once", decision: "deny" },
] as const;

/** A task the admin drives, in `state`, with its session and its prompt as the first event. */
const createTask = async (projectId: string, title: string, state: "needs_you" | "in_review" | "merged") => {
  const task = await db.task.create({
    data: {
      organizationId,
      projectId,
      kind: "code",
      source: "prompt",
      title,
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-needs-you`,
      state,
      ...(state === "needs_you" ? { needsYouReason: "approval" as const } : {}),
      ...(state === "in_review" ? { subState: "ci_running" as const } : {}),
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
    },
  });
  const session = await db.session.create({
    data: {
      organizationId,
      projectId,
      taskId: task.id,
      origin: "new",
      state: state === "needs_you" ? "waiting" : "ended",
      ...(state === "needs_you" ? {} : { outcome: "with_changes" as const, endedAt: new Date() }),
    },
  });
  return { taskId: task.id, sessionId: session.id };
};

const appendEvents = async (projectId: string, taskId: string, sessionId: string, events: readonly TaskEvent[]): Promise<void> => {
  const start = Date.now() - events.length * 1000;
  await db.event.createMany({
    data: events.map((event, i) => ({ organizationId, projectId, taskId, seq: i + 1, sessionId, sessionSeq: i + 1, leaseEpoch: null, kind: event.kind, payload: event, occurredAt: new Date(start + i * 1000) })),
  });
  await db.turn.create({ data: { organizationId, projectId, taskId, sessionId, startSeq: 2, ordinal: 1 } });
  await db.task.update({ where: { id: taskId }, data: { eventSeq: events.length } });
  await db.session.update({ where: { id: sessionId }, data: { ingestedSeq: events.length } });
  await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId, seq: events.length })})`;
};

/** An approval on a new task of the admin's in `projectId`, its open item, and Sam's notification for it. */
const raiseApproval = async (projectId: string, title: string, command: string, samId: string) => {
  const made = await createTask(projectId, title, "needs_you");
  const toolCallId = `tool-${made.taskId}`;
  const approval = await db.approval.create({
    data: { organizationId, projectId, taskId: made.taskId, sessionId: made.sessionId, toolCallId, options: [...OPTIONS], subjectKind: "command", subjectValue: command },
  });
  const turnId = randomUUID();
  await appendEvents(projectId, made.taskId, made.sessionId, [
    taskEventSchema.parse({ kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: title, delivery: "immediate" }),
    taskEventSchema.parse({ kind: "turn.started", turnId }),
    taskEventSchema.parse({ kind: "tool.called", turnId, toolCallId, toolKind: "execute", title: command, input: { command } }),
    taskEventSchema.parse({ kind: "approval.requested", turnId, approvalId: approval.id, toolCallId, options: [...OPTIONS], subject: { kind: "command", value: command } }),
  ]);
  const item = await db.needsYouItem.create({
    data: { organizationId, projectId, taskId: made.taskId, reason: "approval", audience: "driver", approvalId: approval.id, notifiedAt: new Date() },
  });
  await db.notification.create({ data: { organizationId, memberId: samId, projectId, taskId: made.taskId, needsYouItemId: item.id, kind: "approval" } });
  return { taskId: made.taskId, approvalId: approval.id };
};

const samMemberId = async (): Promise<string> => {
  const user = await db.user.findUniqueOrThrow({ where: { username: samUsername } });
  return (await db.member.findFirstOrThrow({ where: { userId: user.id, organizationId } })).id;
};

if (args.step === "world") {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: samUsername, email: `${samUsername}@example.com`, password: args.password, role: "member" });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${samUsername} failed: ${seeded.error}`);
  const samId = await samMemberId();
  const first = await projectOf(`ny-a-${args.tag}`);
  const second = await projectOf(`ny-b-${args.tag}`);
  const approval = await raiseApproval(first.id, `Add left-pad to the build ${args.tag}`, "pnpm add left-pad", samId);
  const inReview = await createTask(second.id, `Bump the parser ${args.tag}`, "in_review");
  const done = await createTask(second.id, `Fix the README typo ${args.tag}`, "merged");

  // Home shows needs-you only once setup is done (F-076): run alone, finish what the setup specs
  // would have. The runner stays online: its last contact is far ahead of core's presence sweep.
  if ((await db.modelProvider.count({ where: { organizationId } })) === 0) {
    await db.modelProvider.create({
      data: { organizationId, name: "Needs you seed", baseUrl: "https://needs-you-seed.invalid/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "seed:none" },
    });
  }
  if ((await db.connection.count({ where: { organizationId, kind: "github" } })) === 0) {
    await db.connection.create({ data: { organizationId, kind: "github", appId: "e2e-needs-you", slug: "e2e-needs-you" } });
  }
  await db.organizationSetting.upsert({ where: { organizationId }, create: { organizationId, linearSkippedAt: new Date() }, update: {} });
  if ((await db.runner.count({ where: { organizationId, name: "e2e-needs-you-runner" } })) === 0) {
    await db.runner.create({
      data: { organizationId, kind: "personal", ownerMemberId: admin.id, name: "e2e-needs-you-runner", publicKey: `e2e-needs-you-${randomUUID()}`, executor: "host", capacity: 1, version: "0.0.0", state: "online", lastSeenAt: new Date("2099-01-01T00:00:00Z") },
    });
  }

  process.stdout.write(
    `${JSON.stringify({ samUsername, first: { id: first.id, name: first.name }, second: { id: second.id, name: second.name }, approval, inReviewTaskId: inReview.taskId, doneTaskId: done.taskId })}\n`,
  );
} else {
  const second = await projectOf(`ny-b-${args.tag}`);
  const approval = await raiseApproval(second.id, args.title, "pnpm add right-pad", await samMemberId());
  process.stdout.write(`${JSON.stringify(approval)}\n`);
}
await db.$disconnect();
