import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunnerClient } from "../producer/runner-client.ts";
import { buildAllKindsEvents, streamingTurn } from "../producer/scenarios.ts";
import { rows } from "../server/db.ts";
import { ApprovalId, ClientMessageId, OptionId, SegmentId, TaskId, ToolCallId, TurnId } from "../shared/ids.ts";
import { sleep } from "../shared/time.ts";
import { applyLive, createSseClient, type SseClient } from "./sse-client.ts";
import { makeRunner, newTask, readMetrics, request, type Ctx } from "./context.ts";
import { startServerProc, type ServerProc } from "./infra.ts";
import { fail, verdict, type Criterion } from "./report.ts";
import { percentile } from "./stats.ts";

const BAR_WATCHER = "A watcher can't send, in the UI or by calling the API. When two members answer one approval, one wins.";
const BAR_RELOAD = "A reload shows the partial text again within 1 s. A 10 s network drop leaves no gap and no duplicate.";
const BAR_TWO = "Key parts: two viewers see the same thing, from ostra's own stream (SSE, resume by sequence number, partial text never saved).";

const count = async (ctx: Ctx, sql: string, values: unknown[]): Promise<number> => {
  const found = await rows(ctx.pool, z.object({ n: z.coerce.number() }), sql, values);
  return found[0]?.n ?? 0;
};

const turn = (id: string): TurnId => TurnId.parse(id);

