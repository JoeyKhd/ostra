// Seeds a task with a replayed event log, for the task page's browser checks (ticket 38): the
// throwaway e2e database only. Run as `node e2e/seed-task.ts '<json>'`; prints `{ "taskId": … }`.
// Events come from @ostra/task-view's fixtures (a recorded OpenCode session, or a long session),
// written the way core's ingest writes them: numbered per task, then one wake-up NOTIFY.
//
// Scenarios:
// - `mid-turn`: the recorded session up to a running command, plus partial text in live_text.
// - `rest`: appends the rest of the recorded session to a `mid-turn` task (`taskId` given).
// - `without-changes`: a finished session with no changes, in "needs you" with the agent's summary.
// - `long`: 5,000 events, for the render budget.
// - `usage`, `estimated-usage`: a turn with two counted model calls; in the second, one is an estimate (F-089).

import { randomUUID } from "node:crypto";

import { createDb, notifyChannels } from "@ostra/db";
import type { TaskEvent } from "@ostra/protocol";
import { storedEventSchema, taskEventSchema, taskIdSchema } from "@ostra/protocol";
import { longSession, recordedOpenCodeSession } from "@ostra/task-view/testing";
import { z } from "zod";

const argsSchema = z.strictObject({
  databaseUrl: z.string(),
  scenario: z.enum(["mid-turn", "rest", "without-changes", "long", "usage", "estimated-usage"]),
  taskId: taskIdSchema.optional(),
});

const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const recorded: TaskEvent[] = recordedOpenCodeSession.flatMap((raw) => {
  const event = storedEventSchema.parse(raw).event;
  // The prompt is the task's own first message, written when the task is made.
  return event.kind === "unsupported" || event.kind === "user.message" ? [] : [event];
});
const splitAt = recorded.findIndex((event) => event.kind === "tool.progress") + 1;

const appendEvents = async (taskId: string, events: readonly TaskEvent[]): Promise<void> => {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId }, include: { sessions: { orderBy: { startedAt: "desc" }, take: 1 } } });
  const session = task.sessions[0];
  if (session === undefined) throw new Error("the task has no session");
  let seq = task.eventSeq;
  const rows = events.map((event, i) => {
    seq += 1;
    return {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId,
      seq,
      sessionId: session.id,
      sessionSeq: event.kind === "pr.opened" || event.kind === "runner.connected" ? null : session.ingestedSeq + i + 1,
      leaseEpoch: null,
      kind: event.kind,
      payload: event,
      occurredAt: new Date(Date.now() - (events.length - i) * 50),
    };
  });
  for (let start = 0; start < rows.length; start += 1000) {
    await db.event.createMany({ data: rows.slice(start, start + 1000) });
  }
  // Core records a turn where it starts, which is what history pages by (ADR 0036).
  const turnsBefore = await db.turn.count({ where: { sessionId: session.id } });
  const turns = rows.flatMap((row) =>
    row.kind === "turn.started" ? [{ organizationId: task.organizationId, projectId: task.projectId, taskId, sessionId: session.id, startSeq: row.seq }] : [],
  );
  if (turns.length > 0) {
    await db.turn.createMany({ data: turns.map((turn, i) => ({ ...turn, ordinal: turnsBefore + i + 1 })) });
  }
  await db.task.update({ where: { id: taskId }, data: { eventSeq: seq } });
  await db.session.update({ where: { id: session.id }, data: { ingestedSeq: session.ingestedSeq + events.length } });
  await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId, seq })})`;
};

const createTask = async (title: string, state: "running" | "needs_you"): Promise<string> => {
  const member = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
  const organizationId = member.organizationId;
  const project =
    (await db.project.findFirst({ where: { organizationId, slug: "replay" } })) ??
    (await db.project.create({ data: { organizationId, name: "replay", slug: "replay", access: "open" } }));
  const task = await db.task.create({
    data: {
      organizationId,
      projectId: project.id,
      kind: "code",
      source: "prompt",
      title,
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-replay`,
      state,
      ...(state === "needs_you" ? { needsYouReason: "no_changes" as const } : {}),
      driverMemberId: member.id,
      creatorMemberId: member.id,
    },
  });
  await db.session.create({
    data: {
      organizationId,
      projectId: project.id,
      taskId: task.id,
      origin: "new",
      ...(state === "running" ? { state: "running" as const } : { state: "ended" as const, outcome: "without_changes" as const, endedAt: new Date() }),
    },
  });
  await appendEvents(task.id, [
    taskEventSchema.parse({ kind: "user.message", memberId: member.id, clientMessageId: randomUUID(), text: title, delivery: "immediate" }),
  ]);
  return task.id;
};

