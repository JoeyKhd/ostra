import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRouter } from "@ostra/api";
import type { TurnId } from "@ostra/protocol";
import { foldTaskEvents, turnItemsOf } from "@ostra/task-view";
import type { RunItem, TaskUIMessage, ThreadContext, TurnSpend } from "@ostra/task-view";
import { calc192, calc192Spend, review483, review483Spend, s1, s2, s3, sceneMembers, sceneTime } from "@ostra/task-view/testing";
import type { Scene } from "@ostra/task-view/testing";

import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";

import { toThreadMessageLike } from "../convert";
import { createTaskIndexStore, indexMessages, TaskContext } from "../task-context";
import type { TaskContextValue, TaskIndexStore } from "../task-context";
import { MessageView } from "../task-thread";
import { runOpenStoreOf } from "./run-open";
import { ThreadParts } from "./thread-context";
import type { ThreadPartsValue } from "./thread-context";
import { createTipControl, TIP_HOVER_MS, TIP_LEAVE_MS, TurnTip } from "./turn-numbers";
import { tooltipRows } from "./words";

// Milestone 10, ticket 16 (F-151/c3; parts.md parts 6 and 9, the README's choices 1 and 2): a
// turn's numbers are in the opened run's footer and in a tooltip on the turn's time, never a line
// of the column. The targets' recorded scenes (`@ostra/task-view/testing`) through the real fold,
// drawn by the thread's own `MessageView` in assistant-ui's runtime as the task page draws them;
// a run is opened through the store its line's button calls. The tooltip's timing is
// `createTipControl`'s, under fake timers; the browser hovers and tabs to it for real in
// `e2e/27-thread-numbers.spec.ts`.

const fail = (what: string): never => {
  throw new Error(`missing: ${what}`);
};

const names = new Map<string, string>(Object.values(sceneMembers).map((member) => [member.id, member.name]));
const contextOf = (scene: Scene): ThreadContext => ({ taskId: scene.taskId, checkoutDirs: ["calculator-web"], mcpServers: ["github"] });

type Spend = ReadonlyMap<TurnId, TurnSpend>;