// Puts an approval request in the log: a turn, a tool call and the request.
const openApproval = async (runner: RunnerClient, taskId: TaskId, id: string): Promise<ApprovalId> => {
  const approvalId = ApprovalId.parse(`${id}-approval`);
  const toolCallId = ToolCallId.parse(`${id}-call`);
  runner.emit(taskId, { kind: "turn.started", turnId: turn(`${id}-turn`) });
  runner.emit(taskId, {
    kind: "tool.called",
    turnId: turn(`${id}-turn`),
    toolCallId,
    toolKind: "execute",
    title: "git push",
    input: { command: "git push" },
  });
  runner.emit(taskId, {
    kind: "approval.requested",
    turnId: turn(`${id}-turn`),
    approvalId,
    toolCallId,
    options: [
      { optionId: OptionId.parse("once"), label: "Approve once", kind: "allow-once", decision: "allow_once" },
      { optionId: OptionId.parse("task"), label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
      { optionId: OptionId.parse("deny"), label: "Deny", kind: "reject-once", decision: "deny" },
    ],
  });
  await runner.drain(10_000);
  return approvalId;
};

const errorBody = z.object({ error: z.looseObject({ code: z.string() }) });
const codeOf = (json: unknown): string => {
  const parsed = errorBody.safeParse(json);
  return parsed.success ? parsed.data.error.code : "none";
};

export const watcherAndApprovalChecks = async (ctx: Ctx): Promise<Criterion[]> => {
  const out: Criterion[] = [];
  const runner = makeRunner(ctx, ctx.baseA);
  try {
    // ---- a watcher cannot send, by calling the API -------------------------------------------
    const taskId = TaskId.parse("api-watcher");
    await newTask(ctx, taskId, "alex");
    const before = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1", [taskId]);
    const send = (who: string | null, text: string) =>
      request(ctx.baseA, "POST", `/api/tasks/${taskId}/send`, who === null ? null : (ctx.cookies[who === "alex" ? "alex" : who === "sam" ? "sam" : "val"]), {
        text,
        clientMessageId: ClientMessageId.parse(`msg-${text}`),
      });
    const watcher = await send("sam", "from a watcher");
    const viewer = await send("val", "from a read-only viewer");
    const anonymous = await send(null, "from nobody");
    const interrupt = await request(ctx.baseA, "POST", `/api/tasks/${taskId}/interrupt`, ctx.cookies.sam, {});
    const afterRejected = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1", [taskId]);
    const commands = await count(ctx, "SELECT count(*) AS n FROM commands WHERE task_id = $1", [taskId]);
    const driver = await send("alex", "from the driver");
    const afterDriver = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1", [taskId]);
    const ok =
      watcher.status === 403 &&
      codeOf(watcher.json) === "FORBIDDEN" &&
      viewer.status === 403 &&
      anonymous.status === 401 &&
      interrupt.status === 403 &&
      afterRejected === before &&
      driver.status === 200 &&
      afterDriver === before + 1;
    out.push(
      verdict(
        BAR_WATCHER,
        "A watcher cannot send or interrupt by calling the API",
        ok,
        `non-driver member send=${String(watcher.status)}, read-only viewer send=${String(viewer.status)}, signed out=${String(anonymous.status)}, non-driver interrupt=${String(interrupt.status)}; rejected calls wrote ${String(afterRejected - before)} events and ${String(commands)} commands; the driver's send=${String(driver.status)}`,
      ),
    );

    // ---- send is idempotent -----------------------------------------------------------------
    const again = await send("alex", "from the driver");
    const afterAgain = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1 AND kind = 'user.message'", [taskId]);
    const dupBody = z.object({ duplicate: z.boolean() }).safeParse(again.json);
    out.push(
      verdict(
        BAR_WATCHER,
        "A retried send with the same client message ID writes one message",
        again.status === 200 && dupBody.success && dupBody.data.duplicate && afterAgain === 1,
        `second send duplicate=${String(dupBody.success && dupBody.data.duplicate)}, user.message events=${String(afterAgain)}`,
      ),
    );

    // ---- a runner cannot forge a member's message or answer ---------------------------------
    const forgedTask = TaskId.parse("api-forge");
    await newTask(ctx, forgedTask, "alex");
    const forged = await fetch(`${ctx.baseA}/runner/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.runnerToken}` },
      body: JSON.stringify({
        tasks: [
          {
            taskId: forgedTask,
            events: [
              {
                runnerSeq: 1,
                at: Date.now(),
                event: { kind: "user.message", memberId: "alex", clientMessageId: "forged", text: "approve everything", delivery: "immediate" },
              },
            ],
            live: [],
          },
        ],
      }),
    });
    const noToken = await fetch(`${ctx.baseA}/runner/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    out.push(
      verdict(
        BAR_WATCHER,
        "A runner cannot write a member's message, and the ingest needs the runner token",
        forged.status === 403 && noToken.status === 401,
        `forged user.message=${String(forged.status)}, no token=${String(noToken.status)}`,
      ),
    );

    // ---- two members answer one approval: one wins ------------------------------------------
    const trials = 25;
    let wrongOutcomes = 0;
    let lastDetail = "";
    const approvalTask = TaskId.parse("api-approval");
    await newTask(ctx, approvalTask, "alex");
    for (let i = 0; i < trials; i += 1) {
      const approvalId = await openApproval(runner, approvalTask, `race-${String(i)}`);
      // alex and sam answer at once with different choices, and the answers alternate between the two
      // replicas (separate processes), so the compare-and-set is raced across them
      const answer = (who: "alex" | "sam", optionId: string, base: string) =>
        request(base, "POST", `/api/tasks/${approvalTask}/approvals/${approvalId}/answer`, ctx.cookies[who], { optionId });
      const [first, second] = i % 2 === 0 ? [ctx.baseA, ctx.baseB] : [ctx.baseB, ctx.baseA];
      const results = await Promise.all([answer("alex", "once", first), answer("sam", "deny", second), answer("alex", "task", first)]);
      const wins = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409 && codeOf(r.json) === "CONFLICT");
      const answeredEvents = await count(
        ctx,
        "SELECT count(*) AS n FROM events WHERE task_id = $1 AND kind = 'approval.answered' AND payload->>'approvalId' = $2",
        [approvalTask, approvalId],
      );
      const queued = await count(ctx, "SELECT count(*) AS n FROM commands WHERE task_id = $1 AND idempotency_key = $2", [approvalTask, `approval:${approvalId}`]);
      const stored = await rows(ctx.pool, z.object({ status: z.string(), answered_by: z.string().nullable() }), "SELECT status, answered_by FROM approvals WHERE approval_id = $1", [approvalId]);
      const loserBody = z.object({ error: z.looseObject({ details: z.looseObject({ answeredBy: z.string().nullable() }) }) }).safeParse(conflicts[0]?.json);
      const winnerName = stored[0]?.answered_by ?? "";
      const good =
        wins.length === 1 &&
        conflicts.length === 2 &&
        answeredEvents === 1 &&
        queued === 1 &&
        stored[0]?.status === "answered" &&
        loserBody.success &&
        loserBody.data.error.details.answeredBy === winnerName;
      if (!good) wrongOutcomes += 1;
      lastDetail = `wins=${String(wins.length)}, conflicts=${String(conflicts.length)}, approval.answered events=${String(answeredEvents)}, queued commands=${String(queued)}`;
    }
    const viewerAnswer = await openApproval(runner, approvalTask, "viewer-try");
    const viewerResult = await request(ctx.baseA, "POST", `/api/tasks/${approvalTask}/approvals/${viewerAnswer}/answer`, ctx.cookies.val, { optionId: "once" });
    out.push(
      verdict(
        BAR_WATCHER,
        "When two members answer one approval, one wins (the other gets a conflict naming the winner)",
        wrongOutcomes === 0,
        `${String(trials)} races of 3 simultaneous answers, sent to alternating replicas: ${String(trials - wrongOutcomes)} gave exactly one winner, one event and one queued command; last: ${lastDetail}`,
      ),
    );
    out.push(
      verdict(
        BAR_WATCHER,
        "A read-only viewer cannot answer an approval",
        viewerResult.status === 403,
        `viewer answer=${String(viewerResult.status)}`,
      ),
    );

    // ---- take over is a compare-and-set -----------------------------------------------------
    const handoffTask = TaskId.parse("api-takeover");
    await newTask(ctx, handoffTask, "alex");
    const info = await request(ctx.baseA, "GET", `/api/tasks/${handoffTask}`, ctx.cookies.sam);
    const version = z.object({ task: z.object({ driverVersion: z.number() }) }).parse(info.json).task.driverVersion;
    // a read-only viewer cannot take over or interrupt by calling the API, and nothing is written
    const beforeViewer = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1", [handoffTask]);
    const viewerTakeOver = await request(ctx.baseA, "POST", `/api/tasks/${handoffTask}/take-over`, ctx.cookies.val, { expectedVersion: version });
    const viewerInterrupt = await request(ctx.baseB, "POST", `/api/tasks/${handoffTask}/interrupt`, ctx.cookies.val, {});
    const afterViewer = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1", [handoffTask]);
    const viewerChanged = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1 AND kind = 'driver.changed'", [handoffTask]);
    const viewerCommands = await count(ctx, "SELECT count(*) AS n FROM commands WHERE task_id = $1", [handoffTask]);
    out.push(
      verdict(
        BAR_WATCHER,
        "A read-only viewer cannot take over or interrupt by calling the API",
        viewerTakeOver.status === 403 && viewerInterrupt.status === 403 && afterViewer === beforeViewer && viewerChanged === 0 && viewerCommands === 0,
        `viewer take-over=${String(viewerTakeOver.status)}, viewer interrupt=${String(viewerInterrupt.status)}; wrote ${String(afterViewer - beforeViewer)} events (${String(viewerChanged)} driver.changed) and ${String(viewerCommands)} commands. A watcher answering a question is not covered: question.answer is not built yet`,
      ),
    );
    const takeOver = (who: "alex" | "sam") => request(ctx.baseA, "POST", `/api/tasks/${handoffTask}/take-over`, ctx.cookies[who], { expectedVersion: version });
    const [t1, t2] = await Promise.all([takeOver("sam"), takeOver("alex")]);
    const statuses = [t1.status, t2.status].sort();
    const driverNow = await rows(ctx.pool, z.object({ driver_member_id: z.string() }), "SELECT driver_member_id FROM tasks WHERE task_id = $1", [handoffTask]);
    const newDriver = driverNow[0]?.driver_member_id ?? "";
    const oldDriver = newDriver === "sam" ? "alex" : "sam";
    const newDriverSend = await request(ctx.baseA, "POST", `/api/tasks/${handoffTask}/send`, ctx.cookies[newDriver === "sam" ? "sam" : "alex"], { text: "mine now", clientMessageId: "handoff-1" });
    const oldDriverSend = await request(ctx.baseA, "POST", `/api/tasks/${handoffTask}/send`, ctx.cookies[oldDriver === "sam" ? "sam" : "alex"], { text: "not mine", clientMessageId: "handoff-2" });
    const changed = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1 AND kind = 'driver.changed'", [handoffTask]);
    out.push(
      verdict(
        BAR_WATCHER,
        "Take over is a compare-and-set: one of two simultaneous takers wins, and the loser becomes a watcher",
        statuses.join(",") === "200,409" && newDriverSend.status === 200 && oldDriverSend.status === 403 && changed === 1,
        `statuses=${statuses.join("/")}, new driver ${newDriver} send=${String(newDriverSend.status)}, previous driver send=${String(oldDriverSend.status)}, driver.changed events=${String(changed)}`,
      ),
    );

    // ---- the runner protocol is idempotent and refuses gaps --------------------------------
    const idemTask = TaskId.parse("api-idempotent");
    await newTask(ctx, idemTask, "alex");
    const body = (seqs: number[]) =>
      JSON.stringify({
        tasks: [
          {
            taskId: idemTask,
            events: seqs.map((runnerSeq) => ({ runnerSeq, at: Date.now(), event: { kind: "session.restored" } })),
            live: [],
          },
        ],
      });
    const post = (text: string) =>
      fetch(`${ctx.baseA}/runner/ingest`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ctx.runnerToken}` }, body: text });
    const first = await post(body([1, 2, 3]));
    const resend = await post(body([1, 2, 3]));
    const resendJson = z.object({ outcomes: z.array(z.looseObject({ ok: z.boolean(), accepted: z.number().optional(), duplicates: z.number().optional() })) }).parse(await resend.json());
    const gap = await post(body([6]));
    const gapOutcome = z
      .object({ outcomes: z.array(z.looseObject({ ok: z.boolean(), reason: z.string().optional(), expectedRunnerSeq: z.number().optional() })) })
      .parse(await gap.json()).outcomes[0];
    const stored = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1", [idemTask]);
    out.push(
      verdict(
        BAR_TWO,
        "Saving is idempotent by the runner's own sequence number, and a gap is refused",
        first.status === 200 && resend.status === 200 && resendJson.outcomes[0]?.accepted === 0 && resendJson.outcomes[0].duplicates === 3 && gapOutcome?.ok === false && gapOutcome.reason === "gap" && gapOutcome.expectedRunnerSeq === 4 && stored === 3,
        `first=${String(first.status)}, resend accepted ${String(resendJson.outcomes[0]?.accepted)} / duplicates ${String(resendJson.outcomes[0]?.duplicates)}, the next batch skipped ahead to runner seq 6: refused as "${gapOutcome?.reason ?? "?"}", expecting ${String(gapOutcome?.expectedRunnerSeq)}; events stored=${String(stored)}`,
      ),
    );
  } catch (error) {
    out.push(fail(BAR_WATCHER, "API checks ran to completion", error instanceof Error ? error.message : "unknown error"));
  } finally {
    await runner.stop();
  }
  return out;
};

