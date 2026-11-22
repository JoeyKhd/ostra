import {
  approvalRuleIdSchema,
  clientMessageIdSchema,
  diffCommentIdSchema,
  messageFileIdSchema,
  questionIdSchema,
  roundPrompt,
  sessionIdSchema,
  subagentIdSchema,
  taskIdSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { ApprovalId, ApprovalOption, MemberId, TaskEvent, ToolCallId, TurnId } from "@ostra/protocol";
import { eventFixtures } from "@ostra/protocol/testing";

import type { LiveText } from "../live-text.ts";
import { calc192, s1, s1Working, sceneExtras, sceneMembers, sceneWorld } from "./scenes.ts";
import { sceneId, sceneLog, sceneTime, turnSteps } from "./scene-log.ts";
import type { Scene, SceneLog, TurnSteps } from "./scene-log.ts";

// Milestone 10 (F-151, spec section 9): the targets' states sheets (`states-steps.md`,
// `states-asks.md`, `states-messages.md`), each numbered cell as a small task's events. A cell
// that's a piece of a scene names it. Demo data, as the scenes'.

const { sam, alex } = sceneMembers;

/** A cell's task: its own task, session and turns, numbered in the sheet's group. */
const cellTask = (group: string) => ({
  taskId: taskIdSchema.parse(sceneId(group, 1)),
  sessionId: sessionIdSchema.parse(sceneId(group, 0x1a)),
  turn: (n: number): TurnId => turnIdSchema.parse(sceneId(group, 0x100 + n)),
});

type CellBuild = (log: SceneLog, task: ReturnType<typeof cellTask>) => { readonly now?: number; readonly liveText?: readonly LiveText[] } | undefined;

const cell = (name: string, group: string, start: string, build: CellBuild): Scene => {
  const task = cellTask(group);
  const log = sceneLog({ taskId: task.taskId, sessionId: task.sessionId, start, prefix: name });
  const shown = build(log, task);
  return { name, taskId: task.taskId, events: [...log.events()], liveText: shown?.liveText ?? [], now: shown?.now ?? log.now() };
};

const say = (log: SceneLog, memberId: MemberId, n: number, text: string, more: Partial<Extract<TaskEvent, { kind: "user.message" }>> = {}): void => {
  log.add({ kind: "user.message", memberId, clientMessageId: clientMessageIdSchema.parse(sceneId("c11e", n)), text, delivery: "immediate", ...more });
};

/** A turn that starts now, with its steps in the scene's repo. */
const startTurn = (log: SceneLog, turnId: TurnId, more: Partial<Extract<TaskEvent, { kind: "turn.started" }>> = {}): TurnSteps => {
  log.add({ kind: "turn.started", turnId, effort: "high", ...more });
  return turnSteps(log, turnId, sceneWorld.repoDir);
};

const endTurn = (log: SceneLog, turnId: TurnId): void => {
  log.wait(1_000);
  log.add({ kind: "turn.ended", turnId, stopReason: "end_turn" });
};

const live = (task: ReturnType<typeof cellTask>, turnId: TurnId, kind: LiveText["kind"], text: string): LiveText => ({
  sessionId: task.sessionId,
  turnId,
  segmentId: eventFixtures["agent.message"].segmentId,
  kind,
  text,
  awaitingSnapshot: false,
});

const approvalOptions: ApprovalOption[] = [
  { optionId: sceneExtras.deny, label: "Deny", kind: "reject-once", decision: "deny" },
  { optionId: sceneExtras.approveOnce, label: "Approve once", kind: "allow-once", decision: "allow_once" },
  { optionId: sceneExtras.approveForTask, label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
];

/** A command that asks before it runs (ADR 0049): the call, then the rule's request. */
const askToRun = (log: SceneLog, steps: TurnSteps, approvalId: ApprovalId, command: string): ToolCallId => {
  const toolCallId = steps.start("execute", command, { command, cwd: sceneWorld.repoDir });
  log.add({
    kind: "approval.requested",
    turnId: steps.turnId,
    approvalId,
    toolCallId,
    options: approvalOptions,
    rule: { source: "profile", ruleId: approvalRuleIdSchema.parse(sceneId("a11e", 1)), name: "Database changes" },
    subject: { kind: "command", value: command },
  });
  return toolCallId;
};

// ---------------------------------------------------------------------------------------------
// `states-steps.md`

/** Cell 1: the live step's words, one small turn each, and S1-working's `Running pnpm test history`. */
const liveWords = {
  thinking: cell("steps-1-thinking", "ce11", "11:00:00", (log, task) => {
    const turnId = task.turn(1);
    say(log, sam.id, 0xce11_01, "Why does the history skip the last result?");
    startTurn(log, turnId);
    return { now: log.now() + 6_000, liveText: [live(task, turnId, "thought", "The store pushes before the display settles, so the last result")] };
  }),
  running: s1Working,
  writing: cell("steps-1-writing", "ce12", "11:00:00", (log, task) => {
    const turnId = task.turn(1);
    say(log, sam.id, 0xce12_01, "Add a Clear button to the panel.");
    const steps = startTurn(log, turnId);
    for (const [path, lines] of [["src/history/panel.tsx", 141], ["src/history/store.ts", 60], ["src/App.tsx", 61], ["src/history/panel.test.tsx", 102]] as const) steps.read(path, lines);
    steps.edit("src/history/store.ts", 6, 0);
    steps.edit("src/history/panel.tsx", 22, 3);
    steps.edit("src/history/panel.test.tsx", 18, 0);
    steps.run("pnpm test history", 0, 3_700, " Tests  17 passed (17)\n");
    steps.search("clear(", "src", 2);
    steps.run("pnpm lint", 0, 5_900, "");
    steps.read("src/history/history.css", 44);
    log.at("11:05:04");
    return { now: sceneTime("11:05:10"), liveText: [live(task, turnId, "message", "The panel has a **Clear** button now, under the list. It empties the store")] };
  }),
  readingAttachment: cell("steps-1-reading", "ce13", "11:00:00", (log, task) => {
    // The member's message is the log's fourth event, so its files are in `.ostra/attachments/4/`.
    say(log, sam.id, 0xce13_01, "Start with the store.");
    const first = startTurn(log, task.turn(1));
    first.say("The store is in.");
    endTurn(log, task.turn(1));
    log.at("11:20:00");
    say(log, sam.id, 0xce13_02, "Now the panel, like this mock.", {
      files: [{ fileId: messageFileIdSchema.parse(sceneId("ce13", 0x301)), name: "history-panel-mock.png", kind: "image", contentType: "image/png", size: 186_368, origin: "member", asImage: false, text: "none" }],
      imagesNotSent: "model",
    });
    const turnId = task.turn(2);
    const steps = startTurn(log, turnId);
    steps.read("src/history/store.ts", 60);
    steps.start("read", "read", { path: "/workspace/.ostra/attachments/4/history-panel-mock.png" });
    return { now: sceneTime("11:20:12") };
  }),
} as const;

/** Cell 2: a running command, its run opened: a read, two edits, then `pnpm test history` streaming for 12 s. */
const runningCommand = cell("steps-2", "ce14", "11:00:00", (log, task) => {
  const turnId = task.turn(1);
  say(log, sam.id, 0xce14_01, "Show the empty state from the mock.");
  const steps = startTurn(log, turnId);
  steps.read("src/history/panel.tsx", 141);
  log.at("11:00:20");
  steps.edit("src/history/panel.tsx", 12, 2);
  log.at("11:00:40");
  steps.edit("src/history/history.css", 9, 0);
  log.at("11:00:50.600");
  const run = steps.start("execute", "pnpm test history", { command: "pnpm test history", cwd: sceneWorld.repoDir });
  let output = " RUN  v3.2.4 /workspace/calculator-web\n";
  for (const line of [" ✓ store keeps the last 50", " ✓ newest first", " ✓ use puts a result back in the display"]) {
    log.wait(3_500);
    output += `${line}\n`;
    log.add({ kind: "tool.progress", toolCallId: run, output: { output, truncated: false, exitCode: null } });
  }
  return { now: sceneTime("11:01:04") };
});

/** Cell 3: a failure the turn recovered from: the failing run, the fix, the passing run. */
const recovered = cell("steps-3", "ce15", "11:00:00", (log, task) => {
  const turnId = task.turn(1);
  say(log, sam.id, 0xce15_01, "Make the panel handle an empty history.");
  const steps = startTurn(log, turnId);
  steps.run("pnpm test history", 1, 4_100, " ✗ panel renders an empty history\n   TypeError: Cannot read properties of undefined (reading 'map')\n\n Tests  1 failed | 13 passed (14)\n");
  steps.edit("src/history/panel.tsx", 12, 2);
  steps.run("pnpm test history", 0, 3_800, " Tests  14 passed (14)\n");
  steps.say("The panel shows the mock's empty state now, and the test passes.");
  endTurn(log, turnId);
  return undefined;
});

/** Cell 4: a failure it didn't recover from, a failed turn, and a limit. */
const unrecovered = cell("steps-4", "ce16", "11:00:00", (log, task) => {
  say(log, sam.id, 0xce16_01, "Build it for production.");
  const first = startTurn(log, task.turn(1));
  first.run("pnpm build", 2, 38_000, "src/history/panel.tsx(23,18): error TS2345: Argument of type 'Result | undefined' is not assignable to parameter of type 'Result'.\n");
  first.say("The build fails on a type error in `panel.tsx` that the tests don't reach. I've left it as it is: the fix changes the store's API, so tell me whether to go ahead.");
  endTurn(log, task.turn(1));
  log.at("11:10:00");
  say(log, sam.id, 0xce16_02, "Go ahead.");
  log.add({ kind: "turn.started", turnId: task.turn(2), effort: "high" });
  log.wait(4_000);
  log.add({ kind: "turn.failed", turnId: task.turn(2), error: "the model's provider answered 529 Overloaded" });
  log.at("11:12:00");
  say(log, sam.id, 0xce16_03, "Try again.");
  const third = startTurn(log, task.turn(3));
  third.start("read", "read", { path: `${sceneWorld.repoDir}/src/history/store.ts` });
  log.at("12:12:00");
  log.add({ kind: "session.limit_reached", limit: "max-duration", observed: 60 });
  log.add({ kind: "turn.ended", turnId: task.turn(3), stopReason: "cancelled" });
  return undefined;
});

/** Cell 5: subagents. The main agent ran 3 (one started a fourth) and read 2 files; one still runs. */
const subagents = cell("steps-5", "ce17", "11:00:00", (log, task) => {
  const turnId = task.turn(1);
  say(log, sam.id, 0xce17_01, "Add tests for the panel, and check the store's.");
  const steps = startTurn(log, turnId);
  steps.read("src/history/panel.tsx", 141);
  steps.read("src/history/store.ts", 60);
  const spawn = (n: number, type: string, description: string, calls: number, callMs: number, outcome: "completed" | "running", parent?: { readonly id: ReturnType<typeof subagentIdSchema.parse>; readonly via: ToolCallId }): ReturnType<typeof subagentIdSchema.parse> => {
    const subagentId = subagentIdSchema.parse(`ce17-sub-${String(n)}`);
    const starter = parent?.via ?? steps.start("think", "task", { description, subagent_type: type });
    log.add({ kind: "subagent.started", toolCallId: starter, subagentId, depth: parent === undefined ? 1 : 2, type, description, prompt: description, ...(parent === undefined ? {} : { parentSubagentId: parent.id }) });
    log.add({ kind: "subagent.status", subagentId, status: "running" });
    for (let i = 0; i < calls; i += 1) {
      const toolCallId = log.nextCall();
      log.add({ kind: "tool.called", turnId, toolCallId, toolKind: "read", title: "read", input: { path: `${sceneWorld.repoDir}/src/history/file-${String(i)}.ts` }, subagentId });
      log.wait(callMs);
      log.add({ kind: "tool.completed", toolCallId, output: { lineCount: 40 } });
    }
    if (outcome === "completed") {
      log.add({ kind: "agent.message", turnId, segmentId: log.nextSegment(), text: `${description}: done.`, subagentId });
      log.add({ kind: "subagent.status", subagentId, status: "completed" });
      if (parent === undefined) log.add({ kind: "tool.completed", toolCallId: starter, output: { output: `${description}: done.` } });
    }
    return subagentId;
  };
  spawn(1, "explore", "Find the history store", 12, 3_000, "completed");
  const checker = spawn(2, "general", "Check the store's tests", 4, 1_500, "running");
  spawn(3, "explore", "Find the store's test helpers", 3, 1_000, "completed", { id: checker, via: log.nextCall() });
  spawn(4, "general", "Write the panel tests", 9, 2_000, "running");
  return { now: log.now() + 4_000 };
});

/** Cell 6: effort. Alex sets Low during turn 2, from the next turn; turn 3 ran at Max where Extra high was asked (the clamp). */
const effort = cell("steps-6", "ce18", "14:00:00", (log, task) => {
  say(log, alex.id, 0xce18_01, "Add the panel.");
  const first = startTurn(log, task.turn(1));
  first.say("The panel is in.");
  endTurn(log, task.turn(1));
  log.at("14:05:00");
  say(log, alex.id, 0xce18_02, "Now its tests.");
  const second = startTurn(log, task.turn(2));
  second.read("src/history/panel.tsx", 141);
  log.at("14:11:00");
  log.add({ kind: "effort.changed", from: "high", to: "low", memberId: alex.id });
  second.say("The tests are in.");
  endTurn(log, task.turn(2));
  log.at("14:20:00");
  say(log, alex.id, 0xce18_03, "Think hard about the rounding.");
  const third = startTurn(log, task.turn(3), { effort: "max", adjustedFrom: "xhigh" });
  third.thought("Half up to 10 digits; the spec agrees with IEEE 754's round half to even only on ties.", 21_000);
  third.usage(48_000, 9_100, 6_400);
  third.say("Rounding is half up to 10 digits.");
  endTurn(log, task.turn(3));
  return undefined;
});

// ---------------------------------------------------------------------------------------------
// `states-asks.md`

const approvalRun = (log: SceneLog, steps: TurnSteps): void => {
  for (const [path, lines] of [["src/db/schema.ts", 88], ["src/db/migrations/0007_history.sql", 14], ["package.json", 41]] as const) steps.read(path, lines);
  steps.edit("src/db/migrations/0008_history_index.sql", 6, 0);
  log.at("11:40:00");
};

/** Cell 1: an approval waits: the asking step stands where the live step was. */
const approvalPending = cell("asks-1", "ce21", "11:38:00", (log, task) => {
  say(log, sam.id, 0xce21_01, "Index the history table by time.");
  const steps = startTurn(log, task.turn(1));
  approvalRun(log, steps);
  askToRun(log, steps, sceneExtras.migrateApproval, "pnpm db:migrate");
  return { now: sceneTime("11:41:00") };
});

/** Cell 2: answered: approved once by Sam, then another command denied by Alex with a reason. */
const approvalAnswered = cell("asks-2", "ce22", "11:38:00", (log, task) => {
  say(log, sam.id, 0xce22_01, "Index the history table by time.");
  const steps = startTurn(log, task.turn(1));
  approvalRun(log, steps);
  const migrate = askToRun(log, steps, sceneExtras.migrateApproval, "pnpm db:migrate");
  log.at("11:41:10");
  log.add({ kind: "approval.answered", approvalId: sceneExtras.migrateApproval, optionId: sceneExtras.approveOnce, decision: "allow_once", memberId: sam.id });
  log.wait(2_300);
  log.add({ kind: "tool.completed", toolCallId: migrate, output: { output: "Applied 0008_history_index.\n", truncated: false, exitCode: 0 } });
  steps.run("pnpm test db", 0, 4_400, " Tests  6 passed (6)\n");
  steps.say("The index is in, and the migration ran on the dev database.");
  const reset = askToRun(log, steps, sceneExtras.resetApproval, "pnpm db:reset");
  log.at("11:43:00");
  log.add({ kind: "approval.answered", approvalId: sceneExtras.resetApproval, optionId: sceneExtras.deny, decision: "deny", memberId: alex.id, reason: "Not on the shared dev database." });
  log.add({ kind: "tool.failed", toolCallId: reset, error: "denied" });
  log.add({ kind: "turn.ended", turnId: task.turn(1), stopReason: "end_turn" });
  return undefined;
});

/** Cells 3 and 4: S1's question, open; a watcher sees it quiet, and the driver may pick `Something else…`. */
const questionOpen = s1;

/** Cell 4, sent: Sam answered in his own words (`Something else…`, minor 9's `other`). */
const somethingElseAnswered = cell("asks-4-answered", "ce24", "14:07:00", (log, task) => {
  const turnId = task.turn(1);
  say(log, sam.id, 0xce24_01, "Add a history panel next to the keypad.");
  const steps = startTurn(log, turnId);
  steps.say("One thing the mock doesn't settle:");
  const questionId = questionIdSchema.parse(sceneId("ce24", 0x201));
  log.add({ kind: "question.asked", turnId, questionId, message: calc192.question.message, fields: [{ id: calc192.question.fieldId, label: "Use", type: "select", options: [...calc192.question.choices] }] });
  log.at("14:09:10");
  log.add({ kind: "question.answered", questionId, answers: { [calc192.question.fieldId]: "Replace it, but keep the expression in the line above" }, memberId: sam.id, other: [calc192.question.fieldId] });
  steps.edit("src/history/panel.tsx", 11, 3);
  return undefined;
});

/** Cell 5: any other need: OpenCode ended its turn with a question in its prose. */
const otherNeed = cell("asks-5", "ce25", "11:00:00", (log, task) => {
  const turnId = task.turn(1);
  say(log, sam.id, 0xce25_01, "Tidy up the history module.");
  const steps = startTurn(log, turnId);
  steps.read("src/history/store.ts", 60);
  steps.read("src/history/panel.tsx", 141);
  steps.say("The module is small already: a store and a panel. I can split the panel's list into its own component, or leave it. Which would you like?");
  endTurn(log, turnId);
  log.wait(1_500);
  log.add({ kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: sceneWorld.repoId, headSha: null, ahead: false, hiddenRefSha: null }], archive: null });
  return undefined;
});

