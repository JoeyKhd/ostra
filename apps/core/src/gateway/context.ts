import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import type { Ports } from "@ostra/domain";
import { runnerLimits } from "@ostra/protocol";
import type {
  BoxId,
  CommandId,
  CommandKind,
  CommandResult,
  CommandSeq,
  DownFrame,
  EventsFrame,
  LeaseEpoch,
  LiveText,
  OrganizationId,
  ReplicaId,
  RunnerId,
  SessionId,
  TaskId,
} from "@ostra/protocol";

import type { AccessTokens } from "./access-token.ts";
import type { NonceCache } from "./assertion.ts";
import type { DeviceSessions } from "./device-sessions.ts";
import type { TaskTokens } from "./task-token.ts";

// What the gateway is built from. The parts later tickets fill in are hooks: event ingest and live
// text (ticket 25), and what a command's result does (tickets 26 and 27). Until they're wired, the
// test doubles below store nothing and ack.

/** A runner the gateway has authenticated: always with its organization. */
export type RunnerRef = { readonly runnerId: RunnerId; readonly organizationId: OrganizationId };

/** One command result a runner reported, with the command it answers, read back scoped to that runner. */
export type AckedCommand = {
  readonly commandId: CommandId;
  readonly seq: CommandSeq;
  readonly kind: CommandKind;
  readonly body: unknown;
  readonly taskId: TaskId | null;
  readonly result: CommandResult;
  readonly reason: string | null;
};

export type GatewayHooks = {
  /**
   * Saves an `events` frame and returns the frames to send once it committed: acks or errors.
   * `refused` names the events a salvaged frame replaced by placeholders (`salvageEventsFrame`).
   */
  readonly ingest: (runner: RunnerRef, frame: EventsFrame, refused?: ReadonlySet<string>) => Promise<readonly DownFrame[]>;
  /** Partial text: shown, never saved as an event (ADR 0035). */
  readonly liveText: (runner: RunnerRef, frame: LiveText) => Promise<void>;
  /** In the transaction that records the results: a dispatch's offer accepted or rejected, a stop done. */
  readonly onCommandResultsInTx: (tx: Tx, runner: RunnerRef, results: readonly AckedCommand[]) => Promise<void>;
  /** A runner's connection was accepted (its grace timers stop). */
  readonly onConnectedInTx: (tx: Tx, runner: RunnerRef) => Promise<void>;
  /** A runner's newest connection closed (its tasks' grace starts, except a box's, whose sidecar holds it). */
  readonly onDisconnectedInTx: (tx: Tx, runner: RunnerRef) => Promise<void>;
  /** A box's sidecar connected (its task's grace stops). */
  readonly onSidecarConnectedInTx: (tx: Tx, lease: SidecarLease) => Promise<void>;
  /** A box's sidecar's newest connection closed (its task's grace starts, F-045). */
  readonly onSidecarDisconnectedInTx: (tx: Tx, lease: SidecarLease) => Promise<void>;
};

/** The lease a sidecar's task token names, checked. */
export type SidecarLease = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly leaseEpoch: LeaseEpoch;
  readonly boxId: BoxId;
  readonly runnerId: RunnerId;
};

/** The gateway's timers, from the protocol's working values; a test shortens them. */
export type GatewayTimers = {
  readonly pingMs: number;
  readonly deadMs: number;
  readonly handshakeTimeoutMs: number;
  readonly sweepMs: number;
  readonly presenceMs: number;
  readonly maxConnectionAgeMs: number;
};

export const defaultTimers: GatewayTimers = {
  pingMs: runnerLimits.pingMs,
  deadMs: runnerLimits.deadMs,
  handshakeTimeoutMs: runnerLimits.handshakeTimeoutMs,
  sweepMs: runnerLimits.sweepMs,
  presenceMs: runnerLimits.presenceMs,
  maxConnectionAgeMs: runnerLimits.maxConnectionAgeMs,
};

export type GatewayContext = {
  readonly db: Db;
  readonly replicaId: ReplicaId;
  /** The minor this server speaks. A test sets another to check the version window. */
  readonly serverMinor: number;
  readonly serverVersion: string;
  /** The panel's address, where a member approves a device code. */
  readonly panelUrl: string;
  readonly deviceClientId: string;
  readonly tokens: AccessTokens;
  /** The task tokens a box's sidecar connects with (ADR 0034, Q129). */
  readonly taskTokens: TaskTokens;
  readonly nonces: NonceCache;
  readonly deviceSessions: DeviceSessions;
  readonly ports: Pick<Ports, "notices" | "audit" | "clock">;
  readonly hooks: GatewayHooks;
  readonly timers: GatewayTimers;
  readonly logger: Logger;
};

/**
 * Hooks that store nothing: ingest acks each session's highest number in the frame. For the
 * gateway's own tests, and for core until ticket 25's ingest is wired.
 */
export const ackingHooks: GatewayHooks = {
  ingest: (_runner, frame) => {
    const highest = new Map<SessionId, number>();
    for (const item of frame.events) {
      highest.set(item.sessionId, Math.max(highest.get(item.sessionId) ?? 0, item.sessionSeq));
    }
    return Promise.resolve([...highest].map(([sessionId, upTo]): DownFrame => ({ type: "ack", sessionId, upTo })));
  },
  liveText: () => Promise.resolve(),
  onCommandResultsInTx: () => Promise.resolve(),
  onConnectedInTx: () => Promise.resolve(),
  onDisconnectedInTx: () => Promise.resolve(),
  onSidecarConnectedInTx: () => Promise.resolve(),
  onSidecarDisconnectedInTx: () => Promise.resolve(),
};
