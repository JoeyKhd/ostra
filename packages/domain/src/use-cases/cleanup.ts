import type { Db, Tx } from "@ostra/db";
import type { BoxId, OrganizationId, TaskId } from "@ostra/protocol";

import type { BoxReleaseReason } from "../lifecycles/box.ts";
import type { Ports } from "../ports.ts";
import { notYet } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// Cleanup and retention (F-079, spec section 11, item 11). Bodies: ticket 20.

// ---------- releasing a box ----------

export type ReleaseBoxInput = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly boxId: BoxId;
  readonly reason: BoxReleaseReason;
};

export type ReleaseBoxResult = UseCaseResult<
  {
    /** `command`: the runner was sent `release`; `already`: the box is gone; `minor-0`: its runner can't take one. */
    readonly outcome: "command" | "already" | "minor-0";
  },
  "not-found"
>;

export type ReleaseBoxDeps = Pick<Ports, "outbox" | "jobs" | "notices" | "clock"> & { readonly tx: Tx };

/**
 * Sends the box's runner the `release` command (protocol minor 1 only), moves the box to released
 * with its reason, and deletes the task's hidden refs on the code host.
 */
export type ReleaseBox = (deps: ReleaseBoxDeps, input: ReleaseBoxInput) => Promise<ReleaseBoxResult>;

export const releaseBox: ReleaseBox = () => notYet("20");

// ---------- the sweeps ----------

export type SweepCleanupInput = {
  readonly now: number;
  /** `OSTRA_BOX_RELEASE_IDLE_DAYS`, in ms. */
  readonly releaseAfterIdleMs: number;
};

export type SweepCleanupResult = UseCaseResult<{ readonly releaseQueued: number }, never>;

/** Finds stopped boxes idle past the limit whose timer was lost, and enqueues their release. */
export type SweepCleanup = (deps: Pick<Ports, "jobs" | "clock"> & { readonly db: Db }, input: SweepCleanupInput) => Promise<SweepCleanupResult>;

export const sweepCleanup: SweepCleanup = () => notYet("20");

export type SweepRetentionInput = {
  readonly now: number;
  /** The retention in effect (`retentionDaysInEffect`); `null` keeps everything, and the sweep does nothing. */
  readonly retentionDays: number | null;
};

export type SweepRetentionResult = UseCaseResult<
  { readonly tasks: number; readonly events: number; readonly blobs: number },
  "blob-store-failed"
>;

/**
 * Deletes, for tasks ended more than the retention ago, their event history, session archives and
 * other blobs (through the blob store), and records `retention.swept` in the audit log.
 */
export type SweepRetention = (deps: Pick<Ports, "audit" | "clock"> & { readonly db: Db }, input: SweepRetentionInput) => Promise<SweepRetentionResult>;

export const sweepRetention: SweepRetention = () => notYet("20");
