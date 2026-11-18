import {
  ApprovalId,
  MemberId,
  OptionId,
  QuestionId,
  RunnerId,
  SegmentId,
  ToolCallId,
  TurnId,
  type TaskId,
} from "../shared/ids.ts";
import type { ApprovalOption, LiveTextFrame, TaskEvent } from "../shared/events.ts";
import { sleep } from "../shared/time.ts";
import type { RunnerClient } from "./runner-client.ts";

// Synthetic sessions. The kinds mirror what spike 1 will record from OpenCode, so the same page and
// the same fold render both (research/agent-ui-stream.md, the mapping table).

export const approvalOptions: ApprovalOption[] = [
  { optionId: OptionId.parse("once"), label: "Approve once", kind: "allow-once", decision: "allow_once" },
  { optionId: OptionId.parse("task"), label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
  { optionId: OptionId.parse("deny"), label: "Deny", kind: "reject-once", decision: "deny" },
];

// Agent text is untrusted. This message is what a hostile or compromised agent could say: a remote image
// (a beacon to a third party), raw HTML with an event handler, a javascript: link and a script tag. The page
// must show all of it as inert text, load nothing from the third party, and run nothing.
export const thirdPartyHost = "third-party.invalid";
export const remoteImageUrl = `https://${thirdPartyHost}/block.png`;
const hostileMarkdown = [
  "Hostile content, which must render inert:",
  "",
  `![beacon](https://${thirdPartyHost}/p.png)`,
  "",
  `<img src="https://${thirdPartyHost}/x.png" onerror="fetch('https://${thirdPartyHost}/y')">`,
  "",
  "[click me](javascript:alert(1))",
  "",
  `<script>fetch('https://${thirdPartyHost}/z')</script>`,
].join("\n");

// One event of every kind the runner may send, in an order a real session could produce.
// `pendingApprovalId` stays open so a test can answer it.
export const buildAllKindsEvents = (prefix: string): { events: TaskEvent[]; pendingApprovalId: ApprovalId } => {
  const t1 = TurnId.parse(`${prefix}-t1`);
  const t2 = TurnId.parse(`${prefix}-t2`);
  const call = (n: number): ToolCallId => ToolCallId.parse(`${prefix}-call-${String(n)}`);
  const pending = ApprovalId.parse(`${prefix}-approval-pending`);
  const auto = ApprovalId.parse(`${prefix}-approval-auto`);
  const closed = ApprovalId.parse(`${prefix}-approval-closed`);
  const events: TaskEvent[] = [
    { kind: "runner.connected", runnerId: RunnerId.parse("runner-1") },
    { kind: "turn.started", turnId: t1 },
    { kind: "agent.thought", turnId: t1, segmentId: SegmentId.parse(`${prefix}-th1`), text: "The ticket asks for a retry. I should look at the client first." },
    { kind: "agent.message", turnId: t1, segmentId: SegmentId.parse(`${prefix}-m1`), text: "I'll read the HTTP client, then add a bounded retry.\n\n- **Read** `src/client.ts`\n- Add `retry()`\n- Run the tests" },
    {
      kind: "agent.message",
      turnId: t1,
      segmentId: SegmentId.parse(`${prefix}-m-hostile`),
      text: hostileMarkdown,
    },
    {
      kind: "plan.updated",
      turnId: t1,
      entries: [
        { content: "Read the HTTP client", priority: "high", status: "completed" },
        { content: "Add a bounded retry", priority: "high", status: "in_progress" },
        { content: "Run the tests", priority: "medium", status: "pending" },
      ],
    },
    { kind: "tool.called", turnId: t1, toolCallId: call(1), toolKind: "read", title: "Read src/client.ts", input: { path: "src/client.ts" } },
    { kind: "tool.completed", toolCallId: call(1), output: { lineCount: 212 } },
    { kind: "tool.called", turnId: t1, toolCallId: call(2), toolKind: "edit", title: "Edit src/client.ts", input: { paths: ["src/client.ts"] } },
    {
      kind: "tool.completed",
      toolCallId: call(2),
      output: {
        files: [
          {
            path: "src/client.ts",
            added: 14,
            removed: 3,
            patch: "@@ -10,3 +10,14 @@\n-  return fetch(url);\n+  return retry(() => fetch(url), { attempts: 3 });\n",
          },
        ],
      },
    },
    { kind: "tool.called", turnId: t1, toolCallId: call(3), toolKind: "execute", title: "pnpm test", input: { command: "pnpm test", cwd: "." } },
    { kind: "tool.progress", toolCallId: call(3), output: { output: "running 12 tests\n", truncated: false, exitCode: null } },
    {
      kind: "tool.completed",
      toolCallId: call(3),
      output: { output: "running 12 tests\n12 passed\n", truncated: false, exitCode: 0 },
    },
    { kind: "tool.called", turnId: t1, toolCallId: call(4), toolKind: "search", title: "Search for retry helpers", input: { query: "retry" } },
    { kind: "tool.completed", toolCallId: call(4), output: { matches: 3 } },
    { kind: "tool.called", turnId: t1, toolCallId: call(5), toolKind: "other", title: "Custom tool", input: { anything: true } },
    { kind: "tool.failed", toolCallId: call(5), error: "tool crashed" },
    { kind: "tool.called", turnId: t1, toolCallId: call(6), toolKind: "execute", title: "git push origin main", input: { command: "git push origin main" } },
    { kind: "approval.requested", turnId: t1, approvalId: pending, toolCallId: call(6), options: approvalOptions },
    { kind: "tool.called", turnId: t1, toolCallId: call(7), toolKind: "execute", title: "ls", input: { command: "ls" } },
    { kind: "approval.requested", turnId: t1, approvalId: auto, toolCallId: call(7), options: approvalOptions },
    { kind: "approval.auto_answered", approvalId: auto, ruleId: "rule-ls" },
    { kind: "tool.completed", toolCallId: call(7), output: { output: "README.md\n", truncated: false, exitCode: 0 } },
    { kind: "tool.called", turnId: t1, toolCallId: call(8), toolKind: "execute", title: "rm -rf build", input: { command: "rm -rf build" } },
    { kind: "approval.requested", turnId: t1, approvalId: closed, toolCallId: call(8), options: approvalOptions },
    { kind: "approval.closed", approvalId: closed, reason: "expired" },
    { kind: "agent.content", turnId: t1, block: { type: "image", mediaType: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" } },
    { kind: "agent.content", turnId: t1, block: { type: "image", mediaType: "image/png", url: remoteImageUrl } },
    { kind: "agent.content", turnId: t1, block: { type: "resource_link", uri: "https://example.com/docs", title: "Retry docs" } },
    {
      kind: "question.asked",
      turnId: t1,
      questionId: QuestionId.parse(`${prefix}-q1`),
      message: "Which retry policy do you want?",
      fields: [
        { id: "policy", label: "Policy", type: "select", options: ["fixed", "exponential"] },
        { id: "note", label: "Note", type: "text" },
      ],
    },
    { kind: "question.closed", questionId: QuestionId.parse(`${prefix}-q1`), reason: "expired" },
    {
      kind: "question.asked",
      turnId: t1,
      questionId: QuestionId.parse(`${prefix}-q2`),
      message: "Should the retry be logged?",
      fields: [{ id: "log", label: "Log it", type: "select", options: ["yes", "no"] }],
    },
    { kind: "compaction.updated", turnId: t1, status: "running" },
    { kind: "compaction.updated", turnId: t1, status: "done", summary: "Compacted 40 messages." },
    { kind: "session.config_changed", key: "mode", value: "build" },
    { kind: "agent.unknown", acpKind: "some_future_update", raw: "{\"sessionUpdate\":\"some_future_update\"}" },
    { kind: "runner.lost", runnerId: RunnerId.parse("runner-1") },
    { kind: "runner.connected", runnerId: RunnerId.parse("runner-2") },
    { kind: "session.restored" },
    { kind: "pr.opened", url: "https://github.com/ostra-test/repo/pull/1", number: 1 },
    { kind: "agent.message", turnId: t1, segmentId: SegmentId.parse(`${prefix}-m2`), text: "Done. The PR is open." },
    { kind: "turn.ended", turnId: t1, stopReason: "end_turn" },
    { kind: "turn.started", turnId: t2 },
    { kind: "turn.failed", turnId: t2, error: "model endpoint returned 502" },
    { kind: "session.crashed", error: "agent exited with code 1" },
  ];
  return { events, pendingApprovalId: pending };
};

// Server-only events a test writes through the API or directly, to cover the rest of the union.
export const buildServerOnlySamples = (prefix: string, memberId: string): TaskEvent[] => [
  {
    kind: "question.answered",
    questionId: QuestionId.parse(`${prefix}-q2`),
    answers: { policy: "exponential" },
    memberId: MemberId.parse(memberId),
  },
];

const words = "the quick brown fox jumps over a lazy dog while the build runs green and tests pass quietly ".split(" ");

export const loremWords = (count: number, offset = 0): string => {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(words[(i + offset) % words.length] ?? "word");
  return out.join(" ");
};

const loremSource = `${words.join(" ")} `.repeat(400);

// Text of an exact length, for payloads that must look like real tool output rather than a few words.
export const loremChars = (chars: number, offset = 0): string => {
  const start = offset % 50;
  return loremSource.slice(start, start + Math.max(0, chars));
};

// A streaming turn: partial text every 250 ms (live frames, never stored), then the completed
// message. `streamMs` controls how long the segment stays open.
export const streamingTurn = async (
  client: RunnerClient,
  taskId: TaskId,
  opts: { turnId: string; segmentId: string; totalWords: number; streamMs: number; tail?: boolean },
): Promise<void> => {
  const turnId = TurnId.parse(opts.turnId);
  const segmentId = SegmentId.parse(opts.segmentId);
  client.emit(taskId, { kind: "turn.started", turnId });
  const ticks = Math.max(1, Math.floor(opts.streamMs / 250));
  for (let i = 1; i <= ticks; i += 1) {
    const sent = Math.floor((opts.totalWords * i) / ticks);
    client.live(taskId, { segmentId, turnId, part: "message", text: loremWords(sent) });
    await sleep(250);
  }
  client.emit(taskId, { kind: "agent.message", turnId, segmentId, text: loremWords(opts.totalWords) });
  if (opts.tail !== false) client.emit(taskId, { kind: "turn.ended", turnId, stopReason: "end_turn" });
};

// An execute tool's output, sized like real command output (a test run, a build log): 4 to 20 KB.
const bigOutput = (seed: number): string => loremChars(4096 + ((seed * 7919) % 16_385), seed);

// A long task: `turns` turns of about 50 events each (100 turns is just over 5,000 events) (reads, edits,
// commands, messages). With `bigOutputEvery`, every n-th command completes with 4 to 20 KB of output.
export const buildLongSession = (prefix: string, turns: number, opts: { bigOutputEvery?: number } = {}): TaskEvent[] => {
  const events: TaskEvent[] = [];
  const every = opts.bigOutputEvery ?? 0;
  let commands = 0;
  for (let t = 0; t < turns; t += 1) {
    const turnId = TurnId.parse(`${prefix}-lt${String(t)}`);
    events.push({ kind: "turn.started", turnId });
    events.push({
      kind: "agent.message",
      turnId,
      segmentId: SegmentId.parse(`${prefix}-lt${String(t)}-m0`),
      text: `Turn ${String(t)}: ${loremWords(40, t)}`,
    });
    for (let c = 0; c < 20; c += 1) {
      const id = ToolCallId.parse(`${prefix}-lt${String(t)}-c${String(c)}`);
      const kind = c % 3;
      if (kind === 0) {
        events.push({ kind: "tool.called", turnId, toolCallId: id, toolKind: "read", title: `Read file ${String(c)}`, input: { path: `src/file-${String(c)}.ts` } });
        events.push({ kind: "tool.completed", toolCallId: id, output: { lineCount: 100 + c } });
      } else if (kind === 1) {
        events.push({ kind: "tool.called", turnId, toolCallId: id, toolKind: "edit", title: `Edit file ${String(c)}`, input: { paths: [`src/file-${String(c)}.ts`] } });
        events.push({
          kind: "tool.completed",
          toolCallId: id,
          output: { files: [{ path: `src/file-${String(c)}.ts`, added: 5, removed: 2, patch: "@@ -1,2 +1,5 @@\n-old\n+new\n" }] },
        });
      } else {
        commands += 1;
        const big = every > 0 && commands % every === 0;
        events.push({ kind: "tool.called", turnId, toolCallId: id, toolKind: "execute", title: "pnpm test", input: { command: "pnpm test" } });
        events.push({ kind: "tool.progress", toolCallId: id, output: { output: "running\n", truncated: false, exitCode: null } });
        events.push({ kind: "tool.completed", toolCallId: id, output: { output: big ? bigOutput(commands) : "ok\n", truncated: false, exitCode: 0 } });
      }
    }
    events.push({
      kind: "agent.message",
      turnId,
      segmentId: SegmentId.parse(`${prefix}-lt${String(t)}-m1`),
      text: `Finished turn ${String(t)}. ${loremWords(30, t + 7)}`,
    });
    events.push({ kind: "turn.ended", turnId, stopReason: "end_turn" });
  }
  return events;
};

// Many short turns: 500 turns of 10 events (a message, three tool calls, a message), which is 500 assistant
// messages for the page to lay out instead of 100.
export const buildManyTurns = (prefix: string, turns: number): TaskEvent[] => {
  const events: TaskEvent[] = [];
  for (let t = 0; t < turns; t += 1) {
    const turnId = TurnId.parse(`${prefix}-mt${String(t)}`);
    events.push({ kind: "turn.started", turnId });
    events.push({ kind: "agent.message", turnId, segmentId: SegmentId.parse(`${prefix}-mt${String(t)}-m0`), text: `Turn ${String(t)}: ${loremWords(25, t)}` });
    for (let c = 0; c < 3; c += 1) {
      const id = ToolCallId.parse(`${prefix}-mt${String(t)}-c${String(c)}`);
      if (c === 0) {
        events.push({ kind: "tool.called", turnId, toolCallId: id, toolKind: "read", title: "Read file", input: { path: `src/file-${String(t)}.ts` } });
        events.push({ kind: "tool.completed", toolCallId: id, output: { lineCount: 120 } });
      } else if (c === 1) {
        events.push({ kind: "tool.called", turnId, toolCallId: id, toolKind: "search", title: "Search", input: { query: "retry" } });
        events.push({ kind: "tool.completed", toolCallId: id, output: { matches: t % 9 } });
      } else {
        events.push({ kind: "tool.called", turnId, toolCallId: id, toolKind: "execute", title: "pnpm test", input: { command: "pnpm test" } });
        events.push({ kind: "tool.completed", toolCallId: id, output: { output: t % 25 === 0 ? bigOutput(t) : "ok\n", truncated: false, exitCode: 0 } });
      }
    }
    events.push({ kind: "agent.message", turnId, segmentId: SegmentId.parse(`${prefix}-mt${String(t)}-m1`), text: `Done with ${String(t)}. ${loremWords(20, t + 3)}` });
    events.push({ kind: "turn.ended", turnId, stopReason: "end_turn" });
  }
  return events;
};

// One enormous turn: a single assistant message holding `pairs` tool calls (2,499 pairs plus the two turn
// events is 5,000 events), the shape that stresses one message's parts instead of the message count.
export const buildSingleTurn = (prefix: string, pairs: number): TaskEvent[] => {
  const turnId = TurnId.parse(`${prefix}-st`);
  const events: TaskEvent[] = [{ kind: "turn.started", turnId }];
  for (let c = 0; c < pairs; c += 1) {
    const id = ToolCallId.parse(`${prefix}-st-c${String(c)}`);
    if (c % 2 === 0) {
      events.push({ kind: "tool.called", turnId, toolCallId: id, toolKind: "read", title: "Read file", input: { path: `src/file-${String(c)}.ts` } });
      events.push({ kind: "tool.completed", toolCallId: id, output: { lineCount: 40 + (c % 200) } });
    } else {
      events.push({ kind: "tool.called", turnId, toolCallId: id, toolKind: "execute", title: "pnpm test", input: { command: "pnpm test" } });
      events.push({ kind: "tool.completed", toolCallId: id, output: { output: c % 50 === 1 ? bigOutput(c) : "ok\n", truncated: false, exitCode: 0 } });
    }
  }
  events.push({ kind: "turn.ended", turnId, stopReason: "end_turn" });
  return events;
};

// A task receiving events at a steady rate for the browser-latency check. Each event is a message whose text
// carries the time it was emitted (`lat:<ms>:<n>`), so the page can measure, from the DOM alone, how long it
// took from emit to the row being on screen. A turn is 20 messages.
export type LatencyScript = { readonly next: (now: number) => TaskEvent };

export const createLatencyScript = (prefix: string): LatencyScript => {
  let n = 0;
  let turn = 0;
  const turnId = (): TurnId => TurnId.parse(`${prefix}-lat-turn-${String(turn)}`);
  return {
    next: (now) => {
      const step = n % 22;
      n += 1;
      if (step === 0) return { kind: "turn.started", turnId: turnId() };
      if (step === 21) {
        const ended: TaskEvent = { kind: "turn.ended", turnId: turnId(), stopReason: "end_turn" };
        turn += 1;
        return ended;
      }
      return { kind: "agent.message", turnId: turnId(), segmentId: SegmentId.parse(`${prefix}-lat-${String(n)}`), text: `lat:${String(now)}:${String(n)}` };
    },
  };
};

// An endless per-task script of realistic events for the load test: small events, tool outputs of 4 to 20 KB,
// and (when streaming is on) a 4 KB message per ~4 s whose partial text the runner also sends every 250 ms.
export type LoadScriptOptions = {
  // every n-th command completes with 4 to 20 KB of output (0 for never)
  readonly largeOutputEvery: number;
  // the partial text grows by this many characters per frame, up to `segmentChars`
  readonly liveStepChars: number;
  readonly segmentChars: number;
};

export type LoadScript = {
  readonly next: () => TaskEvent;
  // The next partial-text frame of the open segment (growing toward `segmentChars`), or null when not streaming.
  readonly liveFrame: () => LiveTextFrame | null;
  readonly setStreaming: (on: boolean) => void;
};

export const createLoadScript = (prefix: string, opts: LoadScriptOptions): LoadScript => {
  let n = 0;
  let turn = 0;
  let commands = 0;
  let streaming = false;
  let segment = 0;
  let liveTicks = 0;
  const maxTicks = Math.ceil(opts.segmentChars / opts.liveStepChars);
  const turnPrefix = (): string => `${prefix}-t${String(turn)}`;
  const liveSegmentId = (): SegmentId => SegmentId.parse(`${prefix}-ls${String(segment)}`);

  return {
    setStreaming: (on) => {
      streaming = on;
    },
    liveFrame: () => {
      if (!streaming) return null;
      liveTicks = Math.min(maxTicks, liveTicks + 1);
      return {
        segmentId: liveSegmentId(),
        turnId: TurnId.parse(turnPrefix()),
        part: "message",
        text: loremChars(Math.min(opts.segmentChars, liveTicks * opts.liveStepChars), segment),
      };
    },
    next: () => {
      const step = n % 10;
      n += 1;
      const turnId = TurnId.parse(turnPrefix());
      const call = ToolCallId.parse(`${turnPrefix()}-c${String(n)}`);
      switch (step) {
        case 0:
          return { kind: "turn.started", turnId };
        case 1:
          return { kind: "tool.called", turnId, toolCallId: call, toolKind: "read", title: "Read file", input: { path: "src/a.ts" } };
        case 2:
          return { kind: "tool.completed", toolCallId: ToolCallId.parse(`${turnPrefix()}-c${String(n - 1)}`), output: { lineCount: 80 } };
        case 3:
          return { kind: "tool.called", turnId, toolCallId: call, toolKind: "execute", title: "pnpm test", input: { command: "pnpm test" } };
        case 4:
          return { kind: "tool.progress", toolCallId: ToolCallId.parse(`${turnPrefix()}-c${String(n - 1)}`), output: { output: "running\n", truncated: false, exitCode: null } };
        case 5: {
          commands += 1;
          const big = opts.largeOutputEvery > 0 && commands % opts.largeOutputEvery === 0;
          return {
            kind: "tool.completed",
            toolCallId: ToolCallId.parse(`${turnPrefix()}-c${String(n - 2)}`),
            output: { output: big ? bigOutput(commands + n) : "ok\n", truncated: false, exitCode: 0 },
          };
        }
        case 6:
          return { kind: "agent.thought", turnId, segmentId: SegmentId.parse(`${turnPrefix()}-th${String(n)}`), text: loremWords(12, n) };
        case 7:
          if (streaming) {
            if (liveTicks < maxTicks) {
              // the open segment is not full yet: keep the event rate with a thought, and let the text grow
              return { kind: "agent.thought", turnId, segmentId: SegmentId.parse(`${turnPrefix()}-th${String(n)}`), text: loremWords(8, n) };
            }
            const done: TaskEvent = { kind: "agent.message", turnId, segmentId: liveSegmentId(), text: loremChars(opts.segmentChars, segment) };
            segment += 1;
            liveTicks = 0;
            return done;
          }
          return { kind: "agent.message", turnId, segmentId: SegmentId.parse(`${turnPrefix()}-m${String(n)}`), text: loremWords(30, n) };
        case 8:
          return { kind: "plan.updated", turnId, entries: [{ content: "keep going", priority: "medium", status: "in_progress" }] };
        default: {
          const done: TaskEvent = { kind: "turn.ended", turnId, stopReason: "end_turn" };
          turn += 1;
          return done;
        }
      }
    },
  };
};
