import { readFile, rm } from "node:fs/promises";
import { checksToRun, GIT_GUARD_ENV_NAMES } from "@ostra/adapter-sdk";
import type { BoxRef, CheckRunResult, ExecutorAdapter, Logger } from "@ostra/adapter-sdk";
import { runnerLimits } from "@ostra/protocol";
import type { BlobId, RepoId, SavedCheck, TaskEvent, TaskSpec } from "@ostra/protocol";
import type { ServerLink } from "./server-link.ts";

// Milestone 3's checks after a turn (F-054, ADR 0052, Q188): between the turn's commit and its push,
// the environment's checks run through the executor, in the environment's order, each with its own
// timeout and all of them within the spec's total (`OSTRA_CHECKS_TOTAL_MINUTES`). Each check emits
// `check.started` and `check.finished`, with its full output uploaded as a blob (milestone 2's bulk
// path). Nothing here blocks the push: a failing, timed-out or broken check is reported, and the
// caller pushes either way; the draft is core's (ticket 23).
//
// A check's output is untrusted: it goes to the event and the blob, never to a log line.

export type TurnChecksDeps = {
  readonly executor: Pick<ExecutorAdapter, "runChecks">;
  readonly link: Pick<ServerLink, "uploadBlob">;
  readonly emit: (event: TaskEvent) => Promise<void>;
  readonly logger: Logger;
  /** The clock the total is measured on. Default: `Date.now`. */
  readonly now?: () => number;
};

export type TurnChecksInput = {
  readonly box: BoxRef;
  readonly spec: TaskSpec;
  /** The repos the turn changed: a check that names another repo isn't run and emits nothing (Q188). */
  readonly changedRepoIds: readonly RepoId[];
  /** Where each check's output file and home folder go for the turn; removed after. */
  readonly outputDir: string;
  /** The session ending cuts the running check short. */
  readonly signal?: AbortSignal;
};

/**
 * The variables a check runs with: each repo's non-secret variables, as the agent gets them. The
 * secrets stay in the repos' env files, which a check reads as the code under test does; a model
 * key, a code host token and the runner's own variables never reach it (the executor's contract).
 */
export const checkVariables = (spec: TaskSpec): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const repo of spec.environment.repos) {
    for (const variable of repo.variables) {
      if (!GIT_GUARD_ENV_NAMES.some((guarded) => guarded === variable.name)) {
        out[variable.name] = variable.value;
      }
    }
  }
  return out;
};

/** The text a check that couldn't run carries in place of its output. */
const NOT_RUN_TOTAL = "The checks' total time ran out before this one.";

/**
 * Runs the turn's checks that apply, in order, and reports each. Answers what `session.saved`
 * carries: each check's ID and status, in order. Never throws.
 */
export const runTurnChecks = async (deps: TurnChecksDeps, input: TurnChecksInput): Promise<readonly SavedCheck[]> => {
  const now = deps.now ?? Date.now;
  const log = deps.logger.child({ taskId: input.box.taskId, boxId: input.box.boxId });
  const checks = checksToRun(input.spec.checks ?? [], input.changedRepoIds);
  if (checks.length === 0) {
    return [];
  }
  const totalMs = (input.spec.checksTotalMinutes ?? runnerLimits.checksTotalMinutes) * 60_000;
  const deadline = now() + totalMs;
  const env = checkVariables(input.spec);
  const saved: SavedCheck[] = [];
  try {
    for (const check of checks) {
      await deps.emit({ kind: "check.started", checkId: check.checkId, repoId: check.repoId, name: check.name });
      const remaining = deadline - now();
      let result: CheckRunResult;
      if (remaining <= 0 || input.signal?.aborted === true) {
        // Past the total: the rest are timed out without running.
        result = { checkId: check.checkId, name: check.name, repoId: check.repoId, status: "timed-out", exitCode: null, durationMs: 0, outputTail: NOT_RUN_TOTAL, outputPath: null };
      } else {
        const ran = await deps.executor.runChecks(input.box, {
          // One check at a time, so each one's start is reported as it starts.
          spec: { ...input.spec, checks: [check] },
          changedRepoIds: input.changedRepoIds,
          env,
          outputDir: input.outputDir,
          totalTimeoutMs: remaining,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const first = ran.ok ? ran.value[0] : undefined;
        result =
          first ??
          {
            checkId: check.checkId,
            name: check.name,
            repoId: check.repoId,
            status: "error",
            exitCode: null,
            durationMs: 0,
            outputTail: ran.ok ? "The check didn't run." : `The check couldn't run: ${ran.error.message}`.slice(0, 500),
            outputPath: null,
          };
        if (!ran.ok) {
          log.warn("a check couldn't run", { checkId: check.checkId, code: ran.error.code });
        }
      }
      const outputBlobId = await uploadOutput(deps, input.spec, result.outputPath);
      await deps.emit({
        kind: "check.finished",
        checkId: result.checkId,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputTail: result.outputTail.slice(-runnerLimits.checkOutputTailMaxBytes),
        outputBlobId,
      });
      // Its status and figures only: the output is untrusted.
      log.info("check finished", {
        checkId: result.checkId,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputUploaded: outputBlobId !== null,
      });
      saved.push({ checkId: result.checkId, status: result.status });
    }
  } finally {
    await rm(input.outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
  return saved;
};

/** A check's full output, up as a blob; `null` when there's no file or the upload failed. */
const uploadOutput = async (deps: TurnChecksDeps, spec: TaskSpec, outputPath: string | null): Promise<BlobId | null> => {
  if (outputPath === null) {
    return null;
  }
  try {
    const bytes = await readFile(outputPath);
    const uploaded = await deps.link.uploadBlob({
      taskId: spec.taskId,
      leaseEpoch: spec.leaseEpoch,
      purpose: "check-output",
      contentType: "text/plain",
      bytes,
    });
    if (!uploaded.ok) {
      deps.logger.warn("a check's output wasn't uploaded", { taskId: spec.taskId, reason: uploaded.failure.kind });
      return null;
    }
    return uploaded.value.blobId;
  } catch (error) {
    deps.logger.warn("a check's output couldn't be read", { taskId: spec.taskId, error: error instanceof Error ? error.name : "unknown" });
    return null;
  } finally {
    await rm(outputPath, { force: true }).catch(() => undefined);
  }
};
