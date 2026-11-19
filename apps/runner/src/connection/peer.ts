import path from "node:path";
import {
  closeCodes,
  encodeUpFrame,
  eventKindSupportedAt,
  parseDownFrame,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  runnerLimits,
  runnerPaths,
  utf8ByteLength,
} from "@ostra/protocol";
import type {
  Ack,
  Command,
  CommandAckItem,
  CommandKind,
  CommandOf,
  CommandResult,
  DownFrame,
  ErrorFrame,
  ExecutorKind,
  ProcessContainment,
  LeaseEpoch,
  Peer,
  RunnerEvent,
  RunnerLabel,
  SessionId,
  TaskEvent,
  TaskId,
  UpFrame,
} from "@ostra/protocol";
import type { Logger } from "@ostra/adapter-sdk";
import WebSocket from "ws";
import type { RawData } from "ws";
import { isTerminalRefusal } from "../server/access-token.ts";
import type { AccessTokenResult, TerminalRefusal } from "../server/access-token.ts";
import { userAgent, RUNNER_VERSION } from "../version.ts";
import { createLiveTextBuffer } from "./live-text.ts";
import type { LiveSegment } from "./live-text.ts";
import { openSessionSpool } from "./spool.ts";
import type { SessionSpool } from "./spool.ts";
import { fileStateStore, markApplied, wasApplied } from "./state.ts";
import type { RunnerState, SessionState } from "./state.ts";

// The peer's side of the runner protocol (ADR 0034), WebSocket only in milestone 1 (the HTTP
// carrier is milestone 5). It connects with a 10-minute access token, says `hello`, and once
// `welcome` comes:
//
// - sends each session's events from its disk spool, numbered per session, inside the credit
//   window (256 frames or 4 MiB, whichever comes first, frames at most 1 MiB), and drops them from
//   the spool only when acked; resends from the first unacked event after a reconnect, and from
//   `resendFrom` when the server says a batch didn't start at its cursor
// - applies each command once by its ID, acks the highest contiguous seq, rejects a command past
//   its `notAfter` by the server's clock, and reports `outcome-unknown` for one a crash cut off
// - sends partial text as untracked frames, at most every 250 ms
// - sends its status on connect and when it changes
// - stops its agents after 9.5 minutes without the server (the self-fence, a courtesy: the
//   server's refusal of a stale lease is the guarantee)
//
// Ported from spikes/runner-transport/src/runner/peer.ts, with the product's frames, the byte
// count in the window, contiguous command acks and typed command handlers.

export type CommandOutcome = { readonly result: CommandResult; readonly reason?: string };

/** One handler per command kind: the task host implements them (ticket 21). */
export type CommandHandlers = { readonly [K in CommandKind]: (command: CommandOf<K>) => Promise<CommandOutcome> };

export type PeerStatus = {
  readonly executor: ExecutorKind;
  /** How the runner ends a task's processes together (ticket 42). A sidecar leaves it out. */
  readonly processContainment?: ProcessContainment;
  readonly capacity: number;
  readonly freeSlots: number;
  readonly labels: readonly RunnerLabel[];
  readonly running: readonly SessionId[];
};

/** Why the server refused this peer, as `onRefused` reports it. */
export type RefusedReason = TerminalRefusal | "clock-skew" | "replayed" | "token-refused" | "replaced" | "version-unsupported";

export type ConnectionHooks = {
  /** The self-fence fired: stop these sessions' agents, keep their workspaces. */
  readonly onSelfFence?: (sessions: readonly SessionId[]) => void;
  /** The server refused a session's lease epoch; its spool is discarded. Stop its agent. */
  readonly onStaleLease?: (sessionId: SessionId) => void;
  readonly onConnected?: (at: number) => void;
  /**
   * The server refused this peer: for good (`revoked`, `unknown-key`), until it's updated, or for
   * now, while the connection keeps asking (the clocks disagree, say).
   */
  readonly onRefused?: (reason: RefusedReason, message: string) => void;
};

export type ConnectionTimers = {
  readonly handshakeTimeoutMs: number;
  readonly deadMs: number;
  readonly selfFenceMs: number;
  readonly backoffMinMs: number;
  readonly backoffMaxMs: number;
  readonly versionRetryMs: number;
  readonly liveTextIntervalMs: number;
  /** How often the dead-connection and self-fence checks run. */
  readonly checkMs: number;
};

