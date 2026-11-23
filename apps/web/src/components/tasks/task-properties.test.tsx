import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@ostra/api";
import { agentProfileIdSchema, memberIdSchema, modelIdSchema, projectIdSchema, providerIdSchema, repoIdSchema, runnerIdSchema, sessionIdSchema, storedEventSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { StoredEvent, TurnId } from "@ostra/protocol";
import { deriveTaskState } from "@ostra/task-view";
import type { TurnSpend } from "@ostra/task-view";
import { calc192, calc192Spend, review483, review483Spend, s1, s2, s3, sceneMembers, sceneWorld } from "@ostra/task-view/testing";
import type { Scene } from "@ostra/task-view/testing";

import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { panelTurnsOf } from "./task-properties-words";
import type { PanelTurns } from "./task-properties-words";
import { Properties } from "./task-view";

// F-084 (task.md, "Properties panel"; m3/task-approval, "Tokens, Cache, Spend"): each task shows its
// tokens in four kinds, its spend and its agent time, as `tasks.get` gives them from what the key
// proxy counted (F-089), and an estimated count says so. F-151/c3 (milestone 10, ticket 16;
// parts.md part 15, `s1.md`, `s2.md`, `s3.md`): the panel's groups, its Usage and Session holding
// the turns' numbers for the task as a whole, over the targets' recorded scenes. The properties
// panel the task page draws, with the API's answer and the live stream's fold handed in the way
// `TaskView` hands them.

type Task = RouterOutputs["tasks"]["get"];
type UsageTurns = NonNullable<Task["usage"]>["turns"];

const fail = (what: string): never => {
  throw new Error(`missing: ${what}`);
};

const now = Date.now();
const taskId = taskIdSchema.parse("01900000-0000-7000-8000-0000000000c1");
const sessionId = sessionIdSchema.parse("01900000-0000-7000-8000-0000000000c2");
const providerId = providerIdSchema.parse("01900000-0000-7000-8000-0000000000c4");
const modelId = modelIdSchema.parse("01900000-0000-7000-8000-0000000000c5");

/** What the scripted turns of the e2e's counted task add up to (seed-answers.ts). */
const totals = { inputTokens: 28_000, outputTokens: 5_600, cacheReadTokens: 133_000, cacheWriteTokens: 3_500, reasoningTokens: 0, agentMs: 112_000 };

/** A running prompt task, as `tasks.get` answers for it, with its usage and spend. */
const taskOf = (over: Partial<Task> & { readonly usage: Task["usage"]; readonly spend: Task["spend"] }): Task => ({
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

const noTurns: PanelTurns = { count: 0, anyEnded: false, saved: { kind: "none" }, savedChecks: null };

/** The panel as the task page draws it: its tokens from the stream's fold (`deriveTaskState`), the rest from `tasks.get`, and members' files as `tasks.files` answers. */
const renderPanel = (task: Task, events: readonly StoredEvent[], turns: PanelTurns = noTurns, people: { readonly images: number; readonly files: number } | null = null): string => {
  const view = deriveTaskState(events);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  // Never called: the groups that read their own queries render from the cache, or empty.
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  if (people !== null) {
    const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
    queryClient.setQueryData(trpc.tasks.files.queryKey({ taskId: task.id }), { files: [], people: { ...people, bytes: 61_000, folders: [] } });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <Properties
          task={task}
          meId={sceneMembers.sam.id}
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
          turns={turns}
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

const decode = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** Markup's words as a reader takes them: each tag a gap, the gaps one space. */
const wordsOf = (html: string): string => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** The panel's groups in order: each one's title and its rows' words (`Box Idle · stops in 11 min`). */
const groupsOf = (html: string): { readonly title: string; readonly rows: readonly string[] }[] => {
  const titles = [...html.matchAll(/<h3 class="[^"]*">([^<]*)<\/h3>/g)];
  return titles.map((match, index) => {
    const body = html.slice(match.index + match[0].length, titles[index + 1]?.index ?? html.length);
    return { title: decode(match[1] ?? ""), rows: body.split(/(?=<div class="grid )/).filter((chunk) => chunk.startsWith('<div class="grid ')).map(wordsOf) };
  });
};
const groupNamed = (html: string, title: string): readonly string[] => groupsOf(html).find((group) => group.title === title)?.rows ?? fail(`the ${title} group`);

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
    // F-151/c3: the four kinds, the spend and the agent time are the Usage group's.
    expect(groupNamed(html, t("taskPage.panel.usage")).map((row) => row.split(" ")[0])).toEqual(["Tokens", "Reasoning", "Cache", "Spend", "Time", "Agent"]);
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

// ---- milestone 10: the groups, over the targets' recorded scenes ------------------------------

/** A scene's turns as `tasks.get`'s `usage.turns` gives them: each turn's calls summed, as ingest counts them, and priced. */
const usageTurnsOf = (scene: Scene, spend: ReadonlyMap<TurnId, TurnSpend>): UsageTurns => {
  type Row = { turnId: TurnId; sessionId: string; startedAt: number; endedAt: number | null; input: number; output: number; read: number; write: number; reasoning: number };
  const rows: Row[] = [];
  for (const { sessionId: session, at, event } of scene.events) {
    const open = rows.at(-1);
    if (event.kind === "turn.started") rows.push({ turnId: event.turnId, sessionId: String(session), startedAt: at, endedAt: null, input: 0, output: 0, read: 0, write: 0, reasoning: 0 });
    else if ((event.kind === "turn.ended" || event.kind === "turn.failed") && open?.turnId === event.turnId) open.endedAt = at;
    else if (event.kind === "usage.recorded" && open?.endedAt === null) {
      open.input += event.inputTokens;
      open.output += event.outputTokens;
      open.read += event.cacheReadTokens;
      open.write += event.cacheWriteTokens;
      open.reasoning += event.reasoningTokens ?? 0;
    }
  }
  return rows.map((row, index) => ({
    turnId: turnIdSchema.parse(row.turnId),
    sessionId: sessionIdSchema.parse(row.sessionId),
    ordinal: index + 1,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    inputTokens: row.input,
    outputTokens: row.output,
    cacheReadTokens: row.read,
    cacheWriteTokens: row.write,
    spentMicroUsd: spend.get(row.turnId)?.microUsd ?? null,
    agentMs: row.endedAt === null ? 0 : row.endedAt - row.startedAt,
    estimated: spend.get(row.turnId)?.estimated ?? false,
    effort: "high",
    adjustedFrom: null,
    reasoningTokens: row.reasoning,
  }));
};

/** A scene's task as `tasks.get` answers for it: its usage summed from its turns, its spend theirs, Sam driving OpenCode on `build-fleet-03`. */
const sceneTask = (scene: Scene, spend: ReadonlyMap<TurnId, TurnSpend>, over: Partial<Task>): { readonly task: Task; readonly turns: UsageTurns } => {
  const turns = usageTurnsOf(scene, spend);
  const sum = (pick: (turn: UsageTurns[number]) => number): number => turns.reduce((total, turn) => total + pick(turn), 0);
  const spent = sum((turn) => turn.spentMicroUsd ?? 0);
  const task = taskOf({
    id: scene.taskId,
    usage: {
      totals: {
        inputTokens: sum((turn) => turn.inputTokens),
        outputTokens: sum((turn) => turn.outputTokens),
        cacheReadTokens: sum((turn) => turn.cacheReadTokens),
        cacheWriteTokens: sum((turn) => turn.cacheWriteTokens),
        reasoningTokens: sum((turn) => turn.reasoningTokens),
        spentMicroUsd: spent,
        agentMs: sum((turn) => turn.agentMs ?? 0),
        estimated: turns.some((turn) => turn.estimated),
      },
      turns,
    },
    spend: { unit: "usd", spent, cap: 25_000_000, reached: false },
    driver: { memberId: memberIdSchema.parse(sceneMembers.sam.id), name: sceneMembers.sam.name },
    runner: { id: runnerIdSchema.parse("01900000-0000-7000-8000-0000000000d1"), name: "build-fleet-03", kind: "pool", executor: "docker", isolated: true },
    agent: {
      id: agentProfileIdSchema.parse("01900000-0000-7000-8000-0000000000d2"),
      name: "Careful",
      adapter: "opencode",
      agentName: "OpenCode",
      model: { id: modelId, name: "Claude Sonnet 5.5", imageInput: "yes" },
      builtInKind: null,
      mcpServers: [],
    },
    ...over,
  });
  return { task, turns };
};

const repo = (over: Partial<Task["repos"][number]>): Task["repos"][number] => ({
  repoId: repoIdSchema.parse("01900000-0000-7000-8000-0000000000e1"),
  fullName: "acme/calculator-web",
  checkoutDir: "calculator-web",
  branchName: sceneWorld.branch,
  baseBranch: "main",
  state: "pr_open",
  headSha: calc192.pushSha,
  ci: null,
  pr: null,
  behindBy: null,
  behindCheckedAt: null,
  pullRequests: [],
  ...over,
});

const box = (over: Partial<NonNullable<Task["box"]>>): NonNullable<Task["box"]> => ({ state: "running", idleStopDueAt: null, releasedAt: null, releaseReason: null, runnerName: "build-fleet-03", size: null, waiting: null, ...over });

/** `22400` as the panel writes a count of tokens: `22.4k`. */
const short = (n: number): string => `${String(Number((n / 1_000).toFixed(1)))}k`;

describe("the properties panel's groups (F-151/c3)", () => {
  it("F-151/c3: a code task's panel, S2: Properties, Usage, Code with Checks and CI, Session with the box, the saved work and the turns, then Attachments", () => {
    const { task, turns } = sceneTask(s2, calc192Spend.pr, {
      state: "in_review",
      subState: "ci_running",
      group: "in-review",
      box: box({ state: "idle", idleStopDueAt: now + 11 * 60_000 }),
      repos: [repo({ pr: { number: calc192.pr.number, url: calc192.pr.url, state: "open" }, ci: { state: "running", failing: null, jobs: { done: 2, total: 4 }, failingJobs: [] } })],
    });
    // The page reads the log for the newest save and numbers the turns as the thread does.
    const html = renderPanel(task, s2.events, panelTurnsOf(s2.events, turns, false), { images: 1, files: 1 });
    expect(groupsOf(html).map((group) => group.title)).toEqual([t("taskPage.properties"), t("taskPage.panel.usage"), t("taskPage.code"), t("taskPage.session.label"), t("task.files.group")]);
    const properties = groupNamed(html, t("taskPage.properties"));
    expect(properties).toContain("Status In review · CI running");
    expect(properties).toContain("Driver SR Sam Rivera · you");
    expect(properties).toContain("Agent OpenCode");
    expect(properties).toContain("Model Claude Sonnet 5.5");
    expect(properties).toContain("Runner build-fleet-03 pool docker");
    // The task's totals: every turn's tokens, reasoning and spend (turn 3's estimated), against the cap.
    const sum = (pick: (turn: UsageTurns[number]) => number): number => turns.reduce((total, turn) => total + pick(turn), 0);
    const usage = groupNamed(html, t("taskPage.panel.usage"));
    expect(usage[0]).toBe(`Tokens ≈ ${short(sum((turn) => turn.inputTokens))} in · ${short(sum((turn) => turn.outputTokens))} out`);
    expect(usage[1]).toBe(`Reasoning ${short(sum((turn) => turn.reasoningTokens))}`);
    expect(usage).toContain("Spend $2.14 of $25.00");
    // ostra's checks in the box, as the newest save counted them, and the code host's CI in jobs.
    expect(groupNamed(html, t("taskPage.code"))).toEqual(["Repo acme/calculator-web", `Branch ${sceneWorld.branch}`, `PR #${String(calc192.pr.number)} · open`, "Checks 3 of 3 passed · in the box", "CI Running · 2 of 4 jobs"]);
    expect(groupNamed(html, t("taskPage.session.label"))).toEqual(["Box Idle · stops in 11 min", "Saved work After turn 4 · 193 kB", "Turns 4"]);
    expect(groupNamed(html, t("task.files.group"))[0]).toBe("From people 1 image · 1 file");
  });

  it("F-151/c3: mid-turn, S1: the box waits on you, nothing is saved while the turn is open, and no turn has ended to count", () => {
    const { task, turns } = sceneTask(s1, calc192Spend.question, { state: "needs_you", reason: "question", group: "needs-you", box: box({ state: "running" }), repos: [repo({ state: "no_branch" })] });
    const html = renderPanel(task, s1.events, panelTurnsOf(s1.events, turns, true));
    expect(groupNamed(html, t("taskPage.code"))).toEqual(["Repo acme/calculator-web", `Branch ${sceneWorld.branch}`, `PR ${t("taskPage.noPr")}`]);
    expect(groupNamed(html, t("taskPage.session.label"))).toEqual(["Box Running · waits on you", "Saved work Not yet: the turn is open"]);
    expect(groupNamed(html, t("taskPage.panel.usage"))).toContain("Spend $0.62 of $25.00");
  });

  it("F-151/c3: a review task's panel, S3: its Result group, no Code group and no saved work", () => {
    const { task, turns } = sceneTask(s3, review483Spend, {
      kind: "review",
      state: "done",
      group: "finished",
      title: "Review of PR #483",
      box: box({ state: "released", releaseReason: "session_ended" }),
      reviewOf: { taskId: calc192.taskId, key: "CALC-192", title: "Add a history panel", prs: [{ repo: "acme/calculator-web", number: calc192.pr.number, url: calc192.pr.url }], run: { round: 2, state: "posted", blocking: 0, nits: 1 } },
      review: { round: 2, limit: 3, state: "posted", blocking: 0, nits: 1, url: review483.reviewUrl, codeTask: { id: calc192.taskId, key: "CALC-192", title: "Add a history panel" }, prNumber: calc192.pr.number },
    });
    const html = renderPanel(task, s3.events, panelTurnsOf(s3.events, turns, false));
    const titles = groupsOf(html).map((group) => group.title);
    expect(titles).toEqual([t("taskPage.properties"), t("taskPage.panel.result"), t("taskPage.panel.usage"), t("taskPage.session.label")]);
    expect(titles).not.toContain(t("taskPage.code"));
    const properties = groupNamed(html, t("taskPage.properties"));
    expect(properties).toContain("Status Done");
    expect(properties).toContain("Kind AI review");
    expect(properties).toContain(`Reviews PR #${String(calc192.pr.number)} · CALC-192`);
    expect(properties).toContain("Round 2 of 3");
    // The released box's runner is the one it last ran on, as `s3.md` draws it.
    expect(properties).toContain("Runner build-fleet-03");
    expect(groupNamed(html, t("taskPage.panel.result"))).toEqual(["Blocking None", "Nits 1", "Review Open the review"]);
    expect(html).toContain(`href="/tasks/${calc192.taskId}/review"`);
    // A review keeps no work: its Session group has the box and the turns, and no saved work.
    expect(html).not.toContain('data-testid="task-saved-work"');
    expect(groupNamed(html, t("taskPage.session.label"))).toEqual(["Box Released · its session ended", "Turns 2"]);
  });

  it("F-151/c3: a review not yet handed in has no Result group", () => {
    const { task, turns } = sceneTask(s3, review483Spend, {
      kind: "review",
      review: { round: 2, limit: 3, state: "running", blocking: 0, nits: 0, url: null, codeTask: { id: calc192.taskId, key: "CALC-192", title: "Add a history panel" }, prNumber: calc192.pr.number },
    });
    const html = renderPanel(task, s3.events, panelTurnsOf(s3.events, turns, true));
    expect(groupsOf(html).map((group) => group.title)).not.toContain(t("taskPage.panel.result"));
  });
});
