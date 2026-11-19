import {
  approvalIdSchema,
  clientMessageIdSchema,
  questionIdSchema,
  segmentIdSchema,
  storedEventSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { SessionId, StoredEvent, TaskEvent, TaskId } from "@ostra/protocol";
import { eventFixtures, fixtureIds } from "@ostra/protocol/testing";

export { recordedOpenCodeSession } from "./opencode-session.ts";

// Test data for the fold and its consumers: stored events built from plain events, a coherent
// session with every kind, and long sessions for the render budget. Ported from
// spikes/live-stream-and-task-view/src/producer/scenarios.ts.

export type StoreOptions = {
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  /** The seq of the first event. */
  readonly fromSeq?: number;
  readonly at?: number;
};

/** Numbers plain events as the server would store them. */
export const storeEvents = (
  events: readonly TaskEvent[],
  options: StoreOptions = {},
): StoredEvent[] => {
  const from = options.fromSeq ?? 1;
  return events.map((event, i) =>
    storedEventSchema.parse({
      taskId: options.taskId ?? fixtureIds.task,
      seq: from + i,
      sessionId: options.sessionId ?? fixtureIds.session,
      sessionSeq: from + i,
      at: (options.at ?? 1_795_000_000_000) + i,
      event,
    }),
  );
};

const f = eventFixtures;

const secondTurn = turnIdSchema.parse("0196f1a0-0000-7000-8000-000000000016");
const call2 = toolCallIdSchema.parse("call-2");
const call3 = toolCallIdSchema.parse("call-3");
const call4 = toolCallIdSchema.parse("call-4");
const approval2 = approvalIdSchema.parse("0196f1a0-0000-7000-8000-00000000001e");
const approval3 = approvalIdSchema.parse("0196f1a0-0000-7000-8000-00000000002e");
const question2 = questionIdSchema.parse("question-2");

/**
 * One coherent session holding every event kind of the protocol, in an order a real session could
 * produce. Tool updates follow their call; answers follow their request.
 */
export const allKindsSession = (): TaskEvent[] => [
  f["user.message"],
  f["runner.connected"],
  f["environment.setup_started"],
  f["environment.setup_output"],
  f["environment.setup_finished"],
  f["turn.started"],
  f["agent.thought"],
  f["plan.updated"],
  f["tool.called"],
  f["tool.progress"],
  f["approval.requested"],
  f["approval.answered"],
  f["tool.completed"],
  f["question.asked"],
  f["question.answered"],
  f["agent.content"],
  f["compaction.updated"],
  f["session.config_changed"],
  { ...f["agent.message"], segmentId: segmentIdSchema.parse("seg-2") },
  f["usage.recorded"],
  f["session.usage"],
  f["provider.rate_limited"],
  f["agent.unknown"],
  f["turn.cancel_requested"],
  f["turn.ended"],
  f["git.pushed"],
  f["pr.text_set"],
  f["session.ended"],
  f["pr.opened"],
  f["driver.changed"],
  f["runner.lost"],
  f["session.restored"],
  // A second turn: an auto-answered approval, an expired one, a closed question, a failed tool.
  { kind: "turn.started", turnId: secondTurn },
  {
    kind: "tool.called",
    turnId: secondTurn,
    toolCallId: call2,
    toolKind: "execute",
    title: "ls",
    input: { command: "ls" },
  },
  { ...f["approval.requested"], turnId: secondTurn, approvalId: approval2, toolCallId: call2 },
  { ...f["approval.auto_answered"], approvalId: approval2 },
  {
    kind: "tool.completed",
    toolCallId: call2,
    output: { output: "README.md\n", truncated: false, exitCode: 0 },
  },
  {
    kind: "tool.called",
    turnId: secondTurn,
    toolCallId: call3,
    toolKind: "execute",
    title: "rm -rf build",
    input: { command: "rm -rf build" },
  },
  { ...f["approval.requested"], turnId: secondTurn, approvalId: approval3, toolCallId: call3 },
  { ...f["approval.closed"], approvalId: approval3, reason: "expired" },
  {
    kind: "tool.called",
    turnId: secondTurn,
    toolCallId: call4,
    toolKind: "execute",
    title: "pnpm test",
    input: { command: "pnpm test" },
  },
  { kind: "tool.failed", toolCallId: call4, error: "exit 1" },
  { ...f["question.asked"], turnId: secondTurn, questionId: question2 },
  { ...f["question.closed"], questionId: question2 },
  { ...f["turn.failed"], turnId: secondTurn },
  f["session.crashed"],
];

const turnId = (n: number) =>
  turnIdSchema.parse(`0196f1a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);

/**
 * A long task: `turns` turns, each a member message, thoughts, a read, an edit, a command with
 * progress and text, about `perTurn` events each. For the render budget (ADR 0036, Q112).
 */
export const longSession = (total: number, perTurn = 25): TaskEvent[] => {
  const events: TaskEvent[] = [];
  let n = 0;
  for (let t = 0; events.length < total; t += 1) {
    const turn = turnId(0x1000 + t);
    events.push({
      ...f["user.message"],
      clientMessageId: clientMessageIdSchema.parse(`client-${String(t)}`),
      text: `Step ${String(t)}`,
    });
    events.push({ kind: "turn.started", turnId: turn });
    while (events.length % perTurn !== perTurn - 1 && events.length < total) {
      n += 1;
      const call = toolCallIdSchema.parse(`call-${String(n)}`);
      const seg = segmentIdSchema.parse(`seg-${String(n)}`);
      switch (n % 6) {
        case 0:
          events.push({
            kind: "agent.thought",
            turnId: turn,
            segmentId: seg,
            text: `Thinking about step ${String(n)}.`,
          });
          break;
        case 1:
          events.push({
            kind: "tool.called",
            turnId: turn,
            toolCallId: call,
            toolKind: "read",
            title: "read",
            input: { path: `src/file-${String(n)}.ts` },
          });
          events.push({ kind: "tool.completed", toolCallId: call, output: { lineCount: 40 } });
          break;
        case 2:
          events.push({
            kind: "tool.called",
            turnId: turn,
            toolCallId: call,
            toolKind: "edit",
            title: "edit",
            input: { paths: [`src/file-${String(n)}.ts`] },
          });
          events.push({
            kind: "tool.completed",
            toolCallId: call,
            output: { files: [{ path: `src/file-${String(n)}.ts`, added: 3, removed: 1 }] },
          });
          break;
        case 3:
          events.push({
            kind: "tool.called",
            turnId: turn,
            toolCallId: call,
            toolKind: "execute",
            title: "pnpm test",
            input: { command: "pnpm test" },
          });
          events.push({
            kind: "tool.progress",
            toolCallId: call,
            output: { output: "running", truncated: false, exitCode: null },
          });
          events.push({
            kind: "tool.completed",
            toolCallId: call,
            output: { output: "ok\n", truncated: false, exitCode: 0 },
          });
          break;
        case 4:
          events.push({
            kind: "tool.called",
            turnId: turn,
            toolCallId: call,
            toolKind: "search",
            title: "grep",
            input: { pattern: "TODO" },
          });
          events.push({ kind: "tool.completed", toolCallId: call, output: { matches: 2 } });
          break;
        default:
          events.push({
            kind: "agent.message",
            turnId: turn,
            segmentId: seg,
            text: `Done with part ${String(n)}. **Next** comes the test.`,
          });
          break;
      }
    }
    events.push({ kind: "turn.ended", turnId: turn, stopReason: "end_turn" });
  }
  return events.slice(0, total);
};
