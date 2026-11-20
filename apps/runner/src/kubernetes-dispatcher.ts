import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOX_ROLE, boxNames, boxSelector, LABELS } from "@ostra/adapter-executor-kubernetes";
import type { KubeApi, KubernetesExecutor, PodView } from "@ostra/adapter-executor-kubernetes";
import type { BoxImage, BoxWaitChange, Logger, TaskProxies } from "@ostra/adapter-sdk";
import { boxIdSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { BoxId, BoxReleaseReason, CommandOf, LeaseEpoch, RegistryCredential, RunnerLabel, TaskEvent, TaskId } from "@ostra/protocol";
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
  /** Holds `kubernetes-boxes/`, the boxes this runner made. */
  readonly dataDir: string;
  readonly labels: readonly RunnerLabel[];
  readonly logger: Logger;
  /** Sends a runner's own event up: the connection's `sendRunnerEvent`. */
  readonly reportRunnerEvent: (event: TaskEvent) => void;
  readonly watchMs?: number;
};

export type KubernetesDispatcher = {
  readonly handlers: CommandHandlers;
  readonly status: () => PeerStatus;
  /** At start: the box pods this runner made and left running, adopted. Answers how many. */
  readonly adopt: () => Promise<number>;
  /** Every box's lifetime, for tests. */
  readonly boxes: () => readonly Promise<void>[];
  /** The runner stops: its boxes' pods stay, for the next start to adopt. */
  readonly detach: () => void;
};

/** A box this runner holds: its IDs, its lifetime, and the `release` that ends it early. */
type Running = { readonly record: BoxRecord; done: Promise<void>; release: BoxReleaseReason | null; released: boolean };

/** Whether a box's task is over, by its pod: gone, deleting, ended, or its sidecar ended. */
const podIsOver = (pod: PodView | null): boolean => {
  if (pod === null || pod.deleting || pod.phase === "Succeeded" || pod.phase === "Failed") {
    return true;
  }
  return pod.initContainers.some((container) => container.name === "sidecar" && container.state === "terminated");
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

  /** Watches the box's pod until its task is over (or the runner detaches), then releases it. */
  const watch = async (entry: Running): Promise<void> => {
    const names = boxNames(entry.record);
    for (;;) {
      if (isDetached()) {
        return;
      }
      if (entry.release !== null) {
        break;
      }
      const read = await options.kube.readPod(options.namespace, names.pod);
      if (read.ok && podIsOver(read.value)) {
        break;
      }
      await sleep(watchMs);
    }
    if (!isDetached() && !entry.released) {
      entry.released = true;
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
      onWaiting: (change) => {
        reportWait(record.boxId, change);
      },
    });
    if (!created.ok) {
      boxLog.error("creating the box failed", { code: created.error.code });
      await releaseOnce(entry, "requested");
      return;
    }
    boxLog.info("box pod created", { sized: size !== null, fromRegistry: image.value !== null });
    // Until the sidecar is ready: the node wait and the image's pull happen here.
    const prepared = await options.executor.prepare({ box, spec: spec.value, secrets: [], onSetupOutput: () => undefined });
    if (!prepared.ok) {
      boxLog.warn("the box never ran", { code: prepared.error.code, failure: options.executor.failureOf(box) ?? "pod" });
      await releaseOnce(entry, entry.release ?? "requested");
      return;
    }
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
        options.link.statusChanged();
      });
    entry.done = lifetime;
    running.set(entry.record.boxId, entry);
    options.link.statusChanged();
  };

  const slots = (): number => options.executor.capacity().slots;

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
      if (running.size >= slots()) {
        return done({ result: "rejected", reason: "no-capacity" });
      }
      const entry: Running = { record: { taskId: body.taskId, sessionId: body.sessionId, boxId: body.boxId, leaseEpoch: body.leaseEpoch }, done: Promise.resolve(), release: null, released: false };
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
    // Ticket 21: built with BuildKit and pushed to the organization's registry.
    "snapshot-build": () => done({ result: "rejected", reason: "not-supported" }),
  };

  return {
    handlers,
    status: () => ({
      executor: "kubernetes",
      processContainment: "container",
      capacity: slots(),
      freeSlots: draining ? 0 : Math.max(0, slots() - running.size),
      labels: options.labels,
      running: [...running.values()].map((entry) => entry.record.sessionId),
      resources: options.executor.capacity(),
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
        const entry: Running = { record, done: Promise.resolve(), release: null, released: false };
        // A pod whose task ended while the runner was away is released now; a running one is watched.
        track(entry, podIsOver(pod) ? releaseOnce(entry, "requested").then(() => undefined) : watch(entry));
        if (!podIsOver(pod)) {
          adopted += 1;
        }
      }
      log.info("adopted the box pods this runner made", { adopted, records: names.length });
      return adopted;
    },
    boxes: () => [...running.values()].map((entry) => entry.done),
    detach: () => {
      detached = true;
    },
  };
};
