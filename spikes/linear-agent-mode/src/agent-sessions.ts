import { randomUUID } from "node:crypto";
import { isAbortError } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { ActivityId } from "./ids.ts";
import type { AgentSessionId, OrganizationId, TicketKey } from "./ids.ts";
import { classifyFailure } from "./linear-api.ts";
import type { ActivityContent, LinearApi } from "./linear-api.ts";
import type { Logger } from "./log.ts";
import { retryUntil } from "./retry.ts";
import type { RetryOutcome } from "./retry.ts";
import { transition } from "./session-model.ts";
import type { EndReason, SessionState, SessionTransition } from "./session-model.ts";
import type { TurnDriver, TurnHandle, TurnOutcome, TurnStart } from "./turn-driver.ts";
import { errorName } from "./util.ts";
import type { SessionEvent } from "./webhook-schema.ts";

export type HeartbeatConfig =
  | { readonly kind: "off" }
  /** A hidden-after-the-next-activity thought: cheap, and meant for exactly this. */
  | { readonly kind: "ephemeral-thought"; readonly intervalMs: number }
  /** A permanent thought, if Linear turns out not to count an ephemeral one as activity. */
  | { readonly kind: "thought"; readonly intervalMs: number };

export type AgentConfig = {
  /** Wall-clock milliseconds the first activity may take, retries included. Linear's own limit is 10 s. */
  readonly firstActivityBudgetMs: number;
  /** Wall-clock milliseconds the final activity of a turn (response, error, stop) may take. */
  readonly finalActivityBudgetMs: number;
  /** Real milliseconds a call may stay unanswered before a second one is started beside it (the first is not cancelled). */
  readonly hedgeAfterMs: number;
  /** Silence is capped by this interval, in `clock` milliseconds. Linear marks a session stale after 30 minutes. */
  readonly heartbeat: HeartbeatConfig;
  readonly taskUrl: (sessionId: AgentSessionId) => string;
};

export type SessionMetrics = {
  readonly sessionId: AgentSessionId;
  /** The ticket's key, when the webhook named one. An ID: safe to print. */
  readonly issueIdentifier: TicketKey | null;
  /** `performance.now()` when the webhook was received. */
  readonly receivedAt: number;
  /**
   * When the first response of either kind landed: the first thought or the external-link update, whichever came
   * first. This is the "unresponsive" rule's view (Linear counts both). It is NOT what the pass bar measures.
   */
  readonly firstActivityAt: number | null;
  /** When the first thought (an agent activity) landed, null until one did. The pass bar's "first activity". */
  readonly firstThoughtAt: number | null;
  readonly firstActivityVia: "activity" | "link" | null;
  readonly firstActivityAttempts: number;
  /** When the driver (the stand-in for a runner) was first asked for anything. */
  readonly driverAskedAt: number | null;
  readonly activitiesPosted: number;
  readonly heartbeatsPosted: number;
  readonly heartbeatsMissed: number;
  readonly followUpsSeen: number;
  readonly stopsSeen: number;
  /** The longest gap between two of ostra's own posts to this session, on the scenario clock. */
  readonly maxPostGapMs: number;
  readonly lastPostAt: number | null;
};

type MutableMetrics = { -readonly [K in keyof SessionMetrics]: SessionMetrics[K] };

export type AgentSessionDeps = {
  readonly apiFor: (organizationId: OrganizationId) => LinearApi | undefined;
  readonly driver: TurnDriver;
  /** Heartbeats and backoff run on this clock: a scaled one lets a 35-minute silence run in seconds. */
  readonly clock: Clock;
  /** The wall clock. Linear's 5 s and 10 s are real seconds. */
  readonly wall: Clock;
  readonly log: Logger;
  readonly config: AgentConfig;
};

export type AgentSessionService = {
  /** Returns at once. The work happens behind it, one session at a time in the order events arrived. */
  handle: (event: SessionEvent, receivedAt: number) => void;
  /** Resolves when no event is being handled. Running turns do not count. */
  idle: () => Promise<void>;
  stateOf: (sessionId: AgentSessionId) => SessionState | undefined;
  metrics: () => readonly SessionMetrics[];
  /** Aborts every heartbeat and stops every running turn. Leaves nothing scheduled. */
  shutdown: () => Promise<void>;
};