export const streamChecks = async (ctx: Ctx): Promise<Criterion[]> => {
  const out: Criterion[] = [];
  const runner = makeRunner(ctx, ctx.baseA);
  const clients: SseClient[] = [];
  try {
    // ---- two viewers, two replicas: the same events, in the same order ----------------------
    const taskId = TaskId.parse("api-two-viewers");
    await newTask(ctx, taskId, "alex");
    const viewerA = createSseClient({ baseUrl: ctx.baseA, path: `/api/tasks/${taskId}/stream`, cookie: ctx.cookies.alex });
    const viewerB = createSseClient({ baseUrl: ctx.baseB, path: `/api/tasks/${taskId}/stream`, cookie: ctx.cookies.sam });
    clients.push(viewerA, viewerB);
    await Promise.all([viewerA.open(), viewerB.open()]);
    // replica B polls once a minute in this harness, so what reaches its viewer reaches it by NOTIFY
    const notifiesBefore = (await readMetrics(ctx.baseB, ctx.runnerToken)).notifiesReceived;
    const { events } = buildAllKindsEvents("tv");
    for (const event of events) {
      runner.emit(taskId, event);
      await sleep(3);
    }
    await runner.drain(10_000);
    const expected = events.length;
    await Promise.all([viewerA.waitFor(() => viewerA.events.length >= expected, 8000), viewerB.waitFor(() => viewerB.events.length >= expected, 8000)]);
    const notifies = (await readMetrics(ctx.baseB, ctx.runnerToken)).notifiesReceived - notifiesBefore;
    const sortedB = [...viewerB.latencies].sort((x, y) => x - y);
    const p99B = percentile(sortedB, 99);
    const history = await request(ctx.baseA, "GET", `/api/tasks/${taskId}/history?turns=all`, ctx.cookies.sam);
    const historyEvents = z.object({ events: z.array(z.looseObject({ seq: z.number() })) }).parse(history.json).events;
    const same = JSON.stringify(viewerA.events) === JSON.stringify(viewerB.events);
    const matchesHistory = JSON.stringify(viewerA.events.map((e) => e.seq)) === JSON.stringify(historyEvents.map((e) => e.seq));
    out.push(
      verdict(
        BAR_TWO,
        "Two viewers, on two replicas, receive exactly the same events in the same order, and the same as history",
        same && matchesHistory && viewerA.events.length === expected && viewerA.stats.gaps === 0 && viewerB.stats.gaps === 0 && notifies > 0 && p99B < 250,
        `viewer on replica A got ${String(viewerA.events.length)}, viewer on replica B got ${String(viewerB.events.length)} of ${String(expected)} (identical: ${String(same)}, equals history: ${String(matchesHistory)}); gaps ${String(viewerA.stats.gaps)}/${String(viewerB.stats.gaps)}, duplicates ${String(viewerA.stats.duplicates)}/${String(viewerB.stats.duplicates)}; replica B (a separate process, polling once a minute) received ${String(notifies)} NOTIFY wake-ups, and its viewer saw every event within p99 ${String(Math.round(p99B))} ms of the runner's emit time (limit 250 ms)`,
      ),
    );
    viewerA.close();
    viewerB.close();

    // ---- an unauthenticated stream is refused ------------------------------------------------
    const anon = await fetch(`${ctx.baseA}/api/tasks/${taskId}/stream`);
    await anon.arrayBuffer();
    out.push(verdict(BAR_TWO, "A stream needs a signed-in member", anon.status === 401, `signed out: ${String(anon.status)}`));

    // ---- resume by sequence number across a dropped stream and another replica -------------
    const resumeTask = TaskId.parse("api-resume");
    await newTask(ctx, resumeTask, "alex");
    const first = createSseClient({ baseUrl: ctx.baseA, path: `/api/tasks/${resumeTask}/stream`, cookie: ctx.cookies.sam });
    clients.push(first);
    await first.open();
    const total = 400;
    let emitted = 0;
    const emitSome = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i += 1) {
        emitted += 1;
        runner.emit(resumeTask, {
          kind: "agent.message",
          turnId: turn("resume-turn"),
          segmentId: SegmentId.parse(`resume-seg-${String(emitted)}`),
          text: `message ${String(emitted)}`,
        });
        if (emitted % 10 === 0) await sleep(5);
      }
    };
    await emitSome(total / 2);
    await first.waitFor(() => first.events.length >= 100, 5000);
    const cutAt = first.lastSeen();
    first.close();
    await emitSome(total / 2);
    await runner.drain(10_000);
    // The reconnect carries Last-Event-ID, and lands on the other replica.
    const second = createSseClient({ baseUrl: ctx.baseB, path: `/api/tasks/${resumeTask}/stream`, cookie: ctx.cookies.sam, lastEventId: cutAt });
    clients.push(second);
    await second.open();
    await second.waitFor(() => second.lastSeen() >= total, 8000);
    const seqs = [...first.events.map((e) => e.seq).filter((s) => s <= cutAt), ...second.events.map((e) => e.seq)];
    const contiguous = seqs.length === total && seqs.every((s, i) => s === i + 1);
    out.push(
      verdict(
        BAR_RELOAD,
        "A dropped stream resumes from Last-Event-ID on another replica with no gap and no duplicate",
        contiguous && second.stats.gaps === 0 && second.stats.duplicates === 0,
        `cut after seq ${String(cutAt)} of ${String(total)}; first stream saw ${String(first.events.length)}, resumed stream saw ${String(second.events.length)}; joined sequence has ${String(seqs.length)} events, contiguous 1..${String(total)}: ${String(contiguous)}`,
      ),
    );
    second.close();

    // ---- partial text: shown, never saved, late joiners get a snapshot ----------------------
    const liveTask = TaskId.parse("api-live");
    await newTask(ctx, liveTask, "alex");
    const early = createSseClient({ baseUrl: ctx.baseA, path: `/api/tasks/${liveTask}/stream`, cookie: ctx.cookies.alex });
    clients.push(early);
    await early.open();
    const segmentId = "live-seg";
    const streaming = streamingTurn(runner, liveTask, { turnId: "live-turn", segmentId, totalWords: 120, streamMs: 3000 });
    let storedBeforeCommit = 0;
    let liveRowsSeen = 0;
    const sampler = (async () => {
      for (let i = 0; i < 11; i += 1) {
        await sleep(250);
        storedBeforeCommit += await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1 AND kind = 'agent.message'", [liveTask]);
        liveRowsSeen = Math.max(liveRowsSeen, await count(ctx, "SELECT count(*) AS n FROM task_live_text WHERE task_id = $1", [liveTask]));
      }
    })();
    await sleep(1500);
    const late = createSseClient({ baseUrl: ctx.baseB, path: `/api/tasks/${liveTask}/stream`, cookie: ctx.cookies.sam });
    clients.push(late);
    await late.open();
    await late.waitFor(() => late.live.length > 0, 3000);
    const firstLate = late.live[0];
    await streaming;
    await runner.drain(10_000);
    await sampler;
    await early.waitFor(() => early.events.some((e) => e.event.kind === "agent.message"), 5000);
    await late.waitFor(() => late.events.some((e) => e.event.kind === "agent.message"), 5000);
    await sleep(600);
    const liveRowsAfter = await count(ctx, "SELECT count(*) AS n FROM task_live_text WHERE task_id = $1", [liveTask]);
    const committed = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1 AND kind = 'agent.message'", [liveTask]);
    const noId = early.frames.filter((f) => f.event === "live").every((f) => f.id === null);
    const finalLate = applyLive(late.live).get(segmentId) ?? "";
    out.push(
      verdict(
        BAR_RELOAD,
        "Partial text is shown to every viewer, and never saved",
        early.live.length >= 5 && storedBeforeCommit === 0 && liveRowsSeen === 1 && committed === 1 && liveRowsAfter === 0,
        `${String(early.live.length)} partial frames reached the early viewer; completed messages stored while the segment was open: ${String(storedBeforeCommit)}; live row existed (${String(liveRowsSeen)}) and was deleted on commit (${String(liveRowsAfter)} left); completed messages stored at the end: ${String(committed)}`,
      ),
    );
    out.push(
      verdict(
        BAR_RELOAD,
        "A viewer who joins late, on another replica, gets the current partial text as a snapshot",
        firstLate?.offset === 0 && firstLate.text.length > 0 && finalLate.length > 0,
        `first frame to the late joiner: offset ${String(firstLate?.offset)}, ${String(firstLate?.text.length)} chars (the segment was about 1.5 s old)`,
      ),
    );
    out.push(
      verdict(
        BAR_RELOAD,
        "Live frames carry no event id, so Last-Event-ID stays on the newest committed event",
        noId && early.frames.some((f) => f.event === "live"),
        `${String(early.frames.filter((f) => f.event === "live").length)} live frames, all without an id line; committed events carried ids ${String(early.frames.filter((f) => f.event === "event").every((f) => f.id !== null))}`,
      ),
    );
  } catch (error) {
    out.push(fail(BAR_TWO, "Stream checks ran to completion", error instanceof Error ? error.message : "unknown error"));
  } finally {
    for (const client of clients) client.close();
    await runner.stop();
  }
  return out;
};

