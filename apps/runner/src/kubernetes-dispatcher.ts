import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOX_ROLE, boxNames, boxSelector, LABELS } from "@ostra/adapter-executor-kubernetes";
import type { BoxWaitFailure, KubeApi, KubernetesExecutor, PodView } from "@ostra/adapter-executor-kubernetes";
import type { BoxImage, BoxWaitChange, Logger, TaskProxies } from "@ostra/adapter-sdk";
import { boxIdSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { BoxId, BoxReleaseReason, BoxUnscheduledReason, CommandOf, LeaseEpoch, RegistryCredential, RunnerLabel, RunnerScopedEvent, SnapshotCredentials, SnapshotId, TaskId } from "@ostra/protocol";
import { z } from "zod";
import type { CommandHandlers, CommandOutcome, PeerStatus } from "./connection/peer.ts";
import { reportedCapabilities } from "./reports.ts";
import type { LinkResult, ServerLink } from "./task-host/server-link.ts";

// A pool runner on the `kubernetes` executor (milestone 5, ticket 20, ADR 0060, ADR 0029). Like
// `docker`'s, it only makes and removes boxes; each box is one pod, whose sidecar connects to the
// server itself on the task token and runs the task.
//
// - **The offer** is accepted at once (ADR 0029): an autoscaling cluster may take minutes to add a
//   node, and the offer times out in two. Then the task token is fetched with the lease's epoch, and
//   the executor's `create` makes the box's secret (the token, the bridge's nonce), its pull secret
//   when its image has a credential, and the pod. While the pod waits for a node or for its image,
//   `onWaiting` becomes `box.waiting`, and its placement `box.scheduled`: runner events, which core
//   records on the box's row and the task's timeline.
// - **A restart** of the runner leaves its pods and their sidecars running: each box the runner
//   made is a file of its own (`<dataDir>/kubernetes-boxes/<boxId>.json`, IDs only, never the token),
//   and at start it lists the namespace's box pods by label and adopts the ones it made.
// - **Release:** when the pod's sidecar ends (the task is over), or on `release`, the executor deletes
//   the pod and its secrets, and the runner lists what's left by the box's label and logs the count.
// - **A lost box** (F-047): a pod deleted or failed under its task, or whose sidecar ended with an
//   error (the kubelet restarting it counts), none of it by a `release`, goes up as a `box.lost`
//   runner event, and core records the session crashed. So does one found so at the start, after
//   the runner was away, and a box that never ran: its create failed, its image wouldn't pull, its
//   sidecar ended or crash-looped before it was ready, or wasn't ready within the box's start time
//   (amended 2026-11-22, as `docker`'s runner reports a box that doesn't start).
// - **A box the cluster never placed** (ADR 0060, amended 2026-11-22): no node joined within the
//   node wait, its pod stayed unschedulable with no scale-up under way, or the namespace's quota
//   refused it. That isn't a lost box: the runner reported room it didn't have. It holds its room
//   first (its status offers no slot), then says `box.unscheduled`, and core sends the task back to
//   its pool's queue with its place. The hold ends when one of its boxes ends (room freed), or after
//   `ROOM_HOLD_FIRST_MS`, doubled at each hold in a row up to `ROOM_HOLD_MAX_MS` until a box is
//   placed again: core offers it nothing meanwhile, so a full cluster isn't asked again and again.

/** What the runner keeps of a box it made: IDs only. Never the task token or a credential. */
const boxRecordSchema = z.strictObject({
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  boxId: boxIdSchema,
  leaseEpoch: leaseEpochSchema,
});
type BoxRecord = z.infer<typeof boxRecordSchema>;

/**
 * The proxies `create` takes are the sidecar's, inside the pod: a pool runner's executor makes the
 * pod and passes no proxy of its own (`KubernetesExecutor` without `inBox`), so these are unused.
 */
const IN_POD_PROXIES: TaskProxies = { gitBaseUrl: "http://127.0.0.1", modelBaseUrl: "http://127.0.0.1", mcpUrl: "http://127.0.0.1" };

/** How often the runner looks at a box's pod while its task runs. */
const WATCH_MS = 2_000;

/** How long the runner first offers no room after a box the cluster never placed *(working value)*. */
export const ROOM_HOLD_FIRST_MS = 60_000;
/** The longest hold, after holds in a row: the node wait's default *(working value)*. */
export const ROOM_HOLD_MAX_MS = 15 * 60_000;

export type KubernetesDispatcherOptions = {
  readonly executor: KubernetesExecutor;
  /** The cluster, for the runner's own reads: its pods by label at start, and what's left after a release. */
  readonly kube: KubeApi;
  readonly namespace: string;
  readonly link: Pick<ServerLink, "fetchSpec" | "statusChanged">;
  /** The task token for a box's sidecar: `POST /runner/v1/tasks/:taskId/token`, asked once per box. */
  readonly taskToken: (taskId: TaskId, leaseEpoch: LeaseEpoch) => Promise<LinkResult<string>>;
  /** Milestone 5 (F-120, ticket 21): the pull credential for the lease's registry image. */
  readonly pullCredential?: (taskId: TaskId, leaseEpoch: LeaseEpoch) => Promise<LinkResult<RegistryCredential | null>>;
  /** Milestone 5 (F-120, ticket 21): a snapshot build's credentials, for this runner only (`fetchSnapshotCredentials`). */
  readonly snapshotCredentials?: (snapshotId: SnapshotId) => Promise<LinkResult<SnapshotCredentials>>;
  /** Milestone 5 (F-120, ticket 21): the push credential for a build (`fetchPushCredential`). */
  readonly pushCredential?: (snapshotId: SnapshotId) => Promise<LinkResult<RegistryCredential>>;
  /** Holds `kubernetes-boxes/`, the boxes this runner made. */
  readonly dataDir: string;
  readonly labels: readonly RunnerLabel[];
  readonly logger: Logger;
  /** Sends a runner's own event up: the connection's `sendRunnerEvent`. */
  readonly reportRunnerEvent: (event: RunnerScopedEvent) => void;
  readonly watchMs?: number;
  /** The first hold after a box never placed; `ROOM_HOLD_FIRST_MS` by default. Tests shorten it. */
  readonly roomHoldMs?: number;
  /** The longest hold; `ROOM_HOLD_MAX_MS` by default. */
  readonly roomHoldMaxMs?: number;
};

export type KubernetesDispatcher = {
  readonly handlers: CommandHandlers;
  readonly status: () => PeerStatus;
  /** At start: the box pods this runner made and left running, adopted. Answers how many. */
  readonly adopt: () => Promise<number>;
  /** Every box's lifetime, for tests. */
  readonly boxes: () => readonly Promise<void>[];
  /** Resolves once every snapshot build accepted so far is over, for tests. */
  readonly builds: () => Promise<void>;
  /** The runner stops: its boxes' pods stay, for the next start to adopt. */
  readonly detach: () => void;
};

/**
 * A box this runner holds: its IDs, its lifetime, the `release` that ends it early, and whether
 * the cluster never placed it (`unplaced`), which frees no room when it goes.
 */
type Running = { readonly record: BoxRecord; done: Promise<void>; release: BoxReleaseReason | null; released: boolean; unplaced: boolean };

/**
 * How the pod's sidecar ended, when it did: it's terminated, or the kubelet started it again (a
 * native sidecar always is), its last run's end then being the one. `null` while it runs.
 */
const sidecarEnd = (pod: PodView | null): { readonly exitCode: number | null } | null => {
  const sidecar = pod?.initContainers.find((container) => container.name === "sidecar");
  if (sidecar === undefined) {
    return null;
  }
  if (sidecar.state === "terminated") {
    return { exitCode: sidecar.exitCode };
  }
  return sidecar.restarts > 0 ? { exitCode: sidecar.lastExitCode } : null;
};

/** Whether a box's task is over, by its pod: gone, deleting, ended, or its sidecar ended. */
const podIsOver = (pod: PodView | null): boolean => {
  if (pod === null || pod.deleting || pod.phase === "Succeeded" || pod.phase === "Failed") {
    return true;
  }
  return sidecarEnd(pod) !== null;
};

/**
 * Whether a pod that's over took its task with it (F-047), and the sidecar's exit code: its
 * sidecar ended its own task with 0; any other end (an error, a kill), a pod deleted or failed
 * by someone else (a lost node, an eviction) or gone, is a lost box. Read only for a pod that no
 * `release` ended.
 */
const podLoss = (pod: PodView | null): { readonly lost: boolean; readonly exitCode: number | null } => {
  const end = sidecarEnd(pod);
  if (end !== null) {
    return { lost: end.exitCode !== 0, exitCode: end.exitCode };
  }
  if (pod === null || pod.deleting || pod.phase === "Failed") {
    return { lost: true, exitCode: null };
  }
  return { lost: false, exitCode: null };
};

export const createKubernetesDispatcher = (options: KubernetesDispatcherOptions): KubernetesDispatcher => {
  const running = new Map<BoxId, Running>();
  let draining = false;
  let detached = false;
  /** Read through a call: the runner may detach while a box is watched. */
  const isDetached = (): boolean => detached;
  const log = options.logger.child({ component: "kubernetes-dispatcher" });
  const recordsDir = path.join(options.dataDir, "kubernetes-boxes");
  const recordFile = (boxId: BoxId): string => path.join(recordsDir, `${encodeURIComponent(boxId)}.json`);
  const watchMs = options.watchMs ?? WATCH_MS;
  const capabilities = reportedCapabilities(options.executor.capabilities);
  const done = (outcome: CommandOutcome): Promise<CommandOutcome> => Promise.resolve(outcome);

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const writeRecord = async (record: BoxRecord): Promise<void> => {
    await mkdir(recordsDir, { recursive: true, mode: 0o700 });
    await writeFile(recordFile(record.boxId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };

  const reportWait = (boxId: BoxId, change: BoxWaitChange): void => {
    options.reportRunnerEvent(
      change.kind === "waiting"
        ? { kind: "box.waiting", boxId, reason: change.reason, since: change.since.getTime() }
        : { kind: "box.scheduled", boxId, afterMs: Math.max(0, Math.round(change.afterMs)) },
    );
  };

  /** Deletes the box's pod and secrets, then checks by label that nothing of it is left. */
  const releaseBox = async (record: BoxRecord, reason: BoxReleaseReason): Promise<boolean> => {
    const box = { taskId: record.taskId, boxId: record.boxId };
    const boxLog = log.child({ taskId: record.taskId, boxId: record.boxId });
    const released = await options.executor.release(box, reason);
    if (!released.ok) {
      boxLog.warn("releasing the box failed", { code: released.error.code });
    }
    const pods = await options.kube.listPods(options.namespace, boxSelector(box));
    const secrets = await options.kube.listSecretNames(options.namespace, boxSelector(box));
    const left = (pods.ok ? pods.value.length : 0) + (secrets.ok ? secrets.value.length : 0);
    boxLog.info("box released", { reason, left, checked: pods.ok && secrets.ok });
    if (left === 0 && pods.ok && secrets.ok) {
      await rm(recordFile(record.boxId), { force: true });
      return true;
    }
    return false;
  };

  /** A pod that went away under its task, with no `release` asked: core hears it as `box.lost` (F-047). */
  const reportIfLost = (entry: Running, pod: PodView | null): void => {
    if (entry.release !== null) {
      return;
    }
    const loss = podLoss(pod);
    if (loss.lost) {
      log.warn("the box went away under its task", { taskId: entry.record.taskId, boxId: entry.record.boxId, exitCode: loss.exitCode, phase: pod?.phase ?? "gone" });
      options.reportRunnerEvent({ kind: "box.lost", boxId: entry.record.boxId, exitCode: loss.exitCode });
    }
  };

  /**
   * A box that never ran, its task still on it, unless a `release` ended it: core hears it as
   * `box.lost` (F-047), as `docker`'s runner reports a box whose create fails or whose sidecar exits
   * before it connects (ADR 0029's parity), and records the session crashed. A box with no node
   * (`no-node`, `no-room`) isn't: ADR 0060 sends its task back to the queue, not to a crash.
   */
  const reportNeverRan = (entry: Running, failure: BoxWaitFailure | null, exitCode: number | null): void => {
    if (entry.release !== null || isDetached() || failure === "no-node" || failure === "no-room") {
      return;
    }
    log.warn("the box never ran: reported lost", { taskId: entry.record.taskId, boxId: entry.record.boxId, failure: failure ?? "pod", exitCode });
    options.reportRunnerEvent({ kind: "box.lost", boxId: entry.record.boxId, exitCode });
  };

  // ---------- the room hold (ADR 0060) ----------

  const firstHoldMs = options.roomHoldMs ?? ROOM_HOLD_FIRST_MS;
  const maxHoldMs = Math.max(firstHoldMs, options.roomHoldMaxMs ?? ROOM_HOLD_MAX_MS);
  /** While the runner offers no room: the timer that ends the hold. */
  let roomHold: NodeJS.Timeout | null = null;
  /** The next hold's length: doubled by each hold, back to the first once a box is placed. */
  let nextHoldMs = firstHoldMs;

  const liftHold = (why: "time" | "a box ended"): void => {
    if (roomHold === null) {
      return;
    }
    clearTimeout(roomHold);
    roomHold = null;
    log.info("the runner offers its room again", { why });
    options.link.statusChanged();
  };

  /**
   * The runner offers no room until the hold ends: its status says so at once, before the box's
   * `box.unscheduled`, so core reads it first and offers nothing more. A hold already on stays as
   * it is: the boxes that find no room meanwhile are the same shortage.
   */
  const holdRoom = (): void => {
    if (roomHold !== null) {
      return;
    }
    const forMs = nextHoldMs;
    nextHoldMs = Math.min(nextHoldMs * 2, maxHoldMs);
    roomHold = setTimeout(() => {
      liftHold("time");
    }, forMs);
    roomHold.unref();
    log.info("the runner holds its room: the cluster had none", { forMs });
    options.link.statusChanged();
  };

  /** A box the cluster never placed (ADR 0060): core sends its task back to the queue, unless a `release` ended it. */
  const reportUnscheduled = (entry: Running, reason: BoxUnscheduledReason): void => {
    entry.unplaced = true;
    if (entry.release !== null || isDetached()) {
      return;
    }
    holdRoom();
    log.warn("the cluster never placed the box: its task goes back to the queue", { taskId: entry.record.taskId, boxId: entry.record.boxId, reason });
    options.reportRunnerEvent({ kind: "box.unscheduled", boxId: entry.record.boxId, reason });
  };

  /** Watches the box's pod until its task is over (or the runner detaches), then releases it. */
  const watch = async (entry: Running): Promise<void> => {
    const names = boxNames(entry.record);
    let over: { readonly pod: PodView | null } | null = null;
    for (;;) {
      if (isDetached()) {
        return;
      }
      if (entry.release !== null) {
        break;
      }
      const read = await options.kube.readPod(options.namespace, names.pod);
      if (read.ok && podIsOver(read.value)) {
        over = { pod: read.value };
        break;
      }
      await sleep(watchMs);
    }
    if (!isDetached() && !entry.released) {
      entry.released = true;
      if (over !== null) {
        reportIfLost(entry, over.pod);
      }
      await releaseBox(entry.record, entry.release ?? "requested");
    }
  };

  /** Releases a box once, whichever of its task's end, its failure or a `release` comes first. */
  const releaseOnce = async (entry: Running, reason: BoxReleaseReason): Promise<boolean> => {
    if (entry.released) {
      return true;
    }
    entry.released = true;
    return releaseBox(entry.record, reason);
  };

  /** The registry image a dispatch names, with its pull credential for this lease (ticket 21). */
  const imageOf = async (body: CommandOf<"dispatch">["body"]): Promise<{ readonly ok: true; readonly value: BoxImage | null } | { readonly ok: false; readonly reason: string }> => {
    const wanted = body.box?.image ?? null;
    if (wanted === null) {
      return { ok: true, value: null };
    }
    if (options.pullCredential === undefined) {
      return { ok: false, reason: "no-pull-credential-source" };
    }
    const credential = await options.pullCredential(body.taskId, body.leaseEpoch);
    if (!credential.ok) {
      return { ok: false, reason: credential.failure.kind };
    }
    // Into the box's pull secret only: never kept, never logged. `null`: the registry is pulled
    // with the cluster's own identity (`node` auth), so the pod has no pull secret (ADR 0060).
    const pull = credential.value === null ? null : { username: credential.value.username, token: credential.value.token };
    return { ok: true, value: { ref: wanted.ref, digest: wanted.digest, pull } };
  };

  const runBox = async (entry: Running, body: CommandOf<"dispatch">["body"]): Promise<void> => {
    const record = entry.record;
    const box = { taskId: record.taskId, boxId: record.boxId };
    const boxLog = log.child({ taskId: record.taskId, boxId: record.boxId, leaseEpoch: record.leaseEpoch });
    const spec = await options.link.fetchSpec(body.taskId, body.leaseEpoch);
    if (!spec.ok) {
      boxLog.warn("couldn't read the task's spec: no box", { reason: spec.failure.kind });
      return;
    }
    // The task token, once: it lasts as long as the lease, and goes into the box's secret only.
    const token = await options.taskToken(body.taskId, body.leaseEpoch);
    if (!token.ok) {
      boxLog.warn("no task token for the box's sidecar: no box", { reason: token.failure.kind });
      return;
    }
    const image = await imageOf(body);
    if (!image.ok) {
      boxLog.warn("no pull credential for the box's image: no box", { reason: image.reason });
      return;
    }
    await writeRecord(record);
    const size = body.box?.size ?? null;
    const created = await options.executor.create({
      ...box,
      spec: spec.value,
      proxies: IN_POD_PROXIES,
      size: size === null ? null : { cpuMillis: size.cpuMillis, memoryMiB: size.memoryMiB },
      image: image.value,
      taskToken: token.value,
      // Milestone 8 (Q300): "Start the app", which the pod's sidecar starts itself.
      ...(body.purpose === undefined ? {} : { purpose: body.purpose }),
      onWaiting: (change) => {
        reportWait(record.boxId, change);
      },
    });
    if (!created.ok) {
      boxLog.error("creating the box failed", { code: created.error.code });
      // The namespace's quota refused the pod: no room, so back to the queue (ADR 0060). A box ID in
      // use is another start's box, left as it is.
      const failure = options.executor.failureOf(box);
      if (failure === "no-room") {
        reportUnscheduled(entry, failure);
      } else if (created.error.code !== "conflict") {
        reportNeverRan(entry, null, null);
      }
      await releaseOnce(entry, "requested");
      return;
    }
    boxLog.info("box pod created", { sized: size !== null, fromRegistry: image.value !== null });
    // Until the sidecar is ready: the node wait and the image's pull happen here, and a sidecar that
    // ends or isn't ready within the box's start time fails it.
    const prepared = await options.executor.prepare({ box, spec: spec.value, secrets: [], onSetupOutput: () => undefined });
    if (!prepared.ok) {
      const failure = options.executor.failureOf(box);
      boxLog.warn("the box never ran", { code: prepared.error.code, failure: failure ?? "pod" });
      if (failure === "no-node" || failure === "no-room") {
        reportUnscheduled(entry, failure);
      } else {
        reportNeverRan(entry, failure, options.executor.sidecarExitCodeOf(box));
      }
      await releaseOnce(entry, entry.release ?? "requested");
      return;
    }
    // Placed: the cluster has room again, so the next hold starts short.
    nextHoldMs = firstHoldMs;
    boxLog.info("the box's sidecar is ready");
    await watch(entry);
  };

  const track = (entry: Running, life: Promise<void>): void => {
    const lifetime = life
      .catch((error: unknown) => {
        log.error("a box failed", { boxId: entry.record.boxId, error: error instanceof Error ? error.name : "unknown" });
      })
      .finally(() => {
        running.delete(entry.record.boxId);
        // A box that held a place frees room as it goes: the runner offers it again.
        if (!entry.unplaced) {
          liftHold("a box ended");
        }
        options.link.statusChanged();
      });
    entry.done = lifetime;
    running.set(entry.record.boxId, entry);
    options.link.statusChanged();
  };

  const slots = (): number => options.executor.capacity().slots;

  // ---------- snapshot builds (F-120, ticket 21) ----------

  const building = new Set<SnapshotId>();
  let buildChain: Promise<void> = Promise.resolve();

  /**
   * A build on the cluster: rootless BuildKit in the build namespace, the scan, then the push with
   * the push credential fetched for this build (the executor's `buildSnapshot`, ticket 08). A
   * `kubernetes` runner keeps nothing itself, so it builds only with a registry to push to.
   */
  const buildOnCluster = async (body: CommandOf<"snapshot-build">["body"], push: { readonly ref: string }): Promise<void> => {
    const buildLog = log.child({ snapshotId: body.snapshotId, projectId: body.projectId });
    const failed = (detail: string): void => {
      options.reportRunnerEvent({ kind: "snapshot.failed", snapshotId: body.snapshotId, reason: "build-failed", detail });
    };
    const credentials = await options.snapshotCredentials?.(body.snapshotId);
    const pushCredential = credentials?.ok === true ? await options.pushCredential?.(body.snapshotId) : undefined;
    if (credentials?.ok !== true || pushCredential?.ok !== true) {
      const takenBack = (credentials?.ok === false && credentials.failure.kind === "stale-lease") || (pushCredential?.ok === false && pushCredential.failure.kind === "stale-lease");
      buildLog.warn("no credentials for the snapshot build", { takenBack });
      // A 409: core took the build back or gave it to another runner, so there's nothing to report.
      if (!takenBack) {
        failed("The runner couldn't read the build's credentials from the server.");
      }
      return;
    }
    const built = await options.executor.buildSnapshot({
      snapshotId: body.snapshotId,
      projectId: body.projectId,
      environment: body.environment,
      credentials: credentials.value,
      push: { ref: push.ref, credential: { username: pushCredential.value.username, token: pushCredential.value.token } },
      onOutput: () => undefined,
    });
    if (!built.ok) {
      buildLog.warn("the snapshot build failed", { code: built.error.code });
      failed(built.error.message.slice(0, 2000));
      return;
    }
    const result = built.value;
    switch (result.outcome) {
      case "built":
        buildLog.info("snapshot built and pushed", { durationMs: result.durationMs });
        options.reportRunnerEvent({ kind: "snapshot.built", snapshotId: body.snapshotId, imageDigest: result.digest ?? result.imageDigest, durationMs: result.durationMs });
        return;
      case "failed":
        buildLog.info("snapshot build failed", { reason: result.reason });
        options.reportRunnerEvent({ kind: "snapshot.failed", snapshotId: body.snapshotId, reason: result.reason, detail: result.detail });
        return;
      default:
        result satisfies never;
    }
  };

  const handlers: CommandHandlers = {
    // Accepted at once: the box is made after the answer (ADR 0029).
    dispatch: (command) => {
      const body = command.body;
      if (running.has(body.boxId)) {
        return done({ result: "accepted" });
      }
      if (draining) {
        return done({ result: "rejected", reason: "draining" });
      }
      // During a hold too: an offer core sent before it read the runner's status without room.
      if (running.size >= slots() || roomHold !== null) {
        return done({ result: "rejected", reason: "no-capacity" });
      }
      const entry: Running = { record: { taskId: body.taskId, sessionId: body.sessionId, boxId: body.boxId, leaseEpoch: body.leaseEpoch }, done: Promise.resolve(), release: null, released: false, unplaced: false };
      track(entry, runBox(entry, body));
      return done({ result: "accepted" });
    },
    // A box's task is its sidecar's: core sends these to the box's own connection (Q129).
    stop: () => done({ result: "done", reason: "the box's sidecar stops it" }),
    interrupt: () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    steer: () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "approval-answer": () => done({ result: "rejected", reason: "no-pending-approval" }),
    drain: () => {
      draining = true;
      options.link.statusChanged();
      return done({ result: "done" });
    },
    resume: () => {
      draining = false;
      options.link.statusChanged();
      return done({ result: "done" });
    },
    "update-hint": (command) => {
      log.info("a newer runner is available", { version: command.body.version });
      return done({ result: "done" });
    },
    // The pod and its secrets go now: a pod is never kept stopped (ADR 0039).
    release: async (command) => {
      const held = running.get(command.body.boxId);
      if (held !== undefined) {
        // At once, whatever the box is doing: a pod waiting for a node stops waiting.
        held.release = command.body.reason;
        const released = await releaseOnce(held, command.body.reason);
        await held.done;
        return released ? { result: "done" } : { result: "rejected", reason: "release-failed" };
      }
      const released = await releaseBox({ taskId: command.body.taskId, boxId: command.body.boxId, sessionId: sessionIdSchema.parse("released"), leaseEpoch: leaseEpochSchema.parse(1) }, command.body.reason);
      return released ? { result: "done", reason: "not-held" } : { result: "rejected", reason: "release-failed" };
    },
    "question-answer": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "plan-answer": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "set-effort": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    // Protocol minor 7 (milestone 8): a box's app and views are its sidecar's, as above.
    "app.start": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "app.stop": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "screenshot.take": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "preview.open": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "preview.close": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    "preview.input": () => done({ result: "rejected", reason: "the box's sidecar takes it" }),
    // Ticket 21 (F-120): accepted at once, built in turn with BuildKit, and pushed to the registry.
    "snapshot-build": (command) => {
      const push = command.body.push ?? null;
      if (push === null || options.snapshotCredentials === undefined || options.pushCredential === undefined) {
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
        .then(() => buildOnCluster(command.body, push))
        .catch((error: unknown) => {
          log.error("a snapshot build failed", { snapshotId, error: error instanceof Error ? error.name : "unknown" });
          options.reportRunnerEvent({ kind: "snapshot.failed", snapshotId, reason: "build-failed", detail: "The runner's build stopped on an unexpected error." });
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
      executor: "kubernetes",
      processContainment: "container",
      capacity: slots(),
      freeSlots: draining || roomHold !== null ? 0 : Math.max(0, slots() - running.size),
      labels: options.labels,
      running: [...running.values()].map((entry) => entry.record.sessionId),
      // During a hold the offer has no slot, which core reads as no room. Its CPU and memory stay,
      // so the box's size still fits the runner, and the task waits its turn (ADR 0059).
      resources: roomHold === null ? options.executor.capacity() : { ...options.executor.capacity(), slots: 0 },
      capabilities,
    }),
    adopt: async () => {
      let names: readonly string[];
      try {
        names = (await readdir(recordsDir)).filter((name) => name.endsWith(".json"));
      } catch {
        return 0;
      }
      const pods = await options.kube.listPods(options.namespace, `${LABELS.role}=${BOX_ROLE}`);
      if (!pods.ok) {
        log.warn("couldn't list the namespace's box pods: nothing adopted", { status: pods.status });
        return 0;
      }
      const live = new Map(pods.value.map((pod) => [pod.name, pod]));
      let adopted = 0;
      for (const name of names) {
        let record: BoxRecord;
        try {
          record = boxRecordSchema.parse(JSON.parse(await readFile(path.join(recordsDir, name), "utf8")));
        } catch {
          log.warn("a box record is damaged: skipped", { file: name });
          continue;
        }
        if (running.has(record.boxId)) {
          continue;
        }
        const pod = live.get(boxNames(record).pod) ?? null;
        const entry: Running = { record, done: Promise.resolve(), release: null, released: false, unplaced: false };
        // A pod whose task ended while the runner was away is released now, and core hears of one
        // lost meanwhile (F-047); a running one is watched.
        if (podIsOver(pod)) {
          reportIfLost(entry, pod);
        }
        track(entry, podIsOver(pod) ? releaseOnce(entry, "requested").then(() => undefined) : watch(entry));
        if (!podIsOver(pod)) {
          adopted += 1;
        }
      }
      log.info("adopted the box pods this runner made", { adopted, records: names.length });
      return adopted;
    },
    boxes: () => [...running.values()].map((entry) => entry.done),
    builds: () => buildChain,
    detach: () => {
      detached = true;
      if (roomHold !== null) {
        clearTimeout(roomHold);
        roomHold = null;
      }
    },
  };
};
