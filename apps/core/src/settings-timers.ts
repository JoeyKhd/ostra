import type { ServerSettings, SessionTimers } from "@ostra/domain";
import type { Jobs } from "@ostra/jobs";

import type { CleanupDeps } from "./cleanup/cleanup.ts";

// The timers core builds from the settings, in one place, so a test that takes them from here
// takes what `startCore` runs with (F-068, F-079): the session's maximum duration in minutes, and
// the idle days a box waits for its release, both as the delayed job's start and as the daily
// sweep's backstop for a lost timer.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The session's timers; `sessionMaxMs` is the tests-only override in milliseconds (`limitsMs`). */
export const sessionTimersOf = (
  settings: Pick<ServerSettings, "sessionMaxMinutes" | "boxReleaseIdleDays">,
  jobs: Pick<Jobs, "cancelInTx">,
  sessionMaxMs?: number,
): SessionTimers => ({
  sessionMaxMs: sessionMaxMs ?? settings.sessionMaxMinutes * MINUTE_MS,
  boxReleaseIdleMs: settings.boxReleaseIdleDays * DAY_MS,
  cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload),
});

/** The settings' part of the cleanup's deps: the same idle days as the timer, and the env's retention. */
export const cleanupSettingsOf = (settings: Pick<ServerSettings, "boxReleaseIdleDays" | "retentionDays">): Pick<CleanupDeps, "releaseAfterIdleMs" | "retentionDays"> => ({
  releaseAfterIdleMs: settings.boxReleaseIdleDays * DAY_MS,
  retentionDays: settings.retentionDays,
});
