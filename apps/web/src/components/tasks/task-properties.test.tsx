import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@ostra/api";
import { modelIdSchema, projectIdSchema, providerIdSchema, sessionIdSchema, storedEventSchema, taskIdSchema } from "@ostra/protocol";
import type { StoredEvent } from "@ostra/protocol";
import { deriveTaskState } from "@ostra/task-view";

import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { Properties } from "./task-view";

// F-084 (task.md, "Properties panel"; m3/task-approval, "Tokens, Cache, Spend"): each task shows its
// tokens in four kinds, its spend and its agent time, as `tasks.get` gives them from what the key
// proxy counted (F-089), and an estimated count says so. The properties panel the task page draws,
// with the API's answer and the live stream's fold handed in the way `TaskView` hands them.

type Task = RouterOutputs["tasks"]["get"];

const now = Date.now();
const taskId = taskIdSchema.parse("01900000-0000-7000-8000-0000000000c1");
const sessionId = sessionIdSchema.parse("01900000-0000-7000-8000-0000000000c2");
const providerId = providerIdSchema.parse("01900000-0000-7000-8000-0000000000c4");
const modelId = modelIdSchema.parse("01900000-0000-7000-8000-0000000000c5");

/** What the scripted turns of the e2e's counted task add up to (seed-answers.ts). */
const totals = { inputTokens: 28_000, outputTokens: 5_600, cacheReadTokens: 133_000, cacheWriteTokens: 3_500, reasoningTokens: 0, agentMs: 112_000 };

/** A running prompt task, as `tasks.get` answers for it, with its usage and spend. */
const taskOf = (over: { readonly usage: NonNullable<Task["usage"]>; readonly spend: Task["spend"] }): Task => ({
  id: taskId,
  projectId: projectIdSchema.parse("01900000-0000-7000-8000-0000000000c6"),
  key: "CALC-142",
  title: "Retry webhook delivery on 5xx",
  kind: "code",
  source: "prompt",
  state: "running",
  subState: null,
  reviewOf: null,
  aiReview: null,
  review: null,
  roundCounts: { ci: { used: 0, limit: 3 }, review: { used: 0, limit: 3 }, automaticTurns: { used: 0, limit: 10 }, lastPersonActionAt: null },
  reason: null,
  group: "running",
  waiting: null,
  queue: null,
  branchName: "ostra/calc-142",
  headSeq: 0,
  createdAt: now - 5 * 60_000,
  updatedAt: now,
  driver: null,
  creator: null,
  runner: null,
  repos: [],
  session: null,
  agent: null,
  effort: { level: "default", levels: [] },
  messageFiles: { model: null, agentTakesImages: false, oldRunner: null },
  needsYou: [],
  ticket: null,
  contextFiles: [],
  sync: [],
  sessions: [],
  box: null,
  limit: null,
  startedAt: now - 5 * 60_000,
  approvals: [],
  questions: [],
  plan: null,
  taskRules: [],
  capabilities: {
    send: false,
    interrupt: false,
    answerApprovals: false,
    takeOver: false,
    setEffort: false,
    steersMidTurn: false,
    questionFreeText: false,
    stop: false,
    reopen: false,
    reopenInBox: false,
    reopenBlocked: null,
    reopenWithoutText: false,
    retrySync: false,
    answerQuestions: false,
    answerPlan: false,
  },
  ...over,
});

/** The live stream's events: the turn's model calls as the key proxy counted them. */
const stored = (seq: number, event: unknown): StoredEvent => storedEventSchema.parse({ taskId, seq, sessionId, sessionSeq: seq, at: now - 60_000 + seq, event });
const call = (seq: number, tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }, estimated: boolean): StoredEvent =>
  stored(seq, { kind: "usage.recorded", providerId, modelId, inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite, estimated });

/** The panel as the task page draws it: its tokens from the stream's fold (`deriveTaskState`), the rest from `tasks.get`. */
const renderPanel = (task: Task, events: readonly StoredEvent[]): string => {
  const view = deriveTaskState(events);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Never called: the groups that read their own queries render empty.
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <Properties
          task={task}
          checks={null}
          tokens={view.tokens}
          reasoningTokens={view.reasoningTokens}
          context={view.context}
          now={now}
          onTakeOver={() => undefined}
          takingOver={false}
          ticket={null}
          effort={null}
          noKey={false}
          projectName="calculator"
        />
      </TRPCProvider>
    </QueryClientProvider>,
  );
};

