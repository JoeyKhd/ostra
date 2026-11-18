import { cpus } from "node:os";
import type { Browser, Page } from "playwright-core";
import { z } from "zod";
import { sumOf } from "../producer/acp-map.ts";
import { findCaptures, findRecordings, replayFile } from "../producer/replay.ts";
import type { RunnerClient } from "../producer/runner-client.ts";
import {
  buildAllKindsEvents,
  buildLongSession,
  buildManyTurns,
  buildSingleTurn,
  createLatencyScript,
  streamingTurn,
  thirdPartyHost,
} from "../producer/scenarios.ts";
import { createAppender } from "../server/appender.ts";
import { exec, rows, withTx } from "../server/db.ts";
import { createLogger } from "../server/log.ts";
import { taskEventKinds, type TaskEvent, type TaskEventKind } from "../shared/events.ts";
import { MemberId, SegmentId, TaskId, TurnId } from "../shared/ids.ts";
import { sleep } from "../shared/time.ts";
import { launchBrowser } from "./browser.ts";
import { makeRunner, newTask, settings, type Ctx } from "./context.ts";
import { createToggleProxy } from "./proxy.ts";
import { fail, skipped, verdict, type Criterion, type Finding } from "./report.ts";
import { capturesDir, recordingsDir } from "./settings.ts";
import { median, percentile } from "./stats.ts";

const BAR_COVERAGE = "Every kind of event in the recorded sessions renders, and nothing is dropped silently.";
const BAR_RELOAD = "A reload shows the partial text again within 1 s. A 10 s network drop leaves no gap and no duplicate.";
const BAR_WATCHER = "A watcher can't send, in the UI or by calling the API. When two members answer one approval, one wins.";
const BAR_RENDER = "5,000 events render in under 1.5 s.";
const BAR_POLICY = "Strict typecheck and lint pass with only documented suppressions. The page calls no third party.";
const BAR_TWO = "Key parts: two viewers see the same thing, from ostra's own stream (SSE, resume by sequence number, partial text never saved).";
const BAR_LOAD = "5,000 events a second sustained and a burst of 10,000, at p99 under 500 ms from runner to browser, with Postgres under 50% of 4 vCPU.";

// The 1.5 s bar has no reference machine, so the render checks run with the CPU throttled to a quarter of this
// machine's speed (Chrome DevTools' Emulation.setCPUThrottlingRate), which stands in for a mid-range laptop.
const CPU_THROTTLE = 4;

export type BrowserResult = { criteria: Criterion[]; findings: Finding[]; executable: string | null };

const diagnostics = z.object({
  counters: z.object({
    eventsReceived: z.number(),
    liveFrames: z.number(),
    liveIgnored: z.number(),
    gaps: z.number(),
    duplicates: z.number(),
    invalidFrames: z.number(),
    reconnects: z.number(),
    watchdogReconnects: z.number(),
  }),
  marks: z.object({
    firstRenderAt: z.number().nullable(),
    renderedEvents: z.number(),
    renderedMessages: z.number(),
    infoAt: z.number().nullable(),
    historyAt: z.number().nullable(),
    foldMs: z.number(),
    flushMs: z.number(),
  }),
  status: z.string(),
  lastSeq: z.number(),
  eventCount: z.number(),
});
type Diagnostics = z.infer<typeof diagnostics>;

const readDiagnostics = async (page: Page): Promise<Diagnostics | null> => {
  const raw: unknown = await page.evaluate(
    "(() => { const o = window.__ostra; return o ? JSON.stringify({ counters: o.counters(), marks: o.marks(), status: o.status(), lastSeq: o.lastSeq(), eventCount: o.eventCount() }) : null; })()",
  );
  if (typeof raw !== "string") return null;
  return diagnostics.parse(JSON.parse(raw));
};

const readLatencies = async (page: Page): Promise<number[]> => {
  const raw: unknown = await page.evaluate("(() => { const o = window.__ostra; return o ? JSON.stringify(o.latencies()) : '[]'; })()");
  return z.array(z.number()).parse(JSON.parse(z.string().parse(raw)));
};

type Tracked = {
  page: Page;
  requests: string[];
  // attempts to reach a host other than this machine: each was stopped, and recorded here
  foreign: string[];
  dialogs: string[];
  answerStatuses: number[];
  sendRequests: string[];
  errors: string[];
};

const isLocal = (url: string): boolean => {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost";
};

const openPage = async (browser: Browser, url: string, options: { cpuThrottle?: number } = {}): Promise<Tracked> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const foreign: string[] = [];
  // A page that reaches for anything but this machine is stopped, and the attempt is recorded: a page that
  // blocks remote images and one that never met one are told apart by what the hostile session makes them do.
  await context.route("**/*", async (route) => {
    const target = route.request().url();
    if (isLocal(target)) {
      await route.continue();
      return;
    }
    foreign.push(target);
    await route.abort();
  });
  const page = await context.newPage();
  if (options.cpuThrottle !== undefined) {
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle });
  }
  const tracked: Tracked = { page, requests: [], foreign, dialogs: [], answerStatuses: [], sendRequests: [], errors: [] };
  page.on("pageerror", (error) => tracked.errors.push(error.message.slice(0, 300)));
  page.on("console", (message) => {
    if (message.type() === "error") tracked.errors.push(message.text().slice(0, 300));
  });
  page.on("dialog", (dialog) => {
    tracked.dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  page.on("request", (request) => {
    tracked.requests.push(request.url());
    if (request.method() === "POST" && request.url().endsWith("/send")) tracked.sendRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.url().endsWith("/answer")) tracked.answerStatuses.push(response.status());
  });
  await page.goto(url, { waitUntil: "commit" });
  return tracked;
};

const waitRendered = async (page: Page, timeoutMs = 20_000): Promise<number | null> => {
  try {
    await page.waitForFunction("window.__ostra && window.__ostra.marks().firstRenderAt !== null", undefined, { timeout: timeoutMs });
  } catch {
    return null;
  }
  return (await readDiagnostics(page))?.marks.firstRenderAt ?? null;
};

const has = async (page: Page, selector: string, text?: string): Promise<boolean> => {
  const locator = text === undefined ? page.locator(selector) : page.locator(selector).filter({ hasText: text });
  return (await locator.count()) > 0;
};

const waitHas = async (page: Page, selector: string, text: string | undefined, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await has(page, selector, text)) return true;
    await sleep(25);
  }
  return has(page, selector, text);
};

