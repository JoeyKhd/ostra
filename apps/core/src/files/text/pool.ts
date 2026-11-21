import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import type { Logger } from "@ostra/adapter-sdk";

import type { DocumentKind } from "./kinds.ts";
import { textPoolLimits, textReadLimits } from "./limits.ts";
import type { TextPoolLimits, TextReadLimits } from "./limits.ts";
import { workerAnswerSchema } from "./messages.ts";
import type { WorkerRequest } from "./messages.ts";
import { textFailed } from "./result.ts";
import type { ExtractedText, TextFailureReason } from "./result.ts";

// The text workers (F-150/c2, spec section 5.5): `workers` threads per core process, each with a
// heap of `heapMiB`, reading one document at a time. Core's event loop never parses: it hands the
// bytes over and waits. A file a worker holds past `fileTimeoutMs` is `timeout`, and the worker is
// terminated and a fresh one takes its place; a worker past its heap is stopped by Node, the file is
// `too-big`, and a fresh one takes its place too. A file that waits past `waitMs` for a worker is
// `busy`. Workers start when the first file comes, so an install that reads no documents runs none.
//
// Logs carry the kind, the size, the time and the reason: never a file's name, bytes or text.

/** One document for the pool: its bytes (copied, never moved from the caller), its kind and its safe name. */
export type TextPoolInput = {
  readonly bytes: Uint8Array;
  readonly kind: DocumentKind;
  /** The file's safe name, for the text's first line. Never logged. */
  readonly name: string;
};

/** What the pool has done, for its tests and core's health. */
export type TextPoolStats = {
  /** Workers running now. */
  readonly workers: number;
  /** Workers ever started. */
  readonly started: number;
  /** Workers stopped by a timeout, their heap or a crash, and replaced. */
  readonly replaced: number;
  readonly timeouts: number;
  readonly outOfMemory: number;
  /** Network calls a worker's seal refused. Always 0 unless a library tried one. */
  readonly refusedCalls: number;
};

export type TextPool = {
  /** Reads a document's text in a worker. Never throws: a failure is a reason. */
  readonly read: (input: TextPoolInput) => Promise<ExtractedText>;
  readonly stats: () => TextPoolStats;
  /** Stops every worker; what waits or runs is `busy`. */
  readonly close: () => Promise<void>;
};

export type TextPoolOptions = {
  readonly logger: Logger;
  /** The pool's limits; the working values by default. */
  readonly pool?: Partial<TextPoolLimits>;
  /** The reader's limits; the working values by default. */
  readonly limits?: TextReadLimits;
};

const WORKER_URL = new URL("./worker.ts", import.meta.url);

/** How many workers in a row may die before they're ready, before the pool stops trying for the files waiting. */
const START_FAILURES_MAX = 3;

type Job = {
  readonly id: number;
  readonly input: TextPoolInput;
  readonly resolve: (result: ExtractedText) => void;
  waitTimer: NodeJS.Timeout | null;
};

type Running = { readonly job: Job; readonly startedAt: number; readonly timer: NodeJS.Timeout };

type Slot = {
  readonly worker: Worker;
  ready: boolean;
  gone: boolean;
  running: Running | null;
};

const isOutOfMemory = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY";

