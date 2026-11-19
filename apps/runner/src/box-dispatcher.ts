import { chmod, chown, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SERVICES_FILE, SERVICES_HEALTHY_WITHIN_MS, servicesFileText, SIDECAR_GID, SIDECAR_UID } from "@ostra/adapter-executor-docker";
import type { BoxService, DockerBoxes, DockerSnapshots } from "@ostra/adapter-executor-docker";
import type { Logger } from "@ostra/adapter-sdk";
import type {
  BoxId,
  CommandOf,
  LeaseEpoch,
  RunnerLabel,
  ServiceSecrets,
  SessionId,
  SnapshotCredentials,
  SnapshotId,
  TaskEvent,
  TaskId,
  TaskSpec,
} from "@ostra/protocol";
import type { CommandHandlers, CommandOutcome, PeerStatus } from "./connection/peer.ts";
import type { LinkResult, ServerLink } from "./task-host/server-link.ts";

// A pool runner on the `docker` executor (ADR 0029): it only creates and removes boxes. On a
// dispatch it makes the box, whose sidecar then connects to the server itself and runs the task;
// when the sidecar exits, the runner removes the box. Commands for a task go to its sidecar.
//
// The sidecar's token is the task token (ADR 0034, Q129, ticket 41): the runner asks core for it
// once, when it makes the box, and writes it to the box's token file, which the sidecar reads when
// it starts and when it reconnects. It names one lease and is valid exactly as long as that lease,
// with no clock, so the runner never rewrites it, and a runner that stops takes nothing from its
// boxes. It still speaks for that task, so only the sidecar may read it: mode 0400 in a 0500
// folder, owned by the sidecar's uid (the runner is root), or, when the runner isn't root and can't
// hand a file to another uid, owned by the runner with its group (0440 in a 0750 folder), which the
// sidecar's container joins as a supplementary group.
//
// Milestone 3 (ticket 14):
// - **Services** (F-094): a spec with services gets their secret variables from the credentials
//   endpoint, asked with the box's task token after the lease check (a boxed lease's credentials
//   answer its task token alone, Q129); only the services' part is kept, for their containers.
//   The runner starts them with the box, polls their health, and writes each one's outcome to
//   `services.json` in the token folder, where the sidecar reads it before the setup and reports
//   `service.healthy` or `service.failed`. A box that can't have its services' secrets isn't made.
// - **A box from a snapshot** (F-051): when the spec names a snapshot image this host keeps (by its
//   label and digest), the agent's container starts from it; otherwise from the base image, and
//   the sidecar falls back to a full setup and says so.
// - **`snapshot-build`**: accepted at once and built one at a time behind the commands, so a build
//   of minutes never holds a dispatch or a stop. Its credentials come from core for this runner
//   only; its result goes up as a `runner-event` frame (`snapshot.built` or `snapshot.failed`). A
//   build core took back (409) reports nothing.

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

export type BoxDispatcherOptions = {
  readonly boxes: DockerBoxes;
  readonly link: Pick<ServerLink, "fetchSpec" | "statusChanged">;
  /** The task token for a box's sidecar: `POST /runner/v1/tasks/:taskId/token`, asked once per box. */
  readonly taskToken: (taskId: TaskId, leaseEpoch: LeaseEpoch) => Promise<LinkResult<string>>;
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
  /**
   * Milestone 3 (F-094): the services' secret variables, asked with the box's task token
   * (`fetchServiceSecrets`). Without it, a spec with services makes no box.
   */
  readonly serviceSecrets?: (taskId: TaskId, leaseEpoch: LeaseEpoch, taskToken: string) => Promise<LinkResult<readonly ServiceSecrets[]>>;
  /** How long the services have to be healthy. Default: 120 s (F-094, working value). */
  readonly servicesWithinMs?: number;
  /** How often their health is polled. Default: 1 s. */
  readonly servicesPollMs?: number;
  /** Milestone 3 (F-051): the snapshots this host builds and keeps. Without them, a build is refused. */
  readonly snapshots?: DockerSnapshots;
  /** A build's credentials, for this runner only (`fetchSnapshotCredentials`). */
  readonly snapshotCredentials?: (snapshotId: SnapshotId) => Promise<LinkResult<SnapshotCredentials>>;
  /** Sends a runner's own event up: the connection's `sendRunnerEvent`. */
  readonly reportRunnerEvent?: (event: TaskEvent) => void;
};

