import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { foldTaskEvents, liveStepOf, turnItemsOf } from "@ostra/task-view";
import type { CommandStep, RunItem, RunStep, TaskUIMessage, ThreadContext, TurnItem, TurnSpend } from "@ostra/task-view";
import { calc192, calc192Spend, review483, review483Spend, s1, s1Working, s2, s3, s5Approved, s5Plan, sceneId, sceneMembers, sceneTime, stateCells } from "@ostra/task-view/testing";
import type { Scene } from "@ostra/task-view/testing";
import type { MemberId, TurnId } from "@ostra/protocol";

import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { boxStatusWords, checksLine, checksRow, ciJobsWords, ciLine, ciRow, footerFacts, liveStepWords, resultWords, runLineWords, segmentsText, stepWords, tooltipRows } from "./words";
import type { HeadCi, Segment } from "./words";

// Milestone 10, ticket 04 (F-151): the compact thread's words over ticket 03's items, from the
// targets' recorded scenes (`@ostra/task-view/testing`), through the real fold and `turnItemsOf`.

const fail = (what: string): never => {
  throw new Error(`missing: ${what}`);
};

const names = new Map<MemberId, string>(Object.values(sceneMembers).map((member) => [member.id, member.name]));
const nameOf = (member: MemberId): string => names.get(member) ?? fail(`member ${member}`);

const contextOf = (scene: Scene): ThreadContext => ({ taskId: scene.taskId, checkoutDirs: ["calculator-web"], mcpServers: ["github"] });
const fold = (scene: Scene, turnSpend?: ReadonlyMap<TurnId, TurnSpend>): TaskUIMessage[] =>
  foldTaskEvents(scene.events, scene.liveText, { taskKind: scene.kind, ...(turnSpend === undefined ? {} : { turnSpend }) });
const turnOf = (scene: Scene, turnId: string, turnSpend?: ReadonlyMap<TurnId, TurnSpend>): TaskUIMessage =>
  fold(scene, turnSpend).find((message) => message.metadata?.turnId === turnId) ?? fail(`turn ${turnId} in ${scene.name}`);
const itemsOf = (scene: Scene, turnId: string): TurnItem[] => turnItemsOf(turnOf(scene, turnId), contextOf(scene));
const runsOf = (scene: Scene, turnId: string): RunItem[] => itemsOf(scene, turnId).flatMap((item) => (item.kind === "run" ? [item] : []));
const runAt = (scene: Scene, turnId: string, n: number): RunItem => runsOf(scene, turnId)[n] ?? fail(`run ${String(n)}`);
const metaOf = (message: TaskUIMessage) => message.metadata ?? fail("the turn's meta");

const line = (run: RunItem): string => segmentsText(runLineWords(run, t, nameOf));
/** The words of segments in one tone. */
const inTone = (segments: readonly Segment[], tone: Segment["tone"]): string[] => segments.filter((segment) => segment.tone === tone).map((segment) => segment.text);

describe("a run's line", () => {
  it("F-151/c2: S1's runs read Thought for 6s, read 4 files and Edited 2 files, ran 2 commands, took a screenshot · 1 failed, then passed, red only on failed", () => {
    const [first, second] = runsOf(s1, calc192.turns.t1);
    expect(line(first ?? fail("S1's first run"))).toBe("Thought for 6s, read 4 files");
    const words = runLineWords(second ?? fail("S1's second run"), t, nameOf);
    expect(segmentsText(words)).toBe("Edited 2 files, ran 2 commands, took a screenshot · 1 failed, then passed");
    expect(inTone(words, "red")).toEqual(["failed"]);
  });

  it("F-151/c2: S3's 23 steps start with their total, each kind in the order it first happened", () => {
    expect(line(runAt(s3, review483.turns.t2, 0))).toBe("23 steps: read 9 files, searched the web 3 times, fetched 1 page, ran 8 commands, used 2 tools");
    // Turn 1 ran commands first, and its hand-in is a tool (parts.md part 4: "any other tool (MCP, ostra's own)"): 23 steps too.
    expect(line(runAt(s3, review483.turns.t1, 0))).toBe("23 steps: ran 5 commands, read 14 files, searched the code 3 times, used 1 tool");
  });

  it("F-151/c2: two code searches read twice, and two counts that share a noun drop the second's", () => {
    expect(line(runAt(s5Plan, s5Plan.events.flatMap((stored) => (stored.event.kind === "turn.started" ? [stored.event.turnId] : []))[0] ?? fail("S5's plan turn"), 0))).toBe("Read 5 files, searched the code twice");
    expect(line(runAt(stateCells.steps[2], sceneId("ce14", 0x101), 0))).toBe("Read 1 file, edited 2 files, ran 1 command");
    const twoAndTwo: RunItem = { ...runAt(s1, calc192.turns.t1, 0), thought: null, counts: [{ kind: "read", n: 2 }, { kind: "edit", n: 2 }], total: 4 };
    expect(line(twoAndTwo)).toBe("Read 2 files, edited 2");
  });

  it("F-151/c2: an approved and a denied tail name who answered, red only on denied, with a reason when one was given", () => {
    const cell = stateCells.asks[2];
    const turnId = sceneId("ce22", 0x101);
    expect(line(runAt(cell, turnId, 0))).toBe("Read 3 files, edited 1 file, ran 2 commands · 1 approved by Sam Rivera");
    const denied = runLineWords(runAt(cell, turnId, 1), t, nameOf);
    expect(segmentsText(denied)).toBe("Ran 1 command · 1 denied by Alex Kim, with a reason");
    expect(inTone(denied, "red")).toEqual(["denied"]);
  });

  it("F-151/c2: a failure the turn didn't recover from is no tail: it has its own line", () => {
    expect(line(runAt(stateCells.steps[4], sceneId("ce16", 0x101), 0))).toBe("Ran 1 command");
  });
});