/** Cell 6: a round limit, then Alex's `Keep working` as its receipt. */
const roundLimit = cell("asks-6", "ce26", "10:50:00", (log, task) => {
  say(log, alex.id, 0xce26_01, "Fix the flaky e2e test.");
  const steps = startTurn(log, task.turn(1));
  steps.edit("e2e/history.spec.ts", 4, 2);
  endTurn(log, task.turn(1));
  log.at("11:02:00");
  log.add({ kind: "round.capped", round: "ci", reason: "rounds" });
  log.at("11:07:00");
  say(log, alex.id, 0xce26_02, "Keep working on the failing checks.", { intent: "keep-working" });
  return undefined;
});

// ---------------------------------------------------------------------------------------------
// `states-messages.md`

/** Cell 1: a CI round: ostra's outlined message, the agent's turn, and its push once CI passed. */
const ciRound = cell("messages-1", "ce31", "10:31:00", (log, task) => {
  log.add({ kind: "round.started", round: "ci", number: 1, automatic: true });
  say(log, sam.id, 0xce31_01, roundPrompt("fix-ci", { quotes: [{ label: "ci-check", text: "unit-tests: failed" }] }), { intent: "fix-ci" });
  const turnId = task.turn(1);
  const steps = startTurn(log, turnId);
  steps.read("ci/test.log", 120);
  steps.read("src/history/store.ts", 60);
  steps.edit("src/history/store.ts", 1, 1);
  steps.run("pnpm test history", 0, 3_600, " Tests  16 passed (16)\n");
  steps.run("pnpm test", 0, 11_200, "      Tests  31 passed (31)\n");
  steps.say("The store kept 51 results; it keeps 50 now, as the test expects.");
  endTurn(log, turnId);
  log.wait(2_000);
  log.add({ kind: "git.pushed", repoId: sceneWorld.repoId, branch: sceneWorld.branch, headSha: "9a03d1e".padEnd(40, "0"), ref: `refs/heads/${sceneWorld.branch}` });
  log.wait(1_000);
  log.add({ kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: sceneWorld.repoId, headSha: "9a03d1e".padEnd(40, "0"), ahead: true, hiddenRefSha: null }], archive: null });
  log.at("10:39:00");
  log.add({ kind: "ci.updated", repoId: sceneWorld.repoId, prNumber: calc192.pr.number, headSha: "9a03d1e".padEnd(40, "0"), state: "passed", failing: [] });
  return undefined;
});

