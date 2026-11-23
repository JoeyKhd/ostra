import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@ostra/api";
import { repoIdSchema, storedEventSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { StoredEvent } from "@ostra/protocol";
import { foldTaskEvents, turnItemsOf } from "@ostra/task-view";
import type { RunItem, TaskUIMessage, ThreadContext } from "@ostra/task-view";
import { calc192, s2, s3, sceneMembers, sceneWorld, stateCells } from "@ostra/task-view/testing";
import type { Scene } from "@ostra/task-view/testing";

import { cardStatusParts } from "@/components/home/board-words";
import { cardStatusOf } from "@/components/home/home-board-view";
import { prCiRow, runningCiJobs, stagesOf } from "@/components/tasks/review/review-words";
import { StageLine } from "@/components/tasks/review/task-rounds";
import { markerWithCi } from "@/components/tasks/task-checks/check-words";
import { ChecksTabMarker } from "@/components/tasks/task-checks/task-checks";
import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { toThreadMessageLike } from "../convert";
import { createTaskIndexStore, indexMessages, TaskContext } from "../task-context";
import type { TaskContextValue } from "../task-context";
import { MessageView } from "../task-thread";
import { headVerdictsKey, headVerdictsOf, withHeadCi } from "./head-ci";
import { runOpenStoreOf } from "./run-open";
import { ThreadParts } from "./thread-context";
import type { ThreadPartsValue, ThreadPr, ThreadResults } from "./thread-context";
import type { HeadCi } from "./words";

// Milestone 10, ticket 14 (F-151/c6, c7, c8): what a turn made. The targets' recorded scenes
// through the real fold, drawn by the thread's own `MessageView` inside assistant-ui's runtime as
// the task page draws them, with `tasks.get`'s CI and PRs in the thread's context and the Changes
// tab's compare in the query cache: S2's push line and its PR card once under it, CI counted in
// jobs and updated as `tasks.get` is; a later push one line; a failing check red and the PR a
// draft; the Checks tab's marker, the stage line, the review screen and Home's board in jobs; S3's
// review lines; a refine task's draft; the preview shown and a memory proposed.

const names = new Map<string, string>(Object.values(sceneMembers).map((member) => [member.id, member.name]));
const contextOf = (scene: Scene): ThreadContext => ({ taskId: scene.taskId, checkoutDirs: ["calculator-web"], mcpServers: ["github"] });
const fold = (scene: Scene, events = scene.events): TaskUIMessage[] => foldTaskEvents(events, scene.liveText, { taskKind: scene.kind });

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

const running = (done: number, total: number): HeadCi => ({ state: "running", jobs: { done, total }, failingJobs: [] });
const prOpenedAt = s2.events.find(({ event }) => event.kind === "pr.opened")?.at ?? 0;
const pr483: ThreadPr = { number: calc192.pr.number, state: "open", draft: false, openedAt: prOpenedAt };

/** `tasks.get`'s side of the results for S2's repo: its head, its PR, the project's AI review on. */
const resultsOf = (input: { readonly head?: string; readonly pr?: ThreadPr; readonly ci: HeadCi | null; readonly events?: readonly StoredEvent[]; readonly reviewHref?: string | null }): ThreadResults =>
  withHeadCi(
    { projectId: "calculator-id", aiReview: true, headOf: () => input.head ?? calc192.pushSha, prsOf: () => [input.pr ?? pr483], reviewHref: input.reviewHref ?? null },
    () => input.ci,
    headVerdictsOf(headVerdictsKey(input.events ?? [])),
  );

type Diff = RouterOutputs["diff"]["get"];

/** The Changes tab's compare of S2's head: six files, `+214 −18`. */
const s2Diff = (): Diff => {
  const sizes = [[46, 0], [58, 0], [64, 3], [27, 0], [7, 9], [12, 6]] as const;
  return {
    taskId: s2.taskId,
    asOf: null,
    repos: [
      {
        taskRepoId: taskRepoIdSchema.parse("0196f1a0-ca1c-7000-8000-000000000011"),
        repoId: repoIdSchema.parse(sceneWorld.repoId),
        repo: sceneWorld.repo,
        branch: sceneWorld.branch,
        base: "main",
        headSha: calc192.pushSha,
        prUrl: calc192.pr.url,
        state: "ready",
        aheadBy: 4,
        behindBy: 0,
        mergeBase: null,
        filesTruncated: false,
        hostUrl: null,
        files: sizes.map(([additions, deletions], index) => ({ path: `src/file-${String(index)}.ts`, previousPath: null, status: "modified", additions, deletions, kind: "binary", hunks: [], oldNoNewlineAtEnd: false, newNoNewlineAtEnd: false })),
      },
    ],
  };
};

/** The scene's messages as the task page's thread draws them; `index` keeps what the viewer opened. */
const render = (scene: Scene, messages: readonly TaskUIMessage[], input: { readonly ci?: HeadCi | null; readonly results?: ThreadResults; readonly diff?: Diff; readonly index?: ReturnType<typeof createTaskIndexStore> } = {}): string => {
  const store = input.index ?? createTaskIndexStore();
  store.set(indexMessages(messages));
  const context: TaskContextValue = { store, memberName: (id) => names.get(id) ?? "", agent: { name: "OpenCode", model: "Claude Sonnet 5.5" }, approvalSummary: () => null };
  const ci = input.ci ?? null;
  const parts: ThreadPartsValue = { taskKind: scene.kind, workspace: contextOf(scene), project: "calculator", capMicroUsd: null, ciOf: () => ci, ...(input.results === undefined ? {} : { results: input.results }) };
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } });
  // Never called: what this render reads is in the cache, or the part renders without it.
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
  if (input.diff !== undefined) queryClient.setQueryData(trpc.diff.get.queryKey({ taskId: scene.taskId }), input.diff);
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
const elementAt = (html: string, marker: string, from = 0): string => {
  const at = html.indexOf(marker, from);
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
  const out: string[] = [];
  for (let at = html.indexOf(marker); at !== -1; at = html.indexOf(marker, at + marker.length)) out.push(elementAt(html, marker, at));
  return out;
};

