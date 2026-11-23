import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@ostra/api";
import { foldTaskEvents, turnItemsOf } from "@ostra/task-view";
import type { RunItem, RunStep, TaskUIMessage, ThreadContext, TurnItem, TurnSpend } from "@ostra/task-view";
import type { TurnId } from "@ostra/protocol";
import { calc192, calc192Spend, review483, review483Spend, s1, s3, sceneId, sceneMembers, stateCells } from "@ostra/task-view/testing";
import type { Scene } from "@ostra/task-view/testing";

import { TRPCProvider } from "@/lib/trpc";

import { toThreadMessageLike } from "../convert";
import { createTaskIndexStore, indexMessages, TaskContext } from "../task-context";
import type { TaskContextValue, TaskIndexStore } from "../task-context";
import { MessageView } from "../task-thread";
import { runOpenStoreOf } from "./run-open";
import { RunSteps } from "./run-steps";
import { ThreadParts } from "./thread-context";
import type { ThreadPartsValue } from "./thread-context";

// Milestone 10, ticket 10 (F-151/c2, c3, c8): a run's line, the opened run and failures. The
// targets' recorded scenes (`@ostra/task-view/testing`) through the real fold, drawn by the
// thread's own `MessageView` in assistant-ui's runtime as the task page draws them. What a press
// does is the thread's open-state store (`run-open.ts`), which the line's, the link's and the
// failure's buttons call: the test calls it as they do, then reads the markup the thread draws.
// The browser presses them for real in `e2e/27-thread-runs.spec.ts`.

const fail = (what: string): never => {
  throw new Error(`missing: ${what}`);
};

const names = new Map<string, string>(Object.values(sceneMembers).map((member) => [member.id, member.name]));
const contextOf = (scene: Scene): ThreadContext => ({ taskId: scene.taskId, checkoutDirs: ["calculator-web"], mcpServers: ["github"] });

type Spend = ReadonlyMap<TurnId, TurnSpend>;
const fold = (scene: Scene, turnSpend: Spend = new Map()): TaskUIMessage[] => foldTaskEvents(scene.events, scene.liveText, { taskKind: scene.kind, turnSpend });

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

/** A scene's thread, once its index store is made: the store keys the open runs, as on the page. */
type Drawn = { readonly store: TaskIndexStore; readonly messages: readonly TaskUIMessage[]; readonly draw: (children?: ReactNode) => string };

