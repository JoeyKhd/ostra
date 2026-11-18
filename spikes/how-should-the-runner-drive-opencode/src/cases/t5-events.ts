// T5 Event completeness: a scripted ticket produces tool_call with rawInput
// and tool_call_update with output for read, edit, shell and a failing tool;
// diff content for an edit; plan; child-session _meta for a subagent;
// usage_update with cost; /compact markers; stopReason. Records events and
// bytes per minute.

import { textPrompt, type DriverEvent } from "../lib/acp-driver.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, newSession, stubCallsFor, waitForEvent, withTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { check, fail, type Check, type Criterion } from "../harness/report.ts";

type Update = Extract<DriverEvent, { kind: "session_update" }>["update"];
type ToolCall = Extract<Update, { sessionUpdate: "tool_call" }>;
type ToolCallUpdate = Extract<Update, { sessionUpdate: "tool_call_update" }>;

const updates = (events: readonly DriverEvent[]): Update[] => events.flatMap((e) => (e.kind === "session_update" ? [e.update] : []));

const toolNameOf = (update: Update): string => {
  if (update.sessionUpdate !== "tool_call") return "";
  return `${update.title} ${update.kind ?? ""}`.toLowerCase();
};

export type EventRate = { readonly eventsPerMinute: number; readonly bytesPerMinute: number; readonly events: number; readonly seconds: number };

export const rateOf = (events: readonly DriverEvent[], bytes: number): EventRate => {
  const first = events[0]?.at ?? 0;
  const last = events.at(-1)?.at ?? first;
  const seconds = Math.max(1, (last - first) / 1000);
  return { events: events.length, seconds, eventsPerMinute: Math.round((events.length / seconds) * 60), bytesPerMinute: Math.round((bytes / seconds) * 60) };
};

