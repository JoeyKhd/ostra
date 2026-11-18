import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import {
  answerRequest,
  answerResponse,
  apiError,
  commandsQuery,
  commandsResponse,
  errorCode,
  errorStatus,
  healthResponse,
  historyPage,
  interruptRequest,
  interruptResponse,
  loginRequest,
  loginResponse,
  meResponse,
  metricsResponse,
  sendRequest,
  sendResponse,
  takeOverRequest,
  takeOverResponse,
  taskInfo,
  type ErrorCode,
  type MemberRole,
  type SseMetrics,
} from "../shared/api.ts";
import { approvalOption, ingestRequest, ingestResponse, serverOnlyKinds, type ApprovalOption, type TaskEvent } from "../shared/events.ts";
import { createFailure, isFailure, type FailureDetails } from "../shared/failure.ts";
import { ApprovalId, MemberId, TaskId } from "../shared/ids.ts";
import type { Appender, AppendRequest, WakeItem } from "./appender.ts";
import type { ServerSettings } from "./config.ts";
import { exec, rows, withTx, type Db } from "./db.ts";
import type { Logger } from "./log.ts";
import { attach, openStream, PING_FRAME } from "./sse.ts";
import type { Tailer } from "./tailer.ts";
import type { WakeListener, WakeSender } from "./wake.ts";

export type Services = {
  readonly settings: ServerSettings;
  readonly db: Db;
  readonly appender: Appender;
  readonly tailer: Tailer;
  readonly sender: WakeSender;
  readonly listener: WakeListener;
  readonly log: Logger;
  readonly sseMetrics: SseMetrics;
  readonly afterCommit: (wake: WakeItem[]) => void;
};

// ---- small http helpers ------------------------------------------------------------------

const failure = (code: ErrorCode, message: string, details: FailureDetails = {}): Error => createFailure(code, message, details);

// The body is checked against the schema the page parses it with, so the two cannot drift apart.
const sendJson = <S extends z.ZodType>(res: ServerResponse, status: number, schema: S, body: z.input<S>, headers: Record<string, string> = {}): void => {
  schema.parse(body);
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
};

const sendError = (res: ServerResponse, code: ErrorCode, message: string, details: FailureDetails = {}): void => {
  sendJson(res, errorStatus[code], apiError, { error: { code, message, details } });
};

const readBody = async (req: IncomingMessage, limit: number): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part: unknown = chunk;
    if (!(part instanceof Buffer)) throw failure("BAD_REQUEST", "unreadable body");
    size += part.length;
    if (size > limit) throw failure("BAD_REQUEST", "body too large");
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
};

// Every mutation accepts JSON only: a body that carries nothing is still an (empty, strict) object.
const readJson = async <S extends z.ZodType>(req: IncomingMessage, schema: S, limit = 1_000_000): Promise<z.infer<S>> => {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.startsWith("application/json")) throw failure("BAD_REQUEST", "content-type must be application/json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req, limit));
  } catch (error) {
    if (isFailure(error)) throw error;
    throw failure("BAD_REQUEST", "invalid json");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw failure("BAD_REQUEST", "invalid body");
  return result.data;
};

const parseCookie = (header: string | undefined): Map<string, string> => {
  const out = new Map<string, string>();
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return out;
};

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const parseUrl = (req: IncomingMessage): URL => {
  try {
    return new URL(req.url ?? "/", "http://localhost");
  } catch {
    throw failure("BAD_REQUEST", "bad url");
  }
};

// ---- identity: a stand-in for better-auth (ADR 0003) -------------------------------------

const memberRow = z.object({ member_id: MemberId, role: z.enum(["member", "viewer"]) });
type Viewer = { readonly memberId: MemberId; readonly role: MemberRole };

const taskRow = z.object({
  task_id: TaskId,
  driver_member_id: MemberId.nullable(),
  driver_version: z.coerce.number(),
});

const AUTH_TTL_MS = 3000;