// Writes a server-owned event the way the server does, for kinds no endpoint produces yet, then sends the
// wake-up NOTIFY that a server would have sent.
const writeServerEvent = async (ctx: Ctx, taskId: string, event: TaskEvent): Promise<void> => {
  const appender = createAppender(ctx.pool, 10, () => undefined, createLogger("harness", true));
  const wake = await withTx(ctx.pool, async (client) => {
    const batch = await appender.commit(client, [{ taskId: TaskId.parse(taskId), events: [{ runnerSeq: null, at: Date.now(), event }], live: [] }]);
    return batch.wake;
  });
  await ctx.wake.send(wake);
};

// A stored event of a kind this build has never heard of: an older panel reading a newer server.
const writeFutureKind = async (ctx: Ctx, taskId: string): Promise<void> => {
  await withTx(ctx.pool, async (client) => {
    const counter = await rows(client, z.object({ next_seq: z.coerce.number() }), "SELECT next_seq FROM task_counters WHERE task_id = $1 FOR UPDATE", [taskId]);
    const seq = counter[0]?.next_seq ?? 1;
    await exec(client, "INSERT INTO events (task_id, seq, runner_seq, at_ms, kind, payload) VALUES ($1, $2, NULL, $3, 'agent.from_the_future', '{\"x\":1}'::jsonb)", [taskId, seq, Date.now()]);
    await exec(client, "UPDATE task_counters SET next_seq = $2 WHERE task_id = $1", [taskId, seq + 1]);
  });
};

type DomCheck = (page: Page) => Promise<boolean>;
const system = (kind: string): DomCheck => (page) => has(page, `[data-part=system][data-event-kind="${kind}"]`);

// What each kind of event looks like in the page. Typed over the whole union, so a new kind without a
// check is a compile error.
const domChecks: Record<TaskEventKind | "unsupported", DomCheck> = {
  "user.message": (p) => has(p, "[data-role=user] [data-part=user-text]", "stop and take this instead"),
  "turn.started": (p) => has(p, "[data-role=assistant][data-turn-state]"),
  "turn.ended": (p) => has(p, "[data-role=assistant][data-turn-state=ended][data-stop-reason=end_turn]"),
  "turn.failed": (p) => has(p, "[data-role=assistant][data-turn-state=failed]"),
  "turn.cancel_requested": system("turn.cancel_requested"),
  "agent.message": (p) => has(p, "[data-part=text]", "bounded retry"),
  "agent.thought": (p) => has(p, "[data-part=reasoning]", "look at the client"),
  "agent.content": async (p) => (await has(p, "[data-part=image]")) && (await has(p, "[data-part=source]", "Retry docs")),
  "tool.called": async (p) =>
    (await has(p, "[data-part=tool][data-kind=read]")) &&
    (await has(p, "[data-part=tool][data-kind=edit]")) &&
    (await has(p, "[data-part=tool][data-kind=execute]")) &&
    (await has(p, "[data-part=tool][data-kind=search]")),
  "tool.progress": (p) => has(p, "[data-part=tool][data-kind=execute] [data-part=output]", "running 12 tests"),
  "tool.completed": async (p) => (await has(p, "[data-part=tool][data-kind=read][data-state=output-available]")) && (await has(p, "[data-part=diff]", "retry(")),
  "tool.failed": (p) => has(p, "[data-part=tool-error]", "tool crashed"),
  "approval.requested": (p) => has(p, "[data-part=approval][data-state=pending], [data-part=approval][data-state=answered]"),
  "approval.answered": (p) => has(p, "[data-part=approval][data-state=answered]", "Approved once by"),
  "approval.auto_answered": (p) => has(p, "[data-part=approval][data-state=auto]", "automatically"),
  "approval.closed": (p) => has(p, "[data-part=approval][data-state=closed]", "expired"),
  "question.asked": (p) => has(p, "[data-part=question]", "retry policy"),
  "question.answered": (p) => has(p, "[data-part=question][data-state=answered]"),
  "question.closed": (p) => has(p, "[data-part=question][data-state=closed]"),
  "plan.updated": (p) => has(p, "[data-part=plan]", "bounded retry"),
  "compaction.updated": (p) => has(p, "[data-part=compaction][data-state=done]", "compacted"),
  "session.config_changed": system("session.config_changed"),
  "driver.changed": system("driver.changed"),
  "runner.connected": system("runner.connected"),
  "runner.lost": system("runner.lost"),
  "session.restored": system("session.restored"),
  "session.crashed": system("session.crashed"),
  "pr.opened": system("pr.opened"),
  "agent.unknown": (p) => has(p, "[data-part=unsupported][data-event-kind=some_future_update]"),
  unsupported: (p) => has(p, "[data-part=unsupported][data-event-kind=\"agent.from_the_future\"]"),
};

const countSel = (page: Page, selector: string): Promise<number> => page.locator(selector).count();

const threadText = (page: Page): Promise<string> => page.locator(".thread").innerText();

