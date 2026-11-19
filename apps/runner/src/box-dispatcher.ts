import { chmod, chown, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SIDECAR_GID, SIDECAR_UID } from "@ostra/adapter-executor-docker";
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
//
// Until then the file is the one thing on the pool host that can act as the runner, so only the
// sidecar may read it: mode 0400 in a 0500 folder, owned by the sidecar's uid (the runner is root),
// or, when the runner isn't root and can't hand a file to another uid, owned by the runner with its
// group (0440 in a 0750 folder), which the sidecar's container joins as a supplementary group.

/** How the sidecar, and only the sidecar, gets to read the token file. */
export type TokenAccess =
  /** The runner is root: the file and folder are owned by the sidecar's uid, and nobody else reads them. */
  | { readonly kind: "owner"; readonly uid: number; readonly gid: number }
  /** The runner isn't root: its own group reads the file, and the sidecar's container joins that group. */
  | { readonly kind: "group"; readonly gid: number }
  /** No way to restrict the file here (no POSIX ids): the dispatcher makes no box. */
  | { readonly kind: "none" };

/** From the runner's own ids: root hands the file to the sidecar's uid; anyone else uses its group. */
export const detectTokenAccess = (): TokenAccess => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === 0) {
    return { kind: "owner", uid: SIDECAR_UID, gid: SIDECAR_GID };
  }
  return gid === undefined ? { kind: "none" } : { kind: "group", gid };
};

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
  /** How the sidecar reads the token file. Defaults to `detectTokenAccess()`. */
  readonly tokenAccess?: TokenAccess;
  /** Hands a file to another uid, for `owner` access. Defaults to `fs.chown`. */
  readonly chown?: (path: string, uid: number, gid: number) => Promise<void>;
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

  const access = options.tokenAccess ?? detectTokenAccess();
  const handOver = options.chown ?? chown;

  /** The box's token folder: closed to everyone but the sidecar (and the runner, which writes it). */
  const makeTokenDir = async (dir: string): Promise<void> => {
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    // A folder left by an earlier try may hold an old token: start from nothing.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { mode: 0o700 });
    switch (access.kind) {
      case "owner":
        await handOver(dir, access.uid, access.gid);
        await chmod(dir, 0o500);
        return;
      case "group":
        await chmod(dir, 0o750);
        return;
      case "none":
        throw new Error("no way to restrict the token folder");
      default:
        access satisfies never;
    }
  };

  /** Writes the token with the file's final mode from the first byte, then swaps it in whole. */
  const writeToken = async (file: string): Promise<boolean> => {
    const token = await options.tokens.get();
    if (!token.ok) {
      return false;
    }
    const staging = `${file}.next`;
    await rm(staging, { force: true });
    switch (access.kind) {
      case "owner":
        await writeFile(staging, token.token, { mode: 0o400, flag: "wx" });
        await handOver(staging, access.uid, access.gid);
        break;
      case "group":
        await writeFile(staging, token.token, { mode: 0o440, flag: "wx" });
        break;
      case "none":
        throw new Error("no way to restrict the token file");
      default:
        access satisfies never;
    }
    await rename(staging, file);
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
      if (access.kind === "none") {
        boxLog.error("this host can't restrict the sidecar's token file to the sidecar: no box");
        return;
      }
      await makeTokenDir(tokenDir);
      const tokenFile = path.join(tokenDir, "token");
      if (!(await writeToken(tokenFile))) {
        boxLog.warn("no access token for the box's sidecar: no box");
        return;
      }
      refresher = setInterval(() => {
        writeToken(tokenFile).catch((error: unknown) => {
          boxLog.warn("rewriting the sidecar's token file failed", { error: error instanceof Error ? error.name : "unknown" });
        });
      }, TOKEN_REFRESH_MS);
      const created = await options.boxes.createBox({
        taskId: body.taskId,
        sessionId: body.sessionId,
        boxId: body.boxId,
        leaseEpoch: body.leaseEpoch,
        serverUrl: options.serverUrl,
        baseImage: spec.value.environment.baseImage,
        tokenDir,
        ...(access.kind === "group" ? { tokenGroup: access.gid } : {}),
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