// A session is a random token in a cookie; the database holds only its SHA-256. The cache belongs to
// one replica (and one handler), so two replicas never share it.
const createAuthenticator = (db: Db): ((req: IncomingMessage) => Promise<Viewer | null>) => {
  const cache = new Map<string, { viewer: Viewer | null; at: number }>();
  return async (req) => {
    const token = parseCookie(req.headers.cookie).get("ostra_token");
    if (token === undefined || token.length === 0) return null;
    const hash = sha256(token);
    const cached = cache.get(hash);
    if (cached !== undefined && Date.now() - cached.at < AUTH_TTL_MS) return cached.viewer;
    const found = await rows(
      db,
      memberRow,
      "SELECT m.member_id, m.role FROM sessions s JOIN members m ON m.member_id = s.member_id WHERE s.token_hash = $1",
      [hash],
    );
    const row = found[0];
    const viewer: Viewer | null = row === undefined ? null : { memberId: row.member_id, role: row.role };
    cache.set(hash, { viewer, at: Date.now() });
    if (cache.size > 10_000) cache.clear();
    return viewer;
  };
};

const loadTask = async (db: Db, taskId: TaskId): Promise<z.infer<typeof taskRow>> => {
  const found = await rows(db, taskRow, "SELECT task_id, driver_member_id, driver_version FROM tasks WHERE task_id = $1", [taskId]);
  const row = found[0];
  if (row === undefined) throw failure("NOT_FOUND", "no such task");
  return row;
};

const headOf = async (db: Db, taskId: TaskId): Promise<number> => {
  const found = await rows(db, z.object({ head: z.coerce.number() }), "SELECT next_seq - 1 AS head FROM task_counters WHERE task_id = $1", [taskId]);
  return found[0]?.head ?? 0;
};

const isTurnRunning = async (db: Db, taskId: TaskId): Promise<boolean> => {
  const found = await rows(
    db,
    z.object({ kind: z.string() }),
    "SELECT kind FROM events WHERE task_id = $1 AND kind IN ('turn.started', 'turn.ended', 'turn.failed') ORDER BY seq DESC LIMIT 1",
    [taskId],
  );
  return found[0]?.kind === "turn.started";
};

// ---- routes -----------------------------------------------------------------------------