const uiSession = async (browser: Browser, ctx: Ctx, runner: RunnerClient, tracked: Tracked[], findings: Finding[]): Promise<Criterion[]> => {
  const out: Criterion[] = [];
  const taskId = TaskId.parse("ui-all");
  await newTask(ctx, taskId, "alex");
  const { events, pendingApprovalId } = buildAllKindsEvents("ui");
  for (const event of events) runner.emit(taskId, event);
  await runner.drain(10_000);
  await writeServerEvent(ctx, taskId, {
    kind: "question.answered",
    questionId: events.flatMap((e) => (e.kind === "question.asked" && e.message.includes("logged") ? [e.questionId] : []))[0] ?? (() => { throw new Error("fixture changed"); })(),
    answers: { log: "yes" },
    memberId: MemberId.parse("alex"),
  });
  await writeFutureKind(ctx, taskId);

  // A tool that is still running, for tool.progress.
  const progressTask = TaskId.parse("ui-progress");
  await newTask(ctx, progressTask, "alex");
  runner.emit(progressTask, { kind: "turn.started", turnId: TurnId.parse("pg-turn") });
  runner.emit(progressTask, {
    kind: "tool.called",
    turnId: TurnId.parse("pg-turn"),
    toolCallId: events.flatMap((e) => (e.kind === "tool.called" ? [e.toolCallId] : []))[2] ?? (() => { throw new Error("fixture changed"); })(),
    toolKind: "execute",
    title: "pnpm test",
    input: { command: "pnpm test" },
  });
  runner.emit(progressTask, {
    kind: "tool.progress",
    toolCallId: events.flatMap((e) => (e.kind === "tool.called" ? [e.toolCallId] : []))[2] ?? (() => { throw new Error("fixture changed"); })(),
    output: { output: "running 12 tests\n", truncated: false, exitCode: null },
  });
  await runner.drain(10_000);

  const alex = await openPage(browser, `${ctx.baseA}/task/${taskId}?as=alex&turns=all`);
  const sam = await openPage(browser, `${ctx.baseB}/task/${taskId}?as=sam&turns=all`);
  const val = await openPage(browser, `${ctx.baseA}/task/${taskId}?as=val&turns=all`);
  const progress = await openPage(browser, `${ctx.baseA}/task/${progressTask}?as=alex&turns=all`);
  tracked.push(alex, sam, val, progress);
  const rendered = await Promise.all([alex, sam, val, progress].map((t) => waitRendered(t.page)));
  if (rendered.some((r) => r === null)) {
    const names = ["alex", "sam", "val", "progress"];
    const detail = [alex, sam, val, progress].map((t, i) => `${names[i] ?? "?"}: rendered=${String(rendered[i] !== null)} errors=${JSON.stringify(t.errors.slice(0, 2))}`);
    out.push(fail(BAR_COVERAGE, "The task page renders", `a page did not finish its first render within 20 s (${detail.join("; ")})`));
    return out;
  }

  // ---- hostile agent content renders inert ----------------------------------------------------
  // The session holds a remote image, an <img onerror>, a javascript: link and a <script> (agent text is
  // untrusted). The page is routed so any request to another host is stopped and recorded.
  await sleep(300);
  const imgSources = await alex.page.locator("img").evaluateAll((els) => els.map((el) => el.getAttribute("src") ?? ""));
  const foreignImages = imgSources.filter((src) => !src.startsWith("data:image/"));
  const javascriptLinks = await countSel(alex.page, "a[href^='javascript' i]");
  const scripts = await countSel(alex.page, ".thread script");
  const blocked = await countSel(alex.page, "[data-part=image-blocked]");
  const hostileShown = await has(alex.page, "[data-part=text]", "Hostile content");
  const linkAsText = (await has(alex.page, ".thread span", "click me")) && (await countSel(alex.page, ".thread a:has-text('click me')")) === 0;
  const handlers = await countSel(alex.page, ".thread [onerror], .thread [onclick], .thread [onload]");
  const attempts = [alex, sam, val, progress].reduce((n, t) => n + t.foreign.length, 0);
  const dialogs = [alex, sam, val, progress].reduce((n, t) => n + t.dialogs.length, 0);
  out.push(
    verdict(
      BAR_POLICY,
      "Hostile agent content renders inert: a remote image, an <img onerror>, a javascript: link and a <script> load nothing, link nowhere and run nothing",
      hostileShown && attempts === 0 && foreignImages.length === 0 && javascriptLinks === 0 && scripts === 0 && blocked >= 1 && linkAsText && handlers === 0 && dialogs === 0,
      `the hostile message is on the page: ${String(hostileShown)}; requests to ${thirdPartyHost} or any other host: ${String(attempts)}; <img> whose src is not an inline data:image: ${String(foreignImages.length)}; a[href^=javascript]: ${String(javascriptLinks)}; script elements in the thread: ${String(scripts)}; inline event handlers: ${String(handlers)}; dialogs opened: ${String(dialogs)}; the javascript: link is plain text: ${String(linkAsText)}; remote image blocks shown ("Image not shown"): ${String(blocked)}`,
    ),
  );

  // ---- who can send, in the UI --------------------------------------------------------------
  const alexComposer = await countSel(alex.page, "[data-part=composer] textarea");
  const samComposer = await countSel(sam.page, "[data-part=composer], textarea:not([aria-hidden=true]), [data-action=send]");
  const samBar = (await sam.page.locator("[data-part=watcher-bar]").innerText()).replace(/\s+/g, " ");
  const samTakeOver = await countSel(sam.page, "[data-action=take-over]");
  const valComposer = await countSel(val.page, "[data-part=composer], textarea:not([aria-hidden=true]), [data-action=send]");
  const valBar = (await val.page.locator("[data-part=watcher-bar]").innerText()).replace(/\s+/g, " ");
  const valTakeOver = await countSel(val.page, "[data-action=take-over]");
  const valButtons = await countSel(val.page, "[data-part=approval][data-state=pending] button");
  const valWaiting = await has(val.page, "[data-part=approval][data-state=pending]", "Waiting for approval");
  const samButtons = await countSel(sam.page, "[data-part=approval][data-state=pending] button");
  const pendingSeen = (await countSel(alex.page, "[data-part=approval][data-state=pending]")) > 0;
  out.push(
    verdict(
      BAR_WATCHER,
      "In the UI, a watcher has no composer and no send control; a read-only viewer cannot take over or answer",
      alexComposer === 1 && samComposer === 0 && samBar.includes("alex is driving") && samTakeOver === 1 && valComposer === 0 && valBar.includes("read-only") && valTakeOver === 0 && valButtons === 0 && valWaiting && samButtons === 3,
      `driver sees ${String(alexComposer)} composer; watcher sam sees ${String(samComposer)} composer/send controls and the bar "${samBar.trim()}"; viewer val sees ${String(valComposer)} composer, ${String(valTakeOver)} take-over and ${String(valButtons)} approval buttons ("Waiting for approval": ${String(valWaiting)}); member watcher sam has ${String(samButtons)} approval buttons`,
    ),
  );

  // ---- take over, then the roles swap on both pages -----------------------------------------
  const takeOverStarted = Date.now();
  await sam.page.locator("[data-action=take-over]").click();
  const samDriving = await waitHas(sam.page, "[data-part=composer]", undefined, 5000);
  const alexWatching = await waitHas(alex.page, "[data-part=watcher-bar]", "sam is driving", 5000);
  const swapMs = Date.now() - takeOverStarted;
  await sleep(300);
  const alexLeftover = await countSel(alex.page, "[data-part=composer], textarea:not([aria-hidden=true]), [data-action=send]");
  const alexNoComposer = alexLeftover === 0;
  out.push(
    verdict(
      BAR_WATCHER,
      "Take over in the UI: the old driver becomes a watcher and the new one gets the composer, on every open page",
      samDriving && alexWatching && alexNoComposer,
      `sam has the composer: ${String(samDriving)}; alex's page shows "sam is driving": ${String(alexWatching)} and has ${String(alexLeftover)} composer controls left; both pages switched within ${String(swapMs)} ms of the click`,
    ),
  );

  // ---- the new driver sends with "Interrupt and send" ---------------------------------------
  await sam.page.locator("[data-part=composer-input]").fill("stop and take this instead");
  await sam.page.locator("[data-action=interrupt-and-send]").click();
  const sentVisible = await waitHas(alex.page, "[data-role=user][data-delivery=after-interrupt]", "stop and take this instead", 5000);
  const samCleared = (await sam.page.locator("[data-part=composer-input]").inputValue()) === "";

  // ---- two members click the same approval at once ------------------------------------------
  const clickOnce = (t: Tracked) => t.page.locator(`[data-approval-id="${pendingApprovalId}"] [data-action=approve-once]`).click();
  await Promise.all([clickOnce(alex), clickOnce(sam)]);
  const settledAlex = await waitHas(alex.page, `[data-approval-id="${pendingApprovalId}"][data-state=answered]`, "Approved once by", 5000);
  const settledSam = await waitHas(sam.page, `[data-approval-id="${pendingApprovalId}"][data-state=answered]`, "Approved once by", 5000);
  const settledVal = await waitHas(val.page, `[data-approval-id="${pendingApprovalId}"][data-state=answered]`, "Approved once by", 5000);
  const receiptOf = (t: Tracked) => t.page.locator(`[data-approval-id="${pendingApprovalId}"]`).innerText();
  const [receiptAlex, receiptSam, receiptVal] = await Promise.all([receiptOf(alex), receiptOf(sam), receiptOf(val)]);
  const statuses = [...alex.answerStatuses, ...sam.answerStatuses].sort((a, b) => a - b);
  out.push(
    verdict(
      BAR_WATCHER,
      "Two members clicking one approval at once: one wins, and every page shows the same receipt",
      statuses.join(",") === "200,409" && settledAlex && settledSam && settledVal && receiptAlex === receiptSam && receiptSam === receiptVal,
      `answer responses ${statuses.join(" and ")}; receipt on all three pages: "${receiptAlex.trim()}"`,
    ),
  );

  // ---- every kind of event renders ----------------------------------------------------------
  await sleep(400);
  const results: { kind: string; ok: boolean }[] = [];
  const kinds: (TaskEventKind | "unsupported")[] = [...taskEventKinds, "unsupported"];
  for (const kind of kinds) {
    const target = kind === "tool.progress" ? progress.page : alex.page;
    const ok = kind === "approval.requested" ? pendingSeen : await domChecks[kind](target);
    results.push({ kind, ok });
  }
  const missing = results.filter((r) => !r.ok).map((r) => r.kind);
  const problems = (await countSel(alex.page, "[data-part=problem], [data-part=data-missing], [data-part=tool-missing]")) + (await countSel(sam.page, "[data-part=problem], [data-part=data-missing], [data-part=tool-missing]"));
  out.push(
    verdict(
      BAR_COVERAGE,
      "Synthetic session: every kind of event in ostra's union renders, including a kind this build does not know",
      missing.length === 0 && problems === 0,
      `${String(results.length - missing.length)} of ${String(results.length)} kinds render${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}; "problem" rows: ${String(problems)}; interrupt-and-send arrived as "after-interrupt": ${String(sentVisible)}; composer cleared: ${String(samCleared)}`,
    ),
  );

  // ---- two viewers see the same thing -------------------------------------------------------
  const [textAlex, textSam] = await Promise.all([threadText(alex.page), threadText(sam.page)]);
  const idsAlex = await alex.page.locator("[data-message-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-message-id")));
  const idsSam = await sam.page.locator("[data-message-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-message-id")));
  const dAlex = await readDiagnostics(alex.page);
  const dSam = await readDiagnostics(sam.page);
  out.push(
    verdict(
      BAR_TWO,
      "Two viewers in two browsers (on two replicas) render the same thread, and agree on the log",
      textAlex === textSam && JSON.stringify(idsAlex) === JSON.stringify(idsSam) && dAlex?.lastSeq === dSam?.lastSeq && dAlex?.counters.gaps === 0 && dSam?.counters.gaps === 0,
      `${String(idsAlex.length)} messages and ${String(textAlex.length)} characters on both pages; log head seq ${String(dAlex?.lastSeq)} / ${String(dSam?.lastSeq)}; gaps ${String(dAlex?.counters.gaps)}/${String(dSam?.counters.gaps)}, duplicates ${String(dAlex?.counters.duplicates)}/${String(dSam?.counters.duplicates)}`,
    ),
  );
  findings.push({
    topic: "the composer's hint and Interrupt and send",
    text: `"${(await sam.page.locator(".hint").innerText()).trim()}" is shown to the driver; Interrupt and send wrote turn.cancel_requested then a user.message marked after-interrupt in one transaction.`,
  });
  return out;
};