export const createTextPool = (options: TextPoolOptions): TextPool => {
  const limits: TextPoolLimits = { ...textPoolLimits, ...options.pool };
  const readLimits = options.limits ?? textReadLimits;
  const logger = options.logger;
  const slots: Slot[] = [];
  const queue: Job[] = [];
  const counts = { started: 0, replaced: 0, timeouts: 0, outOfMemory: 0, refusedCalls: 0 };
  let jobs = 0;
  let startFailures = 0;
  let closed = false;

  const fieldsOf = (input: TextPoolInput) => ({ kind: input.kind, size: input.bytes.byteLength });

  const settle = (job: Job, result: ExtractedText): void => {
    if (job.waitTimer !== null) {
      clearTimeout(job.waitTimer);
      job.waitTimer = null;
    }
    job.resolve(result);
  };

  const failWaiting = (reason: TextFailureReason): void => {
    for (const job of queue.splice(0)) {
      settle(job, textFailed(reason));
    }
  };

  /** Stops a worker for good: out of the pool, terminated, its file settled as `reason` when it held one. */
  const retire = (slot: Slot, reason: TextFailureReason | null): Running | null => {
    if (slot.gone) {
      return null;
    }
    slot.gone = true;
    slots.splice(slots.indexOf(slot), 1);
    const running = slot.running;
    slot.running = null;
    if (running !== null) {
      clearTimeout(running.timer);
      if (reason !== null) {
        settle(running.job, textFailed(reason));
      }
    }
    void slot.worker.terminate().catch(() => undefined);
    return running;
  };

  const run = (slot: Slot, job: Job): void => {
    if (job.waitTimer !== null) {
      clearTimeout(job.waitTimer);
      job.waitTimer = null;
    }
    // The worker gets its own copy, moved to it, so the caller keeps its bytes and only they move. A
    // copy into a fresh buffer: a Node `Buffer`'s `slice` is a view on a pool no message can move.
    const bytes = new Uint8Array(job.input.bytes);
    const request: WorkerRequest = { type: "read", id: job.id, bytes, kind: job.input.kind, name: job.input.name, limits: readLimits };
    const startedAt = performance.now();
    const timer = setTimeout(() => {
      counts.timeouts += 1;
      logger.warn("files.text.timeout", { ...fieldsOf(job.input), ms: Math.round(performance.now() - startedAt) });
      retire(slot, "timeout");
      replace();
    }, limits.fileTimeoutMs);
    slot.running = { job, startedAt, timer };
    slot.worker.postMessage(request, [bytes.buffer]);
  };

  const pump = (): void => {
    if (closed) {
      return;
    }
    for (const slot of slots) {
      if (slot.ready && slot.running === null) {
        const job = queue.shift();
        if (job === undefined) {
          return;
        }
        run(slot, job);
      }
    }
    const starting = slots.filter((slot) => !slot.ready).length;
    for (let waiting = queue.length - starting; waiting > 0 && slots.length < limits.workers; waiting -= 1) {
      spawn();
    }
  };

  const onAnswer = (slot: Slot, raw: unknown): void => {
    const answer = workerAnswerSchema.safeParse(raw);
    if (!answer.success) {
      logger.error("files.text.answer-refused", {});
      retire(slot, "damaged");
      replace();
      return;
    }
    switch (answer.data.type) {
      case "ready":
        slot.ready = true;
        startFailures = 0;
        pump();
        return;
      case "result": {
        const running = slot.running;
        if (running?.job.id !== answer.data.id) {
          return;
        }
        clearTimeout(running.timer);
        slot.running = null;
        const result = answer.data.result;
        const fits = result.state !== "ready" || Buffer.byteLength(result.markdown, "utf8") <= readLimits.textMaxBytes;
        if (answer.data.refusedCalls > 0) {
          counts.refusedCalls += answer.data.refusedCalls;
          logger.warn("files.text.network-refused", { ...fieldsOf(running.job.input), calls: answer.data.refusedCalls });
        }
        const final = fits ? result : textFailed("too-big");
        logger.debug("files.text.read", {
          ...fieldsOf(running.job.input),
          state: final.state,
          reason: final.state === "failed" ? final.reason : null,
          words: final.state === "ready" ? final.words : null,
          ms: Math.round(performance.now() - running.startedAt),
        });
        settle(running.job, final);
        pump();
        return;
      }
      default:
        answer.data satisfies never;
    }
  };

  const onStopped = (slot: Slot, reason: TextFailureReason, code: string): void => {
    if (slot.gone) {
      return;
    }
    const wasReady = slot.ready;
    const running = retire(slot, null);
    if (running !== null) {
      if (reason === "too-big") {
        counts.outOfMemory += 1;
      }
      logger.warn("files.text.worker-stopped", { ...fieldsOf(running.job.input), reason, code, ms: Math.round(performance.now() - running.startedAt) });
      settle(running.job, textFailed(reason));
    } else {
      logger.warn("files.text.worker-stopped", { reason, code });
    }
    if (!wasReady) {
      startFailures += 1;
      if (startFailures >= START_FAILURES_MAX) {
        logger.error("files.text.workers-not-starting", { failures: startFailures });
        failWaiting("busy");
        startFailures = 0;
        return;
      }
    }
    replace();
  };

  /** A fresh worker in place of one that stopped. */
  const replace = (): void => {
    counts.replaced += 1;
    if (!closed) {
      spawn();
      pump();
    }
  };

  const spawn = (): void => {
    const worker = new Worker(WORKER_URL, {
      name: "ostra-text-reader",
      // The worker sees none of core's settings or secrets, and no flag of core's process.
      env: {},
      argv: [],
      execArgv: [],
      // Its stdout and stderr come here and go nowhere: a library's warning can quote the document.
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: limits.heapMiB, maxYoungGenerationSizeMb: Math.max(4, Math.min(32, Math.floor(limits.heapMiB / 8))), stackSizeMb: 4 },
    });
    const slot: Slot = { worker, ready: false, gone: false, running: null };
    slots.push(slot);
    counts.started += 1;
    worker.stdout.resume();
    worker.stderr.resume();
    // An idle worker never keeps core's process alive; a file being read holds its own timer.
    worker.unref();
    worker.on("message", (raw: unknown) => {
      onAnswer(slot, raw);
    });
    worker.on("error", (error: unknown) => {
      onStopped(slot, isOutOfMemory(error) ? "too-big" : "damaged", isOutOfMemory(error) ? "out-of-memory" : "error");
    });
    worker.on("exit", (exitCode: number) => {
      onStopped(slot, "damaged", `exit-${String(exitCode)}`);
    });
  };

  return {
    read: (input) =>
      new Promise<ExtractedText>((resolve) => {
        if (closed) {
          resolve(textFailed("busy"));
          return;
        }
        jobs += 1;
        const job: Job = { id: jobs, input, resolve, waitTimer: null };
        job.waitTimer = setTimeout(() => {
          job.waitTimer = null;
          const at = queue.indexOf(job);
          if (at >= 0) {
            queue.splice(at, 1);
            logger.warn("files.text.busy", { ...fieldsOf(input), waitedMs: limits.waitMs });
            resolve(textFailed("busy"));
          }
        }, limits.waitMs);
        queue.push(job);
        pump();
      }),
    stats: () => ({ workers: slots.length, ...counts }),
    close: async () => {
      closed = true;
      failWaiting("busy");
      const stopping = [...slots];
      for (const slot of stopping) {
        retire(slot, "busy");
      }
      await Promise.all(stopping.map((slot) => slot.worker.terminate().catch(() => undefined)));
    },
  };
};