/** The text inside the element marked `data-testid={id}`, its inner tags dropped. */
const textOf = (html: string, id: string): string | null => {
  const at = html.indexOf(`data-testid="${id}"`);
  if (at === -1) return null;
  const open = html.lastIndexOf("<", at);
  const tags = /<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>/g;
  tags.lastIndex = open;
  let depth = 0;
  let start = -1;
  for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
    if (match[3] === "/") continue;
    if (match[1] === "/") depth -= 1;
    else depth += 1;
    if (start === -1) start = tags.lastIndex;
    if (depth === 0) return html.slice(start, match.index).replaceAll(/<[^>]*>/g, "");
  }
  return null;
};

/** The label of the panel row that holds `data-testid={id}`. */
const labelOf = (html: string, id: string): string | null => {
  const before = html.slice(0, html.indexOf(`data-testid="${id}"`));
  const labels = [...before.matchAll(/<div class="grid [^"]*"><span class="[^"]*">([^<]*)<\/span>/g)];
  return labels.at(-1)?.[1] ?? null;
};

describe("the task's tokens, spend and agent time (F-084)", () => {
  it("F-084/c1: the properties panel shows the task's four kinds of tokens, its spend in dollars or in tokens, and its agent time, as tasks.get counted them", () => {
    // Each call's four kinds at the model's own prices ($3, $15, $0.30 and $3.75 a million), as ingest priced them.
    const priced = taskOf({
      usage: { totals: { ...totals, spentMicroUsd: 221_025, estimated: false }, turns: [] },
      spend: { unit: "usd", spent: 221_025, cap: 25_000_000, reached: false },
    });
    // The stream's page holds none of the calls (they are older than its history): the panel reads what tasks.get counted.
    const html = renderPanel(priced, []);
    expect(html).toContain('data-testid="task-properties"');
    expect(labelOf(html, "task-tokens")).toBe(t("taskPage.tokens"));
    expect(textOf(html, "task-tokens")).toBe(`28k ${t("taskPage.in")} · 5.6k ${t("taskPage.out")}`);
    expect(labelOf(html, "task-cache")).toBe(t("taskAnswers.usage.cache"));
    expect(textOf(html, "task-cache")).toBe(`133k ${t("taskAnswers.usage.read")} · 3.5k ${t("taskAnswers.usage.write")}`);
    expect(labelOf(html, "task-spend")).toBe(t("taskPage.spend"));
    expect(textOf(html, "task-spend")).toBe(t("taskPage.spendOf", { spent: "$0.22", cap: "$25.00" }));
    expect(labelOf(html, "task-agent-time")).toBe(t("taskAnswers.usage.agentTime"));
    expect(textOf(html, "task-agent-time")).toBe(t("units.minutesSeconds", { m: 1, s: "52" }));
    // Nothing was estimated: the count isn't marked.
    expect(html).not.toContain('data-testid="task-tokens-estimated"');

    // A model with no price: the spend is the four kinds' tokens against the token cap.
    const unpriced = taskOf({
      usage: { totals: { ...totals, spentMicroUsd: null, estimated: false }, turns: [] },
      spend: { unit: "tokens", spent: 170_100, cap: 10_000_000, reached: false },
    });
    expect(textOf(renderPanel(unpriced, []), "task-spend")).toBe(t("taskPage.spendOf", { spent: "170.1k", cap: "10M" }));

    // Mid-turn, the stream's own count of the calls runs ahead of what tasks.get last read, and the panel shows it.
    const ahead = renderPanel(priced, [
      call(1, { input: 18_000, output: 3_600, cacheRead: 90_000, cacheWrite: 2_000 }, false),
      call(2, { input: 10_000, output: 2_000, cacheRead: 43_000, cacheWrite: 1_500 }, false),
      call(3, { input: 4_000, output: 400, cacheRead: 0, cacheWrite: 0 }, false),
    ]);
    expect(textOf(ahead, "task-tokens")).toBe(`32k ${t("taskPage.in")} · 6k ${t("taskPage.out")}`);
  });

  it("F-084/c3: a count the key proxy estimated is marked \"≈\" and named an estimate", () => {
    const estimated = taskOf({
      usage: { totals: { ...totals, spentMicroUsd: 221_025, estimated: true }, turns: [] },
      spend: { unit: "usd", spent: 221_025, cap: 25_000_000, reached: false },
    });
    const html = renderPanel(estimated, [call(1, { input: 18_000, output: 3_600, cacheRead: 90_000, cacheWrite: 2_000 }, false), call(2, { input: 10_000, output: 2_000, cacheRead: 43_000, cacheWrite: 1_500 }, true)]);
    expect(textOf(html, "task-tokens")).toBe(`≈ 28k ${t("taskPage.in")} · 5.6k ${t("taskPage.out")}`);
    expect(textOf(html, "task-tokens-estimated")).toBe(t("taskPage.estimated"));
  });
});
