import { describe, expect, it } from "vitest";

import { segmentIdSchema, storedEventSchema, turnIdSchema } from "@ostra/protocol";
import type { StoredEvent, TaskEvent, ToolCallId, TurnId } from "@ostra/protocol";
import { eventFixtures } from "@ostra/protocol/testing";

import { foldTaskEvents, turnOrdinalsOf, turnSpendOf } from "./fold.ts";
import { calc192, calc192Spend, review483, review483Spend, s1, s1Working, s2, s3, s5Approved, sceneId, sceneWorld, stateCells } from "./testing/index.ts";
import type { Scene } from "./testing/index.ts";
import { thoughtTimeKey } from "./ui-types.ts";
import type { TaskUIMessage, TaskUIPart, TurnSpend } from "./ui-types.ts";

// Milestone 10, ticket 02 (F-151): a turn's fields, its steps' times, bookkeeping out of the parts,
// and each result in the turn that made it, over the targets' recorded scenes.

type FoldOptions = Parameters<typeof foldTaskEvents>[2];
const fold = (scene: Scene, options: FoldOptions = {}): TaskUIMessage[] => foldTaskEvents(scene.events, scene.liveText, { taskKind: scene.kind, ...options });
const turnsOf = (messages: readonly TaskUIMessage[]) => messages.filter((message) => message.role === "assistant");
const turnOf = (messages: readonly TaskUIMessage[], turnId: string): TaskUIMessage | undefined => messages.find((message) => message.metadata?.turnId === turnId);
const partsOf = (messages: readonly TaskUIMessage[]): TaskUIPart[] => messages.flatMap((message) => message.parts);
const typesIn = (message: TaskUIMessage | undefined): string[] => (message?.parts ?? []).map((part) => part.type);

/** An event as the server stores it, beside `like`: a runner's has its session's number, core's none. `renumber` sets the seq. */
const storedLike = (like: StoredEvent, at: number, by: "runner" | "core", event: TaskEvent): StoredEvent =>
  storedEventSchema.parse({ taskId: like.taskId, seq: like.seq, sessionId: like.sessionId, sessionSeq: by === "core" ? null : 10_000 + like.seq, at, event });

/** Numbers a spliced log's events in order, as the server would have. */
const renumber = (events: readonly StoredEvent[]): StoredEvent[] => events.map((stored, i) => storedEventSchema.parse({ ...stored, seq: i + 1 }));

/** The stored event of a log at `index`, which a test expects there. */
const eventAt = (events: readonly StoredEvent[], index: number): StoredEvent => {
  const stored = events[index];
  if (stored === undefined) throw new Error(`no event at ${String(index)}`);
  return stored;
};

/** The ID of the call an event list made for a command, the n-th time it ran (from 0). */
const callOf = (events: readonly StoredEvent[], title: string, n = 0): ToolCallId => {
  const call = events.flatMap(({ event }) => (event.kind === "tool.called" && event.title === title ? [event.toolCallId] : []))[n];
  if (call === undefined) throw new Error(`no call ${title} #${String(n)}`);
  return call;
};

