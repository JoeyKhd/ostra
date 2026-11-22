import { describe, expect, it } from "vitest";

import { clientMessageIdSchema, sessionIdSchema, storedEventSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { StoredEvent, TurnId } from "@ostra/protocol";

import { foldTaskEvents } from "../fold.ts";
import { calc192, review483, s1, s1Working, s2, s3, s5Approved, sceneId, sceneLog, sceneMembers, sceneWorld, stateCells, turnSteps } from "../testing/index.ts";
import type { Scene } from "../testing/index.ts";
import type { TaskUIMessage } from "../ui-types.ts";
import { turnItemsOf } from "./items.ts";
import type { RunItem, TurnItem } from "./items.ts";
import type { CaptureStep, CommandStep, OstraStep, RunStep, ThreadContext, ToolStep } from "./steps.ts";

// Milestone 10, ticket 03 (F-151): a turn's items over the targets' recorded scenes: its runs, its
// prose, its captures and failures, what waits on a member and what it made.

/** A test's way to say a value it needs isn't there. */
const fail = (): never => {
  throw new Error("missing");
};

const contextOf = (scene: Scene, more: Partial<ThreadContext> = {}): ThreadContext => ({ taskId: scene.taskId, checkoutDirs: ["calculator-web"], mcpServers: ["github"], ...more });
const fold = (scene: Scene): TaskUIMessage[] => foldTaskEvents(scene.events, scene.liveText, { taskKind: scene.kind });
const turnOf = (scene: Scene, turnId: string): TaskUIMessage => {
  const turn = fold(scene).find((message) => message.metadata?.turnId === turnId);
  if (turn === undefined) throw new Error(`no turn ${turnId} in ${scene.name}`);
  return turn;
};
const itemsOf = (scene: Scene, turnId: string, more: Partial<ThreadContext> = {}): TurnItem[] => turnItemsOf(turnOf(scene, turnId), contextOf(scene, more));
const runsOf = (items: readonly TurnItem[]): RunItem[] => items.flatMap((item) => (item.kind === "run" ? [item] : []));
const runAt = (items: readonly TurnItem[], n: number): RunItem => {
  const run = runsOf(items)[n];
  if (run === undefined) throw new Error(`no run #${String(n)}`);
  return run;
};
const commandsOf = (steps: readonly RunStep[]): CommandStep[] => steps.flatMap((step) => (step.kind === "command" ? [step] : []));
/** The item kinds in order, a run by its counts and a result by its kind, to read a turn at a glance. */
const shapeOf = (items: readonly TurnItem[]): string[] =>
  items.map((item) => {
    switch (item.kind) {
      case "run":
        return `run ${item.counts.map((count) => `${count.kind} ${String(count.n)}`).join(", ")}`;
      case "result":
        return `result ${item.result.kind}`;
      case "needs":
        return `needs ${item.need.kind}`;
      case "failure":
        return `failure ${item.failure.cause}`;
      case "notice":
        return `notice ${item.notice.cause}`;
      case "prose":
      case "captures":
        return item.kind;
      default:
        return item satisfies never;
    }
  });

/** Every string value anywhere in a value, to show a word appears nowhere. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
};

/** A small code task of its own, one turn, its steps written by `build`. */
const oneTurn = (name: string, group: string, build: (steps: ReturnType<typeof turnSteps>, log: ReturnType<typeof sceneLog>, turnId: TurnId) => void): Scene => {
  const taskId = taskIdSchema.parse(sceneId(group, 1));
  const log = sceneLog({ taskId, sessionId: sessionIdSchema.parse(sceneId(group, 0x1a)), start: "10:00:00", prefix: name });
  const turnId = turnIdSchema.parse(sceneId(group, 0x101));
  log.add({ kind: "user.message", memberId: sceneMembers.sam.id, clientMessageId: clientMessageIdSchema.parse(sceneId(group, 0xc1)), text: "Fix the tests.", delivery: "immediate" });
  log.add({ kind: "turn.started", turnId, effort: "high" });
  build(turnSteps(log, turnId, sceneWorld.repoDir), log, turnId);
  return { name, taskId, kind: "code", events: [...log.events()], liveText: [], now: log.now() };
};
const ended = (log: ReturnType<typeof sceneLog>, turnId: TurnId): void => {
  log.wait(1_000);
  log.add({ kind: "turn.ended", turnId, stopReason: "end_turn" });
};

describe("a run's line: its counts, its tail and the recovered rule", () => {
  it("F-151/c2: S1's second run counts edited 2, ran 2, took a screenshot in that order, with one failure recovered", () => {
    const items = itemsOf(s1, calc192.turns.t1);
    expect(shapeOf(items)).toEqual(["run read 4", "prose", "run edit 2, command 2, screenshot 1", "captures", "prose", "needs question"]);
    const second = runAt(items, 1);
    expect(second.counts).toEqual([
      { kind: "edit", n: 2 },
      { kind: "command", n: 2 },
      { kind: "screenshot", n: 1 },
    ]);
    // `pnpm test history` failed, then the same line passed later in the turn: recovered, so no red line.
    expect(second.failures).toEqual({ recovered: 1, unrecovered: [] });
    expect(items.some((item) => item.kind === "failure")).toBe(false);
    expect(commandsOf(second.steps).map((step) => [step.line, step.state])).toEqual([
      ["pnpm test history", "failed"],
      ["pnpm test history", "done"],
    ]);
    // The first run starts with a thought, which its line names by its time; a later thought isn't counted.
    expect(runAt(items, 0).thought).toEqual({ ms: 6_000 });
    expect(second.thought).toBeNull();
    expect([runAt(items, 0).firstInTurn, second.firstInTurn]).toEqual([true, false]);
    expect(second.total).toBe(6);
  });

  it("F-151/c2: a failing pnpm test a, then a passing pnpm test b, is unrecovered and its own failure item after its run", () => {
    const scene = oneTurn("ab", "ab01", (steps, log, turnId) => {
      steps.run("pnpm test a", 1, 2_000, " Tests  1 failed (1)\n");
      steps.run("pnpm test b", 0, 1_500, " Tests  3 passed (3)\n");
      steps.say("Test b passes; test a still fails on the rounding.");
      ended(log, turnId);
    });
    const items = turnItemsOf(fold(scene).find((message) => message.role === "assistant") ?? fail(), contextOf(scene));
    expect(shapeOf(items)).toEqual(["run command 2", "failure step", "prose"]);
    const run = runAt(items, 0);
    expect(run.failures.recovered).toBe(0);
    expect(run.failures.unrecovered.map((step) => step.fullSubject)).toEqual(["pnpm test a"]);
    const failure = items[1];
    expect(failure?.kind === "failure" && failure.failure.cause === "step" ? failure.failure.step : null).toMatchObject({ kind: "command", line: "pnpm test a", exit: 1, state: "failed" });
    // The same line passing later recovers it (the control: S1's `pnpm test history`).
    const again = oneTurn("aa", "aa01", (steps, log, turnId) => {
      steps.run("pnpm test a", 1, 2_000, " Tests  1 failed (1)\n");
      steps.run("pnpm test a", 0, 1_500, " Tests  1 passed (1)\n");
      steps.say("Test a passes now.");
      ended(log, turnId);
    });
    const recovered = turnItemsOf(fold(again).find((message) => message.role === "assistant") ?? fail(), contextOf(again));
    expect(shapeOf(recovered)).toEqual(["run command 2", "prose"]);
    expect(runAt(recovered, 0).failures).toEqual({ recovered: 1, unrecovered: [] });
  });

  it("F-151/c2: a cancelled command is no failure", () => {
    const scene = oneTurn("cancel", "ca01", (steps, log, turnId) => {
      steps.read("src/history/store.ts", 60);
      steps.start("execute", "pnpm test", { command: "pnpm test", cwd: sceneWorld.repoDir });
      log.wait(4_000);
      log.add({ kind: "turn.ended", turnId, stopReason: "cancelled" });
    });
    const items = turnItemsOf(fold(scene).find((message) => message.role === "assistant") ?? fail(), contextOf(scene));
    expect(shapeOf(items)).toEqual(["run read 1, command 1"]);
    const run = runAt(items, 0);
    expect(commandsOf(run.steps).map((step) => [step.state, step.exit])).toEqual([["cancelled", null]]);
    expect(run.failures).toEqual({ recovered: 0, unrecovered: [] });
    // A denied command never ran either: no failure (states-asks, cell 2).
    const denied = runAt(itemsOf(stateCells.asks[2], sceneId("ce22", 0x101)), 1);
    expect(commandsOf(denied.steps).map((step) => [step.line, step.state])).toEqual([["pnpm db:reset", "cancelled"]]);
    expect(denied.failures).toEqual({ recovered: 0, unrecovered: [] });
  });

  it("F-151/c2: an approved and a denied step count in the tail, by whom, and whether the deny gave a reason", () => {
    const items = itemsOf(stateCells.asks[2], sceneId("ce22", 0x101));
    expect(shapeOf(items)).toEqual(["run read 3, edit 1, command 2", "prose", "run command 1"]);
    expect(runAt(items, 0).approvals).toEqual({ approved: [{ by: sceneMembers.sam.id }], denied: [] });
    expect(runAt(items, 1).approvals).toEqual({ approved: [], denied: [{ by: sceneMembers.alex.id, withReason: true }] });
    // Each row carries its receipt; the reason's words stay in the log.
    const [migrate] = commandsOf(runAt(items, 0).steps);
    expect(migrate?.approval).toMatchObject({ state: "answered", decision: "allow_once", by: sceneMembers.sam.id });
    expect(stringsIn(items)).not.toContain("Not on the shared dev database.");
    // An approval answered without a reason says so.
    const noReason = stateCells.asks[2].events.map((stored): StoredEvent => (stored.event.kind === "approval.answered" && stored.event.decision === "deny" ? storedEventSchema.parse({ ...stored, event: { ...stored.event, reason: undefined } }) : stored));
    const plain = turnItemsOf(foldTaskEvents(noReason, []).find((message) => message.role === "assistant") ?? fail(), contextOf(stateCells.asks[2]));
    expect(runAt(plain, 1).approvals.denied).toEqual([{ by: sceneMembers.alex.id, withReason: false }]);
  });
});

describe("a run opened: its rows, relative paths and durations", () => {
  it("F-151/c3: S3's turn 2 is one run of 23 steps, every read on one step with its distinct paths", () => {
    const items = itemsOf(s3, review483.turns.t2);
    expect(shapeOf(items)).toEqual(["run read 9, web-search 3, fetch 1, command 8, tool 2", "failure step", "prose", "result review"]);
    const run = runAt(items, 0);
    expect(run.total).toBe(23);
    const reads = run.steps.filter((step) => step.kind === "read");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      kind: "read",
      paths: ["README.md", "docs/rounding.md", "src/format/result.ts", "src/format/result.test.ts", "src/history/store.ts", "src/history/panel.tsx", "src/keys/keyboard.ts", "src/history/panel.test.tsx", "src/App.tsx"],
      state: "done",
    });
    expect(reads[0]?.kind === "read" ? reads[0].toolCallIds : []).toHaveLength(9);
    // The row's `title` keeps every full path.
    expect(reads[0]?.fullSubject.split(", ")[0]).toBe("/workspace/calculator-web/README.md");
    // 9 reads share a row: 23 steps on 15 rows, in the turn's order.
    expect(run.steps.map((step) => step.kind)).toEqual(["read", "web-search", "web-search", "fetch", "web-search", ...Array<string>(8).fill("command"), "tool", "ostra"]);
    expect(run.firstInTurn).toBe(true);
    // The fetch that answered 403 and wasn't retried is its own line, with its status.
    const failure = items[1];
    expect(failure?.kind === "failure" && failure.failure.cause === "step" ? failure.failure.step : null).toMatchObject({
      kind: "fetch",
      host: "finance.acme.dev",
      path: "/rounding",
      status: { code: 403, text: "Forbidden" },
      fullSubject: review483.failedFetch,
      error: "Request failed with status code: 403 Forbidden",
    });
  });

  it("F-151/c3: each command step has its exit and its duration", () => {
    const run = runAt(itemsOf(s3, review483.turns.t2), 0);
    expect(commandsOf(run.steps).map((step) => [step.line, step.exit, step.ms])).toEqual([
      ["pnpm test format", 0, 2_900],
      ["node -e \"console.log((0.1 + 0.2).toPrecision(10))\"", 0, 200],
      ["pnpm test history", 0, 3_600],
      ["rg -n \"keydown\" src/history", 0, 150],
      ["rg -n \"50\" src/history/store.ts", 0, 140],
      ["git show --stat HEAD", 0, 220],
      ["pnpm test", 0, 11_100],
      ["pnpm lint", 0, 5_800],
    ]);
    // S4's rows: each edit's size, the failing and the passing run, the thought's first sentence, the capture.
    const opened = runAt(itemsOf(s1, calc192.turns.t1), 1).steps;
    expect(opened.map((step) => {
      if (step.kind === "edit") return `${step.path} +${String(step.added)} -${String(step.removed)}`;
      if (step.kind === "command") return `${step.line} exit ${String(step.exit)} ${String(step.ms)}`;
      if (step.kind === "thought") return step.excerpt;
      if (step.kind === "capture") return `${step.media} ${step.route}`;
      return step.kind;
    })).toEqual([
      "src/history/store.ts +48 -0",
      "src/history/panel.tsx +118 -6",
      "pnpm test history exit 1 4100",
      "The empty history renders nothing; Dana's mock has an empty state for it.",
      "src/history/panel.tsx +12 -2",
      "pnpm test history exit 0 3800",
      "screenshot /history",
    ]);
    // An approved command ran from its answer: its duration leaves out the wait (states-asks, cell 2).
    const [migrate] = commandsOf(runAt(itemsOf(stateCells.asks[2], sceneId("ce22", 0x101)), 0).steps);
    expect([migrate?.line, migrate?.exit, migrate?.ms]).toEqual(["pnpm db:migrate", 0, 2_300]);
    // A command killed by a signal ended with no exit code.
    const killed = oneTurn("killed", "k101", (steps, log, turnId) => {
      steps.run("pnpm dev", null, 30_000, "^C\n");
      ended(log, turnId);
    });
    const [dev] = commandsOf(runAt(turnItemsOf(fold(killed).find((message) => message.role === "assistant") ?? fail(), contextOf(killed)), 0).steps);
    expect([dev?.exit, dev?.state, dev?.ms]).toEqual(["killed", "failed", 30_000]);
  });
});

