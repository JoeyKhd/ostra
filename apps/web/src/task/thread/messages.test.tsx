import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@ostra/api";
import { expiredApprovalAnswerPrompt, fixChecksPrompt, lateQuestionAnswerPrompt } from "@ostra/domain";
import { approvedPlanPrompt, clientMessageIdSchema, diffCommentIdSchema, findingIdSchema, planRevisionPrompt, questionIdSchema, sessionIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { PlanEntry, StoredEvent, TaskEvent, TaskKind } from "@ostra/protocol";
import { foldTaskEvents } from "@ostra/task-view";
import type { OptimisticMessage, TaskUIMessage } from "@ostra/task-view";
import { calc192, calc196, calc196Plan, s2, s3, s5Approved, sceneId, sceneLog, sceneMembers, sceneTime, sceneWorld, stateCells, turnSteps } from "@ostra/task-view/testing";

import type { TaskRounds } from "@/components/tasks/review/review-words";
import { formatClock } from "@/lib/format";
import { TRPCProvider } from "@/lib/trpc";

import { toThreadMessageLike } from "../convert";
import { SentDiffCommentsContext, sentBySeq } from "../diff-comments-message";
import type { SentDiffComments } from "../diff-comments-message";
import { createTaskIndexStore, indexMessages, TaskContext } from "../task-context";
import type { TaskContextValue } from "../task-context";
import { dayBreaksOf, MessageView } from "../task-thread";
import { answersOf } from "./answers";
import { ShownPlanList } from "./receipt";
import { ThreadParts } from "./thread-context";
import type { ThreadPartsValue } from "./thread-context";

// Milestone 10, ticket 12 (F-151/c1, F-151/c5; F-111/c1): a member's message, ostra's and GitHub's,
// receipts and dividers, as the task page draws them: the targets' recorded scenes and the messages
// sheet's cells (`@ostra/task-view/testing`) through the real fold, each message through the
// thread's own `MessageView` inside assistant-ui's runtime, with what the page gives the thread
// (`tasks.rounds`, the sent diff comments, the runner, what members answered from the log).

const { sam, alex } = sceneMembers;
const names = new Map<string, string>(Object.values(sceneMembers).map((member) => [member.id, member.name]));

type Shown = { readonly taskId: string; readonly kind: TaskKind; readonly events: readonly StoredEvent[] };
type Options = {
  readonly rounds?: TaskRounds;
  readonly sent?: SentDiffComments;
  readonly ticketKey?: string;
  readonly remember?: boolean;
  readonly runner?: string;
  readonly optimistic?: readonly OptimisticMessage[];
};

/** The messages as the page's thread draws them, each through `MessageView`, a day divider where the day changes. */
const Thread = ({ messages }: { readonly messages: readonly TaskUIMessage[] }) => {
  const runtime = useExternalStoreRuntime<TaskUIMessage>({ messages, convertMessage: toThreadMessageLike, isRunning: false, onNew: () => Promise.resolve() });
  const days = dayBreaksOf(messages);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <ThreadPrimitive.Messages>{({ message }) => <MessageView id={message.id} fallbackRole={message.role} dayAt={days.get(message.id) ?? null} />}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
};

const render = (shown: Shown, options: Options = {}): string => {
  const taskId = taskIdSchema.parse(shown.taskId);
  const messages = foldTaskEvents(shown.events, [], { taskKind: shown.kind, ...(options.optimistic === undefined ? {} : { optimistic: options.optimistic }) });
  const store = createTaskIndexStore();
  store.set(indexMessages(messages));
  const context: TaskContextValue = {
    store,
    memberName: (id) => names.get(id) ?? "",
    agent: { name: "OpenCode", model: "Claude Sonnet 5.5" },
    approvalSummary: () => null,
    ...(options.ticketKey === undefined ? {} : { ticketKey: options.ticketKey }),
    ...(options.remember === true ? { rememberPrComment: () => Promise.resolve({ kind: "proposed" as const }) } : {}),
  };
  const lastSession = messages.findLast((message) => message.metadata?.sessionId !== undefined)?.metadata?.sessionId;
  const parts: ThreadPartsValue = {
    taskKind: shown.kind,
    workspace: { taskId, checkoutDirs: ["calculator-web"], mcpServers: [] },
    project: "calculator",
    capMicroUsd: null,
    ciOf: () => null,
    answers: answersOf(shown.events),
    runnerOf: (sessionId) => (options.runner !== undefined && sessionId === lastSession ? options.runner : null),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Never called: a part that reads its own query renders from what's set here, or without it.
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  if (options.rounds !== undefined) {
    const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
    queryClient.setQueryData(trpc.tasks.rounds.queryKey({ taskId }), options.rounds);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <TaskContext.Provider value={context}>
          <SentDiffCommentsContext.Provider value={options.sent ?? null}>
            <ThreadParts.Provider value={parts}>
              <Thread messages={messages} />
            </ThreadParts.Provider>
          </SentDiffCommentsContext.Provider>
        </TaskContext.Provider>
      </TRPCProvider>
    </QueryClientProvider>,
  );
};

/** The markup of each element that opens with `marker`, up to its close. */
const elementsAt = (html: string, marker: string): string[] => {
  const found: string[] = [];
  for (let at = html.indexOf(marker); at !== -1; at = html.indexOf(marker, at + 1)) {
    const open = html.lastIndexOf("<", at);
    const tags = /<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>/g;
    tags.lastIndex = open;
    let depth = 0;
    for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
      if (match[3] === "/" || ["img", "br", "input", "path", "line", "circle", "rect", "polyline", "polygon"].includes(match[2] ?? "")) continue;
      depth += match[1] === "/" ? -1 : 1;
      if (depth === 0) {
        found.push(html.slice(open, tags.lastIndex));
        break;
      }
    }
  }
  return found;
};

/** Each bubble's markup, in the thread's order. */
const bubblesIn = (html: string): string[] => elementsAt(html, 'data-part="bubble"');
/** Words as a reader sees them: tags gone, the quotes and apostrophes as typed. */
const words = (html: string): string =>
  html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
/** A scene's time as the page shows it, in the zone the test runs in. */
const clock = (time: string): string => formatClock(sceneTime(time));
const one = <T,>(list: readonly T[]): T => {
  expect(list).toHaveLength(1);
  const [only] = list;
  if (only === undefined) throw new Error("none");
  return only;
};

/** When the cell's message of `intent` was written: its round was made with it. */
const messageAt = (events: readonly StoredEvent[], intent: string): number => {
  const found = events.find(({ event }) => event.kind === "user.message" && event.intent === intent);
  if (found === undefined) throw new Error(`no ${intent} message`);
  return found.at;
};

const limits = { ciRounds: 2, reviewRounds: 2, automaticTurns: 4 };
const ciRoundOf = (at: number): TaskRounds["rounds"][number] => ({
  kind: "ci",
  number: 1,
  automatic: true,
  state: "started",
  createdAt: at,
  cause: {
    kind: "ci",
    headSha: "4be21c0".padEnd(40, "0"),
    failing: [
      { repo: sceneWorld.repo, name: "unit-tests", conclusion: "failure", logFile: "0196f1a0-ce31-7000-8000-000000000a01.log" },
      { repo: sceneWorld.repo, name: "lint", conclusion: "failure", logFile: "0196f1a0-ce31-7000-8000-000000000a02.log" },
    ],
  },
  cappedReason: null,
  heldReason: null,
  hold: null,
  outcome: null,
});

describe("a member's message, ostra's and GitHub's (parts.md part 2)", () => {
  it("F-151/c1: a member's message is a filled bubble with its name and time over it; ostra's AI review is outlined, named ostra, tagged automatic", () => {
    const [review, asked] = bubblesIn(render(s3));
    // The AI review: ostra sent it by itself.
    expect(review).toContain('data-look="outlined"');
    expect(review).toContain('data-from="ostra"');
    expect(words(review ?? "")).toContain(`ostra${clock("15:20:00")}· automatic`);
    expect(words(review ?? "")).toContain("AI review of PR #483, round 2 of 3");
    expect(words(review ?? "")).toContain("3 files, +203 −6 · the PR's commits, CALC-192 and its criteria");
    expect(review).toContain('data-action="what-the-agent-got"');
    expect(review).toContain("border-line-2");
    expect(review).not.toContain("bg-sel");
    // Sam typed his here: filled, his name over it.
    expect(asked).toContain('data-look="filled"');
    expect(asked).toContain('data-from="member"');
    expect(asked).toContain("bg-sel");
    expect(words(asked ?? "")).toContain(`Sam Rivera${clock("15:31:00")}`);
    expect(words(asked ?? "")).toContain("Web search works in this box now.");
  });

  it("F-151/c1: a CI round is outlined, ostra · automatic, with its round of its limit, the automatic turn and a row per failing job with its log", () => {
    const cell = stateCells.messages[1];
    const html = render(cell, { rounds: { limits, rounds: [ciRoundOf(messageAt(cell.events, "fix-ci"))] } });
    const round = one(bubblesIn(html));
    expect(round).toContain('data-look="outlined"');
    expect(round).toContain('data-round="ci"');
    expect(words(round)).toContain(`ostra${clock("10:31:00")}· automatic`);
    expect(words(round)).toContain("CI round 1 of 2 · automatic turn 1 of 4");
    const rows = elementsAt(round, 'data-item="check"');
    expect(rows.map(words)).toEqual(["unit-testsfailedlog", "lintfailedlog"]);
    expect(rows[0]).toContain('data-log="0196f1a0-ce31-7000-8000-000000000a01.log"');
    expect(rows[0]).toContain(`href="/tasks/${cell.taskId}?tab=checks"`);
    // Before `tasks.rounds` is read, the jobs the message carried, from its data.
    const before = one(bubblesIn(render(cell)));
    expect(words(before)).toContain("CI failed: 2 jobs");
    expect(elementsAt(before, 'data-item="check"').map(words)).toEqual(["unit-testsfailed", "lintfailed"]);
  });

  it("F-151/c1: a findings round the budget held keeps its hold inside its bubble, and names the blocking finding it sent", () => {
    const cell = stateCells.messages[2];
    const at = messageAt(cell.events, "fix-findings");
    const findings: TaskRounds["rounds"][number] = {
      kind: "findings",
      number: 1,
      automatic: true,
      state: "started",
      createdAt: at,
      cause: { kind: "findings", reviewRunId: sceneId("ce32", 0x501), findings: [{ findingId: findingIdSchema.parse(sceneId("ce32", 0x502)), title: "The store keeps 51 results", path: "src/history/store.ts", line: 9, severity: "blocking" }] },
      cappedReason: null,
      heldReason: null,
      hold: { heldAt: at, releasedAt: at + 9 * 60_000, scope: "project", releasedByName: "Priya Shah" },
      outcome: null,
    };
    const html = render(cell, { rounds: { limits, rounds: [ciRoundOf(at - 20 * 60_000), findings] } });
    const round = one(bubblesIn(html));
    expect(words(round)).toContain(`ostra${clock("10:40:00")}· automatic`);
    expect(words(round)).toContain("Findings round 1 of 2 · automatic turn 2 of 4");
    expect(words(round)).toContain("Sent 1 blocking finding: The store keeps 51 results. 1 nit listed, not required.");
    expect(words(one(elementsAt(round, 'data-part="round-held"')))).toBe("Held 9 min: the project's budget for November was reached. Released when Priya Shah raised it.");
    // The hold is the round's, so no notice line stands for it in the column.
    expect(html).not.toContain('data-part="notice"');
  });

  it("F-151/c1, F-111/c1: an @ostra comment is outlined, named {login} on GitHub, tagged PR comment, quoted where it was, with Open on GitHub and Remember this", () => {
    const html = render(stateCells.messages[3], { remember: true });
    const comment = one(bubblesIn(html));
    expect(comment).toContain('data-look="outlined"');
    expect(comment).toContain('data-from="github"');
    expect(words(comment)).toContain(`sam-rivera on GitHub${clock("15:02:00")}· PR comment`);
    expect(words(comment)).toContain("src/history/panel.tsx:42@ostra the Use button needs a label for screen readers.");
    expect(comment).toContain(`href="${calc192.pr.url}#discussion_r42"`);
    expect(words(one(elementsAt(comment, 'data-part="pr-comment-links"')))).toBe("Open on GitHubRemember this");
    expect(comment).toContain('data-action="remember-this"');
    // Its `pr.comment_received` is the bubble's, never a row of its own; and Remember this only where the page can propose.
    expect(html.match(/data-part="pr-comment"/g)).toHaveLength(1);
    expect(render(stateCells.messages[3])).not.toContain("remember-this");
  });

  it("F-151/c1: a Linear follow-up is filled under the member's name, tagged from a comment on its key", () => {
    const log = sceneLog({ taskId: taskIdSchema.parse(sceneId("ce3a", 1)), sessionId: sessionIdSchema.parse(sceneId("ce3a", 0x1a)), start: "09:00:00", prefix: "linear" });
    log.add({ kind: "user.message", memberId: alex.id, clientMessageId: clientMessageIdSchema.parse(sceneId("ce3a", 2)), text: "Also keep the history when the page **reloads**.", delivery: "immediate", intent: "linear-follow-up" });
    const followUp = one(bubblesIn(render({ taskId: sceneId("ce3a", 1), kind: "code", events: log.events() }, { ticketKey: "CALC-192" })));
    expect(followUp).toContain('data-look="filled"');
    expect(followUp).toContain('data-from="member"');
    expect(words(followUp)).toContain(`Alex Kim${clock("09:00:00")}· from a comment on CALC-192`);
    // A member's words are Markdown, as the agent's prose: `**reloads**` is bold, its asterisks gone.
    expect(followUp).toContain("<strong>reloads</strong>");
  });

  it("F-151/c1: every tag of part 2 renders after the time", () => {
    const log = sceneLog({ taskId: taskIdSchema.parse(sceneId("ce3b", 1)), sessionId: sessionIdSchema.parse(sceneId("ce3b", 0x1a)), start: "09:00:00", prefix: "tags" });
    const say = (n: number, text: string, more: Partial<Extract<TaskEvent, { kind: "user.message" }>> = {}): void => {
      log.add({ kind: "user.message", memberId: sam.id, clientMessageId: clientMessageIdSchema.parse(sceneId("ce3b", n)), text, delivery: "immediate", ...more });
    };
    say(1, "Stop and use local storage.", { delivery: "after-interrupt" });
    say(2, "Add a Clear button.", { replayed: true });
    say(3, planRevisionPrompt("Keep the store in one file."), { intent: "plan-revision" });
    say(4, fixChecksPrompt([{ name: "lint", command: "pnpm lint", status: "failed", outputTail: "1 error" }, { name: "test", command: "pnpm test", status: "failed", outputTail: "" }]), { intent: "fix-checks" });
    say(5, "Also the README.", { intent: "linear-follow-up" });
    say(6, "Please look at the comments below.", { intent: "diff-comments" });
    const diffSeq = log.events().at(-1)?.seq ?? 0;
    const sent = sentBySeq([
      { commentId: diffCommentIdSchema.parse(sceneId("ce3b", 0x701)), path: "src/history/panel.tsx", line: 18, quoted: { kind: "add", text: '<li className="row">{r.expr}</li>' }, body: "Mono here, like the display.", sentInSeq: diffSeq },
      { commentId: diffCommentIdSchema.parse(sceneId("ce3b", 0x702)), path: "src/history/store.ts", line: 9, quoted: { kind: "add", text: "const MAX = 50;" }, body: "Name it HISTORY_LIMIT.", sentInSeq: diffSeq },
    ]);
    const optimistic: OptimisticMessage = { clientMessageId: clientMessageIdSchema.parse(sceneId("ce3b", 9)), memberId: sam.id, text: "One more thing.", delivery: "immediate" };
    const bubbles = bubblesIn(render({ taskId: sceneId("ce3b", 1), kind: "code", events: log.events() }, { ticketKey: "CALC-192", sent, optimistic: [optimistic] }));
    const tags = bubbles.map((bubble) => elementsAt(bubble, "data-tag=").map(words));
    expect(tags).toEqual([
      ["· after an interrupt"],
      ["· replayed"],
      ["· asked for changes"],
      ["· asked to fix 2 checks"],
      ["· from a comment on CALC-192"],
      ["· 2 comments on the diff"],
      ["· sending…"],
    ]);
    // Diff comments are quoted where they are: the place, the quoted line, the words; never a box in the bubble.
    expect(words(bubbles[5] ?? "")).toContain('src/history/panel.tsx:18+ <li className="row">{r.expr}</li>Mono here, like the display.');
    expect(bubbles[5]).toContain("border-l-2 border-line-3");

    // Queued, reopened the task (`states-messages` cell 5), and held in red (cell 6).
    const between = bubblesIn(render(stateCells.messages[5]));
    expect(between.map((bubble) => elementsAt(bubble, "data-tag=").map(words))).toEqual([[], ["· reopened the task"], ["· queued"]]);
    const held = bubblesIn(render(stateCells.messages[6].code)).at(-1) ?? "";
    const word = one(elementsAt(held, 'data-testid="message-held"'));
    expect(words(word)).toBe("held");
    expect(word).toContain("text-red");
  });
});

describe("dividers (parts.md part 12)", () => {
  it("F-151/c1: no divider for a runner connecting, a config change or a save; the plan's and the build's markers stand", () => {
    for (const shown of [s5Approved, s2]) {
      const html = render(shown);
      expect(shown.events.some(({ event }) => event.kind === "runner.connected")).toBe(true);
      expect(shown.events.some(({ event }) => event.kind === "session.saved")).toBe(true);
      const kinds = elementsAt(html, 'data-part="divider"').map((divider) => /data-divider="([a-z-]+)"/.exec(divider)?.[1]);
      expect(kinds.every((kind) => kind === "plan-turn" || kind === "build-turn" || kind === "day" || kind === "effort")).toBe(true);
      expect(words(html)).not.toMatch(/runner connected|Work saved|archive \d/i);
    }
    const markers = elementsAt(render(s5Approved), 'data-part="divider"').map(words);
    expect(markers).toEqual(["Plan first: OpenCode reads the code and proposes a plan. It can't edit files or run commands.", "OpenCode works from the approved plan. Plan mode is off."]);
  });

  it("F-151/c1: between turns, the day, how the session came back on its runner, and a new driver", () => {
    const html = render(stateCells.messages[5], { runner: "alex-desktop" });
    const dividers = elementsAt(html, 'data-part="divider"');
    expect(dividers.map((divider) => /data-divider="([a-z-]+)"/.exec(divider)?.[1])).toEqual(["day", "restored", "driver"]);
    expect(words(dividers[1] ?? "")).toBe("Restored from the session archive on alex-desktop · unfinished work restored");
    expect(words(dividers[2] ?? "")).toBe("Sam Rivera is driving now (Alex Kim handed it over)");
    // The day: the reopen came the next day (`Today`, `Yesterday` or `Fri 20 Nov`, by when the page is read), mono, no icon.
    expect(words(dividers[0] ?? "")).toMatch(/^(Today|Yesterday|[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2})$/);
    expect(dividers[0]).toContain("font-mono");
    expect(dividers[0]).not.toContain("<svg");
    expect(html.indexOf('data-divider="day"')).toBeGreaterThan(html.indexOf("The button is in."));
    // How the session came back stands before the reopen's message, though the log writes it after; once.
    expect(html.indexOf('data-divider="restored"')).toBeLessThan(html.indexOf("Also confirm before clearing."));
    expect(html.indexOf('data-divider="restored"')).toBeGreaterThan(html.indexOf('data-divider="day"'));
  });
});

/** A small task: Sam asks, the agent asks back, the turn ends with the question open, and the box goes. */
const lateLog = (group: string) => {
  const taskId = taskIdSchema.parse(sceneId(group, 1));
  const log = sceneLog({ taskId, sessionId: sessionIdSchema.parse(sceneId(group, 0x1a)), start: "14:02:00", prefix: group });
  log.add({ kind: "user.message", memberId: sam.id, clientMessageId: clientMessageIdSchema.parse(sceneId(group, 2)), text: "Add a history panel.", delivery: "immediate" });
  const turnId = turnIdSchema.parse(sceneId(group, 0x101));
  log.add({ kind: "turn.started", turnId });
  const steps = turnSteps(log, turnId, sceneWorld.repoDir);
  steps.say("One thing the mock doesn't settle:");
  return { taskId, log, turnId, steps };
};

describe("answers become receipts (parts.md part 12, content fix 10)", () => {
  it("F-151/c5: a late question-answer, plan-approved and approval-answer message is its receipt, never a bubble", () => {
    // A question the turn's end closed, answered once the box was gone: the answer reopens the task.
    const question = lateLog("ce4a");
    const questionId = questionIdSchema.parse(sceneId("ce4a", 0x201));
    const fields = [{ id: "use", label: "Use", type: "select" as const, options: ["Replace the display", "Add it to the expression"] }];
    question.log.add({ kind: "question.asked", turnId: question.turnId, questionId, message: calc192.question.message, fields });
    question.log.add({ kind: "turn.ended", turnId: question.turnId, stopReason: "end_turn" });
    question.log.add({ kind: "question.closed", questionId, reason: "expired" });
    question.log.at("14:40:00");
    question.log.add({ kind: "question.answered", questionId, answers: { use: "Replace the display" }, memberId: sam.id });
    question.log.add({ kind: "user.message", memberId: sam.id, clientMessageId: clientMessageIdSchema.parse(sceneId("ce4a", 3)), text: lateQuestionAnswerPrompt({ question: calc192.question.message, fields, answers: { use: "Replace the display" } }), delivery: "immediate", reopen: true });
    const answered = render({ taskId: question.taskId, kind: "code", events: question.log.events() });
    expect(bubblesIn(answered).map(words).map((bubble) => bubble.slice(0, 15))).toEqual([`Sam Rivera${clock("14:02:00")}`]);
    const receipt = one(elementsAt(answered, 'data-part="receipt"'));
    expect(words(receipt)).toBe(`Sam Rivera answered Replace the display${clock("14:40:00")}`);
    // In the reopen message's place, after the turn that asked: the turn draws no second one.
    expect(answered.indexOf('data-part="receipt"')).toBeGreaterThan(answered.indexOf('data-role="assistant"'));

    // A plan approved once the box was gone.
    const plan = lateLog("ce4b");
    const planTurn = turnIdSchema.parse(sceneId("ce4b", 0x102));
    plan.log.add({ kind: "turn.ended", turnId: plan.turnId, stopReason: "end_turn" });
    plan.log.add({ kind: "turn.started", turnId: planTurn, mode: "plan" });
    const entries = (texts: readonly string[]): PlanEntry[] => texts.map((content) => ({ content, priority: "medium", status: "pending" }));
    plan.log.add({ kind: "plan.proposed", turnId: planTurn, entries: entries(calc196Plan.proposed), message: "Six steps." });
    plan.log.add({ kind: "turn.ended", turnId: planTurn, stopReason: "end_turn" });
    plan.log.at("15:00:00");
    const text = calc196Plan.approved.map((entry, i) => `${String(i + 1)}. ${entry}`).join("\n");
    plan.log.add({ kind: "plan.answered", decision: "approve", text, memberId: alex.id, entries: entries(calc196Plan.approved), message: "Six steps." });
    plan.log.add({ kind: "user.message", memberId: alex.id, clientMessageId: clientMessageIdSchema.parse(sceneId("ce4b", 3)), text: approvedPlanPrompt({ text, edited: true }), delivery: "immediate", reopen: true });
    const approved = render({ taskId: plan.taskId, kind: "code", events: plan.log.events() });
    expect(bubblesIn(approved)).toHaveLength(1);
    const planReceipt = one(elementsAt(approved, 'data-part="receipt"'));
    expect(words(planReceipt)).toBe(`Plan approved by Alex Kim, with edits${clock("15:00:00")}Show the plan`);
    expect(planReceipt).toContain('data-action="show-plan"');

    // An approval answered after it expired.
    const approval = lateLog("ce4c");
    approval.log.add({ kind: "turn.ended", turnId: approval.turnId, stopReason: "end_turn" });
    approval.log.at("14:30:00");
    approval.log.add({ kind: "user.message", memberId: sam.id, clientMessageId: clientMessageIdSchema.parse(sceneId("ce4c", 3)), text: expiredApprovalAnswerPrompt({ decision: "allow_once", subject: "pnpm db:migrate", reason: null }), delivery: "immediate", reopen: true });
    const allowed = render({ taskId: approval.taskId, kind: "code", events: approval.log.events() });
    expect(bubblesIn(allowed)).toHaveLength(1);
    expect(words(one(elementsAt(allowed, 'data-part="receipt"')))).toBe(`Approved once by Sam Rivera · pnpm db:migrate${clock("14:30:00")}`);
  });

  it("F-151/c5: a free-text answer's receipt quotes the member's words, in its turn and as a late answer", () => {
    const cell = stateCells.asks[4].answered;
    const html = render(cell);
    expect(words(one(elementsAt(html, 'data-part="receipt"')))).toBe(`Sam Rivera answered “Replace it, but keep the expression in the line above”${clock("14:09:10")}`);
    // A late answer whose question isn't in view (an earlier page): its message's own words, quoted where they're the member's.
    const late = lateLog("ce4d");
    late.log.add({ kind: "turn.ended", turnId: late.turnId, stopReason: "end_turn" });
    late.log.at("14:50:00");
    const fields = [{ id: "use", label: "Use" }];
    late.log.add({ kind: "user.message", memberId: sam.id, clientMessageId: clientMessageIdSchema.parse(sceneId("ce4d", 3)), text: lateQuestionAnswerPrompt({ question: "Replace or add?", fields, answers: { use: "Neither: open a menu" }, other: ["use"] }), delivery: "immediate", reopen: true });
    expect(words(one(elementsAt(render({ taskId: late.taskId, kind: "code", events: late.log.events() }), 'data-part="receipt"')))).toBe(`Sam Rivera answered “Neither: open a menu”${clock("14:50:00")}`);
  });

  it("F-151/c5: Show the plan opens the approved plan with milestone 1's progress marks and its edited entries", () => {
    const html = render(s5Approved);
    // The plan turn's block became one receipt line, between the plan turn and the build turn's marker.
    const receipt = one(elementsAt(html, 'data-part="receipt"'));
    expect(words(receipt)).toBe(`Plan approved by Alex Kim, with edits${clock("14:09:00")}Show the plan`);
    expect(receipt).toContain('aria-expanded="false"');
    expect(html.indexOf('data-part="receipt"')).toBeLessThan(html.indexOf('data-divider="build-turn"'));
    // Opened: the plan as approved, the build's progress on each entry, `edited` on the one Alex changed.
    const answer = answersOf(s5Approved.events).plans.get(calc196.turns.plan);
    expect(answer).toBeDefined();
    if (answer === undefined) return;
    const opened = renderToStaticMarkup(<ShownPlanList id="plan" plan={{ entries: answer.entries, edited: answer.edited, progress: answer.progress }} />);
    const rows = elementsAt(opened, "data-status=");
    expect(rows.map((row) => /data-status="([a-z_]+)"/.exec(row)?.[1])).toEqual(["in_progress", "pending", "pending", "pending", "pending", "pending"]);
    expect(rows[0]).toContain("text-teal");
    expect(rows.map((row) => row.includes('data-edited="true"'))).toEqual([false, false, false, true, false, false]);
    expect(words(rows[3] ?? "")).toBe("4⌘Z and Ctrl+Z undo the last key, through the store's key historyedited");
    expect(rows[0]).toContain("<code");
  });
});
