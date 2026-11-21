import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@ostra/api";
import { needsYouItemIdSchema, questionIdSchema, sessionIdSchema, storedEventSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { StoredEvent } from "@ostra/protocol";
import { foldTaskEvents } from "@ostra/task-view";

import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";
import { AgentMarkdown } from "@/task/renderers";

import { NeedsYouCards, NeedsYouLive } from "./needs-you-cards";
import type { NeedsYouCardsProps } from "./needs-you-cards";
import { asksSomething, needsOf, questionRepeatsMessage, replyHint } from "./needs-you-card-words";
import type { Need, NeedsInput } from "./needs-you-card-words";
import { PlanBlock, QuestionCard, wantsSentence } from "./task-answers";
import type { PlanView, QuestionView } from "./task-answers";

// The maintainer, 2026-11-21: "needs you doesnt become a part of the chat window lol, it's a
// component up top". What needs you is now part of the chat: approvals and questions where the agent
// asked, the rest as one card each at the thread's end, above the composer. The agent's message stays
// in the thread, drawn as Markdown, and no card repeats it.

const taskId = taskIdSchema.parse("01900000-0000-7000-8000-0000000000a1");
const sessionId = sessionIdSchema.parse("01900000-0000-7000-8000-0000000000a2");
const turnId = turnIdSchema.parse("01900000-0000-7000-8000-0000000000a3");
const itemId = needsYouItemIdSchema.parse("01900000-0000-7000-8000-0000000000a4");
const questionId = questionIdSchema.parse("01900000-0000-7000-8000-0000000000a5");
const idle = { run: () => undefined, pending: false, error: null };

/** The agent's last message in the maintainer's report: Markdown, ending on a question. */
const LAST = [
  "It has two packages:",
  "",
  "- **`test1`**: the CLI",
  "- **`test2`**: a small library",
  "",
  "What would you like me to do with `test1`?",
].join("\n");

/** Components that call the API render under a client that is never called. */
const html = (node: ReactNode): string => {
  const queryClient = new QueryClient();
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {node}
      </TRPCProvider>
    </QueryClientProvider>,
  );
};

const item = (reason: NeedsInput["needsYou"][number]["reason"], summary: string | null = null): NeedsInput["needsYou"][number] => ({ id: itemId, reason, audience: "driver", approvalId: null, summary });

const task = (over: Partial<NeedsInput>): NeedsInput => ({
  state: "needs_you",
  group: "needs-you",
  reason: null,
  kind: "code",
  limit: null,
  needsYou: [],
  openApprovals: 0,
  openQuestions: 0,
  planWaiting: false,
  ...over,
});

const cards = (needs: readonly Need[], over: Partial<NeedsYouCardsProps> = {}): string =>
  html(
    <NeedsYouCards
      needs={needs}
      agent="OpenCode"
      how="send"
      limit={{ task: { state: "needs_you", reason: "spend_cap", limit: "spend-cap", spend: { unit: "usd", spent: 25_000_000, cap: 25_000_000, reached: true }, lostBox: false, reopenWithoutText: false }, reopen: idle }}
      ticketClosed={{ stop: idle, keep: idle }}
      conflict={{ canAnswer: true, dismiss: idle }}
      awaiting={undefined}
      {...over}
    />,
  );

/** How many times `needle` occurs in `hay`. */
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

const stored = (seq: number, event: unknown): StoredEvent => storedEventSchema.parse({ taskId, seq, sessionId, sessionSeq: seq, at: seq * 1000, event });