const main = async (): Promise<void> => {
  switch (args.scenario) {
    case "mid-turn": {
      const taskId = await createTask("Read the README, edit it and run a command", "running");
      await appendEvents(taskId, recorded.slice(0, splitAt));
      const last = await db.event.findFirstOrThrow({ where: { taskId, kind: "turn.started" }, orderBy: { seq: "desc" } });
      const turn = z.object({ turnId: z.string() }).parse(last.payload);
      const session = await db.session.findFirstOrThrow({ where: { taskId } });
      await db.$executeRaw`
        INSERT INTO "ostra_live"."live_text" ("taskId", "segmentId", "organizationId", "projectId", "sessionId", "turnId", "kind", "text")
        VALUES (${taskId}, ${"seg-partial"}, ${session.organizationId}, ${session.projectId}, ${session.id}, ${turn.turnId}, ${"message"}, ${"Halfway through the change, the agent writes"})`;
      process.stdout.write(`${JSON.stringify({ taskId })}\n`);
      break;
    }
    case "rest": {
      if (args.taskId === undefined) throw new Error("rest needs a taskId");
      await db.$executeRaw`DELETE FROM "ostra_live"."live_text" WHERE "taskId" = ${args.taskId}`;
      await appendEvents(args.taskId, recorded.slice(splitAt));
      process.stdout.write(`${JSON.stringify({ taskId: args.taskId })}\n`);
      break;
    }
    case "without-changes": {
      const taskId = await createTask("Explain how the tests are organised", "needs_you");
      const turnId = randomUUID();
      const segmentId = "seg-explain";
      const repoId = randomUUID();
      await appendEvents(
        taskId,
        [
          { kind: "turn.started", turnId },
          { kind: "agent.message", turnId, segmentId, text: "The tests live in `test/`, one file per module." },
          { kind: "turn.ended", turnId, stopReason: "end_turn" },
          { kind: "session.ended", outcome: "without-changes", repos: [{ repoId, ahead: false }] },
        ].map((event) => taskEventSchema.parse(event)),
      );
      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      await db.needsYouItem.create({
        data: {
          id: randomUUID(),
          organizationId: task.organizationId,
          projectId: task.projectId,
          taskId,
          reason: "no_changes",
          audience: "driver",
          summary: "No changes: the tests live in test/, one file per module.",
        },
      });
      process.stdout.write(`${JSON.stringify({ taskId })}\n`);
      break;
    }
    case "long": {
      const taskId = await createTask("A long task", "running");
      await appendEvents(taskId, longSession(5_000).filter((event) => event.kind !== "user.message"));
      process.stdout.write(`${JSON.stringify({ taskId })}\n`);
      break;
    }
    case "usage":
    case "estimated-usage": {
      // F-089: one turn with two model calls, counted by the key proxy. In `estimated-usage` the
      // endpoint reported no usage for the second, which the key proxy estimated.
      const taskId = await createTask("Count the tokens of two calls", "running");
      const turnId = randomUUID();
      const call = (inputTokens: number, outputTokens: number, estimated: boolean) => ({
        kind: "usage.recorded",
        providerId: randomUUID(),
        modelId: randomUUID(),
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimated,
      });
      await appendEvents(
        taskId,
        [
          { kind: "turn.started", turnId },
          call(1200, 300, false),
          call(800, 150, args.scenario === "estimated-usage"),
          { kind: "agent.message", turnId, segmentId: "seg-counted", text: "Two calls, counted." },
          { kind: "turn.ended", turnId, stopReason: "end_turn" },
        ].map((event) => taskEventSchema.parse(event)),
      );
      process.stdout.write(`${JSON.stringify({ taskId })}\n`);
      break;
    }
    default:
      args.scenario satisfies never;
  }
  await db.$disconnect();
};

await main();
