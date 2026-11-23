import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRouter } from "@ostra/api";
import { foldTaskEvents, liveStepOf, turnItemsOf } from "@ostra/task-view";
import type { RunItem, TaskUIMessage, ThreadContext } from "@ostra/task-view";
import { s1, s1Working, s5Approved, sceneMembers, stateCells } from "@ostra/task-view/testing";
import type { Scene } from "@ostra/task-view/testing";

import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";

import { toThreadMessageLike } from "../convert";
import { createTaskIndexStore, indexMessages, TaskContext } from "../task-context";
import type { TaskContextValue } from "../task-context";
import { MessageView } from "../task-thread";
import { ANNOUNCE_GAP_MS, createAnnouncer } from "./live-step";
import type { AnnounceGate } from "./live-step";
import { runOpenStoreOf } from "./run-open";
import { ThreadParts } from "./thread-context";
import type { ThreadPartsValue } from "./thread-context";
import { liveStepWords } from "./words";

// Milestone 10, ticket 11 (F-151/c4): the live step (parts.md part 5). The targets' recorded scenes
// through the real fold, drawn by the thread's own `MessageView` inside assistant-ui's runtime as the
// task page draws them, with the clock on fake timers (spec section 9, "Time"): S1 mid-turn reads
// its step, its progress and the clock, and ticks; its words reach a screen reader once per new
// step, never per tick, never twice within 10 s; prose closes the run into its line above it; a
// pending approval's step stands in the live step's place; S5's build turn names its plan step.

const names = new Map<string, string>(Object.values(sceneMembers).map((member) => [member.id, member.name]));
const contextOf = (scene: Scene): ThreadContext => ({ taskId: scene.taskId, checkoutDirs: ["calculator-web"], mcpServers: ["github"] });
const fold = (scene: Scene, events = scene.events, liveText = scene.liveText): TaskUIMessage[] => foldTaskEvents(events, liveText, { taskKind: scene.kind });

const Thread = ({ messages }: { readonly messages: readonly TaskUIMessage[] }) => {
  const runtime = useExternalStoreRuntime<TaskUIMessage>({ messages, convertMessage: toThreadMessageLike, isRunning: true, onNew: () => Promise.resolve() });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <ThreadPrimitive.Messages>{({ message }) => <MessageView id={message.id} fallbackRole={message.role} />}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
};

/** `index`: the thread's own index store, which keeps what the viewer opened (ticket 10's `run-open.ts`). */
const render = (scene: Scene, messages: readonly TaskUIMessage[], index = createTaskIndexStore()): string => {
  const store = index;
  store.set(indexMessages(messages));
  const context: TaskContextValue = { store, memberName: (id) => names.get(id) ?? "", agent: { name: "OpenCode", model: "Claude Sonnet 5.5" }, approvalSummary: () => null };
  const parts: ThreadPartsValue = { taskKind: scene.kind, workspace: contextOf(scene), project: "calculator", capMicroUsd: 25_000_000, ciOf: () => null };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Never called: a part that reads its own query renders without it.
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <TaskContext.Provider value={context}>
          <ThreadParts.Provider value={parts}>
            <Thread messages={messages} />
          </ThreadParts.Provider>
        </TaskContext.Provider>
      </TRPCProvider>
    </QueryClientProvider>,
  );
};

/** The markup of the element that opens with `marker`, up to its close. */
const elementAt = (html: string, marker: string): string => {
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`missing: ${marker}`);
  const open = html.lastIndexOf("<", at);
  const tags = /<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>/g;
  tags.lastIndex = open;
  let depth = 0;
  for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
    if (match[3] === "/" || ["img", "br", "input", "path", "line", "circle", "rect", "polyline"].includes(match[2] ?? "")) continue;
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(open, tags.lastIndex);
  }
  throw new Error(`unclosed: ${marker}`);
};

/** What the markup reads, as a person sees it: its text with one space for each run of white space. */
const textOf = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim();

/** The live step's line as drawn over a scene's log at the time now. */
const liveLineOf = (scene: Scene, messages = fold(scene)): string => textOf(elementAt(render(scene, messages), 'data-part="live-step"'));