describe("what needs you, as cards in the chat", () => {
  it("F-036/c2: each kind of need is one card: approvals and questions where the agent asked, every other kind at the thread's end", () => {
    const kinds = (input: Partial<NeedsInput>) => needsOf(task(input)).map((need) => need.kind);
    expect(kinds({ reason: "approval", openApprovals: 2 })).toEqual(["approval"]);
    expect(kinds({ reason: "question", openQuestions: 1 })).toEqual(["question"]);
    expect(kinds({ reason: "plan", planWaiting: true })).toEqual(["plan"]);
    expect(kinds({ reason: "round_cap" })).toEqual(["round-cap"]);
    expect(kinds({ state: "awaiting_approval", reason: "awaiting_approval" })).toEqual(["awaiting-approval"]);
    expect(kinds({ reason: "spend_cap", limit: "spend-cap" })).toEqual(["limit"]);
    expect(kinds({ reason: "crashed" })).toEqual(["limit"]);
    expect(kinds({ reason: "ticket_closed", needsYou: [item("ticket_closed")] })).toEqual(["ticket-closed"]);
    expect(kinds({ reason: "no_changes", needsYou: [item("no_changes", LAST), item("restore_conflict")] })).toEqual(["restore-conflict"]);
    expect(kinds({ reason: "no_changes", needsYou: [item("no_changes", LAST)] })).toEqual(["reply"]);
    expect(kinds({ reason: "setup_failed", needsYou: [item("setup_failed", "The web service didn't start: exit 1")] })).toEqual(["notice"]);
    expect(kinds({ kind: "refine", reason: "draft_ready" })).toEqual([]);
    expect(kinds({ state: "running", group: "running" })).toEqual([]);

    // Every end-of-thread kind at once: each card once, in the list at the thread's end.
    const all: readonly Need[] = [
      { kind: "limit", what: "spend-cap" },
      { kind: "ticket-closed", summary: null },
      { kind: "restore-conflict", itemId },
      { kind: "reply", asked: true },
      { kind: "notice", reason: "files_outside_repos", summary: null },
    ];
    const drawn = cards(all);
    expect(drawn.startsWith('<div data-part="needs-you-cards">')).toBe(true);
    for (const need of ["limit", "ticket-closed", "restore-conflict", "reply", "notice"]) expect(count(drawn, `data-need="${need}"`)).toBe(1);
    // Every card is the amber block with its mark, in the messages' text column.
    expect(count(drawn, "border-l-(length:--rule-needs-you)")).toBe(5);
    expect(count(drawn, `role="group"`)).toBe(5);
    expect(count(drawn, "ml-10")).toBe(5);

    // Approvals, questions, the plan and the round limit have their own place: this list adds nothing.
    expect(cards([{ kind: "approval", count: 1 }, { kind: "question" }, { kind: "plan" }, { kind: "round-cap" }])).toBe("");
  });

  it("F-065/c2: the agent's summary shows once, in the thread as Markdown; the card points at it and never repeats it", () => {
    const [need] = needsOf(task({ reason: "no_changes", needsYou: [item("no_changes", LAST)] }));
    expect(need).toEqual({ kind: "reply", asked: true });
    const card = cards(need === undefined ? [] : [need]);
    expect(card).toContain(t("taskPage.needsYou"));
    expect(card).toContain("OpenCode asked you something in its message above. Reply below.");
    for (const fragment of ["test1", "two packages", "**", "What would you like"]) expect(card).not.toContain(fragment);

    // The thread holds the message once, and draws it as Markdown: bold, code and a list, no raw marks.
    const thread = foldTaskEvents(
      [stored(1, { kind: "turn.started", turnId }), stored(2, { kind: "agent.message", turnId, segmentId: "s1", text: LAST }), stored(3, { kind: "turn.ended", turnId, stopReason: "end_turn" })],
      [],
    );
    const texts = thread.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])));
    expect(texts).toEqual([LAST]);
    const drawn = html(<AgentMarkdown text={LAST} />);
    expect(drawn).toContain("<strong><code>test1</code></strong>");
    expect(drawn).toContain("<li>");
    expect(drawn).not.toContain("**");
    expect(drawn).not.toContain("`");

    // A message that asks nothing reads as a summary; a watcher is told to take over, a stopped task to reopen.
    expect(cards([{ kind: "reply", asked: false }])).toContain("OpenCode finished without changes. Its message above says what happened. Reply below.");
    expect(cards([{ kind: "reply", asked: true }], { how: "watch" })).toContain("Take over to reply.");
    expect(cards([{ kind: "reply", asked: true }], { how: "reopen" })).toContain("Reply below to reopen the task.");
    expect(cards([{ kind: "reply", asked: true }], { how: "none" })).toContain("OpenCode asked you something in its message above.</span>");
    expect(asksSomething("Which one should I use?**")).toBe(true);
    expect(asksSomething("Done: nothing to change.")).toBe(false);
    expect(asksSomething(null)).toBe(false);
    // And the composer's hint says the agent waits for the reply.
    expect(replyHint([{ kind: "reply", asked: true }], "OpenCode")).toBe("OpenCode is waiting for your reply.");
    expect(replyHint([{ kind: "approval", count: 1 }], "OpenCode")).toBeNull();
  });

  it("F-036/c2: a question's message is Markdown, and a question that only repeats the agent's message points at it", () => {
    const question: QuestionView = { itemId, questionId, message: "Where should the **toggle** go?", fields: [{ id: "place", label: "Place", type: "select", options: ["The top bar", "Both"] }], askedAt: 0 };
    const props = { taskId, question, agent: "OpenCode", isDriver: true, driver: "Alex", onTakeOver: () => undefined, takingOver: false };
    const drawn = html(<QuestionCard {...props} />);
    expect(drawn).toContain("<strong>toggle</strong>");
    expect(drawn).not.toContain("**");
    expect(count(drawn, 'type="radio"')).toBe(2);
    const pointing = html(<QuestionCard {...props} repeats />);
    expect(pointing).toContain("OpenCode asks this in its message above.");
    expect(pointing).not.toContain("toggle");
    expect(count(pointing, 'type="radio"')).toBe(2);

    // It repeats when the agent's last message of the same turn says exactly the question.
    const asked = (text: string, sameTurn = true) => [
      stored(1, { kind: "turn.started", turnId }),
      stored(2, { kind: "agent.message", turnId, segmentId: "s1", text }),
      ...(sameTurn ? [] : [stored(3, { kind: "turn.started", turnId: turnIdSchema.parse("01900000-0000-7000-8000-0000000000a6") })]),
      stored(4, { kind: "question.asked", turnId: sameTurn ? turnId : turnIdSchema.parse("01900000-0000-7000-8000-0000000000a6"), questionId, message: "Where should the toggle go?", fields: [] }),
    ];
    expect(questionRepeatsMessage(asked("Where should the toggle go?\n"), questionId, "Where should the toggle go?")).toBe(true);
    expect(questionRepeatsMessage(asked("I need one choice from you."), questionId, "Where should the toggle go?")).toBe(false);
    expect(questionRepeatsMessage(asked("Where should the toggle go?", false), questionId, "Where should the toggle go?")).toBe(false);
  });

  it("F-063/c2: the plan's card shows its steps and points at the agent's message instead of repeating it", () => {
    const plan: PlanView = {
      state: "proposed",
      itemId,
      turnId,
      turn: 1,
      entries: [{ content: "Read the version at build time", priority: "medium", status: "pending" }],
      message: "Here is my plan. **Step one** reads the version.",
      proposedAt: 0,
      approved: null,
      revision: null,
    };
    const drawn = html(<PlanBlock taskId={taskId} plan={plan} agent="OpenCode" isDriver driver="Alex" onTakeOver={() => undefined} takingOver={false} />);
    expect(drawn).toContain("Read the version at build time");
    expect(drawn).toContain("OpenCode proposes this plan. Its message above explains it.");
    expect(drawn).not.toContain("Step one");
    expect(drawn).toContain('data-action="approve-plan"');
    expect(drawn).toContain('data-action="ask-plan-changes"');
  });

  it("F-026/c3: an approval with no rule says what the agent wants, with no sentence missing its subject", () => {
    expect(wantsSentence("command", "OpenCode")).toBe("OpenCode wants to run this command:");
    expect(wantsSentence("path", "OpenCode")).toBe("OpenCode wants to edit this file:");
    expect(wantsSentence(null, "OpenCode")).toBe("OpenCode asks before it goes on:");
  });

  it("F-081/c2: a polite live region, always there, reads out what needs you when it appears", () => {
    const empty = renderToStaticMarkup(<NeedsYouLive needs={[]} agent="OpenCode" how="send" />);
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain("></p>");
    const said = renderToStaticMarkup(<NeedsYouLive needs={[{ kind: "reply", asked: true }]} agent="OpenCode" how="send" />);
    expect(said).toContain("Needs you: OpenCode asked you something in its message above. Reply below.");
    expect(renderToStaticMarkup(<NeedsYouLive needs={[{ kind: "approval", count: 2 }]} agent="OpenCode" how="send" />)).toContain("Needs you: OpenCode waits for 2 approvals.");
    expect(renderToStaticMarkup(<NeedsYouLive needs={[{ kind: "limit", what: "spend-cap" }]} agent="OpenCode" how="send" />)).toContain(">Needs you · spend cap</p>");
  });
});
