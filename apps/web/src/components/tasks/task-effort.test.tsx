import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { memberIdSchema } from "@ostra/protocol";
import type { EffortChangeData } from "@ostra/task-view";

import { t } from "@/lib/messages";
import { TurnUsage, clampText, turnUsageText } from "@/task/effort-marks";
import { createTaskIndexStore, TaskContext } from "@/task/task-context";
import { Divider } from "@/task/thread/divider";
import { dividerWords } from "@/task/thread/words";

import { ReasoningRow, TaskEffortRow, taskEffortView } from "./task-effort";
import type { TaskEffort } from "./task-effort";

/** The markup with apostrophes as typed, so a message reads as it is in `en.json`. */
const renderToStaticMarkup = (node: ReactElement): string => renderMarkup(node).replaceAll("&#x27;", "'");

// F-137: a task's effort (task-effort.md), each state of the target: the properties panel and the thread.

const deepseek = ["default", "low", "high", "max"] as const;
const driver = { driver: true, canTakeOver: false, finished: false };
const member = { driver: false, canTakeOver: true, finished: false };
const viewer = { driver: false, canTakeOver: false, finished: false };

const row = (effort: TaskEffort | null, who = driver, error: string | null = null): string =>
  renderToStaticMarkup(<TaskEffortRow effort={effort} viewer={who} onChange={() => undefined} onTakeOver={() => undefined} pending={false} error={error} />);

describe("the task's effort in the properties panel", () => {
  it("F-137/c8: the driver changed it during a turn: the new level, and the running turn's under it", () => {
    const effort = { level: "low", levels: deepseek, runningTurn: "max" } as const;
    expect(taskEffortView(effort, driver)).toEqual({ kind: "control", level: "low", levels: deepseek, runsAt: "max" });
    const html = row(effort);
    expect(html).toContain('data-testid="task-effort-trigger"');
    expect(html).toContain('data-level="low"');
    expect(html).toContain(t("tasks.effort.nextTurn"));
    expect(html).toContain("This turn runs at Max.");
  });

  it("F-137: between turns, or once the turn runs at the new level, no lines under the trigger", () => {
    expect(row({ level: "low", levels: deepseek, runningTurn: null })).not.toContain(t("tasks.effort.nextTurn"));
    expect(row({ level: "low", levels: deepseek, runningTurn: "low" })).not.toContain(t("tasks.effort.nextTurn"));
  });

  it("F-137: a member who isn't the driver reads the level, with Take over to change when they may", () => {
    const effort = { level: "high", levels: deepseek, runningTurn: null } as const;
    const html = row(effort, member);
    expect(html).not.toContain("task-effort-trigger");
    expect(html).toContain(">High<");
    expect(html).toContain(t("tasks.effort.takeOver"));
    expect(row(effort, viewer)).not.toContain(t("tasks.effort.takeOver"));
  });

  it("F-137: a model with no levels reads Default for everyone, and a finished task reads its level", () => {
    expect(taskEffortView({ level: "high", levels: ["default"], runningTurn: null }, driver)).toEqual({ kind: "text", level: "default", takeOver: false });
    expect(row({ level: "high", levels: ["default"], runningTurn: null })).toContain(">Default<");
    expect(taskEffortView({ level: "high", levels: deepseek, runningTurn: null }, { ...driver, finished: true })).toEqual({ kind: "text", level: "high", takeOver: false });
  });

  it("F-137: a failed change says why under the trigger", () => {
    expect(row({ level: "high", levels: deepseek, runningTurn: null }, driver, "The task ended.")).toContain("The effort didn't change. The task ended.");
  });

  it("F-137: loading is a skeleton", () => {
    expect(row(null)).toContain("animate-pulse");
  });

  it("F-137/c11: the Reasoning row sums the turns' reasoning tokens, or a dash", () => {
    expect(renderToStaticMarkup(<ReasoningRow tokens={19_000} />)).toContain("19k tokens");
    expect(renderToStaticMarkup(<ReasoningRow tokens={0} />)).toContain("—");
  });
});

describe("the task's effort in the thread", () => {
  const plain = { inputTokens: 48_000, outputTokens: 9_100, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false };
  const usage = { ...plain, reasoningTokens: 6_400 };

  it("F-137/c11: a turn's usage line carries its level and reasoning tokens", () => {
    expect(turnUsageText({ effort: "max", usage })).toBe("Max · 48k in · 9.1k out · 6.4k reasoning");
    expect(turnUsageText({ usage: plain })).toBe("48k in · 9.1k out");
    expect(turnUsageText({ effort: "default", usage: plain })).toBe("48k in · 9.1k out");
    expect(turnUsageText({ effort: "max" })).toBeNull();
  });

  it("F-137/c9: a clamped turn says what it ran at and why", () => {
    expect(clampText({ effort: "max", adjustedFrom: "xhigh" })).toBe("Ran at Max: this model has no Extra high.");
    expect(clampText({ adjustedFrom: "high" })).toBe(t("tasks.effort.ranAtDefault"));
    expect(clampText({ effort: "max" })).toBeNull();
    const html = renderToStaticMarkup(<TurnUsage meta={{ firstSeq: 1, lastSeq: 2, effort: "max", adjustedFrom: "xhigh", usage }} />);
    expect(html).toContain('data-part="turn-usage"');
    expect(html).toContain('data-part="turn-clamp"');
  });

  it("F-137/c8: the marker names who set which level, and from the next turn only during one", () => {
    const data: EffortChangeData = { from: "xhigh", to: "low", memberId: memberIdSchema.parse("01900000-0000-7000-8000-00000000a001"), duringTurn: true, at: Date.UTC(2026, 10, 19, 14, 11) };
    // Milestone 10 (ticket 12): the marker is a divider, `sliders-horizontal` and the time.
    const context = { nameOf: () => "Alex Kim", agent: "OpenCode", now: data.at };
    expect(dividerWords({ kind: "effort", change: data }, t, context).text).toBe("Alex Kim set effort to Low, from the next turn");
    expect(dividerWords({ kind: "effort", change: { ...data, duringTurn: false } }, t, context).text).toBe("Alex Kim set effort to Low");
    const html = renderToStaticMarkup(
      <TaskContext.Provider value={{ store: createTaskIndexStore(), memberName: () => "Alex Kim", agent: { name: "OpenCode", model: null }, approvalSummary: () => null }}>
        <Divider divider={{ kind: "effort", change: data }} now={data.at} />
      </TaskContext.Provider>,
    );
    expect(html).toContain('data-divider="effort"');
    expect(html).toMatch(/\d\d:\d\d/);
  });
});