/** What the live step would say to a screen reader over these events, now: `null` when no step runs. */
const announcementOf = (scene: Scene, events: Scene["events"]): string | null => {
  const turn = fold(scene, events).findLast((message) => message.role === "assistant");
  const live = turn === undefined ? null : liveStepOf(turn, contextOf(scene));
  return live === null ? null : liveStepWords(live, t, Date.now()).announcement;
};

describe("the live step (F-151/c4)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("F-151/c4: over S1 mid-turn it reads `Running pnpm test history · 8 steps done, 1 failed · 3:52`, in the open run's place, and ticks each second", () => {
    vi.setSystemTime(s1Working.now);
    const messages = fold(s1Working);
    const html = render(s1Working, messages);
    const live = elementAt(html, 'data-part="live-step"');
    expect(textOf(live)).toBe("Running pnpm test history · 8 steps done, 1 failed · 3:52");
    // A button that opens the run so far, closed; `failed` the one red word; its region polite.
    expect(live).toContain('aria-expanded="false"');
    expect(live).toMatch(/class="text-red">failed</);
    expect(live).toContain('aria-live="polite"');
    // In the open run's place: the turn's first run is a line, the second is the live step.
    expect(html.match(/data-part="run"/g)).toHaveLength(1);
    expect(html.indexOf('data-part="run"')).toBeLessThan(html.indexOf('data-part="live-step"'));
    // The clock is the turn's, `m:ss` from its start: a second later it reads one more.
    vi.advanceTimersByTime(1_000);
    expect(liveLineOf(s1Working, messages)).toBe("Running pnpm test history · 8 steps done, 1 failed · 3:53");
    vi.advanceTimersByTime(7_000);
    expect(liveLineOf(s1Working, messages)).toBe("Running pnpm test history · 8 steps done, 1 failed · 4:00");
  });

  it("F-151/c4: pressed, it opens the run so far, which stays open once the run closes into its line", () => {
    vi.setSystemTime(s1Working.now);
    const index = createTaskIndexStore();
    const messages = fold(s1Working);
    const turn = messages.findLast((message) => message.role === "assistant");
    const run = turn === undefined ? undefined : turnItemsOf(turn, contextOf(s1Working)).find((item): item is RunItem => item.kind === "run" && item.open);
    if (run === undefined) throw new Error("S1 mid-turn has an open run");
    expect(elementAt(render(s1Working, messages, index), 'data-part="live-step"')).not.toContain('data-part="run-steps"');
    // The press is the store call the line's button makes.
    runOpenStoreOf(index).toggleRun(run);
    const live = elementAt(render(s1Working, messages, index), 'data-part="live-step"');
    expect(live).toContain('aria-expanded="true"');
    expect(live).toContain(`aria-controls="steps-${run.id}"`);
    const steps = elementAt(live, 'data-part="run-steps"');
    // The run so far: two edits, the failed run, the thought, the fix, and the test running again.
    expect(steps.match(/data-step="/g)).toHaveLength(run.steps.length);
    expect(steps).toContain('data-step="command" data-state="running"');
    // The run closes into its line (S1, eight minutes later): the line is open where the live step was.
    vi.setSystemTime(s1.now);
    const closed = render(s1, fold(s1), index);
    expect(elementAt(closed, `data-part="run" data-item="${run.id}"`)).toContain('data-open="true"');
  });

  it("F-151/c4: its live region says a new step once, never a tick, and nothing twice within 10 s", () => {
    vi.setSystemTime(s1Working.now);
    const said: string[] = [];
    const gate: AnnounceGate = { last: null };
    const announcer = createAnnouncer((words) => { said.push(words); }, { now: () => Date.now(), set: (run, ms) => setTimeout(run, ms), clear: (handle) => { clearTimeout(handle); } }, gate);
    const tell = (events: Scene["events"]): void => {
      const words = announcementOf(s1, events);
      if (words !== null) announcer.words(words);
    };
    // S1 mid-turn, ticking for five seconds: its step is said once.
    for (let second = 0; second < 5; second += 1) {
      tell(s1Working.events);
      vi.advanceTimersByTime(1_000);
    }
    expect(said).toEqual(["Running pnpm test history · 8 steps done, 1 failed"]);
    // The test run passes, then the screenshot starts: two new steps within 10 s of the first. Only
    // the newest is said, once the 10 s are up.
    const next = s1Working.events.length;
    tell(s1.events.slice(0, next + 1));
    expect(announcementOf(s1, s1.events.slice(0, next + 1))).toBe("Thinking · 9 steps done");
    vi.advanceTimersByTime(1_000);
    tell(s1.events.slice(0, next + 2));
    expect(said).toHaveLength(1);
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS - 6_000 - 1);
    expect(said).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["Running pnpm test history · 8 steps done, 1 failed", "Capturing /history · 9 steps done"]);
    // Ticking on the same step says nothing more.
    for (let second = 0; second < 15; second += 1) {
      tell(s1.events.slice(0, next + 2));
      vi.advanceTimersByTime(1_000);
    }
    expect(said).toHaveLength(2);
    // A live step that starts under new prose shares the page's 10 s: its first words wait their turn.
    const after = createAnnouncer((words) => { said.push(words); }, { now: () => Date.now(), set: (run, ms) => setTimeout(run, ms), clear: (handle) => { clearTimeout(handle); } }, gate);
    gate.last = Date.now();
    after.words("Writing · 10 steps done");
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS - 1);
    expect(said).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(said.at(-1)).toBe("Writing · 10 steps done");
    // Stopped (the step's line unmounted), a waiting step is never said.
    after.words("Thinking · 10 steps done");
    after.stop();
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    expect(said).toHaveLength(3);
  });

  it("F-151/c4: a text part arriving closes the run into its line above it, and a new live step starts under it", () => {
    const writing = stateCells.steps[1].writing;
    vi.setSystemTime(writing.now);
    // Before the agent writes: the turn is in its run, so the live step stands in the run's place.
    const before = render(writing, fold(writing, writing.events, []));
    expect(before).not.toContain('data-part="run"');
    expect(before).not.toContain('data-part="prose"');
    expect(textOf(elementAt(before, 'data-part="live-step"'))).toBe("Thinking · 11 steps done · 5:10");
    // The text arrives: the run's line, the prose under it, then the live step, `Writing`.
    const after = render(writing, fold(writing));
    const [run, prose, live] = ['data-part="run"', 'data-part="prose"', 'data-part="live-step"'].map((marker) => after.indexOf(marker));
    expect(run).toBeGreaterThan(-1);
    expect(run).toBeLessThan(prose ?? -1);
    expect(prose).toBeLessThan(live ?? -1);
    expect(after.match(/data-part="live-step"/g)).toHaveLength(1);
    expect(textOf(elementAt(after, 'data-part="run"'))).toMatch(/^Read 5 files, edited 3, ran 2 commands/);
    expect(textOf(elementAt(after, 'data-part="live-step"'))).toBe("Writing · 11 steps done · 5:10");
  });

  it("F-151/c4: a pending approval's step stands in the live step's place, still, with the block under it", () => {
    const asking = stateCells.asks[1];
    vi.setSystemTime(asking.now);
    const html = render(asking, fold(asking));
    expect(html).not.toContain('data-part="live-step"');
    const step = elementAt(html, 'data-part="asking-step"');
    expect(textOf(step)).toMatch(/^Wants to run pnpm db:migrate needs approval/);
    // Still: `pause` in the spinner's place, no spinner turns.
    expect(step).toContain("lucide-pause");
    expect(step).not.toContain("animate-spin");
    // After the run before it, the run's line above.
    expect(html.indexOf('data-part="run"')).toBeLessThan(html.indexOf('data-part="asking-step"'));
  });

  it("F-151/c4: S5's build turn names the plan step in progress", () => {
    vi.setSystemTime(s5Approved.now);
    expect(liveLineOf(s5Approved)).toBe("Editing src/keys/shortcuts.ts · Plan step 1 of 6: Add src/keys/shortcuts.ts: a map from keys to the keypad's actions · 3 steps done · 0:42");
  });
});