describe("bookkeeping out of the parts", () => {
  const messages = fold(s2);
  const turns = turnsOf(messages);

  it("F-151/c1: folding S2 draws no saved work, session end, hidden push, runner connection or config change", () => {
    const parts = partsOf(messages);
    const types = new Set(parts.map((part) => part.type));
    expect(types).not.toContain("data-saved");
    expect(types).not.toContain("data-session-end");
    expect(parts.flatMap((part) => (part.type === "data-pushed" ? [part.data.ref] : []))).toEqual([`refs/heads/${sceneWorld.branch}`]);
    const system = parts.flatMap((part) => (part.type === "data-system" ? [part.data.event.kind] : []));
    expect(system).not.toContain("runner.connected");
    expect(system).not.toContain("session.config_changed");
    // The log had each of them, so the fold left them out on purpose.
    const kinds = new Set(s2.events.map(({ event }) => event.kind));
    for (const kind of ["session.saved", "session.ended", "git.pushed", "runner.connected"] as const) expect(kinds).toContain(kind);
    // Nothing stands between the turns but the members' messages.
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    // S5 has ostra's own config changes for plan first; neither is drawn.
    expect(partsOf(fold(s5Approved)).some((part) => part.type === "data-system")).toBe(false);
    expect(s5Approved.events.filter(({ event }) => event.kind === "session.config_changed")).toHaveLength(2);
  });

  it("F-151/c1: each turn's saved and ended hold their facts", () => {
    expect(turns.map((turn) => turn.metadata?.saved)).toEqual([
      { archiveBytes: 141_312, hiddenRefs: ["1a2b3c4d01".padEnd(40, "0")], unsaved: 0, checks: null },
      { archiveBytes: 167_936, hiddenRefs: ["2b3c4d5e02".padEnd(40, "0")], unsaved: 0, checks: null },
      { archiveBytes: 179_200, hiddenRefs: ["3c4d5e6f03".padEnd(40, "0")], unsaved: 0, checks: null },
      { archiveBytes: 193_000, hiddenRefs: [calc192.pushSha], unsaved: 0, checks: { passed: 3, failed: 0, total: 3 } },
    ]);
    // The first session ended after turn 1 (the box idled out); the second is still live.
    expect(turns.map((turn) => turn.metadata?.ended)).toEqual([{ outcome: "without-changes", repos: [{ repoId: sceneWorld.repoId, ahead: false }] }, undefined, undefined, undefined]);
    // S3's review task saves no repo, and its session's end is its last turn's.
    const review = turnsOf(fold(s3));
    expect(review.map((turn) => turn.metadata?.saved?.unsaved)).toEqual([0, 0]);
    expect(review.at(-1)?.metadata?.ended).toEqual({ outcome: "without-changes", repos: [] });
    // A save before any turn has nowhere to go but the Event log.
    expect(foldTaskEvents(s2.events.filter(({ event }) => event.kind === "session.saved"), [])).toEqual([]);
  });

  it("F-151/c1: an unchanged refold keeps every message's identity, and a new price changes only its turn", () => {
    const first = fold(s2, { turnSpend: calc192Spend.pr });
    const again = fold(s2, { turnSpend: calc192Spend.pr, previous: first });
    again.forEach((message, i) => {
      expect(message).toBe(first[i]);
    });
    const repriced = new Map<TurnId, TurnSpend>([...calc192Spend.pr, [calc192.turns.t4, { microUsd: 330_000, estimated: false }]]);
    const moved = fold(s2, { turnSpend: repriced, previous: first });
    expect(moved.filter((message, i) => message !== first[i]).map((message) => message.metadata?.turnId)).toEqual([calc192.turns.t4]);
  });
});