const lastEventIdOf = (req: IncomingMessage, url: URL): number => {
  const header = req.headers["last-event-id"];
  const raw = (typeof header === "string" ? header : undefined) ?? url.searchParams.get("lastEventId") ?? "0";
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

const wireRow = z.object({
  seq: z.coerce.number(),
  at_ms: z.coerce.number(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

const handleHistory = async (services: Services, taskId: TaskId, url: URL, res: ServerResponse): Promise<void> => {
  const head = await headOf(services.db, taskId);
  const beforeParam = url.searchParams.get("before");
  const before = beforeParam === null ? head + 1 : Math.min(Number(beforeParam), head + 1);
  if (!Number.isInteger(before) || before < 1) throw failure("BAD_REQUEST", "bad before");
  const turnsParam = url.searchParams.get("turns") ?? "20";
  let start = 1;
  if (turnsParam !== "all") {
    const turns = Number(turnsParam);
    if (!Number.isInteger(turns) || turns < 1 || turns > 10_000) throw failure("BAD_REQUEST", "bad turns");
    const starts = await rows(
      services.db,
      z.object({ seq: z.coerce.number() }),
      "SELECT seq FROM events WHERE task_id = $1 AND kind = 'turn.started' AND seq < $2 ORDER BY seq DESC LIMIT $3",
      [taskId, before, turns],
    );
    const earliest = starts.length === turns ? starts[starts.length - 1]?.seq : undefined;
    if (earliest !== undefined) {
      // Include the member's message that began the turn: start after the previous turn's end.
      const prev = await rows(
        services.db,
        z.object({ seq: z.coerce.number().nullable() }),
        "SELECT max(seq) AS seq FROM events WHERE task_id = $1 AND kind IN ('turn.ended', 'turn.failed') AND seq < $2",
        [taskId, earliest],
      );
      start = (prev[0]?.seq ?? 0) + 1;
    }
  }
  const events = await rows(
    services.db,
    wireRow,
    "SELECT seq, at_ms, kind, payload FROM events WHERE task_id = $1 AND seq >= $2 AND seq < $3 ORDER BY seq",
    [taskId, start, before],
  );
  sendJson(res, 200, historyPage, {
    events: events.map((row) => ({ seq: row.seq, at: row.at_ms, event: { kind: row.kind, ...row.payload } })),
    hasEarlier: start > 1,
    oldestSeq: start,
    headSeq: head,
  });
};

const handleStream = async (services: Services, viewer: Viewer, taskId: TaskId, req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> => {
  await loadTask(services.db, taskId);
  const lastEventId = lastEventIdOf(req, url);
  const connection = openStream(res, lastEventId, services.sseMetrics);
  // ADR 0035: an open stream outlives a revoked session, so re-check membership on a timer.
  const recheck = setInterval(() => {
    void rows(services.db, memberRow, "SELECT member_id, role FROM members WHERE member_id = $1", [viewer.memberId])
      .then((found) => {
        if (found.length === 0) res.end();
      })
      .catch(() => undefined);
  }, 30_000);
  const keepAlive = setInterval(() => {
    connection.write(PING_FRAME);
  }, 15_000);
  res.on("close", () => {
    clearInterval(recheck);
    clearInterval(keepAlive);
    services.tailer.unsubscribe(taskId, connection);
  });
  await attach(services.tailer, services.db, taskId, connection, lastEventId);
};

const serverEvent = (event: TaskEvent): AppendRequest["events"][number] => ({ runnerSeq: null, at: Date.now(), event });

const noWake: WakeItem[] = [];

const commandInsert =
  "INSERT INTO commands (task_id, type, payload, idempotency_key) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (task_id, idempotency_key) DO NOTHING";

const handleSend = async (services: Services, viewer: Viewer, taskId: TaskId, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const body = await readJson(req, sendRequest);
  const task = await loadTask(services.db, taskId);
  // The server enforces it. The UI only hides the controls (ADR 0036).
  if (viewer.role !== "member" || task.driver_member_id !== viewer.memberId) {
    throw failure("FORBIDDEN", "only the driver can send");
  }
  const running = await isTurnRunning(services.db, taskId);
  const delivery = body.interruptFirst === true ? "after-interrupt" : running ? "queued" : "immediate";
  const outcome = await withTx(services.db, async (client) => {
    const inserted = await exec(client, commandInsert, [
      taskId,
      "prompt",
      JSON.stringify({ text: body.text, clientMessageId: body.clientMessageId, delivery }),
      `send:${body.clientMessageId}`,
    ]);
    if (inserted === 0) return { duplicate: true as const, wake: noWake, seq: 0 };
    const events: TaskEvent[] = [];
    if (delivery === "after-interrupt") events.push({ kind: "turn.cancel_requested", memberId: viewer.memberId });
    events.push({
      kind: "user.message",
      memberId: viewer.memberId,
      clientMessageId: body.clientMessageId,
      text: body.text,
      delivery,
    });
    const batch = await services.appender.commit(client, [{ taskId, events: events.map(serverEvent), live: [] }]);
    const first = batch.outcomes[0];
    return { duplicate: false as const, wake: batch.wake, seq: first?.ok === true ? first.headSeq : 0 };
  });
  services.afterCommit(outcome.wake);
  sendJson(res, 200, sendResponse, { ok: true, duplicate: outcome.duplicate, delivery, seq: outcome.seq });
};

const handleInterrupt = async (services: Services, viewer: Viewer, taskId: TaskId, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  await readJson(req, interruptRequest);
  const task = await loadTask(services.db, taskId);
  if (viewer.role !== "member" || task.driver_member_id !== viewer.memberId) {
    throw failure("FORBIDDEN", "only the driver can interrupt");
  }
  const wake = await withTx(services.db, async (client) => {
    const batch = await services.appender.commit(client, [
      { taskId, events: [serverEvent({ kind: "turn.cancel_requested", memberId: viewer.memberId })], live: [] },
    ]);
    await exec(client, commandInsert, [taskId, "cancel", JSON.stringify({ by: viewer.memberId }), `cancel:${String(Date.now())}:${randomBytes(6).toString("hex")}`]);
    return batch.wake;
  });
  services.afterCommit(wake);
  sendJson(res, 200, interruptResponse, { ok: true });
};

const handleTakeOver = async (services: Services, viewer: Viewer, taskId: TaskId, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const body = await readJson(req, takeOverRequest);
  if (viewer.role !== "member") throw failure("FORBIDDEN", "viewers cannot take over");
  const result = await withTx(services.db, async (client) => {
    // lock order: counter row first, then the rows it guards
    await client.query("SELECT 1 FROM task_counters WHERE task_id = $1 FOR UPDATE", [taskId]);
    // a compare-and-set on the driver's version
    const updated = await rows(
      client,
      z.object({ driver_version: z.coerce.number(), previous: z.string().nullable() }),
      `UPDATE tasks t SET driver_member_id = $2, driver_version = t.driver_version + 1
       FROM (SELECT task_id, driver_member_id AS previous FROM tasks WHERE task_id = $1) p
       WHERE t.task_id = p.task_id AND t.driver_version = $3
       RETURNING t.driver_version, p.previous`,
      [taskId, viewer.memberId, body.expectedVersion],
    );
    if (updated.length === 0) return { ok: false as const };
    const batch = await services.appender.commit(client, [
      { taskId, events: [serverEvent({ kind: "driver.changed", memberId: viewer.memberId, byMemberId: viewer.memberId })], live: [] },
    ]);
    return { ok: true as const, version: updated[0]?.driver_version ?? 0, wake: batch.wake };
  });
  if (!result.ok) {
    const task = await loadTask(services.db, taskId);
    throw failure("CONFLICT", "someone else took over first", {
      driverMemberId: task.driver_member_id,
      driverVersion: task.driver_version,
    });
  }
  services.afterCommit(result.wake);
  sendJson(res, 200, takeOverResponse, { ok: true, driverVersion: result.version });
};

const approvalRow = z.object({
  approval_id: ApprovalId,
  status: z.enum(["pending", "answered", "closed"]),
  decision: z.string().nullable(),
  answered_by: z.string().nullable(),
  options: z.array(approvalOption),
});

const handleAnswer = async (
  services: Services,
  viewer: Viewer,
  taskId: TaskId,
  approvalId: ApprovalId,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const body = await readJson(req, answerRequest);
  // Any member who can open the project may answer; a read-only viewer may not (ADR 0036).
  if (viewer.role !== "member") throw failure("FORBIDDEN", "viewers cannot answer approvals");
  await loadTask(services.db, taskId);
  const result = await withTx(services.db, async (client) => {
    await client.query("SELECT 1 FROM task_counters WHERE task_id = $1 FOR UPDATE", [taskId]);
    const current = await rows(
      client,
      approvalRow,
      "SELECT approval_id, status, decision, answered_by, options FROM approvals WHERE approval_id = $1 AND task_id = $2 FOR UPDATE",
      [approvalId, taskId],
    );
    const approval = current[0];
    if (approval === undefined) return { kind: "missing" as const };
    const option: ApprovalOption | undefined = approval.options.find((o) => o.optionId === body.optionId);
    if (option === undefined) return { kind: "bad-option" as const };
    // The compare-and-set: pending -> answered. The first answer wins; a second member gets a conflict.
    const updated = await exec(
      client,
      "UPDATE approvals SET status = 'answered', decision = $3, option_id = $4, answered_by = $5 WHERE approval_id = $1 AND task_id = $2 AND status = 'pending'",
      [approvalId, taskId, option.decision, option.optionId, viewer.memberId],
    );
    if (updated === 0) {
      return { kind: "lost" as const, status: approval.status, decision: approval.decision, by: approval.answered_by };
    }
    const batch = await services.appender.commit(client, [
      {
        taskId,
        events: [
          serverEvent({
            kind: "approval.answered",
            approvalId,
            optionId: option.optionId,
            decision: option.decision,
            memberId: viewer.memberId,
          }),
        ],
        live: [],
      },
    ]);
    // Committed together with the answer, before anything reaches the agent (ADR 0011).
    await exec(client, commandInsert, [
      taskId,
      "approval_answer",
      JSON.stringify({ approvalId, optionId: option.optionId, decision: option.decision, memberId: viewer.memberId }),
      `approval:${approvalId}`,
    ]);
    return { kind: "won" as const, wake: batch.wake, decision: option.decision };
  });
  switch (result.kind) {
    case "missing":
      throw failure("NOT_FOUND", "no such approval");
    case "bad-option":
      throw failure("BAD_REQUEST", "unknown option");
    case "lost":
      throw failure("CONFLICT", "already answered", {
        status: result.status,
        decision: result.decision,
        answeredBy: result.by,
      });
    case "won":
      services.afterCommit(result.wake);
      sendJson(res, 200, answerResponse, { ok: true, decision: result.decision });
      return;
    default:
      return result satisfies never;
  }
};

// The runner's token guards the runner routes and /metrics.
const requireRunnerToken = (services: Services, req: IncomingMessage): void => {
  const auth = req.headers.authorization ?? "";
  if (!safeEqual(auth, `Bearer ${services.settings.OSTRA_SPIKE_RUNNER_TOKEN}`)) {
    throw failure("UNAUTHORIZED", "bad runner token");
  }
};

const commandRow = z.object({ id: z.coerce.number(), type: z.string(), payload: z.record(z.string(), z.unknown()) });

const handleRunner = async (services: Services, req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> => {
  requireRunnerToken(services, req);
  if (url.pathname === "/runner/ingest" && req.method === "POST") {
    const request = await readJson(req, ingestRequest, 16_000_000);
    for (const batch of request.tasks) {
      if (batch.events.some((e) => serverOnlyKinds.has(e.event.kind))) {
        throw failure("FORBIDDEN", "a runner cannot write server-owned events");
      }
    }
    // Every task's batch joins the same group commit.
    const outcomes = await Promise.all(
      request.tasks.map((batch) =>
        services.appender.append({
          taskId: batch.taskId,
          events: batch.events.map((e) => ({ runnerSeq: e.runnerSeq, at: e.at, event: e.event })),
          live: batch.live,
        }),
      ),
    );
    sendJson(res, 200, ingestResponse, { outcomes });
    return;
  }
  if (url.pathname === "/runner/commands" && req.method === "GET") {
    const query = commandsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) throw failure("BAD_REQUEST", "bad query");
    const found = await rows(
      services.db,
      commandRow,
      "SELECT id, type, payload FROM commands WHERE task_id = $1 AND id > $2 ORDER BY id LIMIT 100",
      [query.data.taskId, query.data.after],
    );
    sendJson(res, 200, commandsResponse, { commands: found });
    return;
  }
  throw failure("NOT_FOUND", "no such runner route");
};

// ---- static files (the built page) -------------------------------------------------------

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const serveStatic = async (services: Services, url: URL, res: ServerResponse): Promise<void> => {
  const root = path.resolve(services.settings.OSTRA_SPIKE_WEB_DIR);
  const requested = url.pathname === "/" || url.pathname.startsWith("/task/") ? "/index.html" : url.pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    // a path with a stray `%` is not a file we have
    throw failure("NOT_FOUND", "not found");
  }
  const file = path.resolve(root, `.${decoded}`);
  if (!file.startsWith(root + path.sep) && file !== root) throw failure("NOT_FOUND", "not found");
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      "content-type": mime[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(content);
  } catch {
    throw failure("NOT_FOUND", "not found");
  }
};

export const createHandler = (services: Services): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
  const authenticate = createAuthenticator(services.db);
  const requireViewer = async (req: IncomingMessage): Promise<Viewer> => {
    const viewer = await authenticate(req);
    if (viewer === null) throw failure("UNAUTHORIZED", "sign in first");
    return viewer;
  };

  return async (req, res) => {
    try {
      const url = parseUrl(req);
      const method = req.method ?? "GET";
      const segments = url.pathname.split("/").filter((s) => s.length > 0);

      if (url.pathname.startsWith("/runner/")) {
        await handleRunner(services, req, url, res);
        return;
      }
      if (url.pathname === "/healthz") {
        sendJson(res, 200, healthResponse, { ok: true });
        return;
      }
      if (url.pathname === "/metrics") {
        requireRunnerToken(services, req);
        sendJson(res, 200, metricsResponse, {
          replica: services.settings.OSTRA_SPIKE_REPLICA_ID,
          appender: services.appender.metrics,
          tailer: { ...services.tailer.metrics, subscribers: services.tailer.subscriberCount(), groups: services.tailer.groupCount() },
          sse: services.sseMetrics,
          notifiesSent: services.sender.notifies(),
          notifiesReceived: services.listener.received(),
          memory: process.memoryUsage().rss,
        });
        return;
      }
      if (url.pathname === "/api/dev-login" && method === "POST") {
        // The stand-in for sign-in mints a session for any member with no secret: it exists only when the
        // server was started with OSTRA_SPIKE_DEV_LOGIN=1 (and then only on a loopback address).
        if (services.settings.OSTRA_SPIKE_DEV_LOGIN !== "1") throw failure("NOT_FOUND", "not found");
        const body = await readJson(req, loginRequest);
        const found = await rows(services.db, z.object({ member_id: MemberId }), "SELECT member_id FROM members WHERE member_id = $1", [body.memberId]);
        if (found[0] === undefined) throw failure("NOT_FOUND", "no such member");
        const token = randomBytes(24).toString("hex");
        await exec(services.db, "INSERT INTO sessions (token_hash, member_id) VALUES ($1, $2)", [sha256(token), body.memberId]);
        sendJson(res, 200, loginResponse, { ok: true }, { "set-cookie": `ostra_token=${token}; Path=/; HttpOnly; SameSite=Strict` });
        return;
      }
      if (segments[0] === "api") {
        const viewer = await requireViewer(req);
        if (segments[1] === "me" && method === "GET") {
          sendJson(res, 200, meResponse, { memberId: viewer.memberId, role: viewer.role });
          return;
        }
        if (segments[1] === "tasks" && segments[2] !== undefined) {
          const taskId = TaskId.parse(segments[2]);
          const action = segments[3];
          if (action === undefined && method === "GET") {
            const task = await loadTask(services.db, taskId);
            const head = await headOf(services.db, taskId);
            sendJson(res, 200, taskInfo, {
              task: { taskId: task.task_id, driverMemberId: task.driver_member_id, driverVersion: task.driver_version },
              me: { memberId: viewer.memberId, role: viewer.role },
              headSeq: head,
            });
            return;
          }
          if (action === "history" && method === "GET") {
            await loadTask(services.db, taskId);
            await handleHistory(services, taskId, url, res);
            return;
          }
          if (action === "stream" && method === "GET") {
            await handleStream(services, viewer, taskId, req, url, res);
            return;
          }
          if (action === "send" && method === "POST") {
            await handleSend(services, viewer, taskId, req, res);
            return;
          }
          if (action === "interrupt" && method === "POST") {
            await handleInterrupt(services, viewer, taskId, req, res);
            return;
          }
          if (action === "take-over" && method === "POST") {
            await handleTakeOver(services, viewer, taskId, req, res);
            return;
          }
          if (action === "approvals" && segments[4] !== undefined && segments[5] === "answer" && method === "POST") {
            await handleAnswer(services, viewer, taskId, ApprovalId.parse(segments[4]), req, res);
            return;
          }
        }
        throw failure("NOT_FOUND", "no such route");
      }
      if (method === "GET") {
        await serveStatic(services, url, res);
        return;
      }
      throw failure("NOT_FOUND", "not found");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (isFailure(error)) {
        const code = errorCode.safeParse(error.code);
        if (code.success) {
          sendError(res, code.data, error.message, error.details);
          return;
        }
      }
      if (error instanceof z.ZodError) {
        sendError(res, "BAD_REQUEST", "invalid input");
        return;
      }
      services.log.error("request.failed", { name: error instanceof Error ? error.name : "unknown" });
      sendError(res, "INTERNAL", "internal error");
    }
  };
};