/** Cell 2: a findings round the budget held for 9 minutes. */
const heldRound = cell("messages-2", "ce32", "10:40:00", (log, task) => {
  log.add({ kind: "round.started", round: "findings", number: 1, automatic: true });
  say(log, sam.id, 0xce32_01, roundPrompt("fix-findings", { quotes: [{ label: "finding", text: "The store keeps 51 results." }] }), { intent: "fix-findings", delivery: "queued" });
  log.add({ kind: "turn.held", origin: "automatic-round", budgetId: eventFixtures["turn.held"].budgetId, scope: "project" });
  log.at("10:49:00");
  log.add({ kind: "turn.released", budgetId: eventFixtures["turn.held"].budgetId });
  startTurn(log, task.turn(1));
  return undefined;
});

/** Cell 3: a PR comment that asks ostra, from GitHub. */
const prComment = cell("messages-3", "ce33", "15:02:00", (log) => {
  log.add({ kind: "pr.comment_received", url: `${calc192.pr.url}#discussion_r42`, login: "sam-rivera", path: "src/history/panel.tsx", line: 42 });
  say(log, sam.id, 0xce33_01, "@ostra the panel should keep the selection when a result is added.", { intent: "pr-comment", delivery: "queued" });
  return undefined;
});

/** Cell 4: two comments on the diff, sent by Sam. */
const diffComments = cell("messages-4", "ce34", "15:06:00", (log) => {
  say(log, sam.id, 0xce34_01, "Please look at the comments below.", { intent: "diff-comments", delivery: "queued" });
  log.add({ kind: "diff.comments_sent", commentIds: [diffCommentIdSchema.parse(sceneId("ce34", 0x701)), diffCommentIdSchema.parse(sceneId("ce34", 0x702))], count: 2 });
  return undefined;
});