const liveSession = async (browser: Browser, ctx: Ctx, tracked: Tracked[], findings: Finding[]): Promise<Criterion[]> => {
  const out: Criterion[] = [];
  const runner = makeRunner(ctx, ctx.baseA);
  try {
    const taskId = TaskId.parse("ui-live");
    await newTask(ctx, taskId, "alex");
    const streaming = streamingTurn(runner, taskId, { turnId: "ui-live-turn", segmentId: "ui-live-seg", totalWords: 600, streamMs: 24_000 });
    const alex = await openPage(browser, `${ctx.baseA}/task/${taskId}?as=alex`);
    tracked.push(alex);
    await waitRendered(alex.page);
    await waitHas(alex.page, "[data-part=text][data-streaming=true]", undefined, 8000);

    // assistant-ui: does onNew fire while a run is active, with no queue adapter of ours?
    await alex.page.locator("[data-part=composer-input]").fill("a message sent while the agent works");
    const sendDisabled = await alex.page.locator("[data-action=send]").isDisabled();
    const before = alex.sendRequests.length;
    if (!sendDisabled) await alex.page.locator("[data-action=send]").click();
    await sleep(1500);
    const fired = alex.sendRequests.length > before;
    findings.push({
      topic: "assistant-ui: onNew while a run is active, with no queue adapter",
      text: `Send button disabled while running: ${String(sendDisabled)}; a POST /send fired after clicking Send: ${String(fired)}. ${fired ? "So the server's own queue (delivery: queued) works through the stock Send." : "So a stock Send cannot queue mid-turn: ostra needs its own Send button or assistant-ui's queue adapter."}`,
    });
    if (fired) {
      const queued = await waitHas(alex.page, "[data-role=user][data-delivery=queued]", "sent while the agent works", 4000);
      findings.push({ topic: "queued message shown to everyone", text: `the message committed with delivery "queued" and is in the thread: ${String(queued)}` });
    }

    // ---- reload mid-message: the partial text is back within 1 s -------------------------
    const sam = await openPage(browser, `${ctx.baseB}/task/${taskId}?as=sam`);
    tracked.push(sam);
    await waitRendered(sam.page);
    await waitHas(sam.page, "[data-part=text][data-streaming=true]", undefined, 8000);
    const times: number[] = [];
    let lengthsOk = true;
    let previousLength = 0;
    for (let i = 0; i < 5; i += 1) {
      await sleep(900);
      const beforeText = await sam.page.locator("[data-part=text][data-streaming=true]").first().innerText();
      previousLength = beforeText.length;
      const started = Date.now();
      await sam.page.reload({ waitUntil: "commit" });
      const back = await waitHas(sam.page, "[data-part=text][data-streaming=true]", "the quick", 5000);
      times.push(back ? Date.now() - started : 5000);
      const afterText = await sam.page.locator("[data-part=text][data-streaming=true]").first().innerText().catch(() => "");
      // the partial is at least as long as it was a moment before (it only grows), and starts the same
      if (afterText.length < previousLength || !afterText.startsWith(beforeText.slice(0, 40))) lengthsOk = false;
    }
    const sorted = [...times].sort((a, b) => a - b);
    out.push(
      verdict(
        BAR_RELOAD,
        "A reload mid-message shows the partial text again within 1 s",
        sorted.every((t) => t < 1000) && lengthsOk,
        `5 reloads, partial text visible again after ${times.map((t) => `${String(t)} ms`).join(", ")} (reload to first words on screen, headless Edge on this machine); text never shorter than before: ${String(lengthsOk)}; last partial was ${String(previousLength)} chars`,
      ),
    );
    await streaming;
    await runner.drain(10_000);
  } catch (error) {
    out.push(fail(BAR_RELOAD, "Live session checks ran to completion", error instanceof Error ? error.message : "unknown error"));
  } finally {
    await runner.stop();
  }
  return out;
};