const BAR_HARDENING = "Strict typecheck and lint pass with only documented suppressions. The page calls no third party.";

// What a self-hostable server must not do by default: hand out sessions with no secret, serve its counters to
// anyone, keep working cookies in its tables, answer a bad query with a 500, or accept a mutation without JSON.
export const hardeningChecks = async (ctx: Ctx): Promise<Criterion[]> => {
  const out: Criterion[] = [];
  let plain: ServerProc | null = null;
  try {
    // a replica started without OSTRA_SPIKE_DEV_LOGIN has no sign-in stand-in at all
    plain = await startServerProc(ctx.dev.url, "replica-plain", ctx.runnerToken, { OSTRA_SPIKE_DEV_LOGIN: "0" });
    const devLogin = await request(plain.baseUrl, "POST", "/api/dev-login", null, { memberId: "alex" });
    const metricsAnonymous = await fetch(`${plain.baseUrl}/metrics`);
    await metricsAnonymous.arrayBuffer();
    const metricsWrongToken = await fetch(`${plain.baseUrl}/metrics`, { headers: { authorization: "Bearer not-the-token-not-the-token" } });
    await metricsWrongToken.arrayBuffer();
    const metricsWithToken = await readMetrics(plain.baseUrl, ctx.runnerToken);
    // a server that would serve dev-login on a non-loopback address refuses to start
    let refused = false;
    try {
      const open = await startServerProc(ctx.dev.url, "replica-open", ctx.runnerToken, { OSTRA_SPIKE_DEV_LOGIN: "1", HOST: "0.0.0.0" });
      await open.stop();
    } catch {
      refused = true;
    }
    // a server with no runner token does not start (there is no default)
    let noTokenRefused = false;
    try {
      const bare = await startServerProc(ctx.dev.url, "replica-bare", "short", {});
      await bare.stop();
    } catch {
      noTokenRefused = true;
    }
    out.push(
      verdict(
        BAR_HARDENING,
        "Safe by default: no dev sign-in unless asked for (and never on a non-loopback address), /metrics needs the runner token, and a runner token under 24 characters is refused",
        devLogin.status === 404 && metricsAnonymous.status === 401 && metricsWrongToken.status === 401 && metricsWithToken.replica === "replica-plain" && refused && noTokenRefused,
        `dev-login on a default server=${String(devLogin.status)}; /metrics with no token=${String(metricsAnonymous.status)}, with a wrong one=${String(metricsWrongToken.status)}, with the runner token=ok; OSTRA_SPIKE_DEV_LOGIN=1 with HOST=0.0.0.0 refused to start: ${String(refused)}; a 5-character runner token refused: ${String(noTokenRefused)}`,
      ),
    );

    // only a hash of a session token is stored
    const cookie = ctx.cookies.alex;
    const token = cookie.split("=")[1] ?? "";
    const hash = createHash("sha256").update(token).digest("hex");
    const plainRows = await count(ctx, "SELECT count(*) AS n FROM sessions WHERE token_hash = $1", [token]);
    const hashRows = await count(ctx, "SELECT count(*) AS n FROM sessions WHERE token_hash = $1", [hash]);
    out.push(
      verdict(
        BAR_HARDENING,
        "A session token is stored only as its SHA-256, never in the clear",
        token.length >= 32 && plainRows === 0 && hashRows === 1,
        `rows holding the cookie value as it is: ${String(plainRows)}; rows holding its SHA-256: ${String(hashRows)}`,
      ),
    );

    // boundary validation: bad input is a 4xx, never a 500
    const taskId = TaskId.parse("api-boundary");
    await newTask(ctx, taskId, "alex");
    const auth = { authorization: `Bearer ${ctx.runnerToken}` };
    const fractional = await fetch(`${ctx.baseA}/runner/commands?taskId=${taskId}&after=1.5`, { headers: auth });
    await fractional.arrayBuffer();
    const negative = await fetch(`${ctx.baseA}/runner/commands?taskId=${taskId}&after=-1`, { headers: auth });
    await negative.arrayBuffer();
    const valid = await fetch(`${ctx.baseA}/runner/commands?taskId=${taskId}&after=0`, { headers: auth });
    const validBody = z.object({ commands: z.array(z.unknown()) }).safeParse(await valid.json());
    const badPath = await fetch(`${ctx.baseA}/%`);
    await badPath.arrayBuffer();
    const noJson = await fetch(`${ctx.baseA}/api/tasks/${taskId}/interrupt`, { method: "POST", headers: { cookie: ctx.cookies.alex } });
    await noJson.arrayBuffer();
    const extraField = await request(ctx.baseA, "POST", `/api/tasks/${taskId}/interrupt`, ctx.cookies.alex, { surprise: true });
    const eventsWritten = await count(ctx, "SELECT count(*) AS n FROM events WHERE task_id = $1", [taskId]);
    out.push(
      verdict(
        BAR_HARDENING,
        "Bad input is a 4xx, not a 500: a fractional or negative `after`, a path with a stray %, an interrupt with no JSON body or with an unknown field",
        fractional.status === 400 && negative.status === 400 && valid.status === 200 && validBody.success && badPath.status === 404 && noJson.status === 400 && extraField.status === 400 && eventsWritten === 0,
        `after=1.5 -> ${String(fractional.status)}, after=-1 -> ${String(negative.status)}, after=0 -> ${String(valid.status)}; GET /% -> ${String(badPath.status)}; interrupt with no body -> ${String(noJson.status)}, with an unknown field -> ${String(extraField.status)}; events written by the rejected calls: ${String(eventsWritten)}`,
      ),
    );
  } catch (error) {
    out.push(fail(BAR_HARDENING, "Hardening checks ran to completion", error instanceof Error ? error.message : "unknown error"));
  } finally {
    if (plain !== null) await plain.stop();
  }
  return out;
};