/** Cell 5: between turns: a new day, a restore, a reopen, a new driver, and a queued message. */
const betweenTurns = cell("messages-5", "ce35", "16:40:00", (log, task) => {
  say(log, alex.id, 0xce35_01, "Add a Clear button.");
  const first = startTurn(log, task.turn(1));
  first.say("The button is in.");
  endTurn(log, task.turn(1));
  log.wait(900_000);
  log.add({ kind: "session.ended", outcome: "with-changes", repos: [{ repoId: sceneWorld.repoId, ahead: true }] });
  // The next day: Alex reopens it on his own machine's runner.
  log.session(sessionIdSchema.parse(sceneId("ce35", 0x1b)));
  log.wait(16 * 3_600_000);
  say(log, alex.id, 0xce35_02, "Also confirm before clearing.", { reopen: true });
  log.add({ kind: "session.restored", origin: "restored", replayedUpdates: 0, hiddenRef: "applied", previousBox: "released" });
  const second = startTurn(log, task.turn(2));
  second.edit("src/history/panel.tsx", 14, 1);
  log.add({ kind: "driver.changed", memberId: sam.id, byMemberId: alex.id });
  say(log, sam.id, 0xce35_03, "And make the confirm a small popover, not a dialog.", { delivery: "queued" });
  return undefined;
});