export const defaultTimers: ConnectionTimers = {
  handshakeTimeoutMs: runnerLimits.handshakeTimeoutMs,
  deadMs: runnerLimits.deadMs,
  selfFenceMs: runnerLimits.selfFenceMs,
  backoffMinMs: runnerLimits.backoffMinMs,
  backoffMaxMs: runnerLimits.backoffMaxMs,
  versionRetryMs: runnerLimits.versionRetryMs,
  liveTextIntervalMs: runnerLimits.liveTextIntervalMs,
  checkMs: 1_000,
};

export type TokenSource = {
  readonly get: () => Promise<AccessTokenResult>;
  readonly invalidate: () => void;
};

export type ConnectionOptions = {
  readonly serverUrl: string;
  /** Who this peer is: the runner, or a box's sidecar. */
  readonly peer: Peer;
  readonly tokens: TokenSource;
  /** Holds `spool/` and `state.json`. */
  readonly dataDir: string;
  readonly handlers: CommandHandlers;
  readonly status: () => PeerStatus;
  readonly logger: Logger;
  readonly hooks?: ConnectionHooks;
  readonly timers?: Partial<ConnectionTimers>;
  /** The runner's spool quota (1 GiB). */
  readonly spoolQuotaBytes?: number;
  /** The clock the self-fence, the dead check and `notAfter` read. */
  readonly now?: () => number;
  readonly random?: () => number;
};

export type SessionRef = { readonly taskId: TaskId; readonly sessionId: SessionId; readonly leaseEpoch: LeaseEpoch };

/** Where a task's events go: numbered, spooled, sent. */
export type SessionChannel = SessionRef & {
  /**
   * Numbers the event, writes it to the spool, and queues it to send. Waits while the runner's
   * spool is over its quota, so a producer reading the agent's output stops reading it.
   */
  readonly emit: (event: TaskEvent) => Promise<RunnerEvent>;
  /** Whether the server, at the negotiated minor, reads an event of `kind`: check before emitting one a minor added. */
  readonly supports: (kind: TaskEvent["kind"]) => boolean;
  readonly appendLiveText: (segment: Omit<LiveSegment, "taskId" | "sessionId">, delta: string) => void;
  readonly endLiveText: (segmentId: LiveSegment["segmentId"]) => void;
  /** Nothing more will be emitted. The spool is deleted once the server has acked everything. */
  readonly close: () => void;
  /** Resolves when every event emitted so far is acked (or the session went stale). */
  readonly drained: () => Promise<void>;
};

/** How the connection ended: stopped, or refused for good. `message` is a sentence for the person. */
export type ConnectionEnd = { readonly kind: "stopped" } | { readonly kind: TerminalRefusal; readonly message: string };

export type ConnectionReport = {
  readonly connected: boolean;
  readonly lastContiguousSeq: number;
  readonly fenced: boolean;
  readonly sessions: readonly { readonly sessionId: SessionId; readonly lastSeq: number; readonly ackedUpTo: number; readonly state: SessionState }[];
};

export type RunnerConnection = {
  /** Opens a session's channel, or reopens one the runner held before a restart. */
  readonly openSession: (ref: SessionRef) => Promise<SessionChannel>;
  /** Sessions held before a restart that no producer has reopened: their agents are gone. */
  readonly restoredSessions: () => readonly SessionRef[];
  /** Sends the status again (a task started or ended). */
  readonly statusChanged: () => void;
  /**
   * Minor 2: a runner's own event, outside any task (a snapshot build's result, F-051), sent in a
   * `runner-event` frame as soon as the connection is ready, and kept in memory for an hour to go
   * again on each new connection (a frame has no ack). Core applies it idempotently by its snapshot.
   */
  readonly sendRunnerEvent: (event: TaskEvent) => void;
  readonly report: () => ConnectionReport;
  /** Closes the connection and the spools. The spools stay on disk for the next start. */
  readonly stop: () => Promise<void>;
  readonly done: Promise<ConnectionEnd>;
};

type Session = SessionRef & {
  readonly spool: SessionSpool;
  state: SessionState;
  sendPointer: number;
  restored: boolean;
  drainWaiters: (() => void)[];
};

type InflightFrame = { readonly sessionId: SessionId; readonly lastSeq: number; readonly bytes: number };

type SocketEnd =
  | { readonly kind: "revoked"; readonly message: string }
  | { readonly kind: "replaced" }
  | { readonly kind: "token-expired" }
  | { readonly kind: "version"; readonly message: string }
  | { readonly kind: "goaway"; readonly afterMs: number }
  | { readonly kind: "lost"; readonly welcomed: boolean; readonly detail: string }
  | { readonly kind: "stopped" };