describe("an opened run's steps", () => {
  const now = s1.now;
  const stepsOfS4 = (): readonly RunStep[] => runAt(s1, calc192.turns.t1, 1).steps;

  it("F-151/c3: S4's rows: each edit's +a −d, each command's exit and duration, the thought's excerpt, the capture's route", () => {
    const rows = stepsOfS4().map((step) => {
      const words = stepWords(step, t, nameOf, { open: false, now });
      return [words.verb, segmentsText(words.subject), segmentsText(words.result), words.link?.label ?? null];
    });
    expect(rows).toEqual([
      // The scenes record each edit's counts, not its patch, so there's no diff to open.
      ["Edited", "src/history/store.ts", "+48", null],
      ["Edited", "src/history/panel.tsx", "+118 −6", null],
      ["Ran", "pnpm test history", "exit 1 · 4.1 s", "output"],
      ["Thought", "The empty history renders nothing; Dana's mock has an empty state for it.", "", null],
      ["Edited", "src/history/panel.tsx", "+12 −2", null],
      ["Ran", "pnpm test history", "✓ exit 0 · 3.8 s", "output"],
      ["Captured", "a screenshot of /history", "web", null],
    ]);
  });

  it("F-151/c3: an edit with its patch offers its diff, named for its file", () => {
    const edit = stepsOfS4().find((step) => step.kind === "edit") ?? fail("an edit");
    const withPatch: RunStep = { ...edit, files: edit.files.map((file) => ({ ...file, patch: "@@ -0,0 +1,48 @@" })) };
    const link = stepWords(withPatch, t, nameOf, { open: false, now }).link;
    expect([link?.label, link?.name]).toEqual(["diff", "Show the diff of src/history/store.ts"]);
    expect(stepWords(withPatch, t, nameOf, { open: true, now }).link?.label).toBe("hide diff");
  });

  it("F-151/c3: a command's link names its step, and reads hide while its output is open", () => {
    const failing = stepsOfS4().find((step): step is CommandStep => step.kind === "command") ?? fail("the failing run");
    const closed = stepWords(failing, t, nameOf, { open: false, now }).link;
    const opened = stepWords(failing, t, nameOf, { open: true, now }).link;
    expect([closed?.label, closed?.name]).toEqual(["output", "Show the output of pnpm test history"]);
    expect([opened?.label, opened?.name]).toEqual(["hide output", "Hide the output of pnpm test history"]);
    const result = stepWords(failing, t, nameOf, { open: false, now }).result;
    expect(inTone(result, "red")).toEqual(["exit 1"]);
  });

  it("F-151/c3: an answered approval's row carries its receipt, a denied one denied in red", () => {
    const cell = stateCells.asks[2];
    const turnId = sceneId("ce22", 0x101);
    const [migrate] = runAt(cell, turnId, 0).steps.filter((step) => step.kind === "command");
    const approved = stepWords(migrate ?? fail("pnpm db:migrate"), t, nameOf, { open: false, now: cell.now });
    expect([segmentsText(approved.result), approved.receipt]).toEqual(["✓ exit 0 · 2.3 s", "approved once by Sam Rivera"]);
    const [reset] = runAt(cell, turnId, 1).steps;
    const denied = stepWords(reset ?? fail("pnpm db:reset"), t, nameOf, { open: false, now: cell.now });
    expect([inTone(denied.result, "red"), denied.receipt]).toEqual([["denied"], "denied by Alex Kim"]);
  });

  it("F-151/c3: S3's opened turn: the MCP tool by its name with its server, the fetch's 403 in red, ostra's hand-in in its own words", () => {
    const rows = runAt(s3, review483.turns.t2, 0).steps.map((step) => stepWords(step, t, nameOf, { open: false, now: s3.now }));
    const tool = rows.find((row) => row.verb === "Used") ?? fail("the MCP tool");
    expect(segmentsText(tool.subject)).toBe("github get_pull_request");
    expect(inTone(tool.subject, "faint")).toEqual(["github"]);
    const fetch = rows.find((row) => row.verb === "Fetched") ?? fail("the fetch");
    expect([segmentsText(fetch.subject), inTone(fetch.result, "red"), fetch.link?.label]).toEqual(["finance.acme.dev/rounding", ["403 Forbidden"], "details"]);
    const handIn = rows.find((row) => row.verb === "Submitted the review") ?? fail("the repeat hand-in");
    expect(segmentsText(handIn.result)).toBe("already submitted, kept as it was");
    expect(rows.map((row) => row.verb)).not.toContain("other");
  });
});

