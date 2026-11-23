import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@ostra/api";
import { foldTaskEvents, turnItemsOf, turnOrdinalsOf, turnSpendOf } from "@ostra/task-view";
import type { TaskUIMessage, ThreadContext, TurnItem, TurnItemKind } from "@ostra/task-view";
import { calc192, calc192Spend, s2, sceneMembers, stateCells } from "@ostra/task-view/testing";
import type { Scene } from "@ostra/task-view/testing";

import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";

import { toThreadMessageLike } from "../convert";
import { createTaskIndexStore, indexMessages, TaskContext } from "../task-context";
import type { TaskContextValue } from "../task-context";
import { MessageView } from "../task-thread";
import { ThreadParts } from "./thread-context";
import type { ThreadPartsValue } from "./thread-context";
import { pricedTurnsOf } from "./turn-spend";

// Milestone 10, ticket 09 (F-151/c1): the thread's frame. The targets' recorded scenes
// (`@ostra/task-view/testing`) through the real fold, drawn by the thread's own `MessageView` inside
// assistant-ui's runtime, as the task page draws them: the column holds what a member reads, the
// agent's prose bare, every item through its part, and no bookkeeping row or token line.

const names = new Map<string, string>(Object.values(sceneMembers).map((member) => [member.id, member.name]));
const contextOf = (scene: Scene): ThreadContext => ({ taskId: scene.taskId, checkoutDirs: ["calculator-web"], mcpServers: ["github"] });

const fold = (scene: Scene, spend: Parameters<typeof turnSpendOf>[0] = []): TaskUIMessage[] =>
  foldTaskEvents(scene.events, scene.liveText, { taskKind: scene.kind, turnSpend: turnSpendOf(spend), turnOrdinals: turnOrdinalsOf(spend) });

/** The scene's messages as the task page's thread draws them, each through `MessageView`. */
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

