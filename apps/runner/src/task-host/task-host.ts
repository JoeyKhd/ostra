import type { Logger } from "@ostra/adapter-sdk";
import type { ExecutorKind, RunnerLabel, SessionId } from "@ostra/protocol";
import type { CommandHandlers, CommandOutcome, PeerStatus, SessionRef } from "../connection/peer.ts";
import { startTaskRun } from "./task-run.ts";
import type { TaskRun, TaskRunDeps } from "./task-run.ts";

// The task host (ticket 21): the runner's side of every command, and the tasks it's running. It
// accepts a dispatch within the offer timeout or rejects it when full, and hands each task to a
// `TaskRun`. The connection calls these handlers; on `host` that's the runner's own, in a box it's
// the sidecar's.

export type TaskHostOptions = TaskRunDeps & {
  readonly capacity: number;
  readonly executorKind: ExecutorKind;
  readonly labels: readonly RunnerLabel[];
};

export type TaskHost = {
  readonly handlers: CommandHandlers;
  readonly status: () => PeerStatus;
  /** The self-fence fired: end these sessions' agents and keep their workspaces. */
  readonly fence: (sessions: readonly SessionId[]) => void;
  /** The server refused a session's lease. */
  readonly abandon: (sessionId: SessionId) => void;
  /** Sessions the runner held before it restarted: their agents are gone, so they crashed. */
  readonly restored: (sessions: readonly SessionRef[]) => Promise<void>;
  /** Every run's promise, for tests and shutdown. */
  readonly running: () => readonly TaskRun[];
  /** Ends every run's agent, keeping the workspaces (the runner is shutting down). */
  readonly shutdown: () => Promise<void>;
};

export const createTaskHost = (options: TaskHostOptions): TaskHost => {
  const runs = new Map<SessionId, TaskRun>();
  let draining = false;
  const log: Logger = options.logger.child({ component: "task-host" });

  const track = (run: TaskRun): void => {
    runs.set(run.dispatch.sessionId, run);
    options.link.statusChanged();
    void run.done.finally(() => {
      runs.delete(run.dispatch.sessionId);
      options.link.statusChanged();
    });
  };

  const done = (outcome: CommandOutcome): Promise<CommandOutcome> => Promise.resolve(outcome);

  const handlers: CommandHandlers = {
    dispatch: (command) => {
      const body = command.body;
      if (runs.has(body.sessionId)) {
        return done({ result: "accepted" });
      }
      if (draining) {
        return done({ result: "rejected", reason: "draining" });
      }
      if (runs.size >= options.capacity) {
        return done({ result: "rejected", reason: "no-capacity" });
      }
      log.info("dispatch accepted", { taskId: body.taskId, sessionId: body.sessionId, leaseEpoch: body.leaseEpoch });
      track(startTaskRun(options, body));
      return done({ result: "accepted" });
    },
    stop: (command) => {
      const run = runs.get(command.body.sessionId);
      if (run === undefined) {
        // Nothing running here: whatever it was is already stopped.
        return done({ result: "done", reason: "unknown-session" });
      }
      if (run.dispatch.leaseEpoch !== command.body.leaseEpoch) {
        return done({ result: "rejected", reason: "stale-lease" });
      }
      return run.stop(command.body.reason);
    },
    interrupt: (command) => {
      const run = runs.get(command.body.sessionId);
      return run === undefined ? done({ result: "rejected", reason: "unknown-session" }) : run.interrupt();
    },
    steer: (command) => {
      const run = runs.get(command.body.sessionId);
      return run === undefined ? done({ result: "rejected", reason: "unknown-session" }) : run.steer(command.body);
    },
    // Approvals answered in the panel come with F-026 (milestone 3): milestone 1 answers them itself.
    "approval-answer": () => done({ result: "rejected", reason: "no-pending-approval" }),
    drain: () => {
      draining = true;
      log.info("draining: no new tasks");
      options.link.statusChanged();
      return done({ result: "done" });
    },
    "update-hint": (command) => {
      log.info("a newer runner is available", { version: command.body.version });
      return done({ result: "done" });
    },    // Protocol minor 1. Milestone 1's host releases the workspace after every session, so a box
    // this runner no longer runs is already gone. Ticket 23 keeps idle boxes and releases them here.
    release: (command) => {
      const held = [...runs.values()].some((run) => run.dispatch.boxId === command.body.boxId);
      log.info("release asked", { taskId: command.body.taskId, boxId: command.body.boxId, reason: command.body.reason, held });
      return done(held ? { result: "rejected", reason: "box-busy" } : { result: "done", reason: "not-held" });
    },
  };

  return {
    handlers,
    status: () => ({
      executor: options.executorKind,
      capacity: options.capacity,
      freeSlots: draining ? 0 : Math.max(0, options.capacity - runs.size),
      labels: options.labels,
      running: [...runs.keys()],
    }),
    fence: (sessions) => {
      for (const sessionId of sessions) {
        void runs.get(sessionId)?.fence();
      }
    },
    abandon: (sessionId) => {
      void runs.get(sessionId)?.abandon();
    },
    restored: async (sessions) => {
      for (const ref of sessions) {
        log.warn("a session's agent didn't survive the runner's restart", { taskId: ref.taskId, sessionId: ref.sessionId });
        const channel = await options.link.openSession(ref);
        await channel.emit({ kind: "session.crashed", error: "the runner restarted while the session was running" });
        channel.close();
      }
    },
    running: () => [...runs.values()],
    shutdown: async () => {
      await Promise.allSettled([...runs.values()].map((run) => run.fence()));
    },
  };
};