describe("a turn's numbers", () => {
  const facts = (message: TaskUIMessage, kind: Scene["kind"]): string => footerFacts(metaOf(message), kind, t).map((fact) => fact.text).join(" · ");
  const clock = (time: string): string => formatClock(sceneTime(time));

  it("F-151/c3: S4's footer: the turn, its level, tokens, reasoning, spend so far and not saved yet", () => {
    expect(facts(turnOf(s1, calc192.turns.t1, calc192Spend.question), "code")).toBe("Turn 1 · High · 41.2k in · 6.3k out · 2.1k reasoning · $0.62 so far · not saved yet");
  });

  it("F-151/c3: a review task's footer has no saved fact", () => {
    expect(facts(turnOf(s3, review483.turns.t2, review483Spend), "review")).toBe("Turn 2 · Max · 13.4k in · 2.6k out · 1.6k reasoning · $0.19");
    // The same turn read as a code task's would say what was kept.
    expect(facts(turnOf(s3, review483.turns.t2, review483Spend), "code")).toContain("saved, archive 97 kB");
  });

  it("F-151/c3: the clamp is the level fact, Max, asked Extra high, with its sentence as the tip", () => {
    const turnId = turnIdOf(stateCells.steps[6], 3);
    const spend = new Map<TurnId, TurnSpend>([[turnId, { microUsd: 410_000, estimated: false }]]);
    const footer = footerFacts(metaOf(turnOf(stateCells.steps[6], turnId, spend)), "code", t);
    expect(footer.map((fact) => fact.text).join(" · ")).toBe("Turn 3 · Max, asked Extra high · 48k in · 9.1k out · 6.4k reasoning · $0.41");
    expect(footer.find((fact) => fact.tip !== null)?.tip).toBe("Ran at Max: this model has no Extra high.");
  });

  it("F-151/c3: an estimate is marked with ≈", () => {
    const footer = facts(turnOf(s2, calc192.turns.t3, calc192Spend.pr), "code");
    expect(footer).toContain("≈$0.47");
  });

  it("F-151/c3: S2's turn 4 tooltip: its span, then Effort, Tokens, Reasoning, Spend and Saved", () => {
    const tooltip = tooltipRows(metaOf(turnOf(s2, calc192.turns.t4, calc192Spend.pr)), "code", t);
    expect(tooltip.head).toBe(`Turn 4 · ${clock("14:44")} to ${clock("14:47")}`);
    expect(tooltip.rows.map((row) => [row.key, row.value])).toEqual([
      ["Effort", "High"],
      ["Tokens", "22.4k in · 3.8k out"],
      ["Reasoning", "1.1k"],
      ["Spend", "$0.31"],
      ["Saved", "archive 193 kB"],
    ]);
  });

  it("F-151/c3: an open turn's tooltip runs to now, and a review task's has no Saved row", () => {
    expect(tooltipRows(metaOf(turnOf(s1, calc192.turns.t1, calc192Spend.question)), "code", t).head).toBe(`Turn 1 · ${clock("14:02")} to now`);
    expect(tooltipRows(metaOf(turnOf(s3, review483.turns.t2, review483Spend)), "review", t).rows.map((row) => row.key)).toEqual(["Effort", "Tokens", "Reasoning", "Spend"]);
  });
});

const turnIdOf = (scene: Scene, n: number): TurnId =>
  scene.events.flatMap((stored) => (stored.event.kind === "turn.started" ? [stored.event.turnId] : []))[n - 1] ?? fail(`turn ${String(n)} of ${scene.name}`);

