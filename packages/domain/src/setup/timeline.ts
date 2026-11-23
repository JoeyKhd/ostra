import type { OrganizationId } from "@ostra/protocol";

import type { AuditAction } from "../audit/actions.ts";

// Setup's timeline (F-076; milestone 7, ticket 36; spec sections 4 and 5.4; ADR 0064's 30-minute
// measure): when each setup step was done, read from ostra's own audit entries and the first PR's
// event, and measured from the time the person wrote down for the guide's first command. Pure: the
// API's `setup.timeline` (ticket 24) reads the rows and hands them here. A step with no entry is
// `missing`, never 0, so a measure can't pass on a step that didn't happen.

/**
 * The steps, in the checklist's order, ending with the first agent-made PR. Milestone 11 (F-152/c7):
 * `tracker` replaced `linear`, for a tracker connection of either kind.
 */
export const setupTimelineSteps = ["password", "model-provider", "github", "tracker", "project", "runner", "first-task", "first-pr"] as const;
export type SetupTimelineStep = (typeof setupTimelineSteps)[number];

/**
 * The audit actions that mark each step done: the earliest of them counts. The first PR is read
 * from its task's `pr.opened` event instead (`firstPullRequestOpenedAt`).
 */
export const setupStepMarks = {
  password: ["password.changed"],
  "model-provider": ["provider.added"],
  github: ["github.connected", "installation.linked"],
  // Any tracker connection that became active: `linear.connected` is what milestones 2 to 10 wrote.
  tracker: ["tracker.connected", "linear.connected"],
  project: ["project.created"],
  // A personal runner registers (and may wait for approval); a pool runner joins with a token.
  runner: ["runner.registered", "runner.approved", "runner.joined"],
  "first-task": ["task.created"],
  "first-pr": [],
} as const satisfies Record<SetupTimelineStep, readonly AuditAction[]>;

/** The tracker is optional (F-076): its step is shown, but never counted against setup being done. */
export const optionalSetupSteps: ReadonlySet<SetupTimelineStep> = new Set<SetupTimelineStep>(["tracker"]);

/** One audit entry as the timeline reads it: IDs and times only. */
export type SetupAuditEntry = {
  readonly organizationId: OrganizationId;
  readonly action: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
};

export type SetupTimelineInput = {
  /** When the person ran the guide's first command, in milliseconds since the epoch. */
  readonly start: number;
  readonly entries: readonly SetupAuditEntry[];
  /** When the organization's first PR was opened (its `pr.opened` event), or `null` for none yet. */
  readonly firstPullRequestOpenedAt: number | null;
};

export type SetupTimelineRow =
  | {
      readonly step: SetupTimelineStep;
      readonly state: "done";
      readonly optional: boolean;
      readonly at: number;
      /** `at - start`: negative when the step was done before the clock started. */
      readonly sinceStartMs: number;
    }
  | { readonly step: SetupTimelineStep; readonly state: "missing"; readonly optional: boolean };

export type SetupTimeline = {
  readonly organizationId: OrganizationId;
  readonly start: number;
  /** Every step, in `setupTimelineSteps`' order. */
  readonly steps: readonly SetupTimelineRow[];
  /** The required steps with no entry. Empty when setup is complete. */
  readonly missing: readonly SetupTimelineStep[];
  /** From the start to the first PR, or `null` while a required step is missing. */
  readonly totalMs: number | null;
};

/** The organization's setup timeline, from its audit entries and its first PR's event. */
export const setupTimeline = (organizationId: OrganizationId, input: SetupTimelineInput): SetupTimeline => {
  const earliest = new Map<string, number>();
  for (const entry of input.entries) {
    if (entry.organizationId !== organizationId) {
      continue;
    }
    const known = earliest.get(entry.action);
    if (known === undefined || entry.createdAt < known) {
      earliest.set(entry.action, entry.createdAt);
    }
  }
  const doneAt = (step: SetupTimelineStep): number | null => {
    if (step === "first-pr") {
      return input.firstPullRequestOpenedAt;
    }
    const times = setupStepMarks[step].flatMap((action: AuditAction) => {
      const at = earliest.get(action);
      return at === undefined ? [] : [at];
    });
    return times.length === 0 ? null : Math.min(...times);
  };
  const steps = setupTimelineSteps.map((step): SetupTimelineRow => {
    const at = doneAt(step);
    const optional = optionalSetupSteps.has(step);
    return at === null ? { step, state: "missing", optional } : { step, state: "done", optional, at, sinceStartMs: at - input.start };
  });
  const missing = steps.filter((row) => row.state === "missing" && !row.optional).map((row) => row.step);
  const last = steps.find((row) => row.step === "first-pr");
  const totalMs = missing.length === 0 && last?.state === "done" ? last.sinceStartMs : null;
  return { organizationId, start: input.start, steps, missing, totalMs };
};