/** Cell 6: results a turn leaves: a preview, a memory proposal, and a budget hold as a notice. */
const results = cell("messages-6", "ce36", "15:10:00", (log, task) => {
  say(log, sam.id, 0xce36_01, "Show me the panel, and remember how the tests run.");
  const turnId = task.turn(1);
  const steps = startTurn(log, turnId);
  steps.tool("ostra_show_preview", { process: "web", path: "/history" }, { output: "The preview of web :5173 /history is open in the task's preview pane." });
  steps.tool("ostra_memory_propose", { title: "Run the tests with pnpm test, not npm" }, { output: "Proposed." });
  log.add({ kind: "memory.proposed", proposalId: sceneExtras.memoryProposal, title: "Run the tests with pnpm test, not npm" });
  steps.say("The preview shows the panel at `/history`, and I proposed a note on how the tests run.");
  endTurn(log, turnId);
  log.at("15:20:00");
  say(log, sam.id, 0xce36_02, "Now the phone layout.", { delivery: "queued" });
  log.add({ kind: "turn.held", origin: "message", budgetId: eventFixtures["turn.held"].budgetId, scope: "project" });
  return undefined;
});

/** Cell 6, a refine task's result: its draft, with its counts (minor 9). */
const draftResult = cell("messages-6-draft", "ce37", "15:30:00", (log, task) => {
  say(log, sam.id, 0xce37_01, "Refine CALC-201.");
  const turnId = task.turn(1);
  const steps = startTurn(log, turnId);
  steps.read("src/history/panel.tsx", 141);
  const handIn = steps.start("other", "ostra_submit_draft", { description: "…", acceptanceCriteria: ["…"], subTickets: [] });
  log.add({ kind: "draft.submitted", draftId: sceneExtras.draftId, version: 2, acceptanceCriteria: 4, subTickets: 2 });
  log.add({ kind: "tool.completed", toolCallId: handIn, output: { output: "The draft is saved." } });
  steps.say("Draft v2 splits the export out into its own ticket.");
  endTurn(log, turnId);
  return undefined;
});

/** The states sheets' cells, by sheet and number: each a small task, or a piece of a scene. */
export const stateCells = {
  steps: { 1: liveWords, 2: runningCommand, 3: recovered, 4: unrecovered, 5: subagents, 6: effort },
  asks: { 1: approvalPending, 2: approvalAnswered, 3: questionOpen, 4: { open: questionOpen, answered: somethingElseAnswered }, 5: otherNeed, 6: roundLimit },
  messages: { 1: ciRound, 2: heldRound, 3: prComment, 4: diffComments, 5: betweenTurns, 6: { code: results, refine: draftResult } },
} as const;