type StartRequest = { readonly reason: "delegated" } | { readonly reason: "follow-up"; readonly text: string };

type ActiveTurn = {
  readonly handle: TurnHandle;
  readonly abort: AbortController;
  loop: Promise<void>;
};

type SessionRecord = {
  readonly id: AgentSessionId;
  readonly organizationId: OrganizationId;
  state: SessionState;
  /** Events for one session run one after the other: a stop never overtakes the `created` before it. */
  chain: Promise<void>;
  turn: ActiveTurn | null;
  readonly metrics: MutableMetrics;
};

// Static text only. Ticket text and follow-up text never go back into Linear or into a log from here.
const TEXT = {
  first: "ostra received this request and is queueing a run.",
  followUp: "Got your follow-up. Passing it to the running task.",
  reopen: "Got your follow-up. Reopening the task.",
  stopped: "Stopped on request. Nothing further will run.",
  noRunner: "No runner is available right now, so nothing was started. Try again once a runner is online.",
} as const;

export const createAgentSessionService = (deps: AgentSessionDeps): AgentSessionService => {
  const { apiFor, driver, clock, wall, log, config } = deps;
  const records = new Map<AgentSessionId, SessionRecord>();
  const inFlight = new Set<Promise<void>>();

  const enqueue = (record: SessionRecord, task: string, work: () => Promise<void>): void => {
    const run = record.chain
      .then(work)
      .catch((error: unknown) => {
        log.error("session_task_failed", { session: record.id, task, error: errorName(error) });
      });
    record.chain = run;
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
  };

  const notePost = (record: SessionRecord): void => {
    const now = clock.now();
    const last = record.metrics.lastPostAt;
    if (last !== null) record.metrics.maxPostGapMs = Math.max(record.metrics.maxPostGapMs, now - last);
    record.metrics.lastPostAt = now;
    record.metrics.activitiesPosted += 1;
  };

  const apply = (record: SessionRecord, event: SessionTransition): void => {
    const result = transition(record.state, event);
    if (result.ok) {
      record.state = result.state;
    } else {
      log.warn("session_transition_rejected", { session: record.id, reason: result.reason });
    }
  };

  const post = async (
    record: SessionRecord,
    content: ActivityContent,
    options: { readonly budgetMs: number; readonly ephemeral?: boolean },
  ): Promise<RetryOutcome<{ readonly activityId: ActivityId }>> => {
    const api = apiFor(record.organizationId);
    if (api === undefined) {
      log.error("no_installation", { session: record.id, org: record.organizationId });
      return { ok: false, reason: "permanent", attempts: 0 };
    }
    const activityId = ActivityId.parse(randomUUID());
    const outcome = await retryUntil(
      () =>
        api.postActivity({
          sessionId: record.id,
          id: activityId,
          content,
          ...(options.ephemeral === true ? { ephemeral: true } : {}),
        }),
      {
        clock: wall,
        deadline: wall.now() + options.budgetMs,
        hedgeAfterMs: config.hedgeAfterMs,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        classify: classifyFailure,
      },
    );
    if (outcome.ok) notePost(record);
    return outcome;
  };

  const heartbeatLoop = async (record: SessionRecord, signal: AbortSignal): Promise<void> => {
    const hb = config.heartbeat;
    if (hb.kind === "off") return;
    const startedAt = clock.now();
    for (;;) {
      try {
        await clock.sleep(hb.intervalMs, signal);
      } catch (error: unknown) {
        if (isAbortError(error)) return;
        throw error;
      }
      if (signal.aborted) return;
      const api = apiFor(record.organizationId);
      if (api === undefined) return;
      const elapsedMinutes = Math.round((clock.now() - startedAt) / 60_000);
      const activityId = ActivityId.parse(randomUUID());
      const outcome = await retryUntil(
        () =>
          api.postActivity({
            sessionId: record.id,
            id: activityId,
            content: { type: "thought", body: `Still working. ${String(elapsedMinutes)} min elapsed.` },
            ...(hb.kind === "ephemeral-thought" ? { ephemeral: true } : {}),
          }),
        {
          clock,
          // A late heartbeat is still worth sending, but it must not outlast the next one.
          deadline: clock.now() + hb.intervalMs / 2,
          hedgeAfterMs: config.hedgeAfterMs,
          baseDelayMs: 500,
          maxDelayMs: 30_000,
          signal,
          classify: classifyFailure,
        },
      );
      if (outcome.ok) {
        record.metrics.heartbeatsPosted += 1;
        notePost(record);
      } else if (outcome.reason !== "aborted") {
        record.metrics.heartbeatsMissed += 1;
        log.warn("heartbeat_missed", { session: record.id, reason: outcome.reason, attempts: outcome.attempts });
      }
    }
  };

  const endTurn = async (record: SessionRecord): Promise<ActiveTurn | null> => {
    const turn = record.turn;
    record.turn = null;
    if (turn !== null) {
      turn.abort.abort();
      await turn.loop;
    }
    return turn;
  };

  const onTurnDone = async (record: SessionRecord, turn: ActiveTurn, outcome: TurnOutcome): Promise<void> => {
    // The stop path may have taken the turn already: it owns the final activity then.
    if (record.turn !== turn) return;
    await endTurn(record);
    switch (outcome.kind) {
      case "completed": {
        await post(record, { type: "response", body: outcome.summary }, { budgetMs: config.finalActivityBudgetMs });
        apply(record, { kind: "turn-ended", reason: "completed" });
        return;
      }
      case "failed": {
        await post(record, { type: "error", body: `The run failed (${outcome.reason}).` }, { budgetMs: config.finalActivityBudgetMs });
        apply(record, { kind: "turn-ended", reason: "failed" });
        return;
      }
      case "stopped": {
        apply(record, { kind: "turn-ended", reason: "stopped" });
        return;
      }
      default:
        return outcome satisfies never;
    }
  };

  const beginTurn = (record: SessionRecord, handle: TurnHandle): void => {
    apply(record, { kind: "turn-started" });
    const abort = new AbortController();
    const turn: ActiveTurn = { handle, abort, loop: Promise.resolve() };
    turn.loop = heartbeatLoop(record, abort.signal).catch((error: unknown) => {
      log.error("heartbeat_failed", { session: record.id, error: errorName(error) });
    });
    record.turn = turn;
    void handle.done
      .catch((): TurnOutcome => ({ kind: "failed", reason: "driver-error" }))
      .then((outcome) => {
        enqueue(record, "turn-done", () => onTurnDone(record, turn, outcome));
      });
  };

  const startTurn = async (record: SessionRecord, request: StartRequest): Promise<void> => {
    record.metrics.driverAskedAt ??= wall.now();
    const start: TurnStart = driver.startTurn({ sessionId: record.id, ...request });
    switch (start.kind) {
      case "started":
        beginTurn(record, start.handle);
        return;
      case "unavailable": {
        log.warn("no_runner", { session: record.id, reason: start.reason });
        await post(record, { type: "error", body: TEXT.noRunner }, { budgetMs: config.finalActivityBudgetMs });
        apply(record, { kind: "turn-ended", reason: "no-runner" });
        return;
      }
      default:
        return start satisfies never;
    }
  };

  /** The fast lane. Nothing in here waits for a runner. */
  const onCreated = async (record: SessionRecord): Promise<void> => {
    const api = apiFor(record.organizationId);
    const budgetMs = config.firstActivityBudgetMs;
    const noteFirst = (via: "activity" | "link"): void => {
      if (record.metrics.firstActivityAt === null) {
        record.metrics.firstActivityAt = wall.now();
        record.metrics.firstActivityVia = via;
      }
    };
    // Both go out at once. The link also counts as a first response for Linear, so one working call is enough.
    const activity = post(record, { type: "thought", body: TEXT.first }, { budgetMs }).then((outcome) => {
      record.metrics.firstActivityAttempts = outcome.attempts;
      if (outcome.ok) {
        // Only a posted thought counts as the pass bar's first activity. The link below does not.
        record.metrics.firstThoughtAt ??= wall.now();
        noteFirst("activity");
      }
      return outcome;
    });
    const link =
      api === undefined
        ? Promise.resolve<RetryOutcome<void>>({ ok: false, reason: "permanent", attempts: 0 })
        : retryUntil(
            () => api.updateSession(record.id, { externalUrls: [{ label: "ostra task", url: config.taskUrl(record.id) }] }),
            {
              clock: wall,
              deadline: wall.now() + budgetMs,
              hedgeAfterMs: config.hedgeAfterMs,
              baseDelayMs: 100,
              maxDelayMs: 1000,
              classify: classifyFailure,
            },
          ).then((outcome) => {
            if (outcome.ok) noteFirst("link");
            return outcome;
          });
    const [activityOutcome, linkOutcome] = await Promise.all([activity, link]);
    if (activityOutcome.ok || linkOutcome.ok) {
      apply(record, { kind: "first-activity-posted" });
    } else {
      log.error("first_activity_failed", {
        session: record.id,
        activity: activityOutcome.reason,
        link: linkOutcome.reason,
      });
    }
    await startTurn(record, { reason: "delegated" });
  };

  const onStop = async (record: SessionRecord): Promise<void> => {
    apply(record, { kind: "stop-requested" });
    const turn = await endTurn(record);
    if (turn !== null) await turn.handle.stop();
    // Linear wants a final response or error after a stop, and nothing else.
    await post(record, { type: "response", body: TEXT.stopped }, { budgetMs: config.finalActivityBudgetMs });
    apply(record, { kind: "turn-ended", reason: "stopped" });
  };

  const onFollowUp = async (record: SessionRecord, text: string): Promise<void> => {
    const running = record.turn;
    await post(
      record,
      { type: "thought", body: running === null ? TEXT.reopen : TEXT.followUp },
      { budgetMs: config.firstActivityBudgetMs },
    );
    if (running === null) {
      await startTurn(record, { reason: "follow-up", text });
    } else {
      running.handle.steer(text);
    }
  };

  const newRecord = (
    sessionId: AgentSessionId,
    organizationId: OrganizationId,
    state: SessionState,
    receivedAt: number,
    issueIdentifier: TicketKey | null,
  ): SessionRecord => {
    const record: SessionRecord = {
      id: sessionId,
      organizationId,
      state,
      chain: Promise.resolve(),
      turn: null,
      metrics: {
        sessionId,
        issueIdentifier,
        receivedAt,
        firstActivityAt: null,
        firstThoughtAt: null,
        firstActivityVia: null,
        firstActivityAttempts: 0,
        driverAskedAt: null,
        activitiesPosted: 0,
        heartbeatsPosted: 0,
        heartbeatsMissed: 0,
        followUpsSeen: 0,
        stopsSeen: 0,
        maxPostGapMs: 0,
        lastPostAt: null,
      },
    };
    records.set(sessionId, record);
    return record;
  };

  return {
    handle: (event, receivedAt) => {
      switch (event.kind) {
        case "created": {
          if (records.has(event.sessionId)) {
            log.info("session_created_again", { session: event.sessionId });
            return;
          }
          const record = newRecord(event.sessionId, event.organizationId, { kind: "received" }, receivedAt, event.issueIdentifier);
          enqueue(record, "created", () => onCreated(record));
          return;
        }
        case "prompted": {
          let record = records.get(event.sessionId);
          if (record === undefined) {
            // A session this process has no record of (it restarted, or another replica took the first event).
            // ostra rebuilds from its database; the spike treats it as ended and carries on.
            log.warn("session_restored", { session: event.sessionId });
            record = newRecord(event.sessionId, event.organizationId, { kind: "ended", reason: "restored" satisfies EndReason }, receivedAt, null);
          }
          const target = record;
          if (event.stop) target.metrics.stopsSeen += 1;
          else target.metrics.followUpsSeen += 1;
          if (event.stop) {
            enqueue(target, "stop", () => onStop(target));
          } else {
            enqueue(target, "follow-up", () => onFollowUp(target, event.body));
          }
          return;
        }
        default:
          return event satisfies never;
      }
    },
    idle: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
    stateOf: (sessionId) => records.get(sessionId)?.state,
    metrics: () => [...records.values()].map((record) => ({ ...record.metrics })),
    shutdown: async () => {
      for (const record of records.values()) {
        const turn = await endTurn(record);
        if (turn !== null) await turn.handle.stop();
      }
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
};