type DropMode = "cut" | "blackhole";

// A network drop in front of the server, two kinds. `cut`: every socket is destroyed, so EventSource errors
// at once and reconnects by itself. `blackhole`: the sockets stay open and nothing flows, as when Wi-Fi roams
// or a NAT forgets the flow; EventSource never errors, so only the page's own watchdog (no frame of any kind,
// pings included, for 20 s) can notice. In both, the 10 s drop must leave no gap and no duplicate.
const dropSession = async (browser: Browser, ctx: Ctx, tracked: Tracked[], findings: Finding[], mode: DropMode): Promise<Criterion[]> => {
  const out: Criterion[] = [];
  const runner = makeRunner(ctx, ctx.baseA);
  const proxy = createToggleProxy(ctx.a.port);
  try {
    await proxy.start();
    const taskId = TaskId.parse(`ui-drop-${mode}`);
    await newTask(ctx, taskId, "alex");
    const control = await openPage(browser, `${ctx.baseA}/task/${taskId}?as=alex`);
    const dropped = await openPage(browser, `http://127.0.0.1:${String(proxy.port())}/task/${taskId}?as=sam`);
    tracked.push(control, dropped);
    await Promise.all([waitRendered(control.page), waitRendered(dropped.page)]);
    // steady committed events, and a partial segment that stays open across the drop
    const total = mode === "cut" ? 24_000 : 44_000;
    const turn = `drop-${mode}-turn`;
    const streaming = streamingTurn(runner, taskId, { turnId: turn, segmentId: `drop-${mode}-seg`, totalWords: 400, streamMs: total, tail: false });
    let n = 0;
    const ticker = (async () => {
      const end = Date.now() + total;
      while (Date.now() < end) {
        n += 1;
        runner.emit(taskId, { kind: "agent.thought", turnId: TurnId.parse(turn), segmentId: SegmentId.parse(`drop-${mode}-th-${String(n)}`), text: `thought ${String(n)}` });
        await sleep(100);
      }
    })();
    await sleep(6000);
    const atCut = await readDiagnostics(dropped.page);
    const watchdogBefore = atCut?.counters.watchdogReconnects ?? 0;
    let cutAt = 0;
    let restoredAt = 0;
    let noticedMs: number | null = null;
    let midDrop: Diagnostics | null = null;
    if (mode === "cut") {
      proxy.cut();
      cutAt = Date.now();
      await sleep(10_000);
      midDrop = await readDiagnostics(dropped.page);
      proxy.restore();
      restoredAt = Date.now();
    } else {
      proxy.blackhole();
      cutAt = Date.now();
      // The network comes back after 10 s, but the connection the page holds is gone for good: it stays open and
      // silent. How long until the page notices (its watchdog), and opens a new one?
      for (;;) {
        const elapsed = Date.now() - cutAt;
        if (restoredAt === 0 && elapsed >= 10_000) {
          midDrop = await readDiagnostics(dropped.page);
          proxy.restore();
          restoredAt = Date.now();
        }
        const d = await readDiagnostics(dropped.page);
        if (noticedMs === null && d !== null && d.counters.watchdogReconnects > watchdogBefore) noticedMs = Date.now() - cutAt;
        if (elapsed >= 30_000) break;
        await sleep(250);
      }
    }
    await Promise.all([streaming, ticker]);
    runner.emit(taskId, { kind: "turn.ended", turnId: TurnId.parse(turn), stopReason: "end_turn" });
    await runner.drain(15_000);
    await sleep(2500);
    const after = await readDiagnostics(dropped.page);
    const ctrl = await readDiagnostics(control.page);
    const head = await rows(ctx.pool, z.object({ n: z.coerce.number() }), "SELECT next_seq - 1 AS n FROM task_counters WHERE task_id = $1", [taskId]);
    const dbHead = head[0]?.n ?? -1;
    const [textDropped, textControl] = await Promise.all([threadText(dropped.page), threadText(control.page)]);
    const clean =
      after !== null &&
      after.counters.gaps === 0 &&
      after.counters.duplicates === 0 &&
      after.lastSeq === dbHead &&
      after.eventCount === dbHead &&
      textDropped === textControl &&
      after.status === "live";
    const seconds = Math.round((restoredAt - cutAt) / 1000);
    if (mode === "cut") {
      const retries = proxy.attempts.filter((a) => a.at >= cutAt && a.at < restoredAt);
      const afterRestore = proxy.attempts.filter((a) => a.at >= restoredAt);
      out.push(
        verdict(
          BAR_RELOAD,
          "A 10 s network drop mid-turn (sockets reset) leaves no gap and no duplicate",
          clean && after.counters.reconnects >= 1,
          `drop lasted ${String(seconds)} s (page status during it: ${midDrop?.status ?? "?"}); after it the page holds ${String(after?.eventCount)} events, head ${String(after?.lastSeq)} = database head ${String(dbHead)}; gaps ${String(after?.counters.gaps)}, duplicates ${String(after?.counters.duplicates)}, reconnect attempts ${String(after?.counters.reconnects)}; thread text identical to a page that never dropped: ${String(textDropped === textControl)} (control gaps ${String(ctrl?.counters.gaps)})`,
        ),
      );
      const ids = [...retries, ...afterRestore].map((a) => a.lastEventId);
      const expectedId = String(atCut?.lastSeq ?? -1);
      out.push(
        verdict(
          BAR_RELOAD,
          "The stream keeps Last-Event-ID across untracked live frames",
          ids.length > 0 && ids.every((id) => id !== null && Number(id) >= Number(expectedId)) && (afterRestore[0]?.lastEventId ?? "") === expectedId && (after?.counters.liveFrames ?? 0) > 0,
          `live frames were flowing (${String(after?.counters.liveFrames)} received); the page's newest committed seq at the cut was ${expectedId}; the browser's ${String(ids.length)} reconnect attempts sent Last-Event-ID ${[...new Set(ids)].join("/")} (the first after the restore: ${afterRestore[0]?.lastEventId ?? "none"}); the server replayed from there`,
        ),
      );
      findings.push({
        topic: "EventSource reconnect behaviour in Edge",
        text: `during a 10 s outage the browser retried ${String(retries.length)} times (server-sent retry: 500 ms) and resumed by itself; nothing in the page re-fetched history.`,
      });
    } else {
      const reconnects = proxy.attempts.filter((a) => a.at >= cutAt);
      out.push(
        verdict(
          BAR_RELOAD,
          "A 10 s black-holed network (sockets stay open, nothing flows) is noticed by the page within 25 s, and leaves no gap and no duplicate",
          clean && noticedMs !== null && noticedMs <= 25_000 && after.counters.watchdogReconnects >= 1,
          `the network was black-holed for ${String(seconds)} s with the page's connection left open and silent (page status then: ${midDrop?.status ?? "?"}, EventSource errors: ${String((after?.counters.reconnects ?? 0) - (atCut?.counters.reconnects ?? 0))}); the page's watchdog noticed after ${noticedMs === null ? "never" : `${(noticedMs / 1000).toFixed(1)} s`} (limit 25 s) and opened a new stream with Last-Event-ID ${reconnects[0]?.lastEventId ?? "none"}; afterwards the page holds ${String(after?.eventCount)} events = database head ${String(dbHead)}; gaps ${String(after?.counters.gaps)}, duplicates ${String(after?.counters.duplicates)}; thread text identical to a page that never dropped: ${String(textDropped === textControl)}`,
        ),
      );
      findings.push({
        topic: "a black-holed connection and EventSource",
        text: "an SSE comment keepalive never reaches an EventSource's JavaScript, and a socket that stays open raises no error, so a page can show 'live' forever with no data. The server now sends a named `ping` event every 15 s, and the page reconnects after 20 s without any frame.",
      });
    }
  } catch (error) {
    out.push(fail(BAR_RELOAD, `Network-drop checks (${mode}) ran to completion`, error instanceof Error ? error.message : "unknown error"));
  } finally {
    await proxy.stop();
    await runner.stop();
  }
  return out;
};

