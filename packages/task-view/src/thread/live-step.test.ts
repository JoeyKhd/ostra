import { describe, expect, it } from "vitest";

import { foldTaskEvents } from "../fold.ts";
import { calc192, calc196, calc196Plan, s1, s1Working, s2, s5Approved, s5Plan, sceneId, stateCells } from "../testing/index.ts";
import type { Scene } from "../testing/index.ts";
import type { TaskUIMessage } from "../ui-types.ts";
import { turnItemsOf } from "./items.ts";
import { liveStepOf } from "./live-step.ts";
import type { ThreadContext } from "./steps.ts";

// Milestone 10, ticket 03 (F-151): the live step, what the agent does this second while a turn
// runs, over the targets' recorded scenes and the states sheet's cells.

const contextOf = (scene: Scene): ThreadContext => ({ taskId: scene.taskId, checkoutDirs: ["calculator-web"], mcpServers: ["github"] });
const fold = (scene: Scene): TaskUIMessage[] => foldTaskEvents(scene.events, scene.liveText, { taskKind: scene.kind });
const turnOf = (scene: Scene, turnId: string): TaskUIMessage => {
  const turn = fold(scene).find((message) => message.metadata?.turnId === turnId);
  if (turn === undefined) throw new Error(`no turn ${turnId} in ${scene.name}`);
  return turn;
};
const liveOf = (scene: Scene, turnId: string) => liveStepOf(turnOf(scene, turnId), contextOf(scene));

describe("the live step", () => {
  it("F-151/c4: over S1-working it's running pnpm test history, 8 steps done, 1 failed, from the turn's start", () => {
    const live = liveOf(s1Working, calc192.turns.t1);
    expect(live).toEqual({ doing: { kind: "running", command: "pnpm test history" }, done: 8, failed: 1, planStep: null, startedAt: turnOf(s1Working, calc192.turns.t1).metadata?.at, waiting: null });
    // The clock reads 3:52 at the scene's moment.
    expect(s1Working.now - (live?.startedAt ?? 0)).toBe(3 * 60_000 + 52_000);
  });

  it("F-151/c4: over S5's build turn it names plan step 1 of 6, editing its file", () => {
    const live = liveOf(s5Approved, calc196.turns.build);
    expect(live?.planStep).toEqual({ index: 1, of: 6, entry: calc196Plan.approved[0] });
    expect(live?.doing).toEqual({ kind: "editing", path: "src/keys/shortcuts.ts" });
    expect(live?.done).toBe(3);
    expect(live?.failed).toBe(0);
    // 0:42 into the build turn.
    expect(s5Approved.now - (live?.startedAt ?? 0)).toBe(42_000);
  });

  it("F-151/c4: over a pending approval it's waiting, with its step, which leaves the run for the block", () => {
    const cell = stateCells.asks[1];
    const turn = turnOf(cell, sceneId("ce21", 0x101));
    const live = liveStepOf(turn, contextOf(cell));
    expect(live?.waiting).toMatchObject({ kind: "command", line: "pnpm db:migrate", state: "running", approval: { state: "pending" } });
    expect(live?.done).toBe(4);
    // The same step is the `needs` item after the closed run.
    const needs = turnItemsOf(turn, contextOf(cell)).at(-1);
    expect(needs?.kind === "needs" && needs.need.kind === "approval" ? needs.need.step : null).toEqual(live?.waiting);
  });

  it("F-151/c4: null for an ended turn, and while the turn waits on its question with nothing running", () => {
    for (const message of fold(s2).filter((one) => one.role === "assistant")) {
      expect(message.metadata?.turnState).toBe("ended");
      expect(liveStepOf(message, contextOf(s2))).toBeNull();
    }
    expect(liveStepOf(turnOf(stateCells.steps[3], sceneId("ce15", 0x101)), contextOf(stateCells.steps[3]))).toBeNull();
    // S1's turn waits on its question: the block stands at the turn's end, and no step runs. S5's
    // plan turn ended with its plan proposed, which waits as `tasks.get`'s plan.
    expect(turnOf(s1, calc192.turns.t1).metadata?.turnState).toBe("running");
    expect(liveOf(s1, calc192.turns.t1)).toBeNull();
    expect(liveOf(s5Plan, calc196.turns.plan)).toBeNull();
    // A member's message isn't a turn.
    const [first] = fold(s1);
    expect(first?.role).toBe("user");
    expect(first === undefined ? undefined : liveStepOf(first, contextOf(s1))).toBeNull();
  });

  it("F-151/c4: its words come from the part that runs: thinking, writing, and a reading of a member's file by its relative path", () => {
    const words = stateCells.steps[1];
    const doingOf = (scene: Scene): unknown => fold(scene).flatMap((message) => {
      const live = liveStepOf(message, contextOf(scene));
      return live === null ? [] : [[live.doing, live.done]];
    });
    expect(doingOf(words.thinking)).toEqual([[{ kind: "thinking" }, 0]]);
    expect(doingOf(words.writing)).toEqual([[{ kind: "writing" }, 11]]);
    expect(doingOf(words.readingAttachment)).toEqual([[{ kind: "reading", path: ".ostra/attachments/4/history-panel-mock.png", count: 1 }, 1]]);
    // A running command streams: still running, its output so far on its step.
    const streaming = fold(stateCells.steps[2]).flatMap((message) => {
      const live = liveStepOf(message, contextOf(stateCells.steps[2]));
      return live === null ? [] : [live];
    });
    expect(streaming.map((live) => [live.doing, live.done])).toEqual([[{ kind: "running", command: "pnpm test history" }, 3]]);
  });
});