export type BoxDispatcher = {
  readonly handlers: CommandHandlers;
  readonly status: () => PeerStatus;
  /** Every box's lifetime, for tests. */
  readonly boxes: () => readonly Promise<void>[];
  /** Resolves once every snapshot build accepted so far is over, for tests. */
  readonly builds: () => Promise<void>;
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

  /**
   * Writes a file of the token folder (the token, the services' health) with the file's final mode
   * from the first byte, then moves it into place, so the sidecar never reads half of it.
   */
  const writeBoxFile = async (file: string, content: string): Promise<void> => {
    const staging = `${file}.next`;
    await rm(staging, { force: true });
    switch (access.kind) {
      case "owner":
        await writeFile(staging, content, { mode: 0o400, flag: "wx" });
        await handOver(staging, access.uid, access.gid);
        break;
      case "group":
        await writeFile(staging, content, { mode: 0o440, flag: "wx" });
        break;
      case "none":
        throw new Error("no way to restrict the token file");
      default:
        access satisfies never;
    }
    await rename(staging, file);
  };

  /** The spec's services, each with its plain and secret variables, for its own container only. */
  const servicesOf = async (
    spec: TaskSpec,
    taskId: TaskId,
    leaseEpoch: LeaseEpoch,
    taskToken: string,
  ): Promise<{ readonly ok: true; readonly value: readonly BoxService[] } | { readonly ok: false; readonly reason: string }> => {
    const wanted = spec.services ?? [];
    if (wanted.length === 0) {
      return { ok: true, value: [] };
    }
    if (options.serviceSecrets === undefined) {
      return { ok: false, reason: "no-secrets-source" };
    }
    const secrets = await options.serviceSecrets(taskId, leaseEpoch, taskToken);
    if (!secrets.ok) {
      return { ok: false, reason: secrets.failure.kind };
    }
    return {
      ok: true,
      value: wanted.map((service) => {
        const secret = secrets.value.find((each) => each.name === service.name)?.variables ?? [];
        const secretNames = new Set(secret.map((variable) => variable.name));
        return {
          name: service.name,
          image: service.image,
          port: service.port,
          healthCheck: service.healthCheck,
          // A secret of the same name as a plain variable wins: one name, one value in the container.
          variables: [...service.variables.filter((plain) => !secretNames.has(plain.name)), ...secret],
        };
      }),
    };
  };

  /** The snapshot image this host keeps for the spec, by its label and digest; `null` for a full setup. */
  const snapshotImageOf = async (spec: TaskSpec): Promise<string | null> => {
    const wanted = spec.snapshot ?? null;
    if (wanted?.kind !== "image" || options.snapshots === undefined) {
      return null;
    }
    const kept = await options.snapshots.hasSnapshot(wanted.snapshotId);
    if (!kept.ok || kept.value?.imageDigest !== wanted.digest) {
      log.info("the spec's snapshot isn't on this host: the box sets up in full", { snapshotId: wanted.snapshotId, found: kept.ok && kept.value !== null });
      return null;
    }
    // By its ID: the image the scan passed, whatever its tag names since.
    return kept.value.imageDigest;
  };

  // ---------- snapshot builds (F-051) ----------

  const building = new Set<SnapshotId>();
  let buildChain: Promise<void> = Promise.resolve();

  const report = (event: TaskEvent): void => {
    options.reportRunnerEvent?.(event);
  };

  const buildSnapshot = async (body: CommandOf<"snapshot-build">["body"], snapshots: DockerSnapshots): Promise<void> => {
    const buildLog = log.child({ snapshotId: body.snapshotId, projectId: body.projectId });
    const credentials = await options.snapshotCredentials?.(body.snapshotId);
    if (credentials === undefined) {
      return;
    }
    if (!credentials.ok) {
      buildLog.warn("no credentials for the snapshot build", { reason: credentials.failure.kind });
      // A 409: core took the build back or gave it to another runner, so there's nothing to report.
      if (credentials.failure.kind !== "stale-lease") {
        report({ kind: "snapshot.failed", snapshotId: body.snapshotId, reason: "build-failed", detail: "The runner couldn't read the build's credentials from the server." });
      }
      return;
    }
    // The build's output is the setup script's: never logged, and not sent up (only its result is).
    const built = await snapshots.buildSnapshot({
      snapshotId: body.snapshotId,
      projectId: body.projectId,
      environment: body.environment,
      credentials: credentials.value,
      onOutput: () => undefined,
    });
    if (!built.ok) {
      buildLog.warn("the snapshot build failed", { code: built.error.code });
      report({ kind: "snapshot.failed", snapshotId: body.snapshotId, reason: "build-failed", detail: built.error.message.slice(0, 2000) });
      return;
    }
    const result = built.value;
    switch (result.outcome) {
      case "built":
        buildLog.info("snapshot built", { durationMs: result.durationMs });
        report({ kind: "snapshot.built", snapshotId: body.snapshotId, imageDigest: result.imageDigest, durationMs: result.durationMs });
        return;
      case "failed":
        buildLog.info("snapshot build failed", { reason: result.reason });
        report({ kind: "snapshot.failed", snapshotId: body.snapshotId, reason: result.reason, detail: result.detail });
        return;
      default:
        result satisfies never;
    }
  };

  const runBox = async (body: Parameters<CommandHandlers["dispatch"]>[0]["body"]): Promise<void> => {
    const boxLog = log.child({ taskId: body.taskId, boxId: body.boxId, leaseEpoch: body.leaseEpoch });
    const tokenDir = path.join(options.dataDir, "boxes", body.boxId);
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
      // The task token, once: it lasts as long as the lease, and is never renewed.
      const token = await options.taskToken(body.taskId, body.leaseEpoch);
      if (!token.ok) {
        boxLog.warn("no task token for the box's sidecar: no box", { reason: token.failure.kind });
        return;
      }
      // The services' secrets before anything is made (F-094): a box can't start them without.
      const services = await servicesOf(spec.value, body.taskId, body.leaseEpoch, token.value);
      if (!services.ok) {
        boxLog.warn("no secrets for the box's services: no box", { reason: services.reason });
        return;
      }
      const snapshotImage = await snapshotImageOf(spec.value);
      await makeTokenDir(tokenDir);
      await writeBoxFile(path.join(tokenDir, "token"), token.value);
      const created = await options.boxes.createBox({
        taskId: body.taskId,
        sessionId: body.sessionId,
        boxId: body.boxId,
        leaseEpoch: body.leaseEpoch,
        serverUrl: options.serverUrl,
        baseImage: spec.value.environment.baseImage,
        tokenDir,
        ...(access.kind === "group" ? { tokenGroup: access.gid } : {}),
        ...(snapshotImage === null ? {} : { snapshotImage }),
        ...(services.value.length === 0 ? {} : { services: services.value }),
      });
      if (!created.ok) {
        boxLog.error("creating the box failed", { status: created.error.status });
        return;
      }
      boxLog.info("box created", { services: services.value.length, fromSnapshot: snapshotImage !== null });
      if (services.value.length > 0) {
        // While the sidecar clones: it waits for this report before the setup script.
        const health = await options.boxes.waitForServices(body.boxId, services.value, {
          timeoutMs: options.servicesWithinMs ?? SERVICES_HEALTHY_WITHIN_MS,
          ...(options.servicesPollMs === undefined ? {} : { pollMs: options.servicesPollMs }),
        });
        await writeBoxFile(path.join(tokenDir, SERVICES_FILE), servicesFileText(health));
        boxLog.info("the box's services reported", {
          healthy: health.filter((service) => service.outcome === "healthy").length,
          failed: health.filter((service) => service.outcome === "failed").length,
        });
      }
      const exitCode = await options.boxes.waitForSidecar(body.boxId);
      boxLog.info("the box's sidecar exited", { exitCode });
    } finally {
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
    // A box's task is its sidecar's: core's outbox sends these to the box's own connection (Q129),
    // where the sidecar's task host answers them as `host` does. One that reaches the runner was
    // misrouted, and is refused so core sees it.
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
    // Protocol minor 1. A box is removed when its sidecar exits, so a box not running here is already
    // gone. Ticket 23 keeps stopped boxes and releases them here.
    release: (command) => {
      const held = running.has(command.body.boxId);
      log.info("release asked", { taskId: command.body.taskId, boxId: command.body.boxId, reason: command.body.reason, held });
      return done(held ? { result: "rejected", reason: "box-busy" } : { result: "done", reason: "not-held" });
    },
    // Protocol minor 2. A box's answers go to its sidecar, as above.
    "question-answer": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "plan-answer": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    // Ticket 14 (F-051): accepted at once, built in turn behind the others, its result a runner event.
    "snapshot-build": (command) => {
      const snapshots = options.snapshots;
      if (snapshots === undefined || options.snapshotCredentials === undefined || options.reportRunnerEvent === undefined) {
        return done({ result: "rejected", reason: "not-supported" });
      }
      const { snapshotId } = command.body;
      if (building.has(snapshotId)) {
        return done({ result: "accepted" });
      }
      if (draining) {
        return done({ result: "rejected", reason: "draining" });
      }
      building.add(snapshotId);
      buildChain = buildChain
        .then(() => buildSnapshot(command.body, snapshots))
        .catch((error: unknown) => {
          log.error("a snapshot build failed", { snapshotId, error: error instanceof Error ? error.name : "unknown" });
          report({ kind: "snapshot.failed", snapshotId, reason: "build-failed", detail: "The runner's build stopped on an unexpected error." });
        })
        .finally(() => {
          building.delete(snapshotId);
        });
      return done({ result: "accepted" });
    },
  };

  return {
    handlers,
    status: () => ({
      executor: "docker",
      processContainment: "container",
      capacity: options.capacity,
      freeSlots: draining ? 0 : Math.max(0, options.capacity - running.size),
      labels: options.labels,
      running: [...running.values()].map((item) => item.sessionId),
    }),
    boxes: () => [...running.values()].map((item) => item.done),
    builds: () => buildChain,
  };
};