describe("a turn's numbers and its steps' times", () => {
  it("F-151/c3: S2's four turns over two sessions are numbered 1 to 4", () => {
    const turns = turnsOf(fold(s2));
    expect(turns.map((turn) => [turn.metadata?.ordinal, turn.metadata?.sessionId])).toEqual([
      [1, calc192.sessions.first],
      [2, calc192.sessions.second],
      [3, calc192.sessions.second],
      [4, calc192.sessions.second],
    ]);
  });

  it("F-151/c3: a page of history that starts at a later turn keeps the task's numbers through turnOrdinals", () => {
    const fromTurn3 = s2.events.findIndex(({ event }) => event.kind === "turn.started" && event.turnId === calc192.turns.t3);
    const page = s2.events.slice(fromTurn3);
    // Alone, the page counts from its own first turn; with `tasks.get`'s turns, from the task's.
    expect(turnsOf(foldTaskEvents(page, [])).map((turn) => turn.metadata?.ordinal)).toEqual([1, 2]);
    const priced = [calc192.turns.t4, calc192.turns.t2, calc192.turns.t1, calc192.turns.t3].map((turnId, i) => ({ turnId, startedAt: [4, 2, 1, 3][i] ?? 0, spentMicroUsd: i === 2 ? null : 100_000, estimated: false }));
    const ordinals = turnOrdinalsOf(priced);
    expect(turnsOf(foldTaskEvents(page, [], { turnOrdinals: ordinals })).map((turn) => turn.metadata?.ordinal)).toEqual([3, 4]);
    // A turn `tasks.get` hasn't listed yet is numbered on from the one before it.
    const unlisted = new Map([...ordinals].filter(([turnId]) => turnId !== calc192.turns.t4));
    expect(turnsOf(foldTaskEvents(page, [], { turnOrdinals: unlisted })).map((turn) => turn.metadata?.ordinal)).toEqual([3, 4]);
    // A turn with no price has no spend.
    expect([...turnSpendOf(priced).keys()]).toEqual([calc192.turns.t4, calc192.turns.t2, calc192.turns.t3]);
  });

  it("F-151/c3: a turn's spend comes from turnSpend, marked estimated when it is", () => {
    const turns = turnsOf(fold(s2, { turnSpend: calc192Spend.pr }));
    expect(turns.map((turn) => turn.metadata?.spend)).toEqual([
      { microUsd: 740_000, estimated: false },
      { microUsd: 620_000, estimated: false },
      { microUsd: 470_000, estimated: true },
      { microUsd: 310_000, estimated: false },
    ]);
    // Unpriced, a turn has no spend; a review task's turns are priced the same way.
    expect(turnsOf(fold(s2)).map((turn) => turn.metadata?.spend)).toEqual([undefined, undefined, undefined, undefined]);
    expect(turnsOf(fold(s3, { turnSpend: review483Spend })).map((turn) => turn.metadata?.spend?.microUsd)).toEqual([550_000, 190_000]);
    expect(turnOf(fold(s1Working, { turnSpend: calc192Spend.working }), calc192.turns.t1)?.metadata?.spend).toEqual({ microUsd: 410_000, estimated: false });
  });

  it("F-151/c3: stepTimes give a command its duration from its two events, and a thought its own", () => {
    const turn = turnOf(fold(s1), calc192.turns.t1);
    const times = turn?.metadata?.stepTimes ?? {};
    const duration = (key: string): number | null => {
      const time = times[key];
      return time === undefined || time.endedAt === null ? null : time.endedAt - time.startedAt;
    };
    const failing = callOf(s1.events, "pnpm test history", 0);
    const passing = callOf(s1.events, "pnpm test history", 1);
    expect([duration(failing), duration(passing)]).toEqual([4_100, 3_800]);
    // The command's start and end are its own events' times.
    const called = s1.events.find(({ event }) => event.kind === "tool.called" && event.toolCallId === failing);
    const completed = s1.events.find(({ event }) => event.kind === "tool.completed" && event.toolCallId === failing);
    expect(times[failing]).toEqual({ startedAt: called?.at, endedAt: completed?.at });
    // A thought runs from the turn's event before it to its own: S1's first is `Thought for 6s`.
    expect([duration(thoughtTimeKey(0)), duration(thoughtTimeKey(1))]).toEqual([6_000, 5_200]);
    expect(turn?.parts.filter((part) => part.type === "reasoning")).toHaveLength(2);
    // Every call of the turn has its times, the absorbed screenshot's too.
    const calls = s1.events.flatMap(({ event }) => (event.kind === "tool.called" ? [event.toolCallId] : []));
    expect(calls.every((call) => times[call] !== undefined)).toBe(true);
  });

  it("F-151/c3: a running tool has endedAt: null, and a thought still streaming too", () => {
    const rerun = callOf(s1Working.events, "pnpm test history", 1);
    const working = turnOf(fold(s1Working), calc192.turns.t1);
    expect(working?.metadata?.stepTimes?.[rerun]).toEqual({ startedAt: s1Working.events.find(({ event }) => event.kind === "tool.called" && event.toolCallId === rerun)?.at, endedAt: null });
    const thinking = stateCells.steps[1].thinking;
    const turn = turnsOf(fold(thinking))[0];
    const started = thinking.events.find(({ event }) => event.kind === "turn.started")?.at;
    expect(turn?.metadata?.stepTimes?.[thoughtTimeKey(0)]).toEqual({ startedAt: started, endedAt: null });
  });

  it("F-151/c3: a cancelled call, a denied one and a subagent's call keep their times", () => {
    // The turn that hit its limit was cancelled while its read ran: it ends with the turn.
    const limited = stateCells.steps[4];
    const cancelled = turnsOf(fold(limited)).at(-1);
    const turnEnd = limited.events.findLast(({ event }) => event.kind === "turn.ended")?.at;
    const read = callOf(limited.events, "read");
    expect(cancelled?.metadata?.stepTimes?.[read]?.endedAt).toBe(turnEnd);
    // A denied command ends with the deny.
    const answered = stateCells.asks[2];
    const reset = callOf(answered.events, "pnpm db:reset");
    const denied = answered.events.find(({ event }) => event.kind === "approval.answered" && event.decision === "deny")?.at;
    expect(turnsOf(fold(answered))[0]?.metadata?.stepTimes?.[reset]?.endedAt).toBe(denied);
    // A subagent's calls are in its turn's times, where its window finds them.
    const subagents = stateCells.steps[5];
    const tree = turnsOf(fold(subagents))[0]?.metadata;
    const subagentCalls = tree?.subagents?.nodes.flatMap((node) => node.rounds.flatMap((round) => round.calls.map((call) => call.toolCallId))) ?? [];
    expect(subagentCalls.length).toBeGreaterThan(20);
    expect(subagentCalls.every((call) => tree?.stepTimes?.[call]?.endedAt !== undefined)).toBe(true);
  });

  it("F-151/c3: a call its turn left open ends with the turn, however it ended, and never before it started", () => {
    // S1-working's rerun of `pnpm test history` is running when the scene stops.
    const rerun = callOf(s1Working.events, "pnpm test history", 1);
    const last = eventAt(s1Working.events, s1Working.events.length - 1);
    const startedAt = s1Working.events.find(({ event }) => event.kind === "tool.called" && event.toolCallId === rerun)?.at;
    const endOf = (by: "runner" | "core", after: number, event: TaskEvent): number | null | undefined => {
      const log = renumber([...s1Working.events, storedLike(last, last.at + after, by, event)]);
      return turnOf(foldTaskEvents(log, []), calc192.turns.t1)?.metadata?.stepTimes?.[rerun]?.endedAt;
    };
    const t1 = calc192.turns.t1;
    expect(endOf("runner", 2_000, { kind: "turn.ended", turnId: t1, stopReason: "end_turn" })).toBe(last.at + 2_000);
    expect(endOf("runner", 3_000, { kind: "turn.failed", turnId: t1, error: "the model endpoint returned 500" })).toBe(last.at + 3_000);
    expect(endOf("runner", 4_000, { kind: "session.crashed", error: "the agent exited with code 1" })).toBe(last.at + 4_000);
    expect(endOf("runner", 5_000, { kind: "session.ended", outcome: "without-changes", repos: [] })).toBe(last.at + 5_000);
    // Core writes a lost box's crash on its own clock: one behind the runner's still ends the call
    // at its start, not before.
    expect(endOf("core", -600_000, { kind: "session.crashed", error: "the box went away", cause: "box_lost" })).toBe(startedAt);
    // A lost runner may come back, so its call runs on.
    expect(endOf("core", 6_000, { kind: "runner.lost", runnerId: eventFixtures["runner.lost"].runnerId })).toBeNull();
  });

  it("F-151/c3: a thought's time is its runner's, whatever core wrote on its own clock in the turn", () => {
    const first = s1.events.findIndex(({ event }) => event.kind === "agent.thought");
    const thought = eventAt(s1.events, first);
    const thoughtTime = (log: readonly StoredEvent[]): number | null => {
      const time = turnOf(foldTaskEvents(log, []), calc192.turns.t1)?.metadata?.stepTimes?.[thoughtTimeKey(0)];
      return time === undefined || time.endedAt === null ? null : time.endedAt - time.startedAt;
    };
    expect(thoughtTime(s1.events)).toBe(6_000);
    // A memory proposal core stored just before the thought, its clock a minute ahead or behind the
    // runner's: the thought is still `Thought for 6s`.
    for (const skew of [60_000, -60_000]) {
      const proposed = storedLike(thought, thought.at + skew, "core", eventFixtures["memory.proposed"]);
      expect(thoughtTime(renumber([...s1.events.slice(0, first), proposed, ...s1.events.slice(first)]))).toBe(6_000);
    }
  });
});

