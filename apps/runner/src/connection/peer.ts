import path from "node:path";
import {
  closeCodes,
  encodeUpFrame,
  eventKindSupportedAt,
  parseDownFrame,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  runnerHeaders,
  runnerLimits,
  runnerPaths,
  upFrameCodec,
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
  Hello,
  ProcessContainment,
  LeaseEpoch,
  Peer,
  RunnerCapabilities,
  RunnerEvent,
  RunnerInstall,
  RunnerLabel,
  RunnerResources,
  SessionId,
  TaskEvent,
  TaskId,
  UpFrame,
  WelcomePool,
} from "@ostra/protocol";
import type { Logger } from "@ostra/adapter-sdk";
import WebSocket from "ws";
import type { RawData } from "ws";
import { isTerminalRefusal } from "../server/access-token.ts";
import type { AccessTokenResult, TerminalRefusal } from "../server/access-token.ts";
import { userAgent, RUNNER_VERSION } from "../version.ts";
import { errorCodeOf, fallbackReasonWords, httpCall, makeAgents, ostraErrorOf, readAnswer } from "./http-carrier.ts";
import type { Carrier, FallbackReason, HttpAnswer, NetworkOptions, Transport } from "./http-carrier.ts";
import { createLiveTextBuffer } from "./live-text.ts";
import type { LiveSegment } from "./live-text.ts";
import { openSessionSpool } from "./spool.ts";
import type { SessionSpool } from "./spool.ts";
import { fileStateStore, markApplied, wasApplied } from "./state.ts";
import type { RunnerState, SessionState } from "./state.ts";

// The peer's side of the runner protocol (ADR 0034), over a WebSocket or, when a proxy blocks it,
// the HTTP carrier (milestone 5's ticket 18). It connects with a 10-minute access token, says
// `hello`, and once `welcome` comes:
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
// Both carriers share the spool, the credit window and the command handling: only how a frame
// travels differs. On `auto` the runner falls back to HTTP by itself (ADR 0034, "Networks") when the
// upgrade is answered by something that isn't ostra, when an upgraded socket brings no `welcome`
// within 10 s, or when the socket dies within 10 s of opening three times in a row; after a
// `welcome`, silence is a network failure and never a reason to fall back. On HTTP it tries the
// WebSocket again every `OSTRA_RUNNER_WS_RETRY_MINUTES`. Both go through `HTTPS_PROXY` (Node's own
// `proxyEnv`) and trust `NODE_EXTRA_CA_CERTS`.
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
  /**
   * Minor 4 (F-092, ADR 0059): what a runner reports in `hello` and each `status`. What it offers
   * (`null` on `host`, which counts `capacity` as slots), what its executor can do, and how it was
   * installed. A sidecar leaves them out.
   */
  readonly resources?: RunnerResources | null;
  readonly capabilities?: RunnerCapabilities;
  readonly install?: RunnerInstall;
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
  /** A connection was welcomed on `carrier`; `fallback` says why it's HTTP on `auto`, `null` on a WebSocket. */
  readonly onCarrier?: (carrier: Carrier, fallback: FallbackReason | null) => void;
  /**
   * Minor 4 (F-091): each `welcome`'s pool, for a pool runner: its name, and whether it waits for an
   * admin's approval. `null` for a personal runner, a sidecar, or a server below minor 4.
   */
  readonly onWelcome?: (pool: WelcomePool | null) => void;
  /** The server acked a session's events up to `upTo`, after its commit. Observation only (the load test's ack latency, ticket 34). */
  readonly onAcked?: (sessionId: SessionId, upTo: number) => void;
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
  /** A socket that dies within this of opening is a quick death; three in a row fall back to HTTP. */
  readonly quickDeathMs: number;
  /** How long a `down` poll may be held: the server's hold, plus room for a slow network. */
  readonly longPollMs: number;
  /** On the HTTP carrier, how often an `auto` runner tries the WebSocket again. */
  readonly wsRetryMs: number;
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
  quickDeathMs: runnerLimits.quickDeathMs,
  longPollMs: runnerLimits.longPollMs,
  wsRetryMs: runnerLimits.wsRetryMs,
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
  /**
   * `--transport`: `websocket` only, `http` only, or `auto`, which falls back to HTTP by itself.
   * Default `websocket`: a box's sidecar keeps its WebSocket (its task token is refused on HTTP).
   */
  readonly transport?: Transport;
  /** The proxy settings (the environment's by default) and, for tests, the CAs to trust. */
  readonly network?: NetworkOptions;
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
  /** The carrier of the welcomed connection; `null` while not connected. */
  readonly carrier: Carrier | null;
  /** Why an `auto` runner is on HTTP; `null` on the WebSocket or before any fallback. */
  readonly fallback: FallbackReason | null;
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