const REVOKED_BY_SERVER = "This runner was revoked in the panel.";

/** Bytes of an `events` frame besides its events: `{"type":"events","events":[...]}` and commas. */
const EVENTS_FRAME_OVERHEAD = 64;
/** The largest event that fits a frame. A bigger one is a bug in the mapping that made it. */
export const MAX_EVENT_BYTES = runnerLimits.frameMaxBytes - EVENTS_FRAME_OVERHEAD;
/** How many recent command results are kept, to answer a resent command with its result. */
const RESULTS_KEPT = 512;
/** How long, and how many, of the runner's own events are kept to send again on a new connection. */
const RUNNER_EVENTS_KEPT_MS = 60 * 60_000;
const RUNNER_EVENTS_KEPT = 64;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

const rawText = (data: RawData): string => {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
};

export const connectionUrl = (serverUrl: string): string =>
  `${serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}${runnerPaths.connect}`;

export const startConnection = async (options: ConnectionOptions): Promise<RunnerConnection> => {
  const timers: ConnectionTimers = { ...defaultTimers, ...options.timers };
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const quota = options.spoolQuotaBytes ?? runnerLimits.spoolQuotaBytes;
  const log = options.logger;
  const hooks = options.hooks ?? {};
  const store = fileStateStore(path.join(options.dataDir, "state.json"));
  const spoolRoot = path.join(options.dataDir, "spool");
  let state: RunnerState = await store.load();
  const sessions = new Map<SessionId, Session>();
  const liveText = createLiveTextBuffer();
  const stopController = new AbortController();

  let socket: WebSocket | undefined;
  let ready = false;
  let minor = PROTOCOL_MINOR;
  let serverOffset = 0;
  let windowFrames: number = runnerLimits.creditFrames;
  let windowBytes: number = runnerLimits.creditBytes;
  let inflight: InflightFrame[] = [];
  let inflightBytes = 0;
  let lastContact = now();
  let fenced = false;
  let commandChain: Promise<void> = Promise.resolve();
  const results = new Map<string, CommandAckItem>();
  let unsentResults: CommandAckItem[] = [];
  /**
   * The runner's own events of the last hour, each with the socket it last went out on. A frame has
   * no ack, and a socket that died unnoticed swallows what was sent on it, so each is sent again on
   * every new connection while it's kept: core applies a snapshot's result idempotently.
   */
  const runnerEvents: { readonly at: number; readonly event: TaskEvent; sentOn: WebSocket | undefined }[] = [];
  const quotaWaiters: (() => void)[] = [];

  const persist = (): Promise<void> => store.save(state);
  const spoolBytes = (): number => [...sessions.values()].reduce((sum, session) => sum + session.spool.bytes(), 0);

  const saveSession = (session: Session): void => {
    const others = state.sessions.filter((entry) => entry.sessionId !== session.sessionId);
    state = {
      ...state,
      sessions: [...others, { sessionId: session.sessionId, taskId: session.taskId, leaseEpoch: session.leaseEpoch, state: session.state }],
    };
  };

  // Order matters: forget the session in the saved state, then delete its spool, and only then drop it
  // from the live map that report() reads. Otherwise report() says the session is gone while its spool
  // is still on disk, and a crash in that window leaves an orphan spool (seen on Linux CI, 2026-11-18).
  const dropSession = async (session: Session): Promise<void> => {
    liveText.endSession(session.sessionId);
    state = { ...state, sessions: state.sessions.filter((entry) => entry.sessionId !== session.sessionId) };
    await persist();
    await session.spool.destroy();
    sessions.delete(session.sessionId);
    for (const resolve of session.drainWaiters.splice(0)) {
      resolve();
    }
    wakeQuota();
  };

  const wakeQuota = (): void => {
    if (spoolBytes() < quota) {
      for (const resolve of quotaWaiters.splice(0)) {
        resolve();
      }
    }
  };

  const settleDrained = async (session: Session): Promise<void> => {
    if (session.spool.ackedUpTo() < session.spool.lastSeq()) {
      return;
    }
    if (session.state === "closing") {
      await dropSession(session);
      return;
    }
    for (const resolve of session.drainWaiters.splice(0)) {
      resolve();
    }
  };

  const addSession = async (ref: SessionRef, sessionState: SessionState, restored: boolean): Promise<Session> => {
    const spool = await openSessionSpool(path.join(spoolRoot, encodeURIComponent(ref.sessionId)), ref.sessionId);
    const session: Session = {
      ...ref,
      spool,
      state: sessionState,
      sendPointer: spool.ackedUpTo() + 1,
      restored,
      drainWaiters: [],
    };
    sessions.set(ref.sessionId, session);
    return session;
  };

  // Restore: a restarted runner resends every unacked event. No producer survives a restart, so a
  // session that was open is now closing until a producer reopens it.
  for (const saved of state.sessions) {
    if (saved.state === "stale") {
      continue;
    }
    await addSession(saved, "closing", saved.state === "open");
  }
  state = { ...state, sessions: [...sessions.values()].map((session) => ({ sessionId: session.sessionId, taskId: session.taskId, leaseEpoch: session.leaseEpoch, state: session.state })) };
  if (state.inflight !== null) {
    // The runner died between starting and finishing this command: its outcome is unknown.
    const { id, seq, kind } = state.inflight;
    log.warn("command outcome unknown after a restart", { commandId: id, seq, kind });
    const item: CommandAckItem = { id, seq, result: "outcome-unknown" };
    results.set(id, item);
    unsentResults.push(item);
    state = { ...markApplied(state, seq, id), inflight: null };
  }
  await persist();
  for (const session of [...sessions.values()]) {
    await settleDrained(session);
  }

  // ---------- up ----------

  const send = (frame: UpFrame): boolean => {
    if (socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(encodeUpFrame(frame, minor));
    return true;
  };

  const flush = (): void => {
    if (!ready) {
      return;
    }
    for (const session of sessions.values()) {
      if (session.state === "stale") {
        continue;
      }
      while (inflight.length < windowFrames && inflightBytes < windowBytes && session.sendPointer <= session.spool.lastSeq()) {
        const budget = Math.min(runnerLimits.frameMaxBytes - EVENTS_FRAME_OVERHEAD, windowBytes - inflightBytes);
        const items = session.spool.read(session.sendPointer, runnerLimits.eventsPerFrameMax, budget);
        const last = items.at(-1);
        if (last === undefined) {
          break;
        }
        const bytes = items.reduce((sum, item) => sum + item.bytes + 1, EVENTS_FRAME_OVERHEAD);
        if (!send({ type: "events", events: items.map((item) => item.event) })) {
          return;
        }
        session.sendPointer = last.event.sessionSeq + 1;
        inflight.push({ sessionId: session.sessionId, lastSeq: last.event.sessionSeq, bytes });
        inflightBytes += bytes;
      }
    }
  };

  const flushRunnerEvents = (): void => {
    const keptSince = now() - RUNNER_EVENTS_KEPT_MS;
    while (runnerEvents.length > RUNNER_EVENTS_KEPT || (runnerEvents[0] !== undefined && runnerEvents[0].at < keptSince)) {
      runnerEvents.shift();
    }
    if (!ready) {
      return;
    }
    for (const item of runnerEvents) {
      if (item.sentOn !== undefined && item.sentOn === socket) {
        continue;
      }
      if (!send({ type: "runner-event", at: item.at, event: item.event })) {
        return;
      }
      item.sentOn = socket;
    }
  };

  const freeInflight =(keep: (frame: InflightFrame) => boolean): void => {
    inflight = inflight.filter(keep);
    inflightBytes = inflight.reduce((sum, frame) => sum + frame.bytes, 0);
  };

  const sendStatus = (): void => {
    const status = options.status();
    send({
      type: "status",
      executor: status.executor,
      capacity: status.capacity,
      freeSlots: status.freeSlots,
      labels: [...status.labels],
      version: RUNNER_VERSION,
      running: [...status.running],
      spoolBytes: spoolBytes(),
      ...(status.processContainment === undefined ? {} : { processContainment: status.processContainment }),
    });
  };

  const sendResults = (items: readonly CommandAckItem[]): void => {
    for (const item of items) {
      results.set(item.id, item);
    }
    while (results.size > RESULTS_KEPT) {
      const oldest = results.keys().next();
      if (oldest.done === true) {
        break;
      }
      results.delete(oldest.value);
    }
    const all = [...unsentResults, ...items].slice(-runnerLimits.ackResultsMax);
    if (send({ type: "command-ack", upTo: state.lastContiguousSeq, results: all })) {
      unsentResults = [];
    } else {
      unsentResults = all;
    }
  };

  const flushLiveText = (): void => {
    if (!ready) {
      return;
    }
    for (const frames of liveText.take(runnerLimits.liveTextPerFrameMax)) {
      const [first, ...rest] = frames;
      if (first !== undefined) {
        send({ type: "live-text", frames: [first, ...rest] });
      }
    }
  };

  // ---------- down ----------

  const onAck = async (ack: Ack): Promise<void> => {
    const session = sessions.get(ack.sessionId);
    if (session === undefined || session.state === "stale") {
      return;
    }
    const upTo = Math.min(ack.upTo, session.spool.lastSeq());
    freeInflight((frame) => frame.sessionId !== session.sessionId || frame.lastSeq > upTo);
    if (ack.resendFrom !== undefined) {
      freeInflight((frame) => frame.sessionId !== session.sessionId);
      session.sendPointer = Math.max(ack.resendFrom, upTo + 1);
      log.info("server asked to resend", { sessionId: session.sessionId, from: session.sendPointer });
    }
    await session.spool.ack(upTo);
    session.sendPointer = Math.max(session.sendPointer, session.spool.ackedUpTo() + 1);
    wakeQuota();
    await settleDrained(session);
    flush();
  };

  const onStale = async (frame: ErrorFrame): Promise<void> => {
    const session = frame.sessionId === undefined ? undefined : sessions.get(frame.sessionId);
    if (session === undefined || session.state === "stale") {
      return;
    }
    log.warn("server refused the session's lease", {
      sessionId: session.sessionId,
      leaseEpoch: session.leaseEpoch,
      currentEpoch: frame.currentEpoch,
      unacked: session.spool.lastSeq() - session.spool.ackedUpTo(),
    });
    session.state = "stale";
    freeInflight((item) => item.sessionId !== session.sessionId);
    // ADR 0034, Q111: late events are refused, never kept. The spool is discarded first, so the hook's
    // promise holds: when the task host hears of the stale lease, the session and its spool are gone.
    await dropSession(session);
    hooks.onStaleLease?.(session.sessionId);
  };

  const applyCommand = async (command: Command): Promise<void> => {
    if (wasApplied(state, command.seq, command.id)) {
      const previous = results.get(command.id);
      sendResults(previous === undefined ? [] : [previous]);
      return;
    }
    if (command.seq > state.lastContiguousSeq + 1) {
      log.warn("command gap", { expected: state.lastContiguousSeq + 1, got: command.seq });
    }
    if (now() + serverOffset > command.notAfter) {
      state = markApplied(state, command.seq, command.id);
      await persist();
      log.info("command past its notAfter", { commandId: command.id, kind: command.kind });
      sendResults([{ id: command.id, seq: command.seq, result: "rejected", reason: "past-not-after" }]);
      return;
    }
    state = { ...state, inflight: { id: command.id, seq: command.seq, kind: command.kind } };
    await persist();
    let outcome: CommandOutcome;
    try {
      outcome = await runHandler(command);
    } catch (error) {
      log.error("command handler failed", { commandId: command.id, kind: command.kind, error: error instanceof Error ? error.name : "unknown" });
      outcome = { result: "rejected", reason: "handler-failed" };
    }
    state = { ...markApplied(state, command.seq, command.id), inflight: null };
    await persist();
    sendResults([
      { id: command.id, seq: command.seq, result: outcome.result, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) },
    ]);
  };

  const runHandler = (command: Command): Promise<CommandOutcome> => {
    const { handlers } = options;
    switch (command.kind) {
      case "dispatch":
        return handlers.dispatch(command);
      case "steer":
        return handlers.steer(command);
      case "interrupt":
        return handlers.interrupt(command);
      case "stop":
        return handlers.stop(command);
      case "approval-answer":
        return handlers["approval-answer"](command);
      case "drain":
        return handlers.drain(command);
      case "update-hint":
        return handlers["update-hint"](command);
      case "release":
        return handlers.release(command);
      case "question-answer":
        return handlers["question-answer"](command);
      case "plan-answer":
        return handlers["plan-answer"](command);
      case "snapshot-build":
        return handlers["snapshot-build"](command);
      default:
        return command satisfies never;
    }
  };

  const onDown = async (frame: DownFrame, onWelcome: () => void, end: (value: SocketEnd) => void): Promise<void> => {
    switch (frame.type) {
      case "welcome":
        serverOffset = frame.serverTime - now();
        minor = frame.minor;
        windowFrames = frame.creditFrames;
        windowBytes = frame.creditBytes;
        ready = true;
        fenced = false;
        freeInflight(() => false);
        for (const session of sessions.values()) {
          session.sendPointer = session.spool.ackedUpTo() + 1;
        }
        liveText.resnapshot();
        onWelcome();
        log.info("connected", { minor: frame.minor, connectionEpoch: frame.connectionEpoch, replicaId: frame.replicaId });
        hooks.onConnected?.(now());
        sendStatus();
        if (unsentResults.length > 0) {
          sendResults([]);
        }
        flush();
        flushRunnerEvents();
        return;
      case "ack":
        await onAck(frame);
        return;
      case "credit":
        // More window: the peer may have this many more frames and bytes unacked.
        windowFrames += frame.frames;
        windowBytes += frame.bytes;
        flush();
        return;
      case "command":
        commandChain = commandChain.then(() => applyCommand(frame)).catch(() => undefined);
        await commandChain;
        return;
      case "goaway":
        log.info("server asked to reconnect", { reason: frame.reason, afterMs: frame.reconnectAfterMs });
        end({ kind: "goaway", afterMs: frame.reconnectAfterMs });
        return;
      case "error":
        if (frame.code === "stale-lease") {
          await onStale(frame);
          return;
        }
        if (frame.code === "version-unsupported") {
          end({ kind: "version", message: frame.message });
          return;
        }
        if (frame.code === "event-rejected") {
          // The database refused this event even as a placeholder, so the server skipped it and moved
          // its cursor past it. It's refused for good: drop it from the spool, never send it again.
          log.warn("server refused an event for good", { sessionId: frame.sessionId, sessionSeq: frame.sessionSeq });
          if (frame.sessionId !== undefined && frame.sessionSeq !== undefined) {
            await onAck({ type: "ack", sessionId: frame.sessionId, upTo: frame.sessionSeq });
          }
          return;
        }
        log.warn("server error", { code: frame.code, sessionId: frame.sessionId });
        return;
      case "evict":
        end(frame.reason === "revoked" ? { kind: "revoked", message: REVOKED_BY_SERVER } : { kind: "replaced" });
        return;
      default:
        frame satisfies never;
    }
  };

  // ---------- the socket ----------

  const runSocket = (token: string): Promise<SocketEnd> =>
    new Promise<SocketEnd>((resolve) => {
      let finished = false;
      let welcomed = false;
      let lastFrame = now();
      let chain: Promise<void> = Promise.resolve();
      const ws = new WebSocket(connectionUrl(options.serverUrl), {
        headers: { authorization: `Bearer ${token}`, "user-agent": userAgent() },
        perMessageDeflate: false,
        handshakeTimeout: timers.handshakeTimeoutMs,
        maxPayload: runnerLimits.frameMaxBytes,
      });
      socket = ws;
      const handshake = setTimeout(() => {
        if (!welcomed) {
          finish({ kind: "lost", welcomed: false, detail: "no welcome within the handshake timeout" });
        }
      }, timers.handshakeTimeoutMs);
      const deadCheck = setInterval(() => {
        if (now() - lastFrame > timers.deadMs) {
          finish({ kind: "lost", welcomed, detail: "no frame from the server for too long" });
        }
      }, timers.checkMs);
      const finish = (value: SocketEnd): void => {
        if (finished) {
          return;
        }
        finished = true;
        ready = false;
        clearTimeout(handshake);
        clearInterval(deadCheck);
        if (socket === ws) {
          socket = undefined;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000);
        } else {
          ws.terminate();
        }
        resolve(value);
      };
      const onStop = (): void => {
        finish({ kind: "stopped" });
      };
      stopController.signal.addEventListener("abort", onStop, { once: true });

      ws.on("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        if (status === 401) {
          finish({ kind: "token-expired" });
        } else if (status === 403) {
          finish({ kind: "revoked", message: "The server refused this runner at the upgrade: it was revoked in the panel." });
        } else if (status === 426) {
          finish({ kind: "version", message: "the server refused this runner's version at the upgrade" });
        } else {
          finish({ kind: "lost", welcomed: false, detail: `the upgrade was answered ${String(status)}` });
        }
      });
      ws.on("open", () => {
        lastFrame = now();
        lastContact = lastFrame;
        const hello: UpFrame = {
          type: "hello",
          protocolMajor: PROTOCOL_MAJOR,
          protocolMinor: PROTOCOL_MINOR,
          runnerVersion: RUNNER_VERSION,
          peer: options.peer,
          carrier: "websocket",
          lastCommandSeq: state.lastContiguousSeq,
          sessions: [...sessions.values()]
            .filter((session) => session.state !== "stale")
            .slice(0, runnerLimits.helloSessionsMax)
            .map((session) => ({
              taskId: session.taskId,
              sessionId: session.sessionId,
              leaseEpoch: session.leaseEpoch,
              nextSessionSeq: session.spool.lastSeq() + 1,
            })),
        };
        ws.send(encodeUpFrame(hello, PROTOCOL_MINOR));
      });
      ws.on("ping", () => {
        lastFrame = now();
        lastContact = lastFrame;
      });
      ws.on("message", (data) => {
        lastFrame = now();
        lastContact = lastFrame;
        const text = rawText(data);
        if (utf8ByteLength(text) > runnerLimits.frameMaxBytes) {
          ws.close(closeCodes.protocolViolation, "frame too large");
          return;
        }
        const parsed = parseDownFrame(text, minor);
        if (!parsed.ok) {
          log.warn("server sent a frame this runner can't read", { reason: parsed.error.reason, detail: parsed.error.detail });
          ws.close(closeCodes.protocolViolation, "invalid frame");
          return;
        }
        const frame = parsed.frame;
        chain = chain
          .then(() =>
            onDown(
              frame,
              () => {
                welcomed = true;
                clearTimeout(handshake);
              },
              finish,
            ),
          )
          .catch((error: unknown) => {
            log.error("handling a server frame failed", { type: frame.type, error: error instanceof Error ? error.name : "unknown" });
          });
      });
      ws.on("error", (error) => {
        log.debug("socket error", { error: error.name });
      });
      ws.on("close", (code) => {
        stopController.signal.removeEventListener("abort", onStop);
        switch (code) {
          case closeCodes.revoked:
            finish({ kind: "revoked", message: REVOKED_BY_SERVER });
            return;
          case closeCodes.replaced:
            finish({ kind: "replaced" });
            return;
          case closeCodes.tokenExpired:
            finish({ kind: "token-expired" });
            return;
          case closeCodes.upgradeRequired:
            finish({ kind: "version", message: "the server refused this runner's version" });
            return;
          default:
            finish({ kind: "lost", welcomed, detail: `closed with ${String(code)}` });
        }
      });
    });

  // ---------- the checks ----------

  const checks = setInterval(() => {
    if (fenced || now() - lastContact < timers.selfFenceMs) {
      return;
    }
    const open = [...sessions.values()].filter((session) => session.state === "open");
    if (open.length === 0) {
      return;
    }
    fenced = true;
    log.warn("self-fence: no server for too long, stopping the agents", {
      sessions: open.length,
      silentMs: now() - lastContact,
    });
    hooks.onSelfFence?.(open.map((session) => session.sessionId));
  }, timers.checkMs);
  const liveTimer = setInterval(flushLiveText, timers.liveTextIntervalMs);

  // ---------- the loop ----------

  const backoff = (attempt: number): number => {
    const cap = Math.min(timers.backoffMaxMs, timers.backoffMinMs * 2 ** Math.min(attempt, 16));
    return timers.backoffMinMs + Math.floor(random() * Math.max(0, cap - timers.backoffMinMs));
  };

  const loop = async (): Promise<ConnectionEnd> => {
    let attempt = 0;
    const signal = stopController.signal;
    const stopped = (): boolean => signal.aborted;
    while (!stopped()) {
      const token = await options.tokens.get();
      if (stopped()) {
        break;
      }
      if (!token.ok) {
        if (isTerminalRefusal(token)) {
          hooks.onRefused?.(token.reason, token.message);
          log.error("the server refused this runner for good", { reason: token.reason });
          return { kind: token.reason, message: token.message };
        }
        const wait = backoff(attempt);
        switch (token.reason) {
          case "clock-skew":
          case "replayed":
          case "token-refused":
            // Not for good: the identity is fine. Asked again with the backoff, so once the server
            // agrees (its clock and this machine's within its window, say), the runner connects.
            hooks.onRefused?.(token.reason, token.message);
            log.warn(token.message, {
              reason: token.reason,
              ...(token.reason === "clock-skew" && token.offsetMs !== null ? { offsetMs: token.offsetMs } : {}),
              attempt,
              retryInMs: wait,
            });
            break;
          case "unreachable":
          case "invalid-response":
            log.warn("no access token", { reason: token.reason, attempt, retryInMs: wait });
            break;
          default:
            token satisfies never;
        }
        await sleep(wait, signal);
        attempt += 1;
        continue;
      }
      const end = await runSocket(token.token);
      switch (end.kind) {
        case "stopped":
          break;
        case "revoked":
          hooks.onRefused?.("revoked", end.message);
          log.error("the server refused this runner for good", { reason: "revoked" });
          return { kind: "revoked", message: end.message };
        case "replaced":
          // Another connection with this identity took over: don't fight it.
          hooks.onRefused?.("replaced", "another connection of this runner took over");
          log.warn("replaced by another connection of this runner");
          await sleep(timers.backoffMaxMs, signal);
          continue;
        case "token-expired":
          options.tokens.invalidate();
          continue;
        case "version":
          hooks.onRefused?.("version-unsupported", end.message);
          log.error("the server refused this runner's version", { retryInMs: timers.versionRetryMs });
          await sleep(timers.versionRetryMs, signal);
          continue;
        case "goaway":
          attempt = 0;
          await sleep(end.afterMs, signal);
          continue;
        case "lost":
          log.info("connection lost", { detail: end.detail, attempt });
          if (end.welcomed) {
            attempt = 0;
          }
          break;
        default:
          end satisfies never;
      }
      if (stopped()) {
        break;
      }
      await sleep(backoff(attempt), signal);
      attempt += 1;
    }
    return { kind: "stopped" };
  };

  const done = loop().finally(() => {
    clearInterval(checks);
    clearInterval(liveTimer);
  });

  const emitInto = async (session: Session, event: TaskEvent): Promise<RunnerEvent> => {
    if (session.state === "stale") {
      throw new Error("the server refused this session's lease; nothing more is sent for it");
    }
    while (spoolBytes() >= quota) {
      // ADR 0034: when the spool is full, stop reading the agent; never drop an event.
      log.warn("spool full: waiting for acks", { sessionId: session.sessionId, spoolBytes: spoolBytes() });
      await new Promise<void>((resolve) => {
        quotaWaiters.push(resolve);
      });
    }
    const at = now();
    const written = await session.spool.append((sessionSeq) => {
      const item: RunnerEvent = { sessionId: session.sessionId, sessionSeq, leaseEpoch: session.leaseEpoch, at, event };
      if (utf8ByteLength(JSON.stringify(item)) > MAX_EVENT_BYTES) {
        throw new RangeError(`a ${event.kind} event is over the frame cap; the mapping must cap its payload`);
      }
      return item;
    });
    flush();
    return written;
  };

  const channelOf = (session: Session): SessionChannel => ({
    taskId: session.taskId,
    sessionId: session.sessionId,
    leaseEpoch: session.leaseEpoch,
    emit: (event) => emitInto(session, event),
    supports: (kind) => eventKindSupportedAt(kind, minor),
    appendLiveText: (segment, delta) => {
      liveText.append({ ...segment, taskId: session.taskId, sessionId: session.sessionId }, delta);
    },
    endLiveText: (segmentId) => {
      liveText.end(segmentId);
    },
    close: () => {
      if (session.state !== "open") {
        return;
      }
      session.state = "closing";
      saveSession(session);
      liveText.endSession(session.sessionId);
      persist()
        .then(() => settleDrained(session))
        .catch(() => undefined);
    },
    drained: () =>
      session.state === "stale" || !sessions.has(session.sessionId) || session.spool.ackedUpTo() >= session.spool.lastSeq()
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            session.drainWaiters.push(resolve);
          }),
  });

  return {
    openSession: async (ref) => {
      const existing = sessions.get(ref.sessionId);
      if (existing !== undefined) {
        if (existing.leaseEpoch !== ref.leaseEpoch) {
          throw new Error("the session is held under another lease epoch");
        }
        existing.state = "open";
        existing.restored = false;
        saveSession(existing);
        await persist();
        return channelOf(existing);
      }
      const session = await addSession(ref, "open", false);
      saveSession(session);
      await persist();
      return channelOf(session);
    },
    restoredSessions: () =>
      [...sessions.values()]
        .filter((session) => session.restored)
        .map((session) => ({ taskId: session.taskId, sessionId: session.sessionId, leaseEpoch: session.leaseEpoch })),
    statusChanged: () => {
      if (ready) {
        sendStatus();
      }
    },
    sendRunnerEvent: (event) => {
      runnerEvents.push({ at: now(), event, sentOn: undefined });
      flushRunnerEvents();
    },
    report: () => ({
      connected: ready,
      lastContiguousSeq: state.lastContiguousSeq,
      fenced,
      sessions: [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        lastSeq: session.spool.lastSeq(),
        ackedUpTo: session.spool.ackedUpTo(),
        state: session.state,
      })),
    }),
    stop: async () => {
      stopController.abort();
      await done;
      for (const resolve of quotaWaiters.splice(0)) {
        resolve();
      }
      for (const session of sessions.values()) {
        await session.spool.close();
      }
    },
    done,
  };
};