describe("checks and CI", () => {
  const ci = (state: HeadCi["state"], done: number, total: number, failingJobs: readonly string[] = []): HeadCi => ({ state, jobs: { done, total }, failingJobs });

  it("F-151/c6: the PR card's CI line counts the code host's CI in jobs: running, passed, failed and none", () => {
    expect(segmentsText(ciLine(ci("running", 2, 4), t, { aiReview: true }))).toBe("CI on GitHub: running, 2 of 4 jobs done · then the AI review");
    expect(segmentsText(ciLine(ci("running", 2, 4), t, { aiReview: false }))).toBe("CI on GitHub: running, 2 of 4 jobs done");
    expect(segmentsText(ciLine(ci("passed", 4, 4), t, { aiReview: true }))).toBe("CI on GitHub passed · 4 jobs");
    const failed = ciLine(ci("failed", 4, 4, ["e2e"]), t, { aiReview: true });
    expect(segmentsText(failed)).toBe("CI on GitHub failed: e2e");
    expect(inTone(failed, "red")).toEqual(["failed"]);
    expect(segmentsText(ciLine(ci("failed", 4, 4, ["e2e", "lint", "unit"]), t, { aiReview: true }))).toBe("CI on GitHub failed: e2e and 2 more");
    expect(segmentsText(ciLine(ci("none", 0, 0), t, { aiReview: true }))).toBe("No CI on GitHub");
  });

  it("F-151/c6: the panel's CI row and Home's board count jobs too", () => {
    expect(ciRow(ci("running", 2, 4), t)).toEqual({ state: "Running", detail: "2 of 4 jobs" });
    expect(ciRow(ci("passed", 1, 1), t)).toEqual({ state: "Passed", detail: "1 job" });
    expect(ciRow(ci("failed", 4, 4, ["e2e"]), t)).toEqual({ state: "Failed", detail: "e2e" });
    expect(ciJobsWords({ done: 0, total: 1 }, t)).toBe("0 of 1 job");
  });

  it("F-151/c6: ostra's checks count as checks, in the box: passed, and one failing in red", () => {
    expect(segmentsText(checksLine({ passed: 3, failed: 0, total: 3 }, t))).toBe("3 checks passed in the box");
    const failing = checksLine({ passed: 2, failed: 1, total: 3 }, t);
    expect(segmentsText(failing)).toBe("1 of 3 checks failed in the box");
    expect(inTone(failing, "red")).toEqual(["failed"]);
    expect(checksRow({ passed: 3, failed: 0, total: 3 }, t)).toEqual({ value: "3 of 3 passed", place: "in the box" });
  });

  it("F-151/c6: S2's push line says the checks passed in the box, and a failing check makes the PR a draft", () => {
    const push = itemsOf(s2, calc192.turns.t4).flatMap((item) => (item.kind === "result" && item.result.kind === "push" ? [item.result] : []))[0] ?? fail("S2's push");
    expect(segmentsText(resultWords(push, t).words)).toBe("Pushed ostra/calc-192-history-panel · 3 checks passed in the box");
    const drafted = resultWords({ kind: "push", push: { ...push.push, checks: { passed: 2, failed: 1, total: 3 } } }, t);
    expect(segmentsText(drafted.words)).toBe("Pushed ostra/calc-192-history-panel · 1 of 3 checks failed in the box, so the PR is a draft");
    expect(inTone(drafted.words, "red")).toEqual(["failed"]);
    expect(segmentsText(resultWords(push, t, { later: true, ci: "passed" }).words)).toBe("Pushed 9c1e2f0 · CI passed");
  });

  it("F-151/c6: no string in en.json counts the code host's CI in checks", async () => {
    const file: unknown = JSON.parse(await readFile(path.resolve(import.meta.dirname, "..", "..", "..", "messages", "en.json"), "utf8"));
    const strings = (node: unknown, prefix: string): [string, string][] => {
      if (typeof node === "string") return [[prefix, node]];
      if (typeof node !== "object" || node === null) return [];
      return Object.entries(node).flatMap(([key, value]) => strings(value, prefix === "" ? key : `${prefix}.${key}`));
    };
    // A string speaks of CI when its words name it, or its key does (`ciPassed`, `fixCi`, `task.ci.*`).
    const speaksOfCi = ([key, text]: [string, string]): boolean => /\bCI\b/.test(text) || key.split(".").some((part) => /^ci(?:[A-Z]|$)|Ci(?:[A-Z]|$)/.test(part));
    // Placeholders aren't words, and a "check run" is GitHub's name for one CI job.
    const saysChecks = (text: string): boolean => /\bchecks?\b/i.test(text.replace(/\{\w+\}/g, "").replace(/\bcheck runs?\b/gi, ""));
    const all = strings(file, "");
    expect(all.filter(speaksOfCi).length).toBeGreaterThan(40);
    expect(all.filter(speaksOfCi).filter(([, text]) => saysChecks(text)).map(([key]) => key)).toEqual([]);
    // The three the targets name, as they read now.
    expect(t("review.panel.ciPassed.other", { n: 3 })).toBe("Passed · 3 jobs");
    expect(t("task.agentMessage.fixCi.other", { n: 2 })).toBe("CI failed: 2 jobs");
    expect(t("review.round.noFailing")).toBe("The failing CI jobs weren't recorded.");
  });
});

