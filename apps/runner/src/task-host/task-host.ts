import os from "node:os";
import type { BoxRef, Logger } from "@ostra/adapter-sdk";
import type { BoxId, ExecutorKind, RunnerLabel, SessionId } from "@ostra/protocol";
import type { CommandHandlers, CommandOutcome, PeerStatus, SessionRef } from "../connection/peer.ts";
import { removeAgentLeftovers } from "./leftovers.ts";
import { startTaskRun } from "./task-run.ts";
import type { KeptBox, TaskRun, TaskRunDeps } from "./task-run.ts";

// The task host (ticket 21): the runner's side of every command, and the tasks it's running. It
// accepts a dispatch within the offer timeout or rejects it when full, and hands each task to a
// `TaskRun`. The connection calls these handlers; on `host` that's the runner's own, in a box it's
// the sidecar's.

export type TaskHostOptions = TaskRunDeps & {
  readonly capacity: number;
  readonly executorKind: ExecutorKind;
  readonly labels: readonly RunnerLabel[];
  /** The system temp folder, where an agent's leftovers go on `host` (ticket 23). Default: `os.tmpdir()`. */
  readonly tempDir?: string;
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
  /** The boxes ended sessions left kept, for a resume or a `release` (milestone 2). */
  readonly kept: () => readonly KeptBox[];
  /** Ends every run's agent, keeping the workspaces (the runner is shutting down). */
  readonly shutdown: () => Promise<void>;
};

export const createTaskHost = (options: TaskHostOptions): TaskHost => {
  const runs = new Map<SessionId, TaskRun>();
  /** Boxes kept after their session ended (ADR 0039), by box. On `host` the worktree stays until a release. */
  const keptBoxes = new Map<BoxId, KeptBox>();
  /** Runs whose kept box a release or the next session already took: their end doesn't keep it again. */
  const handedOver = new WeakSet<TaskRun>();
  let draining = false;
  const log: Logger = options.logger.child({ component: "task-host" });
  const tempDir = options.tempDir ?? os.tmpdir();

  const track = (run: TaskRun): void => {
    runs.set(run.dispatch.sessionId, run);
    options.link.statusChanged();
    void run.done.finally(() => {
      runs.delete(run.dispatch.sessionId);
      const left = run.keptBox();
      if (left !== undefined && !handedOver.has(run)) {
        keptBoxes.set(left.box.boxId, left);
        log.info("box kept", { taskId: left.box.taskId, boxId: left.box.boxId });
      }
      options.link.statusChanged();
    });
  };

  /**
   * `release` (ticket 23): the box and its workspace, the agent's own folders with them, and what
   * the agent left in the system temp folder. A session that waits between turns ends first, as its
   * idle timer would; a box whose turn is running is busy. A box already gone is released too.
   */
  const release = async (body: Parameters<CommandHandlers["release"]>[0]["body"]): Promise<CommandOutcome> => {
    const live = [...runs.values()].find((run) => run.dispatch.boxId === body.boxId && run.dispatch.taskId === body.taskId);
    if (live !== undefined) {
      handedOver.add(live);
      if (!(await live.endBetweenTurns())) {
        handedOver.delete(live);
        log.info("release refused: the box's turn is running", { taskId: body.taskId, boxId: body.boxId });
        return { result: "rejected", reason: "box-busy" };
      }
    }
    const left = keptBoxes.get(body.boxId) ?? live?.keptBox();
    const released = await options.executor.release({ taskId: body.taskId, boxId: body.boxId }, body.reason);
    if (!released.ok) {
      log.warn("releasing the box failed", { taskId: body.taskId, boxId: body.boxId, code: released.error.code });
      return { result: "rejected", reason: "release-failed" };
    }
    keptBoxes.delete(body.boxId);
    const leftovers = await removeAgentLeftovers(tempDir, [body.taskId, left?.agentSessionId]);
    log.info("box released", { taskId: body.taskId, boxId: body.boxId, reason: body.reason, kept: left !== undefined, leftovers });
    return { result: "done" };
  };

  const done = (outcome: CommandOutcome): Promise<CommandOutcome> => Promise.resolve(outcome);

  /**
   * `resumed` (ticket 24): the box a session of the task left kept here, for the new session. A
   * session still waiting in it ends first, as its idle timer would; one whose turn runs keeps it.
   */
  const claimKeptBox = async (box: BoxRef, sessionId: SessionId): Promise<KeptBox | undefined> => {
    const live = [...runs.values()].find((run) => run.dispatch.boxId === box.boxId && run.dispatch.taskId === box.taskId && run.dispatch.sessionId !== sessionId);
    if (live !== undefined) {
      handedOver.add(live);
      if (!(await live.endBetweenTurns())) {
        handedOver.delete(live);
        return undefined;
      }
      keptBoxes.delete(box.boxId);
      return live.keptBox();
    }
    const held = keptBoxes.get(box.boxId);
    if (held?.box.taskId !== box.taskId) {
      return undefined;
    }
    keptBoxes.delete(box.boxId);
    log.info("kept box resumed", { taskId: box.taskId, boxId: box.boxId });
    return held;
  };

  const handlers: CommandHandlers = {
    dispatch: (command) => {
      const body = command.body;
      if (runs.has(body.sessionId)) {
        return done({ result: "accepted" });
      }
      if (draining) {
        return done({ result: "rejected", reason: "draining" });
      }
      // A session of the same box takes the slot of the one waiting in it (a resume, ticket 24).
      const sameBox = [...runs.values()].some((run) => run.dispatch.boxId === body.boxId && run.dispatch.taskId === body.taskId);
      if (runs.size >= options.capacity && !sameBox) {
        return done({ result: "rejected", reason: "no-capacity" });
      }
      log.info("dispatch accepted", { taskId: body.taskId, sessionId: body.sessionId, leaseEpoch: body.leaseEpoch });
      track(startTaskRun({ ...options, claimKeptBox }, body));
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
    // Minor 2 (F-026, ticket 30): a person's answer to a held approval, the driver's to a question.
    "approval-answer": (command) => {
      const run = runs.get(command.body.sessionId);
      return run === undefined ? done({ result: "rejected", reason: "no-pending-approval" }) : run.answerApproval(command.body);
    },
    drain: () => {
      draining = true;
      log.info("draining: no new tasks");
      options.link.statusChanged();
      return done({ result: "done" });
    },
    "update-hint": (command) => {
      log.info("a newer runner is available", { version: command.body.version });
      return done({ result: "done" });
    },
    // Protocol minor 1: remove a kept box (ticket 23). Idempotent: a box already gone acks `done`.
    release: (command) => release(command.body),
    "question-answer": (command) => {
      const run = runs.get(command.body.sessionId);
      return run === undefined ? done({ result: "rejected", reason: "no-pending-question" }) : run.answerQuestion(command.body);
    },
    // Protocol minor 2. Plans are answered with ticket 31; the `host` executor builds no snapshot
    // image (ADR 0038), so it refuses a build.
    "plan-answer": () => done({ result: "rejected", reason: "no-pending-plan" }),
    "snapshot-build": () => done({ result: "rejected", reason: "not-supported" }),
  };

  return {
    handlers,
    status: () => ({
      executor: options.executorKind,
      processContainment: options.executor.capabilities.processContainment,
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
    kept: () => [...keptBoxes.values()],
    shutdown: async () => {
      await Promise.allSettled([...runs.values()].map((run) => run.fence()));
    },
  };
};