describe("tool names, ostra's own tools and captures", () => {
  it("F-151/c8: a generic tool's step has its name and its MCP server, and other appears nowhere", () => {
    const items = itemsOf(s3, review483.turns.t2);
    const tools = runAt(items, 0).steps.filter((step): step is ToolStep => step.kind === "tool");
    expect(tools.map((step) => [step.name, step.server, step.fullSubject])).toEqual([["get_pull_request", "github", "github_get_pull_request"]]);
    // The fold's kind word for a generic tool (`toolName: "other"`) is in no item, though the parts hold it.
    expect(turnOf(s3, review483.turns.t2).parts.some((part) => part.type === "dynamic-tool" && part.toolName === "other")).toBe(true);
    expect(stringsIn(items)).not.toContain("other");
    for (const scene of [s1, s2, s3, s5Approved]) for (const message of fold(scene)) expect(stringsIn(turnItemsOf(message, contextOf(scene)))).not.toContain("other");
    // With no MCP server named, the whole title is the name.
    const bare = runAt(itemsOf(s3, review483.turns.t2, { mcpServers: [] }), 0).steps.filter((step): step is ToolStep => step.kind === "tool");
    expect(bare.map((step) => [step.name, step.server])).toEqual([["github_get_pull_request", null]]);
  });

  it("F-151/c8: ostra_submit_review is an ostra step, and the repeat hand-in came out as already in", () => {
    const ostraOf = (turnId: string): OstraStep[] => runAt(itemsOf(s3, turnId), 0).steps.filter((step): step is OstraStep => step.kind === "ostra");
    expect(ostraOf(review483.turns.t1).map((step) => [step.tool, step.state, step.outcome])).toEqual([["submit_review", "done", "done"]]);
    expect(ostraOf(review483.turns.t2).map((step) => [step.tool, step.state, step.outcome])).toEqual([["submit_review", "done", "already-in"]]);
    // Its result line after the prose says the same: a repeat, the round's figures as first handed in.
    const result = itemsOf(s3, review483.turns.t2).at(-1);
    expect(result?.kind === "result" && result.result.kind === "review" ? result.result.review : null).toMatchObject({ repeat: true, blocking: 0, nits: 1 });
    // ostra's own tools count as tools on the line (`used 2 tools`: the MCP tool and the hand-in).
    expect(runAt(itemsOf(s3, review483.turns.t2), 0).counts.find((count) => count.kind === "tool")).toEqual({ kind: "tool", n: 2 });
  });

  it("F-151/c8: a capture's route is its attachment's own, and its strip goes under the run that took it", () => {
    const items = itemsOf(s1, calc192.turns.t1);
    const capture = runAt(items, 1).steps.find((step): step is CaptureStep => step.kind === "capture");
    expect(capture).toMatchObject({ route: "/history", count: 1, width: 1280, media: "screenshot", preview: { label: "web", port: null } });
    expect(items[3]).toMatchObject({ kind: "captures", attachments: { items: [{ attachmentId: calc192.attachments.desktop, path: "/history" }] } });
    // Another route is read as it is, never `/` by default.
    const moved = s1.events.map((stored): StoredEvent => (stored.event.kind === "attachment.added" ? storedEventSchema.parse({ ...stored, event: { ...stored.event, path: "/settings/history?tab=all" } }) : stored));
    const turn = foldTaskEvents(moved, []).find((message) => message.metadata?.turnId === calc192.turns.t1) ?? fail();
    const route = runAt(turnItemsOf(turn, contextOf(s1)), 1).steps.find((step): step is CaptureStep => step.kind === "capture")?.route;
    expect(route).toBe("/settings/history?tab=all");
  });
});

