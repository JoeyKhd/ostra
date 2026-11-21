// Seeds a task with a replayed event log, for the task page's browser checks (ticket 38): the
// throwaway e2e database only. Run as `node e2e/seed-task.ts '<json>'`; prints `{ "taskId": … }`.
// Events come from @ostra/task-view's fixtures (a recorded OpenCode session, or a long session),
// written the way core's ingest writes them: numbered per task, then one wake-up NOTIFY.
//
// Scenarios:
// - `mid-turn`: the recorded session up to a running command, plus partial text in live_text.
// - `live-edit`: appends an edit of `docs/numbers.md` and a message to a `mid-turn` task's running
//   turn (`taskId` given), for a file change arriving while the page is open.
// - `rest`: appends the rest of the recorded session to a `mid-turn` task (`taskId` given).
// - `without-changes`: a finished session with no changes, in "needs you" with the agent's summary.
// - `long`: 5,000 events, for the render budget.
// - `usage`, `estimated-usage`: a turn with two counted model calls; in the second, one is an estimate (F-089).
// - `approval`: a running turn with a plan, an edit with its diff and a command waiting on an approval
//   (light-task.md's state, F-082).

import { randomUUID } from "node:crypto";

import { createDb, notifyChannels } from "@ostra/db";
import type { TaskEvent } from "@ostra/protocol";
import { storedEventSchema, taskEventSchema, taskIdSchema } from "@ostra/protocol";
import { longSession, recordedOpenCodeSession } from "@ostra/task-view/testing";
import { z } from "zod";

const argsSchema = z.strictObject({
  databaseUrl: z.string(),
  scenario: z.enum(["mid-turn", "live-edit", "rest", "without-changes", "long", "usage", "estimated-usage", "approval"]),
  taskId: taskIdSchema.optional(),
});

const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));

/** The agent's last message of the `without-changes` session, which is also its needs-you summary. */
const WITHOUT_CHANGES_SUMMARY = "The tests live in `test/`, one file per module:\n\n- **unit** tests beside each module\n- **e2e** tests in `test/e2e/`";

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

const createTask = async (title: string, state: "running" | "needs_you", reason: "no_changes" | "approval" = "no_changes"): Promise<string> => {
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
      ...(state === "needs_you" ? { needsYouReason: reason } : {}),
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
      ...(state === "running" || reason === "approval" ? { state: "running" as const } : { state: "ended" as const, outcome: "without_changes" as const, endedAt: new Date() }),
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
    case "live-edit": {
      if (args.taskId === undefined) throw new Error("live-edit needs a taskId");
      const last = await db.event.findFirstOrThrow({ where: { taskId: args.taskId, kind: "turn.started" }, orderBy: { seq: "desc" } });
      const turnId = z.object({ turnId: z.string() }).parse(last.payload).turnId;
      const toolCallId = "toolu_live_edit_1";
      await appendEvents(
        args.taskId,
        [
          { kind: "tool.called", turnId, toolCallId, toolKind: "edit", title: "edit", input: { paths: ["docs/numbers.md"] } },
          {
            kind: "tool.completed",
            toolCallId,
            output: { files: [{ path: "docs/numbers.md", added: 10, removed: 0, patch: "--- /dev/null\n+++ docs/numbers.md\n@@ -0,0 +1,10 @@\n+1\n+2\n+3\n+4\n+5\n+6\n+7\n+8\n+9\n+10\n" }] },
          },
          { kind: "agent.message", turnId, segmentId: "seg-live-edit", text: "Added docs/numbers.md with ten lines." },
        ].map((event) => taskEventSchema.parse(event)),
      );
      process.stdout.write(`${JSON.stringify({ taskId: args.taskId })}\n`);
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
          { kind: "agent.message", turnId, segmentId, text: WITHOUT_CHANGES_SUMMARY },
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
          // As core writes it: the agent's last message (F-065), Markdown and all.
          summary: WITHOUT_CHANGES_SUMMARY,
        },
      });
      process.stdout.write(`${JSON.stringify({ taskId })}\n`);
      break;
    }
    case "approval": {
      const taskId = await createTask("Add a state migration and run it", "needs_you", "approval");
      const turnId = randomUUID();
      const edit = "toolu_approval_edit";
      const run = "toolu_approval_run";
      const patch = [
        "--- a/src/state.ts",
        "+++ b/src/state.ts",
        "@@ -12,7 +12,9 @@ export type CalcState = {",
        "   readonly display: string;",
        "   readonly memory: number;",
        "-  readonly history: string[];",
        "+  readonly history: readonly Entry[];",
        "+  /** The schema version this state was saved at. */",
        "+  readonly version: 2;",
        " };",
      ].join("\n");
      await appendEvents(
        taskId,
        [
          { kind: "turn.started", turnId },
          { kind: "agent.message", turnId, segmentId: "seg-approval-1", text: "I'll version the saved state, then migrate the database so old rows load." },
          {
            kind: "plan.updated",
            turnId,
            entries: [
              { content: "Version the saved state", priority: "high", status: "completed" },
              { content: "Run the migration", priority: "high", status: "in_progress" },
              { content: "Run the tests", priority: "medium", status: "pending" },
            ],
          },
          { kind: "tool.called", turnId, toolCallId: edit, toolKind: "edit", title: "edit", input: { paths: ["src/state.ts"] } },
          { kind: "tool.completed", toolCallId: edit, output: { files: [{ path: "src/state.ts", added: 3, removed: 1, patch }] } },
          { kind: "tool.called", turnId, toolCallId: run, toolKind: "execute", title: "pnpm db:migrate", input: { command: "pnpm db:migrate" } },
          {
            kind: "approval.requested",
            turnId,
            approvalId: randomUUID(),
            toolCallId: run,
            options: [
              { optionId: "allow-once", label: "Approve once", kind: "allow-once", decision: "allow_once" },
              { optionId: "reject-once", label: "Deny", kind: "reject-once", decision: "deny" },
            ],
          },
        ].map((event) => taskEventSchema.parse(event)),
      );
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
