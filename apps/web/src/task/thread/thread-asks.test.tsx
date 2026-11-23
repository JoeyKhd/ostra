import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@ostra/api";
import { approvalIdSchema, needsYouItemIdSchema, questionIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { StoredEvent } from "@ostra/protocol";
import { foldTaskEvents } from "@ostra/task-view";
import type { TaskUIMessage } from "@ostra/task-view";
import { calc192, s1, sceneMembers, stateCells, twoApprovalsPending } from "@ostra/task-view/testing";
import type { Scene } from "@ostra/task-view/testing";

import { ApprovalCard, PlanBlock, QuestionCard } from "@/components/tasks/task-answers";
import type { ApprovalView, PlanView, QuestionView } from "@/components/tasks/task-answers";
import { answerOf, choicesOf, emptyQuestionForm, pick, SOMETHING_ELSE, typeOwn } from "@/components/tasks/question-form";
import { NeedsYouInThread } from "@/components/ui/needs-you";
import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";

import { toThreadMessageLike } from "../convert";
import { createTaskIndexStore, indexMessages, TaskContext } from "../task-context";
import type { TaskContextValue } from "../task-context";
import { MessageView } from "../task-thread";
import { firstControlOf, JumpBandView, jumpTo, pillOf, shownFor } from "./jump-pill";
import type { Span, WaitingBlock } from "./jump-pill";
import { ThreadParts } from "./thread-context";
import type { ThreadPartsValue } from "./thread-context";
import { pillWords } from "./words";

// Milestone 10, ticket 13 (F-151/c4, c5): what waits on a person. The question's form is plain state
// (`question-form.ts`) that the block's controls call: the test calls it as they do and reads the
// markup the block draws for each state. The pill's band reads the blocks that wait (`data-waits`)
// and where they are: the test hands it the spans a browser measures. The scenes are the targets'
// recorded ones, through the real fold and the thread's own `MessageView`. The browser presses all
// of it for real in `e2e/27-thread-asks.spec.ts`.

const fail = (what: string): never => {
  throw new Error(`missing: ${what}`);
};
const taskId = taskIdSchema.parse(s1.taskId);
const names = new Map<string, string>(Object.values(sceneMembers).map((member) => [member.id, member.name]));

/** Components that call the API render under a client that is never called; the thread's blocks at its sizes. */
const html = (node: ReactNode, context?: TaskContextValue): string => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  const inThread = <NeedsYouInThread.Provider value>{node}</NeedsYouInThread.Provider>;
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {context === undefined ? inThread : <TaskContext.Provider value={context}>{inThread}</TaskContext.Provider>}
      </TRPCProvider>
    </QueryClientProvider>,
  );
};

/** The markup of the element that opens with `marker`, up to its close. */
const elementAt = (markup: string, marker: string): string => {
  const at = markup.indexOf(marker);
  if (at === -1) throw new Error(`missing: ${marker}`);
  const open = markup.lastIndexOf("<", at);
  const tags = /<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>/g;
  tags.lastIndex = open;
  let depth = 0;
  for (let match = tags.exec(markup); match !== null; match = tags.exec(markup)) {
    if (match[3] === "/" || ["img", "br", "input", "path", "line", "circle", "rect", "polyline"].includes(match[2] ?? "")) continue;
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return markup.slice(open, tags.lastIndex);
  }
  throw new Error(`unclosed: ${marker}`);
};
const elementsAt = (markup: string, marker: string): string[] => {
  const found: string[] = [];
  for (let at = markup.indexOf(marker); at !== -1; at = markup.indexOf(marker, at + marker.length)) found.push(elementAt(markup.slice(markup.lastIndexOf("<", at)), marker));
  return found;
};
const decode = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const textOf = (markup: string): string => decode(markup.replace(/<[^>]+>/g, ""));

// ---- a scene through the thread -------------------------------------------------------------------

/** Each approval a scene asks for, as `tasks.get` gives it to the page: open unless the scene answered it. */
const approvalsOf = (events: readonly StoredEvent[]): readonly ApprovalView[] =>
  events.flatMap(({ event, at }) => {
    if (event.kind !== "approval.requested") return [];
    const answered = events.some((later) => later.event.kind === "approval.answered" && later.event.approvalId === event.approvalId);
    const subject = event.subject ?? null;
    return [{
      approvalId: approvalIdSchema.parse(event.approvalId),
      itemId: answered ? null : needsYouItemIdSchema.parse(event.approvalId),
      state: answered ? "answered" : "open",
      closedReason: null,
      rule: event.rule ?? null,
      subject,
      options: event.options,
      forThisTask: subject?.kind === "command" ? { tool: "execute", pattern: subject.value.split(" ").slice(0, 2).join(" ") } : null,
      byTaskRule: null,
      decision: null,
      answeredBy: null,
      denyReason: null,
      answerableAnyway: false,
      createdAt: at,
      resolvedAt: null,
    } satisfies ApprovalView];
  });

