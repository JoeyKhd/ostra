// The runner's side of the protocol (ADR 0034): one session over WebSocket,
// with the HTTP fallback, a disk spool, acked commands and the self-fence.
// The runner CLI runs one peer; the load generator runs thousands in one process.

import https from "node:https";
import path from "node:path";
import WebSocket from "ws";
import type { z } from "zod";
import { SessionId, type RunnerId, type TaskId } from "../protocol/ids.ts";
import {
  CloseCode,
  PROTOCOL_MAJOR,
  downFrame,
  encodeUp,
  frameText,
  httpDownBody,
  parseJson,
  type Ack,
  type Command,
  type CommandAck,
  type CommandResult,
  type DownMessage,
  type ErrorMsg,
  type Hello,
  type UpMessage,
} from "../protocol/messages.ts";
import { fullJitter, type Timers } from "../protocol/timers.ts";
import { fakeEvent } from "../shared/fake-event.ts";
import type { Logger } from "../shared/log.ts";
import { nowPrecise, sleep } from "../shared/stats.ts";
import { memorySpool, openFileSpool, type Spool } from "./spool.ts";
import { fileStateStore, memoryStateStore, type RunnerState, type SessionState, type StateStore } from "./state.ts";

export const RUNNER_VERSION = "0.0.0-spike";
const FRAME_ITEMS = 100;
const FRAME_BYTES = 512 * 1024;

export type Transport = "auto" | "websocket" | "http";

export type PeerOptions = {
  readonly runnerId: RunnerId;
  readonly serverUrl: string;
  readonly token: string;
  readonly minor: number;
  readonly transport: Transport;
  readonly timers: Timers;
  readonly eventsPerSec: number;
  readonly eventBytes: number;
  /** A directory for the spool and state, or undefined to keep both in memory (load generator only). */
  readonly dataDir: string | undefined;
  readonly spoolQuotaBytes: number;
  readonly labels: readonly string[];
  readonly log: Logger;
  /** Harness-only switches, wired by `runner-test.ts`; the runner CLI never sets them. */
  readonly testHooks?: PeerTestHooks;
  /** Called when a steer starts, before the agent sees it. */
  readonly onSteer?: (commandId: string, at: number) => void;
  readonly onAckLatency?: (ms: number) => void;
  readonly onConnected?: (carrier: "websocket" | "http", at: number) => void;
};

export type PeerTestHooks = {
  /** Turn the self-fence off, so a test can show the server's refusal holds on its own. */
  readonly disableSelfFence: boolean;
};

type Session = {
  readonly id: SessionId;
  readonly taskId: TaskId;
  readonly leaseEpoch: number;
  readonly spool: Spool;
  state: SessionState;
  sendPointer: number;
  /** In-flight batches: last seq of the batch -> when it was sent. */
  inflight: Map<number, number>;
  generator: NodeJS.Timeout | undefined;
  quotaLogged: boolean;
};

type Conn = {
  readonly carrier: "websocket" | "http";
  ready: boolean;
  minor: number;
  readonly send: (msg: UpMessage) => void;
};

export type PeerReport = {
  readonly runnerId: RunnerId;
  readonly carrier: "websocket" | "http" | "none";
  readonly lastAppliedSeq: number;
  readonly sessions: Record<string, { lastSeq: number; ackedUpTo: number; state: SessionState }>;
};

export type PeerHandle = {
  readonly report: () => PeerReport;
  readonly stop: () => Promise<void>;
};

type WsEnd =
  | { kind: "non-101"; status: number; ostra: boolean }
  | { kind: "version"; error: ErrorMsg | undefined }
  | { kind: "closed"; code: number; opened: boolean; livedMs: number; welcomed: boolean; silent: boolean }
  | { kind: "connect-failed"; code: string };

type HttpEnd =
  | { kind: "ws-retry" }
  | { kind: "version"; error: ErrorMsg | undefined }
  | { kind: "replaced" }
  | { kind: "revoked" }
  | { kind: "network"; proxyAnswered: boolean; welcomed: boolean }
  | { kind: "stopped" };

const errorCodeOf = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  return err instanceof Error ? err.name : "unknown";
};

/** Parse a down frame at our minor, or at the one before (the server may have encoded down). */
const parseDown = (value: unknown, minor: number): DownMessage | undefined => {
  for (const m of [minor, minor - 1]) {
    const r = downFrame(m).safeParse(value);
    if (r.success) return r.data;
  }
  return undefined;
};