const thread = (scene: Scene, spend?: Spend): Drawn => {
  const messages = fold(scene, spend);
  const store = createTaskIndexStore();
  store.set(indexMessages(messages));
  const context: TaskContextValue = { store, memberName: (id) => names.get(id) ?? "", agent: { name: "OpenCode", model: "Claude Sonnet 5.5" }, approvalSummary: () => null, openSubagents: () => undefined };
  const parts: ThreadPartsValue = { taskKind: scene.kind, workspace: contextOf(scene), project: "calculator", capMicroUsd: 25_000_000, ciOf: () => null };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  const draw = (children?: ReactNode): string =>
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <TaskContext.Provider value={context}>
            <ThreadParts.Provider value={parts}>{children ?? <Thread messages={messages} />}</ThreadParts.Provider>
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
/** The words of the spans drawn in `--red`. */
const redWords = (html: string): string[] => [...html.matchAll(/<span class="[^"]*\btext-red\b[^"]*">([^<]*)<\/span>/g)].map((match) => decode(match[1] ?? ""));
/** A button's accessible name and words, by the start of its name. */
const buttonNamed = (html: string, name: string): string => elementAt(html, `aria-label="${name}`);

const turnOf = (drawn: Drawn, turnId: string): TaskUIMessage => drawn.messages.find((message) => message.metadata?.turnId === turnId) ?? fail(`turn ${turnId}`);
const itemsOf = (drawn: Drawn, scene: Scene, turnId: string): TurnItem[] => turnItemsOf(turnOf(drawn, turnId), contextOf(scene));
const runsOf = (drawn: Drawn, scene: Scene, turnId: string): RunItem[] => itemsOf(drawn, scene, turnId).flatMap((item) => (item.kind === "run" ? [item] : []));
const runAt = (drawn: Drawn, scene: Scene, turnId: string, n: number): RunItem => runsOf(drawn, scene, turnId)[n] ?? fail(`run ${String(n)}`);
/** A run's line as the thread draws it: the run's element, by its ID. */
const runLine = (html: string, run: RunItem): string => elementAt(html, `data-part="run" data-item="${run.id}"`);
const lineWords = (html: string, run: RunItem): string => textOf(elementAt(runLine(html, run), `data-part="run-words"`));
/** The rows of an opened run, in order. */
const rowsOf = (html: string, run: RunItem): string[] => elementsAt(elementAt(runLine(html, run), `data-part="run-steps"`), "data-step=");
const rowOf = (rows: readonly string[], kind: RunStep["kind"], n = 0): string => rows.filter((row) => row.includes(`data-step="${kind}"`))[n] ?? fail(`a ${kind} row`);

describe("a run's line and its failures", () => {
  it("F-151/c2: S1's lines read their counts and tail, red only on failed, and the recovered failure is only in the tail", () => {
    const drawn = thread(s1, calc192Spend.question);
    const html = drawn.draw();
    const [first, second] = runsOf(drawn, s1, calc192.turns.t1);
    expect(lineWords(html, first ?? fail("the first run"))).toBe("Thought for 6s, read 4 files");
    expect(redWords(runLine(html, first ?? fail("the first run")))).toEqual([]);
    const run = second ?? fail("the second run");
    expect(lineWords(html, run)).toBe("Edited 2 files, ran 2 commands, took a screenshot · 1 failed, then passed");
    expect(redWords(runLine(html, run))).toEqual(["failed"]);
    // A failure the turn recovered from has no line of its own, and the run's line is closed and quiet.
    expect(html).not.toContain(`data-part="failure"`);
    expect(runLine(html, run)).toContain(`aria-expanded="false"`);
    // The turn's time is on its first line only.
    expect(runLine(html, first ?? fail("the first run"))).toContain(`data-part="turn-time"`);
    expect(runLine(html, run)).not.toContain(`data-part="turn-time"`);
  });

  it("F-151/c2: S3's 23 steps are one line; the unrecovered fetch is its own red line, whose details › opens the run at the fetch with its details open", () => {
    const drawn = thread(s3, review483Spend);
    const closed = drawn.draw();
    const run = runAt(drawn, s3, review483.turns.t2, 0);
    expect(lineWords(closed, run)).toBe("23 steps: read 9 files, searched the web 3 times, fetched 1 page, ran 8 commands, used 2 tools");
    // Not recovered, so not in the tail: its own line, right under its run.
    expect(redWords(runLine(closed, run))).toEqual([]);
    const failure = elementAt(closed, `data-part="failure"`);
    expect(closed.indexOf(`data-part="failure"`)).toBeGreaterThan(closed.indexOf(`data-item="${run.id}"`));
    expect(textOf(failure)).toBe("Fetch failed" + "finance.acme.dev/rounding" + "· 403 Forbidden, not retried" + "details");
    expect(redWords(failure)).toEqual(["Fetch failed"]);
    expect(buttonNamed(failure, "Show the details of finance.acme.dev/rounding")).toContain("details");
    // Its link: the run opens at the fetch, the fetch's details open under its row.
    const fetch = run.steps.find((step) => step.kind === "fetch") ?? fail("the fetch");
    runOpenStoreOf(drawn.store).reveal(fetch.id);
    const opened = drawn.draw();
    expect(runLine(opened, run)).toContain(`aria-expanded="true"`);
    const row = rowOf(rowsOf(opened, run), "fetch");
    expect(redWords(row)).toEqual(["403 Forbidden"]);
    expect(textOf(elementAt(row, `data-part="step-output"`))).toContain("403 Forbidden");
    expect(textOf(buttonNamed(row, "Hide the details of finance.acme.dev/rounding"))).toBe("hide details");
    expect(runOpenStoreOf(drawn.store).get().focus).toBe(fetch.id);
    // Pressing the line again folds it, and what the failure opened in it.
    runOpenStoreOf(drawn.store).toggleRun(run);
    expect(runLine(drawn.draw(), run)).toContain(`aria-expanded="false"`);
  });

  it("F-151/c2: a cancelled step isn't red and isn't a failure; an unrecovered command, a failed turn and a limit each say so on their own line", () => {
    const scene = stateCells.steps[4];
    const drawn = thread(scene);
    const turns = drawn.messages.filter((message) => message.role === "assistant");
    const [built, , cancelled] = turns;
    const cancelledRun = turnItemsOf(cancelled ?? fail("turn 3"), contextOf(scene)).find((item): item is RunItem => item.kind === "run") ?? fail("turn 3's run");
    runOpenStoreOf(drawn.store).toggleRun(cancelledRun);
    const html = drawn.draw();
    // Turn 3's read was cancelled by the limit: `cancelled` in `--faint`, no red word, no failure line.
    expect(lineWords(html, cancelledRun)).toBe("Read 1 file");
    const read = rowOf(rowsOf(html, cancelledRun), "read");
    expect(read).toContain(`data-state="cancelled"`);
    expect(textOf(elementAt(read, `data-part="step-result"`))).toBe("cancelled");
    expect(redWords(runLine(html, cancelledRun))).toEqual([]);
    const failures = elementsAt(html, `data-part="failure"`);
    expect(failures.map(textOf)).toEqual(["Command failed" + "pnpm build" + "· exit 2 after 38 s" + "output", "The turn failed" + "· the model's provider answered 529 Overloaded"]);
    expect(failures.map(redWords)).toEqual([["Command failed"], ["The turn failed"]]);
    // A limit isn't an error: the quiet line, no red.
    const notice = elementAt(html, `data-part="notice"`);
    expect(textOf(notice)).toBe("Stopped at the session's 60-minute limit.");
    expect(redWords(notice)).toEqual([]);
    expect(built).toBeDefined();
  });
});

describe("a run, opened", () => {
  it("F-151/c3: pressing S1's line opens its rows in order with their results and links, the footer its last row", () => {
    const drawn = thread(s1, calc192Spend.question);
    const run = runAt(drawn, s1, calc192.turns.t1, 1);
    runOpenStoreOf(drawn.store).toggleRun(run);
    const html = drawn.draw();
    const line = runLine(html, run);
    expect(line).toContain(`aria-expanded="true"`);
    const steps = elementAt(line, `data-part="run-steps"`);
    expect(steps).toContain(`role="list"`);
    const rows = rowsOf(html, run).map(textOf);
    expect(rows).toEqual([
      "Edited" + "src/history/store.ts" + "+48",
      "Edited" + "src/history/panel.tsx" + "+118 −6",
      "Ran" + "pnpm test history" + "exit 1 · 4.1 s" + "output",
      "Thought" + "The empty history renders nothing; Dana's mock has an empty state for it.",
      "Edited" + "src/history/panel.tsx" + "+12 −2",
      "Ran" + "pnpm test history" + "✓ exit 0 · 3.8 s" + "output",
      "Captured" + "a screenshot of /history" + "web",
    ]);
    expect(redWords(rowOf(rowsOf(html, run), "command", 0))).toEqual(["exit 1"]);
    // The footer is the opened run's last row: the turn's numbers and the Event log.
    const footerAt = steps.indexOf(`data-part="run-footer"`);
    expect(footerAt).toBeGreaterThan(steps.lastIndexOf("data-step="));
    expect(textOf(elementAt(steps, `data-part="run-footer"`))).toContain("Turn 1");
  });

  it("F-151/c3: output › opens a command's output under its row and reads hide output ›, named for its step", () => {
    const drawn = thread(s1, calc192Spend.question);
    const run = runAt(drawn, s1, calc192.turns.t1, 1);
    const store = runOpenStoreOf(drawn.store);
    store.toggleRun(run);
    const before = rowOf(rowsOf(drawn.draw(), run), "command", 0);
    expect(textOf(buttonNamed(before, "Show the output of pnpm test history"))).toBe("output");
    expect(before).not.toContain(`data-part="step-output"`);
    store.toggleShown(run.steps.find((step) => step.kind === "command") ?? fail("the failing run"));
    const after = rowOf(rowsOf(drawn.draw(), run), "command", 0);
    expect(textOf(buttonNamed(after, "Hide the output of pnpm test history"))).toBe("hide output");
    expect(buttonNamed(after, "Hide the output of pnpm test history")).toContain(`aria-expanded="true"`);
    // The output itself, as text: the line it marks failed in `--red`, nothing else coloured.
    const output = elementAt(after, `data-part="step-output"`);
    expect(textOf(output)).toContain("panel renders an empty history");
    expect(redWords(output).every((line) => /^\s*✗/.test(line))).toBe(true);
    expect(redWords(output).length).toBeGreaterThan(0);
  });

  it("F-151/c3: a long path shows relative to the repo, by the files' names on a read row, the full value in title", () => {
    const drawn = thread(s1, calc192Spend.question);
    const [first, second] = runsOf(drawn, s1, calc192.turns.t1);
    const store = runOpenStoreOf(drawn.store);
    store.toggleRun(first ?? fail("the first run"));
    store.toggleRun(second ?? fail("the second run"));
    const html = drawn.draw();
    const edit = (second ?? fail("the second run")).steps.find((step) => step.kind === "edit") ?? fail("an edit");
    const subject = elementAt(rowOf(rowsOf(html, second ?? fail("the second run")), "edit", 0), `data-part="step-subject"`);
    expect(textOf(subject)).toBe("src/history/store.ts");
    expect(decode(/title="([^"]*)"/.exec(subject)?.[1] ?? "")).toBe(edit.fullSubject);
    expect(edit.fullSubject).not.toBe("src/history/store.ts");
    expect(edit.fullSubject.replace(/\\/g, "/").endsWith("/src/history/store.ts")).toBe(true);
    const read = (first ?? fail("the first run")).steps.find((step) => step.kind === "read") ?? fail("the reads");
    const reads = elementAt(rowOf(rowsOf(html, first ?? fail("the first run")), "read"), `data-part="step-subject"`);
    expect(textOf(reads).split(", ")).toHaveLength(4);
    expect(textOf(reads).split(", ").every((name) => !name.includes("/"))).toBe(true);
    expect(decode(/title="([^"]*)"/.exec(reads)?.[1] ?? "")).toBe(read.fullSubject);
  });

  it("F-151/c3: a running command's row turns a spinner, reads Running and its time so far, and its output streams under it", () => {
    const scene = stateCells.steps[2];
    const drawn = thread(scene);
    const turn = turnOf(drawn, sceneId("ce14", 0x101));
    const run = turnItemsOf(turn, contextOf(scene)).find((item): item is RunItem => item.kind === "run") ?? fail("the open run");
    const command = run.steps.find((step) => step.kind === "command") ?? fail("the running command");
    runOpenStoreOf(drawn.store).toggleShown(command);
    const html = drawn.draw(<RunSteps run={run} message={turn} />);
    const row = rowOf(elementsAt(html, "data-step="), "command");
    expect(row).toContain(`data-state="running"`);
    expect(row).toContain("animate-spin");
    expect(textOf(row)).toMatch(/^Running/);
    expect(textOf(buttonNamed(row, "Hide the output of pnpm test history"))).toBe("hide output");
    expect(textOf(elementAt(row, `data-part="step-output"`))).toContain("use puts a result back in the display");
  });
});

describe("tools by their names, ostra's in their own words, a capture by its own route", () => {
  it("F-151/c8: S3's MCP tool reads Used and its name, its server faint before it, other nowhere; Submitted the review, already submitted, kept as it was", () => {
    const drawn = thread(s3, review483Spend);
    const run = runAt(drawn, s3, review483.turns.t2, 0);
    runOpenStoreOf(drawn.store).toggleRun(run);
    const html = drawn.draw();
    const rows = rowsOf(html, run);
    const tool = rowOf(rows, "tool");
    expect(textOf(tool)).toBe("Used" + "github get_pull_request" + "input");
    expect(elementAt(tool, `data-part="step-subject"`)).toMatch(/<span class="[^"]*text-faint[^"]*">github<\/span>/);
    expect(rows.map(textOf).join("\n")).not.toMatch(/\bother\b/);
    expect(textOf(runLine(html, run))).not.toMatch(/\bother\b/);
    const ostra = rowOf(rows, "ostra");
    expect(textOf(ostra)).toBe("Submitted the review" + "already submitted, kept as it was");
    expect(redWords(ostra)).toEqual([]);
  });

  it("F-151/c8: S1's capture sits under the run that took it, captioned with its width and its own route", () => {
    const drawn = thread(s1, calc192Spend.question);
    const html = drawn.draw();
    const run = runAt(drawn, s1, calc192.turns.t1, 1);
    const captures = elementAt(html, `data-part="captures"`);
    expect(textOf(captures)).toBe("1280 · /history");
    // Under its run's line: the run's, then the strip, then the prose after them.
    const items = itemsOf(drawn, s1, calc192.turns.t1);
    const at = items.findIndex((item) => item.id === run.id);
    expect(items[at + 1]?.kind).toBe("captures");
    expect(html.indexOf(`data-part="captures"`)).toBeGreaterThan(html.indexOf(`data-item="${run.id}"`));
  });
});