describe("the status line's box", () => {
  const now = sceneTime("14:51:00");

  it("F-151/c9: an idle box says when it stops, its minutes rounded up", () => {
    expect(boxStatusWords({ state: "idle", idleStopDueAt: now + 10 * 60_000 + 1_000 }, now, t)).toBe("box idle, stops in 11 min");
    expect(boxStatusWords({ state: "idle", idleStopDueAt: now + 11 * 60_000 }, now, t)).toBe("box idle, stops in 11 min");
    expect(boxStatusWords({ state: "idle", idleStopDueAt: now + 5_000 }, now, t)).toBe("box idle, stops in 1 min");
    expect(boxStatusWords({ state: "idle", idleStopDueAt: null }, now, t)).toBe("box idle");
  });

  it("F-151/c9: a stopped and a released box say so, and a running one leaves the line to the turn", () => {
    expect(boxStatusWords({ state: "stopped", idleStopDueAt: null }, now, t)).toBe("box stopped");
    expect(boxStatusWords({ state: "released", idleStopDueAt: null }, now, t)).toBe("box released");
    expect(boxStatusWords({ state: "running", idleStopDueAt: null }, now, t)).toBeNull();
  });
});

describe("the live step", () => {
  const live = (scene: Scene, turnId: string) => liveStepOf(turnOf(scene, turnId), contextOf(scene)) ?? fail(`a live step in ${scene.name}`);

  it("F-151/c4: S1-working reads Running pnpm test history · 8 steps done, 1 failed, its clock from the turn's start", () => {
    const words = liveStepWords(live(s1Working, calc192.turns.t1), t, s1Working.now);
    expect(segmentsText(words.doing)).toBe("Running pnpm test history");
    expect(words.doing.filter((segment) => segment.mono).map((segment) => segment.text)).toEqual(["pnpm test history"]);
    expect(segmentsText(words.progress)).toBe("8 steps done, 1 failed");
    expect(inTone(words.progress, "red")).toEqual(["failed"]);
    expect(words.clock).toBe("3:52");
    expect(words.announcement).toBe("Running pnpm test history · 8 steps done, 1 failed");
  });

  it("F-151/c4: S5's build turn names the plan step in progress", () => {
    const words = liveStepWords(live(s5Approved, turnIdOf(s5Approved, 2)), t, s5Approved.now);
    expect(segmentsText(words.doing)).toBe("Editing src/keys/shortcuts.ts");
    expect(segmentsText(words.progress)).toBe("Plan step 1 of 6: Add src/keys/shortcuts.ts: a map from keys to the keypad's actions · 3 steps done");
    expect(words.clock).toBe("0:42");
  });

  it("F-151/c4: a step whose approval waits stands in the live step's place", () => {
    const cell = stateCells.asks[1];
    const words = liveStepWords(live(cell, sceneId("ce21", 0x101)), t, cell.now);
    expect([segmentsText(words.waiting?.asks ?? []), words.waiting?.needs]).toEqual(["Wants to run pnpm db:migrate", "needs approval"]);
  });
});

describe("a review task's results", () => {
  it("F-151/c7: S3's first hand-in is posted, its repeat confirmed, never failed", () => {
    const results = (turnId: string) => itemsOf(s3, turnId).flatMap((item) => (item.kind === "result" ? [resultWords(item.result, t)] : []));
    const [posted] = results(review483.turns.t1);
    expect([segmentsText(posted?.words ?? []), posted?.action?.label]).toEqual(["Review posted on PR #483 · nothing blocking, 1 nit", "Open the review"]);
    const [confirmed] = results(review483.turns.t2);
    expect(segmentsText(confirmed?.words ?? [])).toBe("Review on PR #483 confirmed · already posted this round, unchanged");
    expect(inTone(confirmed?.words ?? [], "red")).toEqual([]);
  });
});