/** How one connection, on either carrier, ended. */
type End =
  | { readonly kind: "revoked"; readonly message: string }
  | { readonly kind: "replaced" }
  | { readonly kind: "token-expired" }
  | { readonly kind: "version"; readonly message: string }
  | { readonly kind: "goaway"; readonly afterMs: number }
  /** A network failure. `quick`: a WebSocket the far side closed within `quickDeathMs` of opening. */
  | { readonly kind: "lost"; readonly welcomed: boolean; readonly detail: string; readonly quick: boolean }
  /** The upgrade was answered, not with 101, by something that isn't ostra (or ostra saying it's no upgrade). */
  | { readonly kind: "upgrade-refused"; readonly status: number }
  /** Upgraded, but no `welcome` within the handshake timeout. */
  | { readonly kind: "no-welcome" }
  /** HTTP: a newer connection of this runner holds it (`409`). */
  | { readonly kind: "superseded" }
  /** HTTP: time to try the WebSocket again. */
  | { readonly kind: "ws-retry" }
  | { readonly kind: "stopped" };

/** How a frame travels on the current connection. */
type Link = { readonly carrier: Carrier; readonly send: (frame: UpFrame) => boolean };

const REVOKED_BY_SERVER = "This runner was revoked in the panel.";

/** Bytes of an `events` frame besides its events: `{"type":"events","events":[...]}` and commas. */
const EVENTS_FRAME_OVERHEAD = 64;
/** The largest event that fits a frame. A bigger one is a bug in the mapping that made it. */
export const MAX_EVENT_BYTES = runnerLimits.frameMaxBytes - EVENTS_FRAME_OVERHEAD;
/** How many recent command results are kept, to answer a resent command with its result. */
const RESULTS_KEPT = 512;
/** The most of an upgrade's refusal read, to tell ostra's error from a proxy's page. */
const REFUSAL_MAX_BYTES = 16 * 1024;
/** How long an upgrade's refusal is read before it's judged on what came. */
const REFUSAL_READ_MS = 2_000;
/** An HTTP `up` batch: at most this many bytes, under core's cap of twice the frame cap. */
const UP_BATCH_MAX_BYTES = 2 * runnerLimits.frameMaxBytes - 64 * 1024;
/** An HTTP `up` waits this long for its answer. */
const UP_TIMEOUT_MS = 30_000;
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

/** The HTTP carrier's endpoint on the server. */
const httpUrl = (serverUrl: string, pathAndQuery: string): string => `${serverUrl.replace(/\/+$/, "")}${pathAndQuery}`;