const Thread = ({ messages }: { readonly messages: readonly TaskUIMessage[] }) => {
  const runtime = useExternalStoreRuntime<TaskUIMessage>({ messages, convertMessage: toThreadMessageLike, isRunning: false, onNew: () => Promise.resolve() });
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

type Drawn = { readonly store: TaskIndexStore; readonly messages: readonly TaskUIMessage[]; readonly draw: () => string };

/** A scene's thread as the task page draws it, for a task of `kind` (a scene read as another kind's shows what that kind keeps). */
const thread = (scene: Scene, spend: Spend, kind: Scene["kind"] = scene.kind): Drawn => {
  const messages = foldTaskEvents(scene.events, scene.liveText, { taskKind: kind, turnSpend: spend });
  const store = createTaskIndexStore();
  store.set(indexMessages(messages));
  const context: TaskContextValue = { store, memberName: (id) => names.get(id) ?? "", agent: { name: "OpenCode", model: "Claude Sonnet 5.5" }, approvalSummary: () => null, openSubagents: () => undefined };
  const parts: ThreadPartsValue = { taskKind: kind, workspace: contextOf(scene), project: "calculator", capMicroUsd: 25_000_000, ciOf: () => null };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  const draw = (): string =>
    renderToStaticMarkup(
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
  return { store, messages, draw };
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

/** Every element that opens with `marker`, in order. */
const elementsAt = (html: string, marker: string): string[] => {
  const found: string[] = [];
  for (let at = html.indexOf(marker); at !== -1; at = html.indexOf(marker, at + marker.length)) found.push(elementAt(html.slice(html.lastIndexOf("<", at)), marker));
  return found;
};

const decode = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** What a reader sees of some markup: its text, tags gone. */
const textOf = (html: string): string => decode(html.replace(/<[^>]+>/g, ""));
/** Markup's words with each tag a gap, the gaps one space: a tooltip row reads `Tokens 22.4k in · 3.8k out`. */
const wordsOf = (html: string): string => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const turnOf = (drawn: Drawn, turnId: string): TaskUIMessage => drawn.messages.find((message) => message.metadata?.turnId === turnId) ?? fail(`turn ${turnId}`);
const runsOf = (drawn: Drawn, scene: Scene, turnId: string): RunItem[] => turnItemsOf(turnOf(drawn, turnId), contextOf(scene)).flatMap((item) => (item.kind === "run" ? [item] : []));
const runLine = (html: string, run: RunItem): string => elementAt(html, `data-part="run" data-item="${run.id}"`);
/** The opened run's footer: its facts as they read, and where `Event log ›` goes. */
const footerOf = (html: string, run: RunItem): { readonly facts: string; readonly href: string } => {
  const footer = elementAt(runLine(html, run), `data-part="run-footer"`);
  return { facts: textOf(elementAt(footer, `data-part="footer-facts"`)), href: decode(/href="([^"]*)"/.exec(footer)?.[1] ?? "") };
};
/** A turn's tooltip as its time shows it (`TurnTip` over `tooltipRows`, the words `TurnTime` hands it): its head and its rows. */
const tipOf = (message: TaskUIMessage, kind: Scene["kind"]): { readonly tip: string; readonly head: string; readonly rows: string[] } => {
  const tip = renderToStaticMarkup(<TurnTip id="tip" tip={tooltipRows(message.metadata ?? fail("the turn's meta"), kind, t)} />);
  return { tip, head: textOf(elementAt(tip, `data-part="tip-head"`)), rows: elementsAt(tip, `data-part="tip-row"`).map(wordsOf) };
};

/** What the key proxy counted for a turn, as `tasks.get`'s `usage.turns` sums it: its calls' tokens, and its price. */
const countedOf = (scene: Scene, turnId: TurnId, spend: Spend): { readonly input: number; readonly output: number; readonly reasoning: number; readonly microUsd: number } => {
  let inTurn = false;
  const counted = { input: 0, output: 0, reasoning: 0 };
  for (const { event } of scene.events) {
    if (event.kind === "turn.started") inTurn = event.turnId === turnId;
    else if (event.kind === "turn.ended" || event.kind === "turn.failed") inTurn = inTurn && event.turnId !== turnId;
    else if (event.kind === "usage.recorded" && inTurn) {
      counted.input += event.inputTokens;
      counted.output += event.outputTokens;
      counted.reasoning += event.reasoningTokens ?? 0;
    }
  }
  return { ...counted, microUsd: spend.get(turnId)?.microUsd ?? fail("the turn's spend") };
};

/** A scene's clock time as the panel shows it, in this machine's zone. */
const clock = (time: string): string => formatClock(sceneTime(time));

/** `22400` as the thread writes a count of tokens: `22.4k`. */
const short = (n: number): string => `${String(Number((n / 1_000).toFixed(1)))}k`;

/** The seq of a turn's first event: its `turn.started`. */
const firstSeqOf = (scene: Scene, turnId: TurnId): number => scene.events.find(({ event }) => event.kind === "turn.started" && event.turnId === turnId)?.seq ?? fail("the turn's start");

describe("the opened run's footer", () => {
  it("F-151/c3: S4's footer reads its facts in order, each kept whole, with Event log › to the turn's first seq; every run of the turn shows the same footer", () => {
    const drawn = thread(s1, calc192Spend.question);
    const [first, second] = runsOf(drawn, s1, calc192.turns.t1);
    const runs = [first ?? fail("the first run"), second ?? fail("the second run")];
    // Closed, no run shows its footer: the numbers aren't a line of the column.
    expect(drawn.draw()).not.toContain(`data-part="run-footer"`);
    for (const run of runs) runOpenStoreOf(drawn.store).toggleRun(run);
    const html = drawn.draw();
    const footers = runs.map((run) => footerOf(html, run));
    expect(footers[0]).toEqual({ facts: "Turn 1 · High · 41.2k in · 6.3k out · 2.1k reasoning · $0.62 so far · not saved yet", href: `?tab=events&seq=${String(firstSeqOf(s1, calc192.turns.t1))}` });
    expect(footers[1]).toEqual(footers[0]);
    // The footer is the opened run's last row; each fact and the ` ·` after it never part, the row breaking only between facts.
    const steps = elementAt(runLine(html, runs[1] ?? fail("the run")), `data-part="run-steps"`);
    expect(steps.lastIndexOf(`data-part="run-footer"`)).toBeGreaterThan(steps.lastIndexOf(`data-step=`));
    const facts = elementAt(steps, `data-part="footer-facts"`);
    expect(elementsAt(facts, `class="whitespace-nowrap"`).map(textOf)).toEqual(["Turn 1 ·", "High ·", "41.2k in ·", "6.3k out ·", "2.1k reasoning ·", "$0.62 so far ·", "not saved yet"]);
  });

  it("F-151/c3: a review task's footer has no saved fact", () => {
    const review = thread(s3, review483Spend);
    const [run] = runsOf(review, s3, review483.turns.t2);
    const opened = run ?? fail("turn 2's run");
    runOpenStoreOf(review.store).toggleRun(opened);
    expect(footerOf(review.draw(), opened).facts).toBe("Turn 2 · Max · 13.4k in · 2.6k out · 1.6k reasoning · $0.19");
    // The same turn in a code task's thread says what was kept.
    const code = thread(s3, review483Spend, "code");
    const [same] = runsOf(code, s3, review483.turns.t2);
    runOpenStoreOf(code.store).toggleRun(same ?? fail("turn 2's run"));
    expect(footerOf(code.draw(), same ?? fail("turn 2's run")).facts).toContain("saved, archive 97 kB");
  });
});

describe("the tooltip on a turn's time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The control on the browser's timers, faked: what it shows, as it changes. */
  const controlled = () => {
    const shown: boolean[] = [];
    const control = createTipControl((open) => { shown.push(open); }, { set: (run, ms) => setTimeout(run, ms), clear: (handle) => { clearTimeout(handle); } });
    return { control, open: () => shown.at(-1) ?? false, shown };
  };

  it("F-151/c3: hovering S2's turn 4 time shows its tooltip after 300 ms, focus shows it at once, Escape closes it", () => {
    // S2's turn 4 time: focusable, its tooltip not in the page until it shows (the numbers are never the column's text).
    const drawn = thread(s2, calc192Spend.pr);
    const runs = runsOf(drawn, s2, calc192.turns.t4);
    const html = drawn.draw();
    const time = elementAt(runLine(html, runs[0] ?? fail("turn 4's run")), `data-part="turn-time"`);
    expect(textOf(time)).toBe(clock("14:44"));
    expect(time).toContain(`tabindex="0"`);
    expect(html).not.toContain(`role="tooltip"`);
    const { tip, head } = tipOf(turnOf(drawn, calc192.turns.t4), "code");
    expect(tip).toContain(`role="tooltip"`);
    expect(head).toBe(`Turn 4 · ${clock("14:44")} to ${clock("14:47")}`);
    // Its time is on the turn's first line only.
    expect(runs.slice(1).every((run) => !runLine(html, run).includes(`data-part="turn-time"`))).toBe(true);

    // Hover: nothing for 299 ms, then the tooltip.
    const hover = controlled();
    hover.control.enter();
    vi.advanceTimersByTime(TIP_HOVER_MS - 1);
    expect(hover.open()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(hover.open()).toBe(true);
    // Leaving the time, the pointer has a moment to reach the tooltip; on it, the tooltip stays.
    hover.control.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS - 1);
    hover.control.enter();
    vi.advanceTimersByTime(TIP_LEAVE_MS);
    expect(hover.open()).toBe(true);
    // Gone from both, it closes.
    hover.control.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS);
    expect(hover.open()).toBe(false);
    // A pointer that passes over in less than 300 ms shows nothing.
    hover.control.enter();
    vi.advanceTimersByTime(TIP_HOVER_MS - 50);
    hover.control.leave();
    vi.advanceTimersByTime(TIP_HOVER_MS);
    expect(hover.shown).toEqual([true, false]);

    // Focus: at once; Escape closes it, the focus still there; the pointer leaving doesn't close a focused one.
    const focus = controlled();
    focus.control.focus();
    expect(focus.open()).toBe(true);
    focus.control.enter();
    focus.control.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS * 2);
    expect(focus.open()).toBe(true);
    focus.control.escape();
    expect(focus.open()).toBe(false);
    // Escape holds until the focus or the pointer comes back.
    vi.advanceTimersByTime(TIP_HOVER_MS * 2);
    expect(focus.open()).toBe(false);
    focus.control.blur();
    focus.control.focus();
    expect(focus.open()).toBe(true);
    focus.control.blur();
    expect(focus.open()).toBe(false);
  });

  it("F-151/c3: S2's turn 4: the tooltip's numbers equal the footer's and usage.turns' for that turn", () => {
    const drawn = thread(s2, calc192Spend.pr);
    const [run] = runsOf(drawn, s2, calc192.turns.t4);
    const opened = run ?? fail("turn 4's run");
    runOpenStoreOf(drawn.store).toggleRun(opened);
    const html = drawn.draw();
    const { rows } = tipOf(turnOf(drawn, calc192.turns.t4), "code");
    expect(rows).toEqual(["Effort High", "Tokens 22.4k in · 3.8k out", "Reasoning 1.1k", "Spend $0.31", "Saved archive 193 kB"]);
    // The footer says the same numbers in the same words.
    expect(footerOf(html, opened).facts).toBe("Turn 4 · High · 22.4k in · 3.8k out · 1.1k reasoning · $0.31 · saved, archive 193 kB");
    // And they're what the key proxy counted for the turn, as `tasks.get`'s `usage.turns` gives it.
    const counted = countedOf(s2, calc192.turns.t4, calc192Spend.pr);
    expect(rows[1]).toBe(`Tokens ${short(counted.input)} in · ${short(counted.output)} out`);
    expect(rows[2]).toBe(`Reasoning ${short(counted.reasoning)}`);
    expect(rows[3]).toBe(`Spend $${(counted.microUsd / 1_000_000).toFixed(2)}`);
  });
});