type Shape = { readonly name: string; readonly events: TaskEvent[] };

// 5,000 events, in three shapes: assistant-ui's cost scales with the number of messages and with the parts in
// one message, not only with the event count. Each loads three times with the CPU throttled to a quarter
// (and once unthrottled, for reference). The verdict is the throttled median.
const renderSession = async (browser: Browser, ctx: Ctx, runner: RunnerClient, tracked: Tracked[], findings: Finding[]): Promise<Criterion[]> => {
  const out: Criterion[] = [];
  const shapes: Shape[] = [
    { name: "100 turns x 50 events, 100 messages, every 5th command with 4 to 20 KB of output", events: buildLongSession("long", 100, { bigOutputEvery: 5 }) },
    { name: "500 turns x 10 events, 500 messages", events: buildManyTurns("many", 500) },
    { name: "1 turn x 5,000 events, one message with 2,499 tool rows", events: buildSingleTurn("single", 2499) },
  ];
  for (const [i, shape] of shapes.entries()) {
    const taskId = TaskId.parse(`ui-shape-${String(i)}`);
    await newTask(ctx, taskId, "alex");
    for (const event of shape.events) runner.emit(taskId, event);
    await runner.drain(60_000);
    const expectedTools = shape.events.filter((e) => e.kind === "tool.called").length;
    const url = `${ctx.baseA}/task/${taskId}?as=alex&turns=all`;

    const unthrottled = await openPage(browser, url);
    tracked.push(unthrottled);
    const plainAt = await waitRendered(unthrottled.page, 60_000);
    await unthrottled.page.context().close();

    const times: number[] = [];
    const detail: string[] = [];
    let eventsRendered = 0;
    let messagesRendered = 0;
    let toolsRendered = 0;
    let partsRendered = 0;
    for (let run = 0; run < 3; run += 1) {
      const page = await openPage(browser, url, { cpuThrottle: CPU_THROTTLE });
      tracked.push(page);
      const at = await waitRendered(page.page, 90_000);
      const d = await readDiagnostics(page.page);
      if (at === null || d === null) {
        times.push(90_000);
        await page.page.context().close();
        continue;
      }
      times.push(at);
      eventsRendered = d.marks.renderedEvents;
      messagesRendered = d.marks.renderedMessages;
      toolsRendered = await countSel(page.page, "[data-part=tool]");
      partsRendered = await countSel(page.page, "[data-part]");
      detail.push(`${String(Math.round(at))} ms (events fetched at ${String(Math.round(d.marks.historyAt ?? 0))} ms)`);
      await page.page.context().close();
    }
    const med = median(times);
    out.push(
      verdict(
        BAR_RENDER,
        `5,000 events render in under 1.5 s with the CPU throttled ${String(CPU_THROTTLE)}x: ${shape.name}`,
        eventsRendered >= shape.events.length && toolsRendered === expectedTools && med < 1500,
        `${String(eventsRendered)} events folded into ${String(messagesRendered)} messages with ${String(toolsRendered)} of ${String(expectedTools)} tool rows (${String(partsRendered)} rendered parts in the DOM), from navigation to the last row in the DOM, throttled ${String(CPU_THROTTLE)}x: ${detail.join(", ")}; median ${String(Math.round(med))} ms. Unthrottled for reference: ${plainAt === null ? "did not render" : `${String(Math.round(plainAt))} ms`} (headless Edge, ${String(cpus().length)} logical cores on this machine; the throttle stands in for a mid-range laptop, which was not run; no virtualization)`,
      ),
    );
    if (i === 0) {
      // the default view: the newest 20 turns, with the rest paged by turn
      const page = await openPage(browser, `${ctx.baseA}/task/${taskId}?as=alex`);
      tracked.push(page);
      const at = await waitRendered(page.page, 30_000);
      const d = await readDiagnostics(page.page);
      findings.push({
        topic: "the default view of a long task",
        text: `the newest 20 turns render in ${String(Math.round(at ?? -1))} ms (${String(d?.marks.renderedEvents)} events, ${String(d?.marks.renderedMessages)} messages); "Load earlier turns" pages the rest by turn.`,
      });
      await page.page.context().close();
    }
  }
  return out;
};