export const startConnection = async (options: ConnectionOptions): Promise<RunnerConnection> => {
  const timers: ConnectionTimers = { ...defaultTimers, ...options.timers };
  const transport: Transport = options.transport ?? "websocket";
  const agents = makeAgents(options.serverUrl, options.network);
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

  let link: Link | undefined;
  let ready = false;
  let fallback: FallbackReason | null = null;
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
  const runnerEvents: { readonly at: number; readonly event: TaskEvent; sentOn: Link | undefined }[] = [];
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
    // A session that was open is kept, even with every event acked, until its producer reopens it:
    // the task host to report that its agent is gone (`restoredSessions`), or a sidecar's dispatch
    // of the same session. An idle session between turns has nothing unacked, and dropping it here
    // left the server holding it idle forever; a reopen also continues its spool's sequence.
    if (session.restored) {
      continue;
    }
    await settleDrained(session);
  }

  // ---------- up ----------

  const send = (frame: UpFrame): boolean => link?.send(frame) ?? false;

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
      if (item.sentOn !== undefined && item.sentOn === link) {
        continue;
      }
      if (!eventKindSupportedAt(item.event.kind, minor)) {
        // A box's wait to a server below minor 4: it can't read it, and the box runs the same.
        item.sentOn = link;
        continue;
      }
      if (!send({ type: "runner-event", at: item.at, event: item.event })) {
        return;
      }
      item.sentOn = link;
    }
  };

  const freeInflight =(keep: (frame: InflightFrame) => boolean): void => {
    inflight = inflight.filter(keep);
    inflightBytes = inflight.reduce((sum, frame) => sum + frame.bytes, 0);
  };

  /** Minor 4's reports of a status, as `hello` and `status` carry them; the codec drops them below minor 4. */
  const reportsOf = (status: PeerStatus): Pick<Hello, "resources" | "capabilities" | "install"> => ({
    ...(status.resources === undefined ? {} : { resources: status.resources }),
    ...(status.capabilities === undefined ? {} : { capabilities: status.capabilities }),
    ...(status.install === undefined ? {} : { install: status.install }),
  });

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
      ...reportsOf(status),
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
    hooks.onAcked?.(session.sessionId, upTo);
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
      case "set-effort":
        return handlers["set-effort"](command);
      case "resume":
        return handlers.resume(command);
      default:
        return command satisfies never;
    }
  };

  const onDown = async (frame: DownFrame, onWelcome: () => void, end: (value: End) => void): Promise<void> => {
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
        log.info("connected", { minor: frame.minor, connectionEpoch: frame.connectionEpoch, replicaId: frame.replicaId, carrier: link?.carrier ?? "none" });
        hooks.onConnected?.(now());
        hooks.onWelcome?.(frame.pool ?? null);
        if (link !== undefined) {
          hooks.onCarrier?.(link.carrier, link.carrier === "http" ? fallback : null);
        }
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

  // ---------- hello ----------

  const helloFrame = (carrier: Carrier): Hello => ({
    type: "hello",
    protocolMajor: PROTOCOL_MAJOR,
    protocolMinor: PROTOCOL_MINOR,
    runnerVersion: RUNNER_VERSION,
    peer: options.peer,
    carrier,
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
    // Minor 4 (F-092): a runner's executor and what it reports; a sidecar sends none of them.
    ...(options.peer.kind === "runner" ? helloReports() : {}),
  });

  const helloReports = (): Pick<Hello, "executor" | "resources" | "capabilities" | "install"> => {
    const status = options.status();
    return { executor: status.executor, ...reportsOf(status) };
  };

  // ---------- the WebSocket ----------

  const runSocket = (token: string): Promise<End> =>
    new Promise<End>((resolve) => {
      let finished = false;
      let welcomed = false;
      let openedAt: number | null = null;
      let lastFrame = now();
      let chain: Promise<void> = Promise.resolve();
      let welcomeTimer: ReturnType<typeof setTimeout> | undefined;
      const ws = new WebSocket(connectionUrl(options.serverUrl), {
        agent: agents.websocket,
        headers: { authorization: `Bearer ${token}`, "user-agent": userAgent() },
        perMessageDeflate: false,
        handshakeTimeout: timers.handshakeTimeoutMs,
        maxPayload: runnerLimits.frameMaxBytes,
      });
      const wsLink: Link = {
        carrier: "websocket",
        send: (frame) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return false;
          }
          ws.send(encodeUpFrame(frame, minor));
          return true;
        },
      };
      link = wsLink;
      const deadCheck = setInterval(() => {
        if (openedAt !== null && now() - lastFrame > timers.deadMs) {
          finish({ kind: "lost", welcomed, detail: "no frame from the server for too long", quick: false });
        }
      }, timers.checkMs);
      const finish = (value: End): void => {
        if (finished) {
          return;
        }
        finished = true;
        ready = false;
        clearTimeout(welcomeTimer);
        clearInterval(deadCheck);
        if (link === wsLink) {
          link = undefined;
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

      ws.on("unexpected-response", (request, response) => {
        // Not 101. ostra's own refusals carry its error body; anything else answered is in the way
        // (a proxy's page, nginx's defaults), and that's a reason to fall back, never a verdict.
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        let judged = false;
        const judge = (): void => {
          if (judged) {
            return;
          }
          judged = true;
          clearTimeout(readTimer);
          request.destroy();
          const error = ostraErrorOf(Buffer.concat(chunks).toString("utf8"));
          if (error === null) {
            finish({ kind: "upgrade-refused", status });
          } else if (status === 401) {
            finish({ kind: "token-expired" });
          } else if (status === 403) {
            finish({ kind: "revoked", message: "The server refused this runner at the upgrade: it was revoked in the panel." });
          } else if (error.code === "version-unsupported") {
            finish({ kind: "version", message: "the server refused this runner's version at the upgrade" });
          } else if (status >= 500) {
            finish({ kind: "lost", welcomed: false, detail: `the upgrade was answered ${String(status)}`, quick: false });
          } else {
            // ostra answered, but not with an upgrade: something on the way dropped the Upgrade header.
            finish({ kind: "upgrade-refused", status });
          }
        };
        const readTimer = setTimeout(judge, REFUSAL_READ_MS);
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= REFUSAL_MAX_BYTES) {
            chunks.push(chunk);
          }
        });
        response.on("end", judge);
        response.on("error", judge);
        response.on("close", judge);
      });
      ws.on("open", () => {
        openedAt = now();
        lastFrame = openedAt;
        lastContact = lastFrame;
        ws.send(encodeUpFrame(helloFrame("websocket"), PROTOCOL_MINOR));
        // Upgraded, but no `welcome` within the handshake timeout: something holds the frames.
        welcomeTimer = setTimeout(() => {
          if (!welcomed) {
            finish({ kind: "no-welcome" });
          }
        }, timers.handshakeTimeoutMs);
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
                clearTimeout(welcomeTimer);
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
            finish({
              kind: "lost",
              welcomed,
              detail: `closed with ${String(code)}`,
              quick: openedAt !== null && now() - openedAt < timers.quickDeathMs,
            });
        }
      });
    });

  // ---------- the HTTP carrier ----------

  /** What an HTTP answer that isn't frames ends the connection with. */
  const httpEndOf = (answer: HttpAnswer, read: ReturnType<typeof readAnswer>, welcomed: boolean, what: string): End => {
    switch (read.kind) {
      case "superseded":
        return { kind: "superseded" };
      case "error":
        if (answer.status === 401) {
          return { kind: "token-expired" };
        }
        if (answer.status === 403) {
          return { kind: "revoked", message: "The server refused this runner: it was revoked in the panel." };
        }
        return { kind: "lost", welcomed, detail: `${what} was answered ${String(answer.status)} ${read.error.code}`, quick: false };
      case "not-ostra":
        // ADR 0034: a proxy's page is a network failure, and the runner says so.
        log.warn("a proxy answered instead of the ostra server", { request: what, status: answer.status });
        return { kind: "lost", welcomed, detail: `${what} was answered ${String(answer.status)} by something that isn't the ostra server`, quick: false };
      case "frames":
      case "empty":
        return { kind: "lost", welcomed, detail: `${what} was answered ${String(answer.status)}`, quick: false };
      default:
        return read satisfies never;
    }
  };

  const runHttp = async (wsRetryAt: number): Promise<End> => {
    const abort = new AbortController();
    const outbox: UpFrame[] = [];
    let wake: (() => void) | undefined;
    const poke = (): void => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    const conn: { ended: End | undefined; welcomed: boolean; epoch: number } = { ended: undefined, welcomed: false, epoch: 0 };
    const over = (): boolean => conn.ended !== undefined;
    const httpLink: Link = {
      carrier: "http",
      send: (frame) => {
        if (conn.ended !== undefined) {
          return false;
        }
        outbox.push(frame);
        poke();
        return true;
      },
    };
    const finish = (value: End): void => {
      if (conn.ended !== undefined) {
        return;
      }
      conn.ended = value;
      ready = false;
      if (link === httpLink) {
        link = undefined;
      }
      abort.abort();
      poke();
    };
    const onStop = (): void => {
      finish({ kind: "stopped" });
    };
    stopController.signal.addEventListener("abort", onStop, { once: true });
    const retryTimer = setInterval(() => {
      if (transport === "auto" && conn.welcomed && now() >= wsRetryAt) {
        finish({ kind: "ws-retry" });
      }
    }, Math.min(timers.checkMs, timers.wsRetryMs));

    /** One request: the token, the minor and, after the hello, the connection's epoch. */
    const call = async (method: "GET" | "POST", pathAndQuery: string, body: string | undefined, timeoutMs: number): Promise<HttpAnswer | End> => {
      const token = await options.tokens.get();
      if (!token.ok) {
        return { kind: "lost", welcomed: conn.welcomed, detail: `no access token (${token.reason})`, quick: false };
      }
      try {
        return await httpCall({
          url: httpUrl(options.serverUrl, pathAndQuery),
          method,
          agent: agents.http,
          headers: {
            authorization: `Bearer ${token.token}`,
            "user-agent": userAgent(),
            [runnerHeaders.minor]: String(conn.welcomed ? minor : PROTOCOL_MINOR),
            ...(conn.welcomed ? { [runnerHeaders.connectionEpoch]: String(conn.epoch) } : {}),
          },
          ...(body === undefined ? {} : { body }),
          timeoutMs,
          signal: abort.signal,
        });
      } catch (error) {
        return conn.ended ?? { kind: "lost", welcomed: conn.welcomed, detail: `${method} ${pathAndQuery.split("?")[0] ?? ""} failed: ${errorCodeOf(error)}`, quick: false };
      }
    };
    const isEnd = (value: HttpAnswer | End): value is End => "kind" in value;

    /** The answer's frames, each handled in turn; `false` once the connection ended. */
    const take = async (answer: HttpAnswer, what: string): Promise<boolean> => {
      lastContact = now();
      const read = readAnswer(answer, conn.welcomed ? minor : PROTOCOL_MINOR);
      if (answer.status === 204 && read.kind === "empty") {
        return true;
      }
      if (answer.status !== 200 || read.kind !== "frames") {
        finish(httpEndOf(answer, read, conn.welcomed, what));
        return false;
      }
      for (const frame of read.frames) {
        if (conn.ended !== undefined) {
          return false;
        }
        await onDown(
          frame,
          () => {
            conn.welcomed = true;
          },
          finish,
        );
      }
      return conn.ended === undefined;
    };

    try {
      // ---- hello ----
      link = httpLink;
      const hello = await call("POST", runnerPaths.httpHello, encodeUpFrame(helloFrame("http"), PROTOCOL_MINOR), timers.handshakeTimeoutMs);
      if (isEnd(hello)) {
        finish(hello);
        return conn.ended ?? hello;
      }
      lastContact = now();
      const helloRead = readAnswer(hello, PROTOCOL_MINOR);
      if (helloRead.kind === "frames") {
        const refusal = helloRead.frames.find((frame) => frame.type === "error");
        if (hello.status !== 200 && refusal?.type === "error") {
          finish(
            refusal.code === "version-unsupported"
              ? { kind: "version", message: refusal.message }
              : { kind: "revoked", message: "The server refused this runner at its hello: it was revoked in the panel." },
          );
          return conn.ended ?? { kind: "stopped" };
        }
        const welcome = helloRead.frames.find((frame) => frame.type === "welcome");
        if (welcome?.type === "welcome") {
          conn.epoch = welcome.connectionEpoch;
        }
      }
      if (!(await take(hello, "the hello")) || !conn.welcomed) {
        finish({ kind: "lost", welcomed: false, detail: "the hello was answered without a welcome", quick: false });
        return conn.ended ?? { kind: "stopped" };
      }

      // ---- down: commands, held up to 25 s ----
      const downLoop = async (): Promise<void> => {
        while (conn.ended === undefined) {
          // The poll's `after` acks what was applied, so it waits for the commands in hand.
          await commandChain;
          if (over()) {
            return;
          }
          const answer = await call("GET", `${runnerPaths.httpDown}?after=${String(state.lastContiguousSeq)}`, undefined, timers.longPollMs + 15_000);
          if (isEnd(answer)) {
            finish(answer);
            return;
          }
          if (!(await take(answer, "a down poll"))) {
            return;
          }
        }
      };

      // ---- up: the outbox in batches ----
      const upLoop = async (): Promise<void> => {
        while (conn.ended === undefined) {
          if (outbox.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          const encoded: unknown[] = [];
          let bytes = 0;
          while (outbox.length > 0 && encoded.length < 512) {
            const [next] = outbox;
            if (next === undefined) {
              break;
            }
            const value = upFrameCodec.encodeValue(next, minor);
            const size = utf8ByteLength(JSON.stringify(value)) + 1;
            if (encoded.length > 0 && bytes + size > UP_BATCH_MAX_BYTES) {
              break;
            }
            outbox.shift();
            encoded.push(value);
            bytes += size;
          }
          const answer = await call("POST", runnerPaths.httpUp, JSON.stringify({ frames: encoded }), UP_TIMEOUT_MS);
          if (isEnd(answer)) {
            finish(answer);
            return;
          }
          if (!(await take(answer, "an up batch"))) {
            return;
          }
        }
      };

      await Promise.all([downLoop(), upLoop()]);
      return conn.ended ?? { kind: "stopped" };
    } finally {
      clearInterval(retryTimer);
      stopController.signal.removeEventListener("abort", onStop);
      finish({ kind: "stopped" });
    }
  };

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
    let quickDeaths = 0;
    let carrier: Carrier = transport === "http" ? "http" : "websocket";
    let wsRetryAt = 0;
    const signal = stopController.signal;
    const stopped = (): boolean => signal.aborted;
    /** An `auto` runner moves to HTTP at once, and tries the WebSocket again after `wsRetryMs`. */
    const fallBack = (reason: FallbackReason): void => {
      carrier = "http";
      fallback = reason;
      quickDeaths = 0;
      attempt = 0;
      wsRetryAt = now() + timers.wsRetryMs;
      log.warn("falling back to the HTTP carrier", { reason, detail: fallbackReasonWords[reason], wsRetryInMs: timers.wsRetryMs });
    };
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
      const end = carrier === "websocket" ? await runSocket(token.token) : await runHttp(wsRetryAt);
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
        case "upgrade-refused":
          log.warn("the WebSocket upgrade was answered by something other than the ostra server", { status: end.status, transport });
          if (transport === "auto") {
            fallBack("upgrade-refused");
            continue;
          }
          break;
        case "no-welcome":
          log.warn("the WebSocket upgraded but no welcome came", { waitedMs: timers.handshakeTimeoutMs, transport });
          if (transport === "auto") {
            fallBack("no-welcome");
            continue;
          }
          break;
        case "lost":
          log.info("connection lost", { detail: end.detail, attempt, carrier });
          // After a welcome, silence or a drop is a network failure: reconnect on the same carrier.
          quickDeaths = carrier === "websocket" && end.quick ? quickDeaths + 1 : 0;
          if (transport === "auto" && carrier === "websocket" && quickDeaths >= 3) {
            fallBack("quick-deaths");
            continue;
          }
          if (end.welcomed) {
            attempt = 0;
          }
          break;
        case "superseded":
          // A newer connection of this runner holds it (another replica saw a newer hello): this
          // one ends, and the runner says hello again from scratch.
          log.info("another connection of this runner holds it: saying hello again");
          break;
        case "ws-retry":
          log.info("trying the WebSocket again", { fallback });
          carrier = "websocket";
          continue;
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
    agents.destroy();
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
      carrier: ready ? (link?.carrier ?? null) : null,
      fallback: ready && link?.carrier === "http" ? fallback : null,
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
