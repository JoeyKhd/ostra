import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DockerBoxes } from "@ostra/adapter-executor-docker";
import type { Logger } from "@ostra/adapter-sdk";
import type { BoxId, RunnerLabel, SessionId } from "@ostra/protocol";
import type { CommandHandlers, CommandOutcome, PeerStatus, TokenSource } from "./connection/peer.ts";
import type { ServerLink } from "./task-host/server-link.ts";

// A pool runner on the `docker` executor (ADR 0029): it only creates and removes boxes. On a
// dispatch it makes the box, whose sidecar then connects to the server itself and runs the task;
// when the sidecar exits, the runner removes the box. Commands for a task go to its sidecar.
//
// The sidecar's access token: the protocol has no task-scoped token yet (it's the runner's
// 10-minute one, written to a file the sidecar reads and the runner rewrites every few minutes).
// A token for one task, tied to its lease, is the contract change this waits on.

/** How often the runner rewrites a box's token file: well inside the token's 10 minutes. */
export const TOKEN_REFRESH_MS = 4 * 60_000;

export type BoxDispatcherOptions = {
  readonly boxes: DockerBoxes;
  readonly link: Pick<ServerLink, "fetchSpec" | "statusChanged">;
  readonly tokens: TokenSource;
  /** Where box token folders go: `<dataDir>/boxes/<boxId>`. */
  readonly dataDir: string;
  /** Core's address as a box's sidecar reaches it. */
  readonly serverUrl: string;
  readonly capacity: number;
  readonly labels: readonly RunnerLabel[];
  readonly logger: Logger;
};

export type BoxDispatcher = {
  readonly handlers: CommandHandlers;
  readonly status: () => PeerStatus;
  /** Every box's lifetime, for tests. */
  readonly boxes: () => readonly Promise<void>[];
};

type Running = { readonly sessionId: SessionId; readonly done: Promise<void> };

export const createBoxDispatcher = (options: BoxDispatcherOptions): BoxDispatcher => {
  const running = new Map<BoxId, Running>();
  let draining = false;
  const log = options.logger.child({ component: "box-dispatcher" });
  const done = (outcome: CommandOutcome): Promise<CommandOutcome> => Promise.resolve(outcome);

  const writeToken = async (file: string): Promise<boolean> => {
    const token = await options.tokens.get();
    if (!token.ok) {
      return false;
    }
    // The sidecar runs as the agent's uid in its container: the file is readable by it, on a
    // dedicated pool host (Q97).
    await writeFile(file, token.token, { mode: 0o644 });
    await chmod(file, 0o644);
    return true;
  };

  const runBox = async (body: Parameters<CommandHandlers["dispatch"]>[0]["body"]): Promise<void> => {
    const boxLog = log.child({ taskId: body.taskId, boxId: body.boxId, leaseEpoch: body.leaseEpoch });
    const tokenDir = path.join(options.dataDir, "boxes", body.boxId);
    let refresher: ReturnType<typeof setInterval> | undefined;
    try {
      const spec = await options.link.fetchSpec(body.taskId, body.leaseEpoch);
      if (!spec.ok) {
        boxLog.warn("couldn't read the task's spec: no box", { reason: spec.failure.kind });
        return;
      }
      await mkdir(tokenDir, { recursive: true, mode: 0o755 });
      const tokenFile = path.join(tokenDir, "token");
      if (!(await writeToken(tokenFile))) {
        boxLog.warn("no access token for the box's sidecar: no box");
        return;
      }
      refresher = setInterval(() => {
        void writeToken(tokenFile);
      }, TOKEN_REFRESH_MS);
      const created = await options.boxes.createBox({
        taskId: body.taskId,
        sessionId: body.sessionId,
        boxId: body.boxId,
        leaseEpoch: body.leaseEpoch,
        serverUrl: options.serverUrl,
        baseImage: spec.value.environment.baseImage,
        tokenDir,
      });
      if (!created.ok) {
        boxLog.error("creating the box failed", { status: created.error.status });
        return;
      }
      boxLog.info("box created");
      const exitCode = await options.boxes.waitForSidecar(body.boxId);
      boxLog.info("the box's sidecar exited", { exitCode });
    } finally {
      if (refresher !== undefined) {
        clearInterval(refresher);
      }
      const removed = await options.boxes.removeBox(body.boxId);
      if (!removed.ok) {
        boxLog.warn("removing the box failed", { status: removed.error.status });
      }
      await rm(tokenDir, { recursive: true, force: true });
    }
  };

  const handlers: CommandHandlers = {
    dispatch: (command) => {
      const body = command.body;
      if (running.has(body.boxId)) {
        return done({ result: "accepted" });
      }
      if (draining) {
        return done({ result: "rejected", reason: "draining" });
      }
      if (running.size >= options.capacity) {
        return done({ result: "rejected", reason: "no-capacity" });
      }
      const lifetime = runBox(body)
        .catch((error: unknown) => {
          log.error("a box failed", { boxId: body.boxId, error: error instanceof Error ? error.name : "unknown" });
        })
        .finally(() => {
          running.delete(body.boxId);
          options.link.statusChanged();
        });
      running.set(body.boxId, { sessionId: body.sessionId, done: lifetime });
      options.link.statusChanged();
      return done({ result: "accepted" });
    },
    // A box's task is its sidecar's: the server sends it these.
    stop: () => done({ result: "done", reason: "the box's sidecar stops it" }),
    interrupt: () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    steer: () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "approval-answer": () => done({ result: "rejected", reason: "no-pending-approval" }),
    drain: () => {
      draining = true;
      options.link.statusChanged();
      return done({ result: "done" });
    },
    "update-hint": (command) => {
      log.info("a newer runner is available", { version: command.body.version });
      return done({ result: "done" });
    },
  };

  return {
    handlers,
    status: () => ({
      executor: "docker",
      capacity: options.capacity,
      freeSlots: draining ? 0 : Math.max(0, options.capacity - running.size),
      labels: options.labels,
      running: [...running.values()].map((item) => item.sessionId),
    }),
    boxes: () => [...running.values()].map((item) => item.done),
  };
};