// One page watches a task receiving about 200 events a second for 30 s. Each event's text carries the time it
// was emitted, and the page notes (from the DOM, with a MutationObserver) how long after that the row was
// there: the whole leg from the runner to a row in the browser, which the Node viewers of the load test do not
// cover (the 16 ms flush timer, the fold of the whole log, assistant-ui, React).
const latencySession = async (browser: Browser, ctx: Ctx, tracked: Tracked[], findings: Finding[]): Promise<Criterion[]> => {
  const out: Criterion[] = [];
  const runner = makeRunner(ctx, ctx.baseA);
  try {
    const taskId = TaskId.parse("ui-latency");
    await newTask(ctx, taskId, "alex");
    const script = createLatencyScript("ui");
    runner.emit(taskId, script.next(Date.now()));
    await runner.drain(10_000);
    const page = await openPage(browser, `${ctx.baseA}/task/${taskId}?as=alex&probe=latency`);
    tracked.push(page);
    await waitRendered(page.page);
    const rate = 200;
    const durationMs = 30_000;
    const start = performance.now();
    let emitted = 0;
    let messages = 0;
    for (;;) {
      const elapsed = performance.now() - start;
      if (elapsed >= durationMs) break;
      const due = Math.floor((rate * elapsed) / 1000) - emitted;
      for (let i = 0; i < due; i += 1) {
        const event = script.next(Date.now());
        if (event.kind === "agent.message") messages += 1;
        runner.emit(taskId, event);
      }
      emitted += due;
      await sleep(5);
    }
    await runner.drain(30_000);
    await sleep(2000);
    const samples = (await readLatencies(page.page)).sort((a, b) => a - b);
    const d = await readDiagnostics(page.page);
    const head = await rows(ctx.pool, z.object({ n: z.coerce.number() }), "SELECT next_seq - 1 AS n FROM task_counters WHERE task_id = $1", [taskId]);
    const dbHead = head[0]?.n ?? -1;
    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);
    // in emit order, to see whether it gets worse as the log grows
    const inOrder = await readLatencies(page.page);
    const early = [...inOrder.slice(0, 500)].sort((a, b) => a - b);
    const late = [...inOrder.slice(-500)].sort((a, b) => a - b);
    out.push(
      verdict(
        BAR_LOAD,
        "Runner to browser: one page watching a task at about 200 events a second for 30 s shows every row within p99 500 ms of its emit time (to the row being in the DOM, unthrottled)",
        samples.length === messages && p99 < 500 && d !== null && d.lastSeq === dbHead && d.counters.gaps === 0 && d.counters.duplicates === 0,
        `${String(emitted)} events in ${String(Math.round(durationMs / 1000))} s (${String(messages)} messages, ${String(Math.round(emitted / (durationMs / 1000)))}/s achieved); rows seen in the DOM ${String(samples.length)} of ${String(messages)}; emit to DOM: p50 ${String(Math.round(p50))} ms, p99 ${String(Math.round(p99))} ms, max ${String(Math.round(samples[samples.length - 1] ?? Number.NaN))} ms; the first 500 rows p50 ${String(Math.round(percentile(early, 50)))} ms, the last 500 p50 ${String(Math.round(percentile(late, 50)))} ms; at the end one fold of the log took ${String(Math.round(d?.marks.foldMs ?? 0))} ms and a flush to the next frame ${String(Math.round(d?.marks.flushMs ?? 0))} ms; the page holds ${String(d?.eventCount)} events = database head ${String(dbHead)}; gaps ${String(d?.counters.gaps)}, duplicates ${String(d?.counters.duplicates)}`,
      ),
    );
    findings.push({
      topic: "the browser leg of the latency budget",
      text: `at ${String(rate)} events/s to one page the row is in the DOM p50 ${String(Math.round(p50))} ms, p99 ${String(Math.round(p99))} ms after the runner emitted it; the page folds the whole log on every 16 ms flush.`,
    });
  } catch (error) {
    out.push(fail(BAR_LOAD, "Browser latency check ran to completion", error instanceof Error ? error.message : "unknown error"));
  } finally {
    await runner.stop();
  }
  return out;
};

const missingNeeds = {
  browser: "a Chromium-based browser (Edge or Chrome; set OSTRA_SPIKE_BROWSER to its path)",
  recordings: "recorded sessions (*.jsonl or *.json) from spike 1, in spikes/how-should-the-runner-drive-opencode/recordings or OSTRA_SPIKE_RECORDINGS_DIR (the format is in README.md)",
  captures: "spike 1's captures (.runs/*/events.json) in spikes/how-should-the-runner-drive-opencode/.runs or OSTRA_SPIKE_CAPTURES_DIR",
} as const;

// Replays each file as a task and checks the page against what the mapper reported: every line is accounted
// for (mapped, ignored by design, unknown, or not JSON), and every unknown is an `agent.unknown` event and an
// "unsupported" row. The page is compared with the lines, not only with the events the mapper chose to emit.
const replayCheck = async (browser: Browser, ctx: Ctx, runner: RunnerClient, tracked: Tracked[], files: readonly string[], offset: number): Promise<{ ok: boolean; detail: string }> => {
  const details: string[] = [];
  let allOk = true;
  for (const [i, file] of files.entries()) {
    const taskId = TaskId.parse(`rec-${String(offset + i)}`);
    await newTask(ctx, taskId, "alex");
    const result = await replayFile(runner, taskId, file, { delayMs: 0 });
    await runner.drain(30_000);
    const page = await openPage(browser, `${ctx.baseA}/task/${taskId}?as=alex&turns=all`);
    tracked.push(page);
    const rendered = result.events.length === 0 ? 0 : await waitRendered(page.page, 30_000);
    const toolEvents = result.events.filter((e) => e.kind === "tool.called").length;
    const tools = await countSel(page.page, "[data-part=tool]");
    const unknownEvents = result.events.filter((e) => e.kind === "agent.unknown").length;
    const unsupported = await countSel(page.page, "[data-part=unsupported]");
    const problems = await countSel(page.page, "[data-part=problem], [data-part=data-missing], [data-part=tool-missing]");
    const mapped = sumOf(result.report.mapped);
    const ignored = sumOf(result.report.ignoredByDesign);
    const unknown = sumOf(result.report.unknown);
    const accounted = result.lines === mapped + ignored + unknown + result.rejectedLines;
    const ok = rendered !== null && accounted && unknown === unknownEvents && unknownEvents === unsupported && tools === toolEvents && problems === 0 && result.rejectedLines === 0;
    allOk &&= ok;
    details.push(
      `${file.split(/[\\/]/).slice(-2).join("/")}: ${String(result.lines)} lines = ${String(mapped)} mapped + ${String(ignored)} ignored by design + ${String(unknown)} unknown + ${String(result.rejectedLines)} not JSON (accounted for: ${String(accounted)}); unknown ${String(unknown)} = agent.unknown events ${String(unknownEvents)} = unsupported rows on the page ${String(unsupported)}; tool rows ${String(tools)}/${String(toolEvents)}; problems ${String(problems)}; server-owned lines skipped ${String(result.serverOwnedSkipped)}; ignored by design ${JSON.stringify([...result.report.ignoredByDesign])}`,
    );
    await page.page.context().close();
  }
  return { ok: allOk, detail: details.join("; ") };
};