/** What the markup reads, as a person sees it. */
const textOf = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim();

/** The words inside every red span of some markup. */
const redWords = (html: string): string[] => [...html.matchAll(/<span class="[^"]*\btext-red\b[^"]*">([^<]*)<\/span>/g)].map((match) => match[1] ?? "");

/** The column's items in order, as `{kind}:{part}` (`result:result`, `result:pr-card`). */
const itemsInOrder = (html: string): string[] => [...html.matchAll(/data-item-kind="([a-z]+)"[^>]*><div[^>]*data-part="([a-z-]+)"/g)].map((match) => `${match[1] ?? ""}:${match[2] ?? ""}`);

/** S2 with the CI round's turn after it (states-messages, cell 1): a later push to the open PR #483, an hour on. */
const s2ThenRound = (): Scene => {
  const last = s2.events.at(-1);
  const round = stateCells.messages[1];
  const events = [...s2.events, ...round.events.map((stored, index) => storedEventSchema.parse({ ...stored, taskId: s2.taskId, seq: (last?.seq ?? 0) + index + 1, at: stored.at + 5 * 3_600_000 }))];
  return { ...s2, name: "s2-then-round", events };
};

describe("what a turn made (F-151/c6)", () => {
  it("F-151/c6: S2's push line says 3 checks passed in the box; the card shows once under it, running 2 of 4 jobs, and says passed · 4 jobs when tasks.get does", () => {
    const messages = fold(s2);
    const html = render(s2, messages, { ci: running(2, 4), results: resultsOf({ ci: running(2, 4) }), diff: s2Diff() });
    // One push line: the hidden ref's three saves are no result.
    const pushes = elementsAt(html, 'data-result="push"');
    expect(pushes.map(textOf)).toEqual(["Pushed ostra/calc-192-history-panel · 3 checks passed in the box"]);
    expect(redWords(pushes.join(""))).toEqual([]);
    expect(pushes[0]).toContain('aria-expanded="false"');
    // The card: once, the item right after the push that opened it.
    const order = itemsInOrder(html);
    expect(order.filter((item) => item === "result:pr-card")).toHaveLength(1);
    expect(order[order.indexOf("result:result") + 1]).toBe("result:pr-card");
    const card = elementAt(html, 'data-part="pr-card"');
    expect(card).toContain('data-pr-look="open"');
    expect(card).toContain("lucide-git-pull-request ");
    expect(textOf(elementAt(card, 'data-part="pr-size"'))).toBe("+214−18");
    expect(card).toContain(`href="${calc192.pr.url}"`);
    const ciLine = elementAt(card, 'data-part="pr-ci"');
    expect(textOf(ciLine)).toBe("CI on GitHub: running, 2 of 4 jobs done · then the AI review");
    expect(ciLine).toContain("animate-spin");
    // `tasks.get` says CI passed: the same card, its line in place, no spinner.
    const passed = render(s2, messages, { ci: { state: "passed", jobs: { done: 4, total: 4 }, failingJobs: [] }, results: resultsOf({ ci: null }), diff: s2Diff() });
    expect(elementsAt(passed, 'data-part="pr-card"')).toHaveLength(1);
    const passedLine = elementAt(passed, 'data-part="pr-ci"');
    expect(textOf(passedLine)).toBe("CI on GitHub passed · 4 jobs");
    expect(passedLine).not.toContain("animate-spin");
    const failed = elementAt(render(s2, messages, { ci: { state: "failed", jobs: { done: 4, total: 4 }, failingJobs: ["e2e"] }, results: resultsOf({ ci: null }) }), 'data-part="pr-ci"');
    expect([textOf(failed), redWords(failed)]).toEqual(["CI on GitHub failed: e2e", ["failed"]]);
    expect(textOf(elementAt(render(s2, messages, { ci: { state: "none", jobs: { done: 0, total: 0 }, failingJobs: [] } }), 'data-part="pr-ci"'))).toBe("No CI on GitHub");
  });

  it("F-151/c6: the push opens in place on its commit, how far it is ahead, and a link to the Changes tab", () => {
    const messages = fold(s2);
    const index = createTaskIndexStore();
    const push = messages.flatMap((message) => turnItemsOf(message, contextOf(s2))).find((item) => item.kind === "result" && item.result.kind === "push");
    expect(push).toBeDefined();
    if (push === undefined) return;
    runOpenStoreOf(index).toggleRun({ id: push.id, steps: [] });
    const html = render(s2, messages, { ci: running(2, 4), results: resultsOf({ ci: running(2, 4) }), diff: s2Diff(), index });
    const line = elementAt(html, 'data-result="push"');
    expect(line).toContain('aria-expanded="true"');
    const commit = elementAt(line, 'data-push-row="commit"');
    expect(textOf(commit)).toBe("Pushed9c1e2f04 commits ahead of mainchanges");
    expect(commit).toContain(`href="/tasks/${s2.taskId}?tab=changes"`);
  });

  it("F-151/c6: a second push is one line, `Pushed {sha7} · CI passed` once CI says, with no second card", () => {
    const scene = s2ThenRound();
    const messages = fold(scene);
    const later = "9a03d1e".padEnd(40, "0");
    // The PR's head is the later push, and `tasks.get` says its CI passed.
    const html = render(scene, messages, { ci: { state: "passed", jobs: { done: 4, total: 4 }, failingJobs: [] }, results: resultsOf({ head: later, ci: { state: "passed", jobs: { done: 4, total: 4 }, failingJobs: [] }, events: scene.events }) });
    expect(elementsAt(html, 'data-result="push"').map(textOf)).toEqual(["Pushed ostra/calc-192-history-panel · 3 checks passed in the box", "Pushed 9a03d1e · CI passed"]);
    expect(elementsAt(html, 'data-part="pr-card"')).toHaveLength(1);
    // A head pushed since: the later push's own verdict is the log's `ci.updated`.
    const since = render(scene, messages, { ci: running(0, 4), results: resultsOf({ head: "1111111".padEnd(40, "0"), ci: running(0, 4), events: scene.events }) });
    expect(textOf(elementsAt(since, 'data-result="push"')[1] ?? "")).toBe("Pushed 9a03d1e · CI passed");
    // Before CI says, the line is the push alone.
    const before = render(scene, messages, { results: resultsOf({ head: later, ci: null, events: [] }) });
    expect(textOf(elementsAt(before, 'data-result="push"')[1] ?? "")).toBe("Pushed 9a03d1e");
  });

  it("F-151/c6: a failing check makes the push line's one red word and the card's draft icon", () => {
    const events = s2.events.map((stored) =>
      stored.event.kind === "session.saved" && stored.event.checks !== undefined
        ? storedEventSchema.parse({ ...stored, event: { ...stored.event, checks: stored.event.checks.map((check, index) => (index === 0 ? { ...check, status: "failed" } : check)) } })
        : stored,
    );
    const html = render(s2, fold(s2, events), { ci: running(1, 4), results: resultsOf({ pr: { ...pr483, draft: true }, ci: running(1, 4) }) });
    const push = elementAt(html, 'data-result="push"');
    expect(textOf(push)).toBe("Pushed ostra/calc-192-history-panel · 1 of 3 checks failed in the box, so the PR is a draft");
    expect(redWords(push)).toEqual(["failed"]);
    const card = elementAt(html, 'data-part="pr-card"');
    expect(card).toContain('data-pr-look="draft"');
    expect(card).toMatch(/lucide-git-pull-request-draft[^"]*text-muted/);
    expect(textOf(card)).toContain(t("task.result.prState.draft"));
  });

  it("F-151/c6: the Checks tab's marker, the stage line, the review screen and Home's board count CI in jobs", () => {
    const ci = (state: HeadCi["state"], failingJobs: readonly string[] = []) => ({ state, failingJobs });
    // The tab's marker follows both: spinning while either runs, red with a count once one failed, green when both passed.
    expect(markerWithCi({ kind: "passed" }, [ci("running")])).toEqual({ kind: "running" });
    expect(markerWithCi({ kind: "running" }, [ci("passed")])).toEqual({ kind: "running" });
    expect(markerWithCi({ kind: "passed" }, [ci("passed")])).toEqual({ kind: "passed" });
    expect(markerWithCi({ kind: "none" }, [ci("passed")])).toEqual({ kind: "passed" });
    expect(markerWithCi({ kind: "failing", count: 1 }, [ci("failed", ["e2e", "lint"])])).toEqual({ kind: "failing", count: 3 });
    expect(markerWithCi({ kind: "passed" }, [ci("failed", ["e2e"])])).toEqual({ kind: "failing", count: 1 });
    expect(markerWithCi({ kind: "none" }, [ci("none")])).toEqual({ kind: "none" });
    expect(renderToStaticMarkup(<ChecksTabMarker marker={markerWithCi({ kind: "passed" }, [ci("running")])} />)).toContain(`aria-label="${t("taskTabs.checksRunning")}"`);
    // Milestone 6's stage line: CI running, as the current stage, counts its jobs.
    const repos = [{ ci: { state: "running", jobs: { done: 2, total: 4 } } }, { ci: null }];
    expect(runningCiJobs(repos)).toEqual({ done: 2, total: 4 });
    expect(runningCiJobs([{ ci: { state: "passed", jobs: { done: 4, total: 4 } } }])).toBeNull();
    const counts = { ci: { used: 0, limit: 2 }, review: { used: 0, limit: 2 } };
    expect(stagesOf({ subState: "ci_running", aiReview: true, ...counts, ciJobs: { done: 2, total: 4 } })[0]).toMatchObject({ state: "current", words: "CI running · 2 of 4 jobs" });
    expect(stagesOf({ subState: "ai_review", aiReview: true, ...counts, ciJobs: { done: 2, total: 4 } })[0]?.words).toBe("CI running");
    const line = renderToStaticMarkup(<StageLine subState="ci_running" aiReview counts={{ ...counts, automaticTurns: { used: 0, limit: 4 } }} needsYou={false} held={false} ciJobs={{ done: 2, total: 4 }} />);
    expect(textOf(line)).toContain("CI running · 2 of 4 jobs");
    // The review screen's CI row.
    const job = (name: string, conclusion: string | null) => ({ name, conclusion });
    expect(prCiRow({ state: "passed", checks: [job("build", "success"), job("lint", "success"), job("test", "success")], completedAt: 1 }).words).toBe("Passed · 3 jobs");
    expect(prCiRow({ state: "pending", checks: [job("build", "success"), job("lint", "success"), job("test", "in_progress"), job("e2e", null)], completedAt: null }).words).toBe("Running · 2 of 4 jobs");
    // Home's board: the in-review card's sub-state, from `home.board`'s status.
    const status = cardStatusOf({ kind: "in-review", subState: "ci_running", prNumbers: [483], ciJobs: { done: 2, total: 4 } });
    expect(cardStatusParts(status).map((part) => part.text).join("")).toBe("PR #483 · CI running · 2 of 4 jobs");
    expect(cardStatusParts(cardStatusOf({ kind: "in-review", subState: "waiting_for_reviewer", prNumbers: [483], ciJobs: null })).map((part) => part.text).join("")).toBe("PR #483 · waiting for a reviewer");
  });
});

describe("a review task's and a refine task's results (F-151/c7)", () => {
  it("F-151/c7: S3's result lines: posted with its verdict, and the repeat's confirmed line, neither red, each opening the review screen", () => {
    const reviewHref = "/tasks/calc-192/review";
    const html = render(s3, fold(s3), { results: { ...resultsOf({ ci: null }), reviewHref } });
    const reviews = elementsAt(html, 'data-result="review"');
    expect(reviews.map(textOf)).toEqual(["Review posted on PR #483 · nothing blocking, 1 nitOpen the review", "Review on PR #483 confirmed · already posted this round, unchangedOpen the review"]);
    expect(redWords(reviews.join(""))).toEqual([]);
    for (const review of reviews) expect(review).toContain(`href="${reviewHref}"`);
    // `PR #483` is the PR's own link on the code host.
    expect(reviews[0]).toMatch(/<a href="https:\/\/github\.com\/acme\/calculator-web\/pull\/483[^"]*"[^>]*>PR #483<\/a>/);
    // A review task pushes nothing and opens no PR.
    expect(html).not.toContain('data-result="push"');
    expect(html).not.toContain('data-part="pr-card"');
  });

  it("F-151/c7: a refine task's draft line and no push or PR line", () => {
    const scene = stateCells.messages[6].refine;
    const html = render(scene, fold(scene), { results: resultsOf({ ci: null }) });
    const draft = elementAt(html, 'data-result="draft"');
    expect(textOf(draft)).toBe("Handed in draft v2 · 4 acceptance criteria, 2 sub-ticketsOpen the draft");
    expect(draft).toContain("lucide-file-pen-line");
    expect(draft).toContain(`href="/tasks/${scene.taskId}?tab=draft"`);
    expect(html).not.toContain('data-result="push"');
    expect(html).not.toContain('data-part="pr-card"');
  });
});

describe("ostra's own tools as results (F-151/c8)", () => {
  it("F-151/c8: an ostra_show_preview call is the preview's result line, not a tool row; a memory proposed is its line too", () => {
    const scene = stateCells.messages[6].code;
    const messages = fold(scene);
    const index = createTaskIndexStore();
    const html = render(scene, messages, { results: resultsOf({ ci: null }), index });
    const preview = elementAt(html, 'data-result="preview"');
    expect(textOf(preview)).toBe("Preview web :5173 /historyShow");
    expect(preview).toContain("lucide-app-window");
    expect(preview).toContain('href="?pane=preview&amp;preview=port-5173&amp;path=%2Fhistory"');
    const memory = elementAt(html, 'data-result="memory"');
    expect(textOf(memory)).toBe("Proposed a memory: Run the tests with pnpm test, not npmReview");
    expect(memory).toContain(`href="/projects/calculator-id/memory/proposals?proposal=`);
    // The results come after the turn's prose, and no row names the tool.
    const order = itemsInOrder(html);
    expect(order.indexOf("result:result")).toBeGreaterThan(order.indexOf("prose:prose"));
    expect(html).not.toContain("ostra_show_preview");
    // Opened, the run's row is ostra's own words for it, never `Used ostra_show_preview`.
    const run = messages.flatMap((message) => turnItemsOf(message, contextOf(scene))).find((item): item is RunItem => item.kind === "run");
    expect(run).toBeDefined();
    if (run === undefined) return;
    runOpenStoreOf(index).toggleRun(run);
    const opened = render(scene, messages, { results: resultsOf({ ci: null }), index });
    const steps = elementAt(opened, 'data-part="run-steps"');
    expect(textOf(steps)).toContain(t("task.step.ostra.show_preview"));
    expect(steps).not.toContain("ostra_show_preview");
  });
});