describe("results in their turn", () => {
  it("F-151/c7: S3's review result is a data-review part in the turn that handed it in, and the repeat one has repeat: true", () => {
    const messages = fold(s3);
    const [first, second] = turnsOf(messages);
    const reviewsIn = (turn: TaskUIMessage | undefined) => (turn?.parts ?? []).flatMap((part) => (part.type === "data-review" ? [part.data] : []));
    const posted = [{ repoId: sceneWorld.repoId, prNumber: calc192.pr.number, url: review483.reviewUrl }];
    expect(reviewsIn(first)).toEqual([{ reviewRunId: review483.reviewRunId, blocking: 0, nits: 1, repeat: false, posted }]);
    expect(reviewsIn(second)).toEqual([{ reviewRunId: review483.reviewRunId, blocking: 0, nits: 1, repeat: true, posted }]);
    // After the turn's text, though the hand-in came before it.
    for (const turn of [first, second]) expect(typesIn(turn).lastIndexOf("text")).toBeLessThan(typesIn(turn).indexOf("data-review"));
    // Every hand-in is drawn once, and a review task has no push or PR.
    expect(partsOf(messages).filter((part) => part.type === "data-review")).toHaveLength(2);
    expect(partsOf(messages).some((part) => part.type === "data-pushed" || part.type === "data-pr")).toBe(false);
  });

  it("F-151/c7: the code task's copy of a review's hand-in and its post join none of the code task's turns", () => {
    // Core writes the first hand-in and each post into the code task's log too, on its latest
    // session (`submitReview`, `postReview`). None of its turns made the review: the Event log keeps both.
    const last = s2.events.at(-1);
    if (last === undefined) throw new Error("S2 has no events");
    const copies = [
      { kind: "review.submitted", reviewRunId: review483.reviewRunId, blocking: 0, nits: 1 },
      { kind: "review.posted", reviewRunId: review483.reviewRunId, repoId: sceneWorld.repoId, prNumber: calc192.pr.number, url: review483.reviewUrl },
    ] as const satisfies readonly TaskEvent[];
    const log = [...s2.events, ...copies.map((event, i) => storedEventSchema.parse({ taskId: s2.taskId, seq: last.seq + i + 1, sessionId: last.sessionId, sessionSeq: null, at: last.at + (i + 1) * 1_000, event }))];
    const before = fold(s2);
    const after = foldTaskEvents(log, s2.liveText, { taskKind: s2.kind, previous: before });
    expect(partsOf(after).some((part) => part.type === "data-review")).toBe(false);
    // Its thread is as it was, every message the same object.
    expect(after).toHaveLength(before.length);
    after.forEach((message, i) => {
      expect(message).toBe(before[i]);
    });
    // A fold that isn't told the task's kind reads it as not a review task.
    expect(partsOf(foldTaskEvents(log, [])).some((part) => part.type === "data-review")).toBe(false);
  });

  it("F-151/c7: a push and the PR it opened are parts of the turn that pushed, not rows between turns", () => {
    const messages = fold(s2);
    const last = turnOf(messages, calc192.turns.t4);
    expect(messages.at(-1)).toBe(last);
    expect(messages.some((message) => message.role === "system")).toBe(false);
    const pushed = last?.parts.find((part) => part.type === "data-pushed");
    const pr = { repoId: sceneWorld.repoId, url: calc192.pr.url, number: calc192.pr.number, title: calc192.pr.title };
    expect(pushed?.type === "data-pushed" ? pushed.data : null).toEqual({
      repoId: sceneWorld.repoId,
      branch: sceneWorld.branch,
      headSha: calc192.pushSha,
      ref: `refs/heads/${sceneWorld.branch}`,
      hidden: false,
      checks: { passed: 3, failed: 0, total: 3 },
      firstPr: pr,
    });
    expect(last?.parts.find((part) => part.type === "data-pr")).toMatchObject({ data: pr });
    // In the turn's order: its prose, then the PR's text, the push and the PR.
    const types = typesIn(last);
    expect(types.slice(types.lastIndexOf("text") + 1)).toEqual(["data-pr-text", "data-pushed", "data-pr"]);
    // A later push to the open PR opens nothing: it has no `firstPr`.
    const later = foldTaskEvents(stateCells.messages[1].events, []);
    expect(later.flatMap((message) => message.parts).find((part) => part.type === "data-pushed")).toMatchObject({ data: { firstPr: null, checks: null } });
  });

  it("F-151/c7: a PR core opens after the next turn started is a part of the turn that pushed", () => {
    // Core opens the PR from a job the save started (`task.open-pull-requests`). The runner starts
    // the next turn right after the save when a message is queued, and core's closing turn follows
    // a save too, so the next turn's start can be stored before `pr.opened`.
    const at = s2.events.findIndex(({ event }) => event.kind === "pr.opened");
    const opened = eventAt(s2.events, at);
    const t5 = turnIdSchema.parse(sceneId("0192", 0x105));
    const next = [
      storedLike(opened, opened.at - 2_000, "runner", { kind: "turn.started", turnId: t5 }),
      storedLike(opened, opened.at - 1_000, "runner", { kind: "agent.message", turnId: t5, segmentId: segmentIdSchema.parse("calc192-seg-t5"), text: "Reading the review's nit." }),
    ];
    const log = renumber([...s2.events.slice(0, at), ...next, opened, ...s2.events.slice(at + 1)]);
    const messages = foldTaskEvents(log, [], { taskKind: "code" });
    const pushedIn = turnOf(messages, calc192.turns.t4);
    const pr = { repoId: sceneWorld.repoId, url: calc192.pr.url, number: calc192.pr.number, title: calc192.pr.title };
    expect(pushedIn?.parts.find((part) => part.type === "data-pushed")).toMatchObject({ data: { headSha: calc192.pushSha, firstPr: pr } });
    const types = typesIn(pushedIn);
    expect(types.slice(types.lastIndexOf("text") + 1)).toEqual(["data-pr-text", "data-pushed", "data-pr"]);
    // The turn that pushed reads as it does when the PR came first; the next turn has no PR.
    expect(pushedIn?.parts).toEqual(turnOf(fold(s2), calc192.turns.t4)?.parts);
    expect(typesIn(turnOf(messages, t5))).toEqual(["step-start", "text"]);
    expect(partsOf(messages).filter((part) => part.type === "data-pr")).toHaveLength(1);
    // With no push in the log (a page of history that starts after it), the PR joins the session's last turn.
    const unpushed = foldTaskEvents(
      log.filter(({ event }) => event.kind !== "git.pushed"),
      [],
      { taskKind: "code" },
    );
    expect(typesIn(turnOf(unpushed, t5))).toEqual(["step-start", "text", "data-pr"]);
  });

  it("F-151/c7: a refine task's draft and a turn's memory proposal are results of their turn", () => {
    const draft = turnsOf(fold(stateCells.messages[6].refine))[0];
    expect(draft?.parts.find((part) => part.type === "data-draft")).toMatchObject({ data: { version: 2, acceptanceCriteria: 4, subTickets: 2 } });
    expect(typesIn(draft).at(-1)).toBe("data-draft");
    const code = fold(stateCells.messages[6].code);
    const turn = turnsOf(code)[0];
    expect(typesIn(turn).at(-1)).toBe("data-memory-proposed");
    // The budget's hold of the next message stays a row of its own, in time order.
    expect(code.at(-1)?.parts.map((part) => part.type)).toEqual(["data-held"]);
  });
});