export const sessionNames = ["ui", "live", "drop-cut", "drop-blackhole", "render", "latency", "recordings"] as const;
export type SessionName = (typeof sessionNames)[number];

// `only` runs some of the sessions (pnpm check:browser --only latency,render); the default is all of them.
export const browserChecks = async (ctx: Ctx, only: ReadonlySet<SessionName> | null = null): Promise<BrowserResult> => {
  const wants = (name: SessionName): boolean => only === null || only.has(name);
  const criteria: Criterion[] = [];
  const findings: Finding[] = [];
  const launched = await launchBrowser(settings);
  if (launched === null) {
    const need = missingNeeds.browser;
    return {
      executable: null,
      findings,
      criteria: [
        skipped(BAR_COVERAGE, "Synthetic session: every kind of event renders", need),
        skipped(BAR_POLICY, "Hostile agent content renders inert", need),
        skipped(BAR_WATCHER, "In the UI, a watcher has no composer and no send control", need),
        skipped(BAR_WATCHER, "Two members clicking one approval at once: one wins", need),
        skipped(BAR_RELOAD, "A reload mid-message shows the partial text again within 1 s", need),
        skipped(BAR_RELOAD, "A 10 s network drop mid-turn (sockets reset) leaves no gap and no duplicate", need),
        skipped(BAR_RELOAD, "A 10 s black-holed network is noticed by the page within 25 s, and leaves no gap and no duplicate", need),
        skipped(BAR_LOAD, "Runner to browser: one page watching a task at about 200 events a second", need),
        skipped(BAR_RENDER, "5,000 events render in under 1.5 s with the CPU throttled 4x", need),
        skipped(BAR_POLICY, "The page calls no third party", need),
      ],
    };
  }
  const tracked: Tracked[] = [];
  const runner = makeRunner(ctx, ctx.baseA);
  try {
    if (wants("ui")) criteria.push(...(await uiSession(launched.browser, ctx, runner, tracked, findings)));
    if (wants("live")) criteria.push(...(await liveSession(launched.browser, ctx, tracked, findings)));
    if (wants("drop-cut")) criteria.push(...(await dropSession(launched.browser, ctx, tracked, findings, "cut")));
    if (wants("drop-blackhole")) criteria.push(...(await dropSession(launched.browser, ctx, tracked, findings, "blackhole")));
    if (wants("render")) criteria.push(...(await renderSession(launched.browser, ctx, runner, tracked, findings)));
    if (wants("latency")) criteria.push(...(await latencySession(launched.browser, ctx, tracked, findings)));
    if (!wants("recordings")) return { criteria, findings, executable: launched.executable };

    // ---- spike 1's real OpenCode captures (.runs/*/events.json): tiny, but real -------------------
    const captures = await findCaptures(capturesDir(settings));
    if (captures.length === 0) {
      criteria.push(skipped(BAR_COVERAGE, "Real OpenCode captures from spike 1: every line accounted for, and rendered", missingNeeds.captures));
    } else {
      const checked = await replayCheck(launched.browser, ctx, runner, tracked, captures, 0);
      criteria.push(
        verdict(
          BAR_COVERAGE,
          `Real OpenCode captures from spike 1 (${String(captures.length)} sessions, message and thought chunks only, no tool calls): every line is accounted for and rendered; nothing is dropped silently`,
          checked.ok,
          checked.detail,
        ),
      );
    }

    // ---- recorded sessions from spike 1 ----------------------------------------------------
    const recordings = await findRecordings(recordingsDir(settings));
    if (recordings.length === 0) {
      criteria.push(
        skipped(
          BAR_COVERAGE,
          "Recorded sessions from spike 1: every kind of event renders, and nothing is dropped silently",
          `${missingNeeds.recordings}. The captures above are real but hold no tool call, permission request or plan, so they do not stand in for this`,
        ),
      );
    } else {
      const checked = await replayCheck(launched.browser, ctx, runner, tracked, recordings, 100);
      criteria.push(verdict(BAR_COVERAGE, "Recorded sessions from spike 1: every kind of event renders, and nothing is dropped silently", checked.ok, checked.detail));
    }

    // ---- no third party ---------------------------------------------------------------------
    const allUrls = tracked.flatMap((t) => t.requests);
    const foreignHosts = new Set<string>();
    for (const url of allUrls) {
      if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") continue;
      if (!isLocal(url)) foreignHosts.add(new URL(url).hostname);
    }
    const attempts = tracked.reduce((n, t) => n + t.foreign.length, 0);
    const cloud = allUrls.filter((u) => u.includes("assistant-api.com") || u.includes("assistant-ui.com"));
    criteria.push(
      verdict(
        BAR_POLICY,
        "The page calls no third party (a network log of every page the checks opened, with every request to another host stopped and counted)",
        foreignHosts.size === 0 && attempts === 0 && cloud.length === 0,
        `${String(allUrls.length)} requests across ${String(tracked.length)} pages, including a session that hands the page a remote image, an <img> and a script aimed at ${thirdPartyHost}; requests to any host but this machine: ${String(attempts)}; foreign hosts: ${foreignHosts.size === 0 ? "none" : [...foreignHosts].join(", ")}; assistant-api.com / assistant-ui.com requests: ${String(cloud.length)} (ADR 0021)`,
      ),
    );
  } catch (error) {
    criteria.push(fail(BAR_COVERAGE, "Browser checks ran to completion", error instanceof Error ? error.message : "unknown error"));
  } finally {
    await runner.stop();
    await launched.close();
  }
  return { criteria, findings, executable: launched.executable };
};
