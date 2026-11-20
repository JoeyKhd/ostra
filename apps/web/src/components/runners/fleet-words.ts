import type { DispatchWait } from "@ostra/domain";

import { t } from "@/lib/messages";

// F-092, F-067, F-061 (tickets 30 and 31): the fleet's facts in the panel's words (pool.md,
// runner.md). Every switch is exhaustive, so a new code fails the typecheck here until it has words.

/** A capability's line, as `runners.list` and `pools.list` return it (ticket 26). */
export type FleetLine = "not-isolated" | "direct-internet-access" | "same-user-development";

/** A pool's lines under its lede, `kubernetes` first; `same-user-development` replaces `not-isolated`. */
export const poolLines = (lines: readonly FleetLine[]): readonly { readonly icon: "globe" | "shield"; readonly text: string }[] => {
  const out: { readonly icon: "globe" | "shield"; readonly text: string }[] = [];
  if (lines.includes("direct-internet-access")) out.push({ icon: "globe", text: t("runners.pool.lineInternet") });
  if (lines.includes("same-user-development")) out.push({ icon: "shield", text: t("runners.pool.lineSameUser") });
  else if (lines.includes("not-isolated")) out.push({ icon: "shield", text: t("runners.pool.lineHost") });
  return out;
};

/** A pool row's chips on the Runners page: `not isolated` (or its same-user form) and the internet line's short form. */
export const poolChips = (lines: readonly FleetLine[]): readonly string[] => {
  const out: string[] = [];
  if (lines.includes("same-user-development")) out.push(t("runners.pool.chipSameUser"));
  else if (lines.includes("not-isolated")) out.push(t("runners.notIsolated"));
  if (lines.includes("direct-internet-access")) out.push(t("runners.pool.chipInternet"));
  return out;
};

/** `WebSocket` or `HTTP`: the carrier a presence row names. */
export const carrierText = (carrier: string | null): string => (carrier === null ? "—" : carrier.toLowerCase() === "http" ? "HTTP" : "WebSocket");

/** How a runner contains a task's processes, as its status said. */
export type Containment = "container" | "job-object" | "cgroup" | "process-tree";

export const containmentText = (containment: Containment | null): string => {
  switch (containment) {
    case null:
      return "—";
    case "container":
      return t("runners.containment.container");
    case "job-object":
      return t("runners.containment.jobObject");
    case "cgroup":
      return t("runners.containment.cgroup");
    case "process-tree":
      return t("runners.containment.processTree");
    default:
      return containment satisfies never;
  }
};

/** The second half of the runner page's Containment row. */
export const containmentNote = (containment: Containment | null): string | null => {
  switch (containment) {
    case null:
      return null;
    case "container":
      return t("runners.containment.containerNote");
    case "job-object":
      return t("runners.containment.jobObjectNote");
    case "cgroup":
      return t("runners.containment.cgroupNote");
    case "process-tree":
      return t("runners.containment.processTreeNote");
    default:
      return containment satisfies never;
  }
};

export type VersionState = "current" | "behind" | "ahead" | "outside";

/** The chip after a version, in a list: `behind` one minor back, `outdated` outside the window. */
export const versionChip = (state: VersionState | null): string | null => {
  switch (state) {
    case null:
    case "current":
      return null;
    case "behind":
      return t("runners.version.behind");
    case "ahead":
      return t("runners.version.newer");
    case "outside":
      return t("runners.version.outdated");
    default:
      return state satisfies never;
  }
};

/** A queued task's ticket priority (1 Urgent to 4 Low); prompt tasks and tickets without one are Medium. */
export type Priority = "urgent" | "high" | "medium" | "low";

export const priorityOf = (value: number | null): Priority => {
  switch (value) {
    case 1:
      return "urgent";
    case 2:
      return "high";
    case 4:
      return "low";
    case null:
      return "medium";
    default:
      return "medium";
  }
};

export const priorityText = (priority: Priority): string => {
  switch (priority) {
    case "urgent":
      return t("runners.queue.urgent");
    case "high":
      return t("runners.queue.high");
    case "medium":
      return t("runners.queue.medium");
    case "low":
      return t("runners.queue.low");
    default:
      return priority satisfies never;
  }
};

/** `1st`, `2nd`, `3rd`, `11th`. */
export const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${String(n)}th`;
  switch (n % 10) {
    case 1:
      return `${String(n)}st`;
    case 2:
      return `${String(n)}nd`;
    case 3:
      return `${String(n)}rd`;
    default:
      return `${String(n)}th`;
  }
};

/** What the queue's words need about the pool. */
export type QueuePool = { readonly name: string; readonly busy: number; readonly cap: number };

/**
 * Why a queued task waits, short (the queue's Why cell) and in full (its tooltip, and the task
 * page's waiting line). `null`: the admission hasn't passed over it yet.
 */
export const queueReason = (wait: DispatchWait | null, pool: QueuePool, project: string): { readonly short: string; readonly full: string } => {
  if (wait === null) return { short: t("runners.queue.why.pending"), full: t("runners.queue.why.pendingFull") };
  const same = (text: string) => ({ short: text, full: text });
  switch (wait.code) {
    case "pool-full":
      return { short: t("runners.queue.why.poolFull", { busy: pool.busy, cap: pool.cap }), full: t("runners.queue.why.poolFullFull", { pool: pool.name, busy: pool.busy, cap: pool.cap }) };
    case "project-share-reached":
      return { short: t("runners.queue.why.share", { cap: wait.cap }), full: t("runners.queue.why.shareFull", { project, pool: pool.name, cap: wait.cap }) };
    case "no-runner-with-labels":
      return { short: t("runners.queue.why.labels", { labels: wait.labels.join(", ") }), full: t("runners.queue.why.labelsFull", { pool: pool.name, labels: wait.labels.join(", ") }) };
    case "needs-registry":
      return { short: t("runners.queue.why.registry"), full: t("runners.queue.why.registryFull", { pool: pool.name }) };
    case "size-too-large":
      return { short: t("runners.queue.why.size", { size: wait.size }), full: t("runners.queue.why.sizeFull", { pool: pool.name, size: wait.size }) };
    case "no-runner-online":
      return { short: t("runners.queue.why.noRunner"), full: t("runners.queue.why.noRunnerFull", { pool: pool.name }) };
    case "queued":
      return { short: t("runners.queue.why.next"), full: t("runners.queue.why.nextFull", { place: ordinal(wait.place), pool: pool.name }) };
    case "needs-services":
    case "needs-services-runner":
      return same(t("runners.queue.why.services"));
    case "no-model":
    case "no-provider-for-model":
    case "provider-not-allowed":
      return same(t("runners.queue.why.model"));
    case "provider-held":
    case "provider-cap":
      return same(t("runners.queue.why.provider"));
    case "personal-runner-not-allowed":
    case "personal-runner-unavailable":
      return same(t("runners.queue.why.personal"));
    case "offer-declined":
    case "offer-timed-out":
      return same(t("runners.queue.why.offer"));
    case "needs-protocol":
      return same(t("runners.queue.why.protocol", { minor: wait.minor }));
    case "budget-reached":
    case "model-unpriced":
      return same(t("runners.queue.why.budget"));
    case "installation-not-linked":
      return same(t("runners.queue.why.installation"));
    default:
      return wait satisfies never;
  }
};