describe("the column holds what a member reads", () => {
  it("F-151/c1: a turn's items hold its prose as prose items in order, and no item for a bookkeeping event", () => {
    const messages = fold(s2);
    for (const message of messages.filter((one) => one.role === "assistant")) {
      const said = s2.events.flatMap(({ event }) => (event.kind === "agent.message" && event.turnId === message.metadata?.turnId && event.subagentId === undefined ? [event.text] : []));
      const prose = turnItemsOf(message, contextOf(s2)).flatMap((item) => (item.kind === "prose" && item.part.type === "text" ? [item.part.text] : []));
      expect(prose).toEqual(said);
      expect(said.length).toBeGreaterThan(0);
    }
    // S2 holds every kind of bookkeeping (each session's runner, each turn's hidden ref and save, the
    // session's end, CI's update, the checks): none is an item. Turn 4 reads its run, its prose, its push and the PR.
    expect(messages.map((message) => shapeOf(turnItemsOf(message, contextOf(s2))))).toEqual([
      [],
      ["run read 4", "prose", "run edit 2, command 2, screenshot 1", "captures", "prose", "needs question", "run edit 1, command 1", "prose"],
      [],
      ["run read 2, edit 2, command 2, screenshot 1", "captures", "prose"],
      [],
      ["run edit 1, command 1", "prose"],
      [],
      ["run command 2", "prose", "result push", "result pr"],
    ]);
    for (const kind of ["runner.connected", "session.saved", "session.ended", "git.pushed", "check.finished", "ci.updated", "pr.text_set"] as const) expect(s2.events.some(({ event }) => event.kind === kind)).toBe(true);
    // The question answered keeps its place as its receipt.
    const question = turnItemsOf(messages[1] ?? fail(), contextOf(s2)).find((item) => item.kind === "needs");
    expect(question).toMatchObject({ open: false, need: { kind: "question", question: { status: { state: "answered", answers: { use: "Replace the display" } } } } });
    // The push carries its checks, and the PR's card follows the push that opened it.
    const turn4 = turnItemsOf(messages[7] ?? fail(), contextOf(s2));
    expect(turn4[2]).toMatchObject({ kind: "result", result: { kind: "push", push: { branch: sceneWorld.branch, checks: { passed: 3, failed: 0, total: 3 }, firstPr: { number: 483 } } } });
    expect(turn4[3]).toMatchObject({ kind: "result", result: { kind: "pr", pr: { number: 483, title: calc192.pr.title } } });
    // S5's two config changes and its plan's progress are no item either.
    expect(fold(s5Approved).flatMap((message) => shapeOf(turnItemsOf(message, contextOf(s5Approved))))).toEqual(["run read 5, search 2", "prose", "run read 2", "prose", "run search 1, edit 1"]);
  });

  it("F-151/c1: a member's message has no item; a crashed session and a lost box are failures, a limit and a hold notices", () => {
    expect(fold(s1).filter((message) => message.role === "user").flatMap((message) => turnItemsOf(message, contextOf(s1)))).toEqual([]);
    const cell = stateCells.steps[4];
    const shapes = fold(cell).map((message) => shapeOf(turnItemsOf(message, contextOf(cell))));
    expect(shapes).toEqual([[], ["run command 1", "failure step", "prose"], [], ["failure turn"], [], ["run read 1"], ["notice limit"]]);
    const failed = fold(cell).flatMap((message) => turnItemsOf(message, contextOf(cell))).find((item) => item.kind === "failure" && item.failure.cause === "turn");
    expect(failed).toMatchObject({ failure: { cause: "turn", error: "the model's provider answered 529 Overloaded" } });
    // A budget hold of a member's message (states-messages, cell 6) is a notice.
    const held = stateCells.messages[6].code;
    expect(fold(held).flatMap((message) => shapeOf(turnItemsOf(message, contextOf(held))))).toEqual(["run tool 2", "prose", "result preview", "result memory", "notice held"]);
    // A box lost and a session crashed, each a row of its own.
    const lost = stateCells.steps[3].events.at(-1) ?? fail();
    const rows = foldTaskEvents(
      [
        ...stateCells.steps[3].events,
        storedEventSchema.parse({ ...lost, seq: lost.seq + 1, sessionSeq: null, event: { kind: "runner.lost", runnerId: sceneWorld.runners.buildFleet03 } }),
        storedEventSchema.parse({ ...lost, seq: lost.seq + 2, sessionSeq: null, event: { kind: "session.crashed", error: "the box exited" } }),
      ],
      [],
    ).filter((message) => message.role === "system");
    expect(rows.map((message) => shapeOf(turnItemsOf(message, contextOf(stateCells.steps[3]))))).toEqual([["failure lost"], ["failure crashed"]]);
  });

  it("F-151/c1: each prose item has its own id, an image or a link between texts too, and keeps it as the turn goes on", () => {
    let linkAt = 0;
    const scene = oneTurn("prose", "f11e", (steps, log, turnId) => {
      log.add({ kind: "agent.content", turnId, block: { type: "image", mediaType: "image/png", url: "data:image/png;base64,aGk=" } });
      steps.say("The panel as it is.");
      steps.say("And the store under it.");
      steps.read("src/history/store.ts", 40);
      steps.say("It keeps 50 results.");
      linkAt = log.events().length;
      log.add({ kind: "agent.content", turnId, block: { type: "resource_link", uri: "https://example.com/history", title: "History" } });
      steps.say("The limit comes from here.");
      steps.thought("Check the keypad next.", 900);
      steps.say("Done.");
      ended(log, turnId);
    });
    const turnId = sceneId("f11e", 0x101);
    const proseOf = (items: readonly TurnItem[]): (readonly [string, string])[] => items.flatMap((item) => (item.kind === "prose" ? [[item.id, item.part.type] as const] : []));
    const items = itemsOf(scene, turnId);
    const prose = proseOf(items);
    expect(prose.map(([, type]) => type)).toEqual(["file", "text", "text", "text", "source-url", "text", "text"]);
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The turn before its link: each piece of its prose has the id it has once the turn ends.
    const before = proseOf(itemsOf({ ...scene, events: scene.events.slice(0, linkAt) }, turnId));
    expect(before).toHaveLength(4);
    expect(prose.slice(0, before.length)).toEqual(before);
  });
});

describe("the run the turn is in", () => {
  it("F-151/c4: prose closes a run; the run a turn is in is open, with no failure line while a later step may recover it", () => {
    const working = itemsOf(s1Working, calc192.turns.t1);
    expect(shapeOf(working)).toEqual(["run read 4", "prose", "run edit 2, command 2"]);
    expect(runsOf(working).map((run) => run.open)).toEqual([false, true]);
    expect(runAt(working, 1).failures.unrecovered.map((step) => step.fullSubject)).toEqual(["pnpm test history"]);
    // Closed by its prose, the same run is a line; recovered, it says so.
    const closed = itemsOf(s1, calc192.turns.t1);
    expect(runsOf(closed).map((run) => run.open)).toEqual([false, false]);
    // A pending approval's step leaves its run, which closes, and stands with its block after it.
    const asking = itemsOf(stateCells.asks[1], sceneId("ce21", 0x101));
    expect(shapeOf(asking)).toEqual(["run read 3, edit 1", "needs approval"]);
    expect(runAt(asking, 0).open).toBe(false);
    expect(asking[1]).toMatchObject({ open: true, need: { kind: "approval", step: { kind: "command", line: "pnpm db:migrate", approval: { state: "pending" } } } });
  });
});