const render = (scene: Scene, messages: readonly TaskUIMessage[]): string => {
  const store = createTaskIndexStore();
  store.set(indexMessages(messages));
  const context: TaskContextValue = { store, memberName: (id) => names.get(id) ?? "", agent: { name: "OpenCode", model: "Claude Sonnet 5.5" }, approvalSummary: () => null };
  const parts: ThreadPartsValue = { taskKind: scene.kind, workspace: contextOf(scene), project: "calculator", capMicroUsd: 25_000_000, ciOf: () => ({ state: "running", jobs: { done: 2, total: 4 }, failingJobs: [] }) };
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

/** The markup of the element that opens with `marker`, up to its close: one message, one item. */
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

/** The part each item kind is drawn by (`data-part` on the part's root). */
const partOf = (item: TurnItem): string => {
  switch (item.kind) {
    case "run":
      return item.open ? "live-step" : "run";
    case "prose":
      return "prose";
    case "captures":
      return "captures";
    case "failure":
      return "failure";
    case "notice":
      return "notice";
    case "result":
      return item.result.kind === "pr" ? "pr-card" : "result";
    case "needs":
      return item.need.kind === "approval" ? "asking-step" : item.open ? "question" : "receipt";
    default:
      return item satisfies never;
  }
};

/** Each item of the scene's messages is in the markup, drawn by its own part; returns the kinds seen. */
const expectEveryItemDrawn = (scene: Scene, messages: readonly TaskUIMessage[], html: string): Set<TurnItemKind> => {
  const kinds = new Set<TurnItemKind>();
  for (const message of messages) {
    for (const item of turnItemsOf(message, contextOf(scene))) {
      kinds.add(item.kind);
      const drawn = elementAt(html, `data-item="${item.id}"`);
      expect(drawn, `${scene.name}: ${item.id}`).toContain(`data-item-kind="${item.kind}"`);
      expect(drawn, `${scene.name}: ${item.id} by its part`).toContain(`data-part="${partOf(item)}"`);
    }
  }
  return kinds;
};

describe("the thread's frame (F-151)", () => {
  it("F-151/c1: S2 drawn through MessageView: no bookkeeping row or token line, prose with no avatar or header, every item kind by its part", () => {
    // `tasks.get`'s turns, priced in core, matched to the log's turns by their session and start.
    const usageTurns = s2.events.flatMap(({ sessionId, at, event }) =>
      event.kind === "turn.started" ? [{ turnId: `row-${event.turnId}`, sessionId, startedAt: at, spentMicroUsd: calc192Spend.pr.get(event.turnId)?.microUsd ?? null, estimated: calc192Spend.pr.get(event.turnId)?.estimated ?? false }] : [],
    );
    const priced = pricedTurnsOf(s2.events, usageTurns);
    expect(priced.map((turn) => turn.turnId)).toEqual([calc192.turns.t1, calc192.turns.t2, calc192.turns.t3, calc192.turns.t4]);
    const messages = fold(s2, priced);
    const html = render(s2, messages);

    // The bookkeeping isn't a row: no save, no session's end, no runner's connection, no token line.
    expect(html).not.toContain("Work saved");
    for (const n of [1, 2, 3]) expect(html).not.toContain(t("task.saved", { n }));
    expect(html).not.toContain(t("task.endedWithoutChanges"));
    expect(html).not.toContain(t("task.endedWithChanges"));
    expect(html).not.toContain("The session ended");
    expect(html).not.toContain(t("task.system.runnerConnected"));
    expect(html).not.toContain("The runner connected");
    expect(html).not.toContain('data-part="turn-usage"');
    // The turn's numbers are only the time's tooltip (its `title` until ticket 16 draws it), never a line.
    expect(html.replaceAll(/ title="[^"]*"/g, "")).not.toMatch(/\d(\.\d)?k in · \d/);
    expect(html).not.toContain('data-part="saved"');
    expect(html).not.toContain('data-part="session-end"');

    // Every assistant turn is its items alone: prose with no avatar, no name, no time, no status word.
    const turns = messages.filter((message) => message.role === "assistant");
    expect(turns).toHaveLength(4);
    for (const turn of turns) {
      const drawn = elementAt(html, `data-message-id="${turn.id}"`);
      expect(drawn).toContain('data-part="prose"');
      expect(drawn).not.toContain("rounded-full border border-line-2");
      expect(drawn).not.toContain("OpenCode");
      expect(drawn).not.toContain("Claude Sonnet 5.5");
      // Milestone 1's status words after the time (`working`, `proposed a plan`, `the turn failed`, `stopped`) went with the header.
      for (const word of ["working", "proposed a plan", "the turn failed", "stopped"]) expect(drawn).not.toContain(`>${word}<`);
      // The prose is the message's own markup, never inside a header's column.
      const prose = elementAt(drawn, 'data-part="prose"');
      expect(prose).toContain("thread-prose");
    }
    // The turn's time is on its first run's line, and only there.
    expect(elementAt(html, `data-message-id="${turns[0]?.id ?? ""}"`)).toContain('data-part="turn-time"');

    // A member's message is a bubble with their name over it.
    const asked = messages.filter((message) => message.role === "user");
    expect(asked).toHaveLength(4);
    for (const message of asked) expect(elementAt(html, `data-message-id="${message.id}"`)).toContain('data-part="bubble"');
    expect(html).toContain("Sam Rivera");

    // Every item kind S2 holds, each drawn by its part: runs, prose, captures, results (the push and the PR's card) and the answered question's receipt.
    const kinds = expectEveryItemDrawn(s2, messages, html);
    expect([...kinds].sort()).toEqual(["captures", "needs", "prose", "result", "run"]);
    expect(html).toContain('data-part="pr-card"');
    expect(html).toContain('data-receipt="question"');
  });

  it("F-151/c1: a failure, a notice and a pending approval are drawn by their parts too", () => {
    const failed = stateCells.steps[4];
    const failedMessages = fold(failed);
    const failedKinds = expectEveryItemDrawn(failed, failedMessages, render(failed, failedMessages));
    expect([...failedKinds]).toEqual(expect.arrayContaining(["failure", "notice", "run", "prose"]));

    const asking = stateCells.asks[1];
    const askingMessages = fold(asking);
    const askingHtml = render(asking, askingMessages);
    const askingKinds = expectEveryItemDrawn(asking, askingMessages, askingHtml);
    expect([...askingKinds]).toContain("needs");
    expect(askingHtml).toContain('data-part="asking-step"');
    expect(askingHtml).toContain(t("task.doing.needsApproval"));
  });
});