export const startPeer = async (o: PeerOptions): Promise<PeerHandle> => {
  const log = o.log;
  const t = o.timers;
  const store: StateStore = o.dataDir === undefined ? memoryStateStore() : fileStateStore(o.dataDir);
  const state: RunnerState = await store.load();
  const sessions = new Map<SessionId, Session>();
  const proxyEnv = { ...process.env };
  const wsAgent = new https.Agent({ proxyEnv, keepAlive: false });
  const httpAgent = new https.Agent({ proxyEnv, keepAlive: true, maxSockets: 4 });

  let stopped = false;
  const isStopped = (): boolean => stopped;
  let conn: Conn | undefined;
  let creditFrames = 16;
  let inFlight = 0;
  let serverOffset = 0;
  let connEpoch = 0;
  let lastServerContact = performance.now();
  let fenced = false;
  let cmdChain: Promise<void> = Promise.resolve();
  /** Results of recent commands, resent after every welcome until a connection carries them. */
  let pendingResults: CommandAck["results"] = [];
  const persist = (): Promise<void> => store.save(state);

  const openSpool = (sessionId: SessionId): Promise<Spool> =>
    o.dataDir === undefined ? Promise.resolve(memorySpool()) : openFileSpool(path.join(o.dataDir, "sessions", sessionId));

  // ---------- the fake agent ----------

  const produce = async (s: Session, steerId?: string): Promise<void> => {
    await s.spool.append((seq) => fakeEvent(s.id, seq, o.eventBytes, steerId));
    flush();
  };

  const startGenerator = (s: Session): void => {
    if (s.generator !== undefined || o.eventsPerSec <= 0) return;
    s.generator = setInterval(() => {
      if (s.state !== "running") return;
      if (s.spool.bytes() >= o.spoolQuotaBytes) {
        // Full spool: stop reading the agent's output. Events are never dropped.
        if (!s.quotaLogged) log("spool-full", { session: s.id });
        s.quotaLogged = true;
        return;
      }
      s.quotaLogged = false;
      produce(s).catch(() => undefined);
    }, 1000 / o.eventsPerSec);
  };

  const stopGenerator = (s: Session): void => {
    if (s.generator !== undefined) clearInterval(s.generator);
    s.generator = undefined;
  };

  const addSession = async (id: SessionId, taskId: TaskId, leaseEpoch: number, st: SessionState): Promise<Session> => {
    const spool = await openSpool(id);
    const s: Session = {
      id,
      taskId,
      leaseEpoch,
      spool,
      state: st,
      sendPointer: spool.ackedUpTo() + 1,
      inflight: new Map(),
      generator: undefined,
      quotaLogged: false,
    };
    sessions.set(id, s);
    if (st === "running") startGenerator(s);
    return s;
  };

  // Resume sessions from disk: a restarted runner carries on where its spool ends.
  for (const [id, saved] of Object.entries(state.sessions)) {
    const sid = SessionId.parse(id);
    await addSession(sid, saved.taskId, saved.leaseEpoch, saved.state);
  }
  if (state.inflight !== null) {
    // We died between starting and finishing this command: we can't know its outcome.
    log("outcome-unknown", { command: state.inflight.id, seq: state.inflight.seq, kind: state.inflight.kind });
    pendingResults.push({ id: state.inflight.id, seq: state.inflight.seq, result: "outcome-unknown" });
    state.lastAppliedSeq = Math.max(state.lastAppliedSeq, state.inflight.seq);
    state.applied.push(state.inflight.id);
    state.inflight = null;
    await persist();
  }

  // ---------- up: flushing the spool ----------

  const flush = (): void => {
    const c = conn;
    if (c?.ready !== true) return;
    for (const s of sessions.values()) {
      if (s.state === "stale") continue;
      while (inFlight < creditFrames && s.sendPointer <= s.spool.lastSeq()) {
        const items = s.spool.read(s.sendPointer, FRAME_ITEMS, FRAME_BYTES);
        if (items.length === 0) break;
        c.send({ type: "events", sessionId: s.id, leaseEpoch: s.leaseEpoch, fromSeq: s.sendPointer, items });
        s.sendPointer += items.length;
        s.inflight.set(s.sendPointer - 1, performance.now());
        inFlight += 1;
      }
    }
  };

  const resetInflight = (): void => {
    inFlight = 0;
    for (const s of sessions.values()) {
      s.inflight.clear();
      s.sendPointer = s.spool.ackedUpTo() + 1;
    }
  };

  const onAck = async (a: Ack): Promise<void> => {
    const s = sessions.get(a.sessionId);
    if (s === undefined) return;
    const now = performance.now();
    for (const [end, sentAt] of s.inflight) {
      if (end <= a.upTo) {
        o.onAckLatency?.(now - sentAt);
        s.inflight.delete(end);
        inFlight = Math.max(0, inFlight - 1);
      }
    }
    if (a.resendFrom !== undefined) {
      inFlight = Math.max(0, inFlight - s.inflight.size);
      s.inflight.clear();
      s.sendPointer = a.resendFrom;
      log("resend-from", { session: s.id, from: a.resendFrom });
    }
    await s.spool.ack(a.upTo);
    flush();
  };

  const onStale = async (sessionId: SessionId | undefined): Promise<void> => {
    if (sessionId === undefined) return;
    const s = sessions.get(sessionId);
    if (s === undefined || s.state === "stale") return;
    stopGenerator(s);
    s.state = "stale";
    inFlight = Math.max(0, inFlight - s.inflight.size);
    s.inflight.clear();
    log("stale-lease-refused", { session: s.id, epoch: s.leaseEpoch, unacked: s.spool.lastSeq() - s.spool.ackedUpTo() });
    const saved = state.sessions[s.id];
    if (saved !== undefined) saved.state = "stale";
    await persist();
  };

  // ---------- down: commands ----------

  const sendCommandAck = (results: CommandAck["results"]): void => {
    pendingResults = [...pendingResults, ...results].slice(-50);
    conn?.send({ type: "command.ack", upTo: state.lastAppliedSeq, results });
  };

  const execute = async (cmd: Command): Promise<{ result: CommandResult; reason?: string }> => {
    switch (cmd.kind) {
      case "dispatch": {
        const b = cmd.body;
        if (!sessions.has(b.sessionId)) {
          state.sessions[b.sessionId] = { taskId: b.taskId, leaseEpoch: b.leaseEpoch, state: "running" };
          await persist();
          await addSession(b.sessionId, b.taskId, b.leaseEpoch, "running");
          log("dispatch-accepted", { session: b.sessionId, task: b.taskId, epoch: b.leaseEpoch });
        }
        return { result: "accepted" };
      }
      case "steer": {
        const s = sessions.get(cmd.body.sessionId);
        if (s?.state !== "running") return { result: "rejected", reason: "session-not-running" };
        const at = nowPrecise();
        o.onSteer?.(cmd.id, at);
        log("steer-received", { command: cmd.id, session: s.id, at });
        await produce(s, cmd.id);
        return { result: "done" };
      }
      case "stop": {
        const s = sessions.get(cmd.body.sessionId);
        if (s === undefined) return { result: "done" };
        stopGenerator(s);
        if (s.state === "running" || s.state === "fenced") s.state = "stopped";
        const saved = state.sessions[s.id];
        if (saved !== undefined && saved.state !== "stale") saved.state = "stopped";
        await persist();
        log("session-stopped", { session: s.id, reason: cmd.body.reason });
        return { result: "done" };
      }
      case "interrupt":
      case "drain":
      case "update-hint":
        return { result: "done" };
      default:
        return cmd satisfies never;
    }
  };

  const applyCommand = async (cmd: Command): Promise<void> => {
    // Applied once, by id; re-acked if it comes again.
    if (cmd.seq <= state.lastAppliedSeq || state.applied.includes(cmd.id)) {
      sendCommandAck([]);
      return;
    }
    if (cmd.seq !== state.lastAppliedSeq + 1) log("command-gap", { expected: state.lastAppliedSeq + 1, got: cmd.seq });
    // judged by the server's clock, so a laptop's clock doesn't matter
    if (cmd.notAfter !== undefined && Date.now() + serverOffset > cmd.notAfter) {
      state.lastAppliedSeq = cmd.seq;
      state.applied = [...state.applied, cmd.id].slice(-500);
      await persist();
      log("command-expired", { command: cmd.id, kind: cmd.kind });
      sendCommandAck([{ id: cmd.id, seq: cmd.seq, result: "rejected", reason: "expired" }]);
      return;
    }
    state.inflight = { id: cmd.id, seq: cmd.seq, kind: cmd.kind };
    await persist();
    const r = await execute(cmd);
    state.lastAppliedSeq = cmd.seq;
    state.applied = [...state.applied, cmd.id].slice(-500);
    state.inflight = null;
    await persist();
    sendCommandAck([{ id: cmd.id, seq: cmd.seq, result: r.result, ...(r.reason === undefined ? {} : { reason: r.reason }) }]);
  };

  const onCommand = (cmd: Command): Promise<void> => {
    cmdChain = cmdChain.then(() => applyCommand(cmd)).catch(() => undefined);
    return cmdChain;
  };

  const sendStatus = (): void => {
    const running = [...sessions.values()].filter((s) => s.state === "running").map((s) => s.id);
    const spoolBytes = [...sessions.values()].reduce((a, s) => a + s.spool.bytes(), 0);
    conn?.send({ type: "status", capacity: 4, running, labels: [...o.labels], spoolBytes });
  };

  /** Handle one down message. Returns "version" or "replaced" when the session must end. */
  const onDown = async (msg: DownMessage): Promise<void> => {
    lastServerContact = performance.now();
    switch (msg.type) {
      case "welcome": {
        if (conn === undefined) return;
        serverOffset = msg.serverTime - Date.now();
        creditFrames = msg.creditFrames;
        connEpoch = msg.connEpoch;
        conn.minor = msg.minor;
        conn.ready = true;
        if (fenced) log("unfenced-contact", {});
        resetInflight();
        log("welcome", { carrier: conn.carrier, minor: msg.minor, epoch: msg.connEpoch, replica: msg.replicaId });
        o.onConnected?.(conn.carrier, nowPrecise());
        sendStatus();
        if (pendingResults.length > 0) conn.send({ type: "command.ack", upTo: state.lastAppliedSeq, results: pendingResults });
        flush();
        return;
      }
      case "ack":
        await onAck(msg);
        return;
      case "credit":
        creditFrames = msg.frames;
        flush();
        return;
      case "goaway":
        log("goaway", { reason: msg.reason, ms: msg.reconnectAfterMs });
        return;
      case "error":
        if (msg.code === "stale-lease") await onStale(msg.sessionId);
        else log("server-error", { code: msg.code });
        return;
      case "command":
        await onCommand(msg);
        return;
      default:
        return msg satisfies never;
    }
  };

  const hello = (carrier: "websocket" | "http"): Hello => ({
    type: "hello",
    protocolMajor: PROTOCOL_MAJOR,
    protocolMinor: o.minor,
    runnerVersion: RUNNER_VERSION,
    runnerId: o.runnerId,
    carrier,
    lastCommandSeq: state.lastAppliedSeq,
    sessions: [...sessions.values()]
      .filter((s) => s.state !== "stale")
      .map((s) => ({ sessionId: s.id, taskId: s.taskId, leaseEpoch: s.leaseEpoch, nextSeq: s.spool.lastSeq() + 1 })),
  });

  // ---------- WebSocket carrier ----------

  const wsUrl = `${o.serverUrl.replace(/^http/, "ws")}/runner/v1/connect`;

  const runWs = (): Promise<WsEnd> =>
    new Promise<WsEnd>((resolve) => {
      let done = false;
      const finish = (end: WsEnd): void => {
        if (done) return;
        done = true;
        clearInterval(deadTimer);
        clearTimeout(silentTimer);
        conn = undefined;
        resolve(end);
      };
      const ws = new WebSocket(wsUrl, {
        agent: wsAgent,
        headers: { authorization: `Bearer ${o.token}` },
        perMessageDeflate: false,
        handshakeTimeout: t.handshakeTimeoutMs,
        maxPayload: 1024 * 1024,
      });
      let opened = false;
      let openedAt = 0;
      let welcomed = false;
      let silent = false;
      let lastFrame = performance.now();
      let versionError: ErrorMsg | undefined;
      let chain: Promise<void> = Promise.resolve();
      let silentTimer: NodeJS.Timeout | undefined;
      const deadTimer = setInterval(() => {
        if (opened && performance.now() - lastFrame > t.deadMs) {
          log("ws-dead", { silentMs: Math.round(performance.now() - lastFrame) });
          ws.terminate();
        }
      }, Math.min(1_000, t.deadMs / 4));

      ws.on("unexpected-response", (req, res) => {
        // TLS worked but the answer isn't 101: a proxy or nginx's defaults in the way.
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          if (chunks.length < 16) chunks.push(c);
        });
        const settle = (): void => {
          const body = parseJson(Buffer.concat(chunks).toString("utf8"));
          const ostra =
            body.ok && typeof body.value === "object" && body.value !== null && "messages" in body.value;
          req.destroy();
          finish({ kind: "non-101", status: res.statusCode ?? 0, ostra });
        };
        res.on("end", settle);
        res.on("error", settle);
        setTimeout(settle, 2_000).unref();
      });
      ws.on("open", () => {
        opened = true;
        openedAt = performance.now();
        lastFrame = openedAt;
        conn = {
          carrier: "websocket",
          ready: false,
          minor: o.minor,
          send: (m) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(encodeUp(m, conn?.minor ?? o.minor)));
          },
        };
        ws.send(JSON.stringify(hello("websocket")));
        // Upgraded, but no `welcome` within the handshake timeout: something holds the frames.
        silentTimer = setTimeout(() => {
          if (!welcomed) {
            silent = true;
            log("ws-silent-after-upgrade", { waitedMs: t.handshakeTimeoutMs });
            ws.terminate();
          }
        }, t.handshakeTimeoutMs);
      });
      ws.on("ping", () => {
        lastFrame = performance.now();
        lastServerContact = lastFrame;
      });
      ws.on("message", (data) => {
        lastFrame = performance.now();
        const parsed = parseJson(frameText(data));
        const msg = parsed.ok ? parseDown(parsed.value, o.minor) : undefined;
        if (msg === undefined) {
          log("frame-invalid", {});
          ws.close(CloseCode.protocolViolation, "invalid frame");
          return;
        }
        if (msg.type === "error" && msg.code === "version-unsupported") versionError = msg;
        if (msg.type === "welcome") welcomed = true;
        chain = chain.then(() => onDown(msg)).catch(() => undefined);
      });
      ws.on("error", (err) => {
        if (!opened) finish({ kind: "connect-failed", code: errorCodeOf(err) });
      });
      ws.on("close", (code) => {
        if (code === CloseCode.upgradeRequired) {
          finish({ kind: "version", error: versionError });
          return;
        }
        finish({
          kind: "closed",
          code,
          opened,
          livedMs: opened ? performance.now() - openedAt : 0,
          welcomed,
          silent,
        });
      });
      stopWs = () => {
        ws.terminate();
      };
    });
  let stopWs: () => void = () => undefined;

  // ---------- HTTP carrier ----------

  type HttpResult = { status: number; text: string };
  let httpAbort = new AbortController();

  const request = (method: "GET" | "POST", pathAndQuery: string, body: string | undefined, timeoutMs: number, minor: number): Promise<HttpResult> =>
    new Promise<HttpResult>((resolve, reject) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${o.token}`,
        "x-ostra-minor": String(minor),
      };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(body));
      }
      const req = https.request(`${o.serverUrl}${pathAndQuery}`, {
        method,
        agent: httpAgent,
        headers,
        signal: httpAbort.signal,
        timeout: timeoutMs,
      });
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", reject);
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      });
      req.end(body);
    });

  /** Parse an ostra envelope list, or say that something else answered. */
  const envelopes = (r: HttpResult, minor: number): z.infer<ReturnType<typeof httpDownBody>> | undefined => {
    const parsed = parseJson(r.text);
    if (!parsed.ok) return undefined;
    for (const m of [minor, minor - 1]) {
      const b = httpDownBody(m).safeParse(parsed.value);
      if (b.success) return b.data;
    }
    return undefined;
  };

  const runHttp = async (wsRetryAt: number): Promise<HttpEnd> => {
    httpAbort = new AbortController();
    const outbox: UpMessage[] = [];
    let wakeUp: () => void = () => undefined;
    const c: Conn = {
      carrier: "http",
      ready: false,
      minor: o.minor,
      send: (m) => {
        outbox.push(m);
        wakeUp();
      },
    };
    conn = c;
    let r: HttpResult;
    try {
      r = await request("POST", "/runner/v1/hello", JSON.stringify(hello("http")), t.handshakeTimeoutMs, o.minor);
    } catch (err) {
      conn = undefined;
      log("http-hello-failed", { code: errorCodeOf(err) });
      return { kind: "network", proxyAnswered: false, welcomed: false };
    }
    const body = envelopes(r, o.minor);
    if (body === undefined) {
      conn = undefined;
      log("http-not-ostra", { status: r.status, message: "a proxy answered instead of the ostra server" });
      return { kind: "network", proxyAnswered: true, welcomed: false };
    }
    if (r.status === 426) {
      conn = undefined;
      const err = body.messages.find((m) => m.type === "error");
      return { kind: "version", error: err?.type === "error" ? err : undefined };
    }
    if (r.status === 401) {
      conn = undefined;
      return { kind: "revoked" };
    }
    if (r.status !== 200) {
      conn = undefined;
      return { kind: "network", proxyAnswered: false, welcomed: false };
    }
    for (const m of body.messages) await onDown(m);
    if (!c.ready) {
      conn = undefined;
      return { kind: "network", proxyAnswered: false, welcomed: false };
    }

    let end: HttpEnd | undefined;
    const ended = (): boolean => end !== undefined;
    const stop = (e: HttpEnd): void => {
      if (end !== undefined) return;
      end = e;
      wakeUp();
      httpAbort.abort();
    };
    const statusTimer = setInterval(sendStatus, Math.max(1_000, t.pingMs));
    const retryTimer = setInterval(() => {
      if (o.transport === "auto" && Date.now() >= wsRetryAt) stop({ kind: "ws-retry" });
      if (stopped) stop({ kind: "stopped" });
    }, 500);

    const classify = (res: HttpResult): HttpEnd | undefined => {
      if (res.status === 409) return { kind: "replaced" };
      if (res.status === 426) return { kind: "version", error: undefined };
      if (res.status === 401) return { kind: "revoked" };
      return undefined;
    };

    const downLoop = async (): Promise<void> => {
      while (end === undefined) {
        await cmdChain;
        let res: HttpResult;
        try {
          res = await request("GET", `/runner/v1/down?after=${String(state.lastAppliedSeq)}&conn=${String(connEpoch)}`, undefined, t.longPollMs + 15_000, c.minor);
        } catch (err) {
          if (!ended()) log("http-down-failed", { code: errorCodeOf(err) });
          stop({ kind: "network", proxyAnswered: false, welcomed: true });
          return;
        }
        lastServerContact = performance.now();
        const k = classify(res);
        if (k !== undefined) {
          stop(k);
          return;
        }
        if (res.status === 204) continue;
        const b = envelopes(res, c.minor);
        if (res.status !== 200 || b === undefined) {
          log("http-not-ostra", { status: res.status, message: "a proxy answered instead of the ostra server" });
          stop({ kind: "network", proxyAnswered: b === undefined, welcomed: true });
          return;
        }
        for (const m of b.messages) await onDown(m);
      }
    };

    const upLoop = async (): Promise<void> => {
      while (end === undefined) {
        if (outbox.length === 0) {
          await new Promise<void>((resolve) => {
            wakeUp = resolve;
          });
          continue;
        }
        const batch = outbox.splice(0, 256).map((m) => encodeUp(m, c.minor));
        let res: HttpResult;
        try {
          res = await request("POST", "/runner/v1/up", JSON.stringify({ conn: connEpoch, messages: batch }), 30_000, c.minor);
        } catch (err) {
          if (!ended()) log("http-up-failed", { code: errorCodeOf(err) });
          stop({ kind: "network", proxyAnswered: false, welcomed: true });
          return;
        }
        lastServerContact = performance.now();
        const k = classify(res);
        if (k !== undefined) {
          stop(k);
          return;
        }
        const b = envelopes(res, c.minor);
        if (res.status !== 200 || b === undefined) {
          log("http-not-ostra", { status: res.status, message: "a proxy answered instead of the ostra server" });
          stop({ kind: "network", proxyAnswered: b === undefined, welcomed: true });
          return;
        }
        for (const m of b.messages) await onDown(m);
      }
    };

    await Promise.all([downLoop(), upLoop()]);
    clearInterval(statusTimer);
    clearInterval(retryTimer);
    conn = undefined;
    return end ?? { kind: "stopped" };
  };

  // ---------- self-fence ----------

  const fenceTimer = setInterval(() => {
    if (o.testHooks?.disableSelfFence === true || fenced) return;
    if (performance.now() - lastServerContact < t.selfFenceMs) return;
    const running = [...sessions.values()].filter((s) => s.state === "running");
    if (running.length === 0) return;
    // A courtesy: the server's refusal is the guarantee.
    fenced = true;
    for (const s of running) {
      stopGenerator(s);
      s.state = "fenced";
      const saved = state.sessions[s.id];
      if (saved !== undefined) saved.state = "fenced";
    }
    persist().catch(() => undefined);
    log("self-fence", { sessions: running.length, silentMs: Math.round(performance.now() - lastServerContact) });
  }, Math.min(1_000, Math.max(50, t.selfFenceMs / 20)));

  // ---------- the connection loop ----------

  const loop = async (): Promise<void> => {
    let mode: "websocket" | "http" = o.transport === "http" ? "http" : "websocket";
    let attempt = 0;
    let quickDeaths = 0;
    let wsRetryAt = 0;
    const versionRefused = (error: ErrorMsg | undefined, carrier: string): Promise<void> => {
      log("version-refused", {
        level: "error",
        carrier,
        runnerMinor: o.minor,
        serverMinor: error?.serverMinor ?? null,
        supportedMin: error?.supported?.min ?? null,
        supportedMax: error?.supported?.max ?? null,
        fix: "install the runner version this server pins (GET /runner/v1/info), then restart the runner",
        retryInMs: t.versionRetryMs,
      });
      return sleep(t.versionRetryMs);
    };
    while (!stopped) {
      if (mode === "websocket") {
        const end = await runWs();
        if (isStopped()) return;
        switch (end.kind) {
          case "non-101":
            log("ws-upgrade-refused", { status: end.status, proxyAnswered: !end.ostra });
            if (o.transport === "auto") {
              mode = "http";
              wsRetryAt = Date.now() + t.wsRetryMs;
              log("fallback-http", { reason: "non-101" });
              continue;
            }
            break;
          case "version":
            await versionRefused(end.error, "websocket");
            continue;
          case "connect-failed":
            log("ws-connect-failed", { code: end.code, attempt });
            break;
          case "closed": {
            log("ws-closed", { code: end.code, livedMs: Math.round(end.livedMs), welcomed: end.welcomed });
            if (end.code === CloseCode.revoked) {
              log("revoked", { level: "error" });
              return;
            }
            if (end.welcomed) attempt = 0;
            quickDeaths = end.opened && end.livedMs < t.quickDeathMs ? quickDeaths + 1 : 0;
            if (o.transport === "auto" && (quickDeaths >= 3 || end.silent)) {
              mode = "http";
              wsRetryAt = Date.now() + t.wsRetryMs;
              log("fallback-http", { reason: end.silent ? "silent" : "quick-deaths" });
              quickDeaths = 0;
              continue;
            }
            if (end.code === CloseCode.replaced) {
              // Another connection with our identity took over: back off hard.
              await sleep(t.backoffMaxMs);
              continue;
            }
            break;
          }
          default:
            return end satisfies never;
        }
        await sleep(fullJitter(attempt, t));
        attempt += 1;
      } else {
        const end = await runHttp(wsRetryAt);
        if (isStopped()) return;
        switch (end.kind) {
          case "ws-retry":
            log("ws-retry", {});
            mode = "websocket";
            continue;
          case "version":
            await versionRefused(end.error, "http");
            continue;
          case "revoked":
            log("revoked", { level: "error" });
            return;
          case "replaced":
            continue;
          case "network":
            if (end.welcomed) attempt = 0;
            break;
          case "stopped":
            return;
          default:
            return end satisfies never;
        }
        await sleep(fullJitter(attempt, t));
        attempt += 1;
      }
    }
  };

  const running = loop().catch((err: unknown) => {
    log("loop-failed", { err: errorCodeOf(err) });
  });

  return {
    report: () => ({
      runnerId: o.runnerId,
      carrier: conn?.carrier ?? "none",
      lastAppliedSeq: state.lastAppliedSeq,
      sessions: Object.fromEntries(
        [...sessions.values()].map((s) => [s.id, { lastSeq: s.spool.lastSeq(), ackedUpTo: s.spool.ackedUpTo(), state: s.state }]),
      ),
    }),
    stop: async () => {
      stopped = true;
      clearInterval(fenceTimer);
      for (const s of sessions.values()) stopGenerator(s);
      stopWs();
      httpAbort.abort();
      await Promise.race([running, sleep(2_000)]);
      for (const s of sessions.values()) await s.spool.close();
      wsAgent.destroy();
      httpAgent.destroy();
    },
  };
};