export const t5Events = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number> = {};
  try {
    await withTask(ctx, { name: "t5", upstream: { kind: "stub", format: "anthropic" }, experimental: { todo: true } }, async (task) => {
      const sessionId = await newSession(task);
      const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("t5")} work the scripted ticket`)), 180_000, "t5 turn");
      // The subagent runs in the background; give its updates time to land.
      await waitForEvent(
        task.driver,
        (e) => e.kind === "session_update" && e.update._meta?.["opencode/child-session"] !== undefined,
        30_000,
        "a child-session update",
      ).catch(() => undefined);
      const compact = await withTimeout(task.driver.prompt(sessionId, textPrompt("/compact")), 120_000, "/compact");
      await ctx.save("t5-events.json", task.driver.events);
      await ctx.save(
        "t5-stub-calls.json",
        stubCallsFor(ctx, task, "anthropic").map((c) => ({ model: c.model, tools: c.tools, messages: c.messages.map((m) => ({ role: m.role, text: m.text.slice(0, 4000) })) })),
      );

      const all = updates(task.driver.events);
      const calls = all.filter((u): u is ToolCall => u.sessionUpdate === "tool_call");
      const callUpdates = all.filter((u): u is ToolCallUpdate => u.sessionUpdate === "tool_call_update");
      const finished = (id: string): ToolCallUpdate | undefined => callUpdates.find((u) => u.toolCallId === id && (u.status === "completed" || u.status === "failed"));
      const hasOutput = (u: ToolCallUpdate | undefined): boolean => u !== undefined && ((u.content?.length ?? 0) > 0 || u.rawOutput !== undefined);

      // OpenCode sends rawInput on the first in_progress update, not on the tool_call itself.
      const inputOf = (id: string): string =>
        JSON.stringify(callUpdates.find((u) => u.toolCallId === id && u.rawInput !== undefined && JSON.stringify(u.rawInput) !== "{}")?.rawInput ?? {});
      const toolCheck = (label: string, match: (u: ToolCall, input: string) => boolean, wantFailed: boolean): void => {
        const call = calls.find((u) => match(u, inputOf(u.toolCallId)));
        if (call === undefined) {
          checks.push(fail(`tool_call and tool_call_update for ${label}`, "no matching tool_call"));
          return;
        }
        const done = finished(call.toolCallId);
        const status = done?.status;
        const rawInput = inputOf(call.toolCallId) !== "{}";
        checks.push(
          check(
            `tool_call with rawInput and tool_call_update with output for ${label}`,
            rawInput && hasOutput(done) && (wantFailed ? status === "failed" : status === "completed"),
            `kind=${call.kind ?? "?"}, rawInput ${rawInput ? "yes" : "no"}, final status ${status ?? "none"}, output ${hasOutput(done) ? "yes" : "no"}`,
          ),
        );
      };
      toolCheck("read", (u, input) => u.kind === "read" && !input.includes("does-not-exist"), false);
      toolCheck("edit", (u) => u.kind === "edit", false);
      toolCheck("shell", (u) => u.kind === "execute", false);
      toolCheck("a failing tool", (_u, input) => input.includes("does-not-exist"), true);

      const diff = [...calls, ...callUpdates].some((u) => (u.content ?? []).some((c) => c.type === "diff"));
      checks.push(check("diff content for an edit", diff, diff ? "a diff content block arrived" : "no diff content on any tool call"));

      const plan = all.some((u) => u.sessionUpdate === "plan" || u.sessionUpdate === "plan_update");
      const todo = calls.some((u) => toolNameOf(u).includes("todowrite"));
      checks.push(
        check(
          "plan",
          plan,
          plan
            ? "a plan update arrived"
            : `no plan or plan_update from OpenCode ${task.binary.packageVersion}, even with the plan capability advertised; ${todo ? "the todo list arrives only as a todowrite tool call (experimental.todo), in rawInput.todos and rawOutput.metadata.todos" : "no todowrite tool call either"}`,
        ),
      );

      const child = task.driver.events.find((e) => e.kind === "session_update" && e.update._meta?.["opencode/child-session"] !== undefined);
      checks.push(check("child-session _meta for a subagent", child !== undefined, child === undefined ? "no update carried _meta[\"opencode/child-session\"]" : "child-session updates arrived on the parent session"));

      const usage = all.find((u) => u.sessionUpdate === "usage_update" && u.cost !== undefined && u.cost !== null);
      checks.push(
        check("usage_update with cost", usage !== undefined, usage?.sessionUpdate === "usage_update" ? `used=${String(usage.used)}, size=${String(usage.size)}, cost=${JSON.stringify(usage.cost)}` : "no usage_update with cost"),
      );

      const compaction = all.filter((u) => u.sessionUpdate === "compaction_update" || u.sessionUpdate === "compaction_summary_chunk" || (u.sessionUpdate === "session_info_update" && JSON.stringify(u).includes("compaction")));
      checks.push(check("/compact compaction markers", compaction.length > 0, `${String(compaction.length)} compaction updates; /compact stopReason=${compact.stopReason}`));

      checks.push(check("stopReason", response.stopReason === "end_turn", `stopReason=${response.stopReason}`));

      const rate = rateOf(task.driver.events, task.driver.wire().inboundBytes);
      recorded["events (stub)"] = rate.events;
      recorded["events per minute (stub, scripted)"] = rate.eventsPerMinute;
      recorded["bytes per minute (stub, scripted)"] = rate.bytesPerMinute;
      recorded["session updates on the wire / in the log"] = `${String(task.driver.wire().inboundSessionUpdates)} / ${String(all.length)}`;
      checks.push(
        check(
          "every session/update on the wire reached the event log",
          task.driver.wire().inboundSessionUpdates === all.length,
          `${String(task.driver.wire().inboundSessionUpdates)} on the wire, ${String(all.length)} in the log`,
        ),
      );
    });
  } catch (error) {
    checks.push(fail("the scripted ticket", errorMessage(error)));
  }
  return [{ id: "T5", title: "Event completeness: tool calls with input and output, diff, plan, child sessions, usage with cost, compaction, stopReason.", checks, recorded }];
};