/** A scene drawn by the thread's own `MessageView`, as the task page draws it, its open approvals answerable. */
const drawThread = (scene: Scene): string => {
  const messages = foldTaskEvents(scene.events, scene.liveText, { taskKind: scene.kind });
  const store = createTaskIndexStore();
  store.set(indexMessages(messages));
  const approvals = approvalsOf(scene.events);
  const context: TaskContextValue = {
    store,
    memberName: (id) => names.get(id) ?? "",
    agent: { name: "OpenCode", model: "Claude Sonnet 5.5" },
    approvalSummary: () => null,
    openSubagents: () => undefined,
    approvalCard: (approvalId) => {
      const approval = approvals.find((one) => one.approvalId === approvalId);
      return approval?.state !== "open" ? null : <ApprovalCard taskId={taskId} approval={approval} agent="OpenCode" project="calculator" othersOpen={approvals.length - 1} />;
    },
  };
  const parts: ThreadPartsValue = { taskKind: scene.kind, workspace: { taskId: scene.taskId, checkoutDirs: ["calculator-web"], mcpServers: [] }, project: "calculator", capMicroUsd: 25_000_000, ciOf: () => null };
  const Thread = () => {
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
  return html(<ThreadParts.Provider value={parts}><Thread /></ThreadParts.Provider>, context);
};

describe("an approval during a run", () => {
  it("F-151/c4: an approval's block sits under its asking step, where the live step was: milestone 3's card, the pattern mono", () => {
    const markup = drawThread(stateCells.asks[1]);
    const asking = elementsAt(markup, `data-part="asking-step"`);
    expect(asking).toHaveLength(1);
    const [step = ""] = asking;
    expect(textOf(step)).toMatch(/^Wants to run pnpm db:migrate\s*needs approval/);
    // No live step beside it: the asking step stands in its place.
    expect(markup).not.toContain(`data-part="live-step"`);
    const block = elementAt(step, `data-testid="approval"`);
    expect(block).toContain(`data-waits="approval"`);
    expect(textOf(block)).toContain("Database changes asks before OpenCode runs this command:");
    expect(textOf(elementAt(block, `data-part="subject"`))).toBe("pnpm db:migrate");
    expect(elementsAt(block, "data-action=").map(textOf)).toEqual(["Deny", "Approve once", "Approve for this task"]);
    expect(textOf(elementAt(block, `data-part="for-this-task"`))).toBe("Approve for this task also approves commands that start with pnpm db:migrate.");
    expect(elementAt(block, `data-part="for-this-task"`)).toMatch(/<span class="font-mono[^"]*">pnpm db:migrate<\/span>/);
    expect(textOf(block)).toContain("Any member of calculator can answer. The first answer wins.");
  });

  it("F-151/c4: two open approvals are two asking steps and two blocks, in the order they asked", () => {
    const markup = drawThread(twoApprovalsPending);
    const asking = elementsAt(markup, `data-part="asking-step"`);
    expect(asking.map((step) => /^Wants to run (pnpm db:(?:migrate|reset))\s*needs approval/.exec(textOf(step))?.[1])).toEqual(["pnpm db:migrate", "pnpm db:reset"]);
    expect(asking.map((step) => textOf(elementAt(elementAt(step, `data-testid="approval"`), `data-part="subject"`)))).toEqual(["pnpm db:migrate", "pnpm db:reset"]);
    // Each block is its own approval, and the pill counts them.
    const waiting = [...markup.matchAll(/data-waits="([a-z]+)"/g)].map((match) => match[1]);
    expect(waiting).toEqual(["approval", "approval"]);
    const need = pillOf(["approval", "approval"]);
    expect(need === null ? null : pillWords(need, t)).toBe("Needs you · 2 approvals");
  });
});

// ---- S1's question ------------------------------------------------------------------------------

const asked = s1.events.findLast(({ event }) => event.kind === "question.asked")?.event;
const question: QuestionView =
  asked?.kind === "question.asked"
    ? { itemId: needsYouItemIdSchema.parse("01900000-0000-7000-8000-0000000013a1"), questionId: questionIdSchema.parse(asked.questionId), message: asked.message, fields: asked.fields.map(({ options, ...one }) => (options === undefined ? one : { ...one, options })), askedAt: s1.now }
    : fail("S1's question");
const field = question.fields[0] ?? fail("S1's field");

const card = (over: { readonly isDriver?: boolean; readonly freeText?: boolean } = {}): string =>
  html(<QuestionCard taskId={taskId} question={question} agent="OpenCode" isDriver={over.isDriver ?? true} driver={sceneMembers.sam.name} onTakeOver={() => undefined} takingOver={false} freeText={over.freeText ?? true} />);

const choiceWords = (markup: string): string[] => elementsAt(markup, `data-part="choice"`).map(textOf);
const sendButton = (markup: string): string => elementAt(markup, `data-action="answer-question"`);

describe("the question, with Something else…", () => {
  it("F-151/c5: S1's choices are a radio group, the enum's values then Something else…; nothing chosen, Send answer asleep", () => {
    const markup = card();
    const group = elementAt(markup, `role="radiogroup"`);
    expect(choiceWords(group)).toEqual([...calc192.question.choices, "Something else…"]);
    expect([...group.matchAll(/<input type="radio"/g)]).toHaveLength(3);
    expect(group).not.toContain("checked=");
    expect(sendButton(markup)).toMatch(/\sdisabled=""/);
    expect(textOf(sendButton(markup))).toBe("Send answer");
    expect(markup).toContain("OpenCode waits for your answer. Only the driver answers questions.");
    // The amber rule waits on its driver: the pill reads it.
    expect(elementAt(markup, `data-testid="question"`)).toMatch(/data-tone="amber"[^>]*data-waits="question"/);
  });

  it("F-151/c5: picking Something else… opens its field and asks for its focus; Send answer stays asleep until it holds words, then sends them with other", () => {
    const words = "Replace it, but keep the expression in the line above";
    // A choice wakes Send answer and sends nothing by itself.
    const chose = pick(emptyQuestionForm, field.id, "Replace the display");
    expect(chose.focus).toBeNull();
    expect(answerOf(question.fields, chose.form)).toEqual({ answers: { [field.id]: "Replace the display" }, other: [] });
    // Something else…: the focus goes into its field, and Send answer sleeps while it's empty or blank.
    const other = pick(chose.form, field.id, SOMETHING_ELSE);
    expect(other.focus).toEqual({ field: field.id });
    expect(answerOf(question.fields, other.form)).toBeNull();
    expect(answerOf(question.fields, typeOwn(other.form, field.id, "   "))).toBeNull();
    // With words it wakes, and what it sends is `questions.answer`'s input: the words as the answer, the field named in `other`.
    expect(answerOf(question.fields, typeOwn(other.form, field.id, `  ${words} `))).toEqual({ answers: { [field.id]: words }, other: [field.id] });
    // The block draws Something else… as the last choice; its 32px field opens only once it's chosen.
    expect(card()).not.toContain(`data-part="something-else"`);
  });

  it("F-151/c5: with questionFreeText false there's no Something else…, and the form is milestone 3's", () => {
    expect(choicesOf(field, false)).toEqual(calc192.question.choices);
    const markup = card({ freeText: false });
    expect(choiceWords(markup)).toEqual([...calc192.question.choices]);
    expect(markup).not.toContain("Something else…");
  });

  it("F-151/c5: a watcher's form is the quiet block, the choices disabled at 50%, with Take over to answer and who drives, and no pill", () => {
    const markup = card({ isDriver: false });
    const block = elementAt(markup, `data-testid="question"`);
    expect(block).toContain(`data-tone="quiet"`);
    expect(block).not.toContain("data-waits");
    expect(block).toContain("border-line-2");
    const group = elementAt(block, `role="radiogroup"`);
    expect(group).toMatch(/aria-disabled="true"/);
    expect(group).toContain("opacity-50");
    const radios = [...group.matchAll(/<input type="radio"[^>]*>/g)].map((match) => match[0]);
    expect(radios).toHaveLength(3);
    expect(radios.every((radio) => /\sdisabled=""/.test(radio) && radio.includes(`aria-disabled="true"`))).toBe(true);
    expect(block).not.toContain(`data-action="answer-question"`);
    expect(textOf(elementAt(block, `data-action="take-over-to-answer"`))).toBe("Take over to answer");
    expect(textOf(block)).toContain("Sam Rivera answers questions while driving.");
    expect(html(<QuestionCard taskId={taskId} question={question} agent="OpenCode" isDriver={false} driver={null} onTakeOver={() => undefined} takingOver={false} freeText />)).toContain("Nobody is driving. Take over to answer.");
  });

  it("F-151/c5: the answered block becomes its receipt, the member's own words quoted, no block left", () => {
    const { answered } = stateCells.asks[4];
    const markup = drawThread(answered);
    expect(markup).not.toContain(`data-testid="question"`);
    expect(textOf(elementAt(markup, `data-receipt="question"`))).toContain("Sam Rivera answered “Replace it, but keep the expression in the line above”");
  });
});

// ---- the pill -----------------------------------------------------------------------------------

/** A block as the band measures it: where it is, and its first choice's focus, recorded. */
const blockAt = (kind: WaitingBlock["kind"], span: Span) => {
  const calls: string[] = [];
  const radio = { focus: (options?: FocusOptions) => { calls.push(`focus first choice${options?.preventScroll === true ? ", no scroll" : ""}`); } };
  const element = {
    dataset: { waits: kind },
    getBoundingClientRect: () => span,
    scrollIntoView: (options?: ScrollIntoViewOptions) => { calls.push(`scroll into view ${options?.block ?? ""}`); },
    querySelector: (selector: string) => (selector === "input[type='radio']:not([disabled])" ? radio : null),
    hasAttribute: () => false,
    setAttribute: () => undefined,
  };
  // A stand-in for the browser's element: the band reads its kind and box, and the press calls these.
  // @ts-expect-error A test double: the band and the press use only these members of an element.
  const asElement: HTMLElement = element;
  return { block: { element: asElement, kind }, calls };
};

/** The thread's visible span: 900px tall from y 100. */
const view: Span = { top: 100, bottom: 1000 };

describe("the pill", () => {
  it("F-151/c5: it shows while the question block is scrolled out of view and not while it's in view, and names what waits", () => {
    const below = blockAt("question", { top: 1040, bottom: 1240 });
    const shown = shownFor([below.block], view);
    expect(shown?.target).toBe(below.block.element);
    expect(shown === null ? null : pillWords(shown.need, t)).toBe("Needs you · question");
    // Its title line in view: the block is seen, and the band goes.
    expect(shownFor([blockAt("question", { top: 960, bottom: 1160 }).block], view)).toBeNull();
    expect(shownFor([blockAt("question", { top: 400, bottom: 600 }).block], view)).toBeNull();
    // Above the view, scrolled past, it waits too.
    expect(shownFor([blockAt("question", { top: -300, bottom: 80 }).block], view)).not.toBeNull();
    // What it names: the plan, an approval, two, a reply, or `Needs you` for a mix.
    const named = (kinds: readonly WaitingBlock["kind"][]): string | null => {
      const need = pillOf(kinds);
      return need === null ? null : pillWords(need, t);
    };
    expect(named(["plan"])).toBe("Needs you · plan");
    expect(named(["approval"])).toBe("Needs you · approval");
    expect(named(["approval", "approval"])).toBe("Needs you · 2 approvals");
    expect(named(["reply"])).toBe("Needs you · reply");
    expect(named(["question", "approval"])).toBe("Needs you");
    expect(named([])).toBeNull();
    // Its band: 46px of solid `--bg` over the thread's bottom, an 18px fade above, the pill a button centred in it.
    const band = html(<JumpBandView need={{ kind: "question" }} onJump={() => undefined} />);
    expect(band).toMatch(/data-part="jump-band"[^>]*class="[^"]*\babsolute\b[^"]*\bbottom-0\b[^"]*\bh-\[46px\][^"]*\bbg-bg\b[^"]*before:-top-\[18px\]/);
    expect(elementAt(band, `data-part="jump-pill"`)).toMatch(/^<button type="button"/);
    expect(textOf(band)).toBe("Needs you · question");
  });

  it("F-151/c5: pressing it brings the block into view and focuses its first choice", () => {
    const below = blockAt("question", { top: 1040, bottom: 1240 });
    expect(firstControlOf(below.block.element)).not.toBe(below.block.element);
    jumpTo(below.block.element, true);
    expect(below.calls).toEqual(["scroll into view center", "focus first choice, no scroll"]);
  });

  it("F-151/c5: no pill for a watcher's quiet block: only blocks that wait on the viewer are read", () => {
    const driver = card();
    const watcher = card({ isDriver: false });
    // The band reads `data-waits` only (`waitingBlocks`), which the driver's block has and the watcher's doesn't.
    const waits = (markup: string): string[] => [...markup.matchAll(/data-waits="([a-z]+)"/g)].map((match) => match[1] ?? "");
    expect(waits(driver)).toEqual(["question"]);
    expect(waits(watcher)).toEqual([]);
    expect(shownFor([], view)).toBeNull();
    // A watcher's quiet plan doesn't wait on them either; the driver's does.
    const plan: PlanView = {
      state: "proposed",
      itemId: needsYouItemIdSchema.parse("01900000-0000-7000-8000-0000000013a2"),
      turnId: turnIdSchema.parse("01900000-0000-7000-8000-0000000013a3"),
      turn: 1,
      entries: [{ content: "Add `src/keys/shortcuts.ts`: a map from keys to the keypad's actions", priority: "medium", status: "pending" }],
      message: "Here's the plan:",
      proposedAt: s1.now,
      approved: null,
      revision: null,
    };
    expect(html(<PlanBlock taskId={taskId} plan={plan} agent="OpenCode" isDriver={false} driver="Alex Kim" onTakeOver={() => undefined} takingOver={false} />)).not.toContain("data-waits");
  });
});
