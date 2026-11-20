import type { BoxWaitingReason } from "@ostra/protocol";

import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// F-067, F-069, F-093 (milestone 5's ticket 33; app-targets/m1/task, m2/task-limits): the task's
// waiting line. One sentence per reason a queued task waits, worded here from `messages/en.json`
// and never from the server (F-083): its place in its pool's queue, why, a box waiting for a node,
// and who cancelled it.

type Task = RouterOutputs["tasks"]["get"];
export type Waiting = NonNullable<Task["waiting"]>;
export type Reason = Extract<Waiting, { readonly kind: "no-runner" }>["reason"];
export type QueuePlace = NonNullable<Task["queue"]>;

/** `1st`, `2nd`, `3rd`, `11th`, `22nd`. */
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

/** `Alex Kim`, `Alex Kim or Priya Nair`, `a, b or c`. */
const orList = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")}${t("waitLine.or")}${names[names.length - 1] ?? ""}`;

/** What the line needs beyond the reason: names the reason carries only as IDs. */
export type WaitContext = {
  readonly project: string;
  /** The project's pools in its order, by name. */
  readonly poolNames: readonly string[];
  /** A pool's name by its ID, `""` when it isn't known to this member. */
  readonly poolName: (poolId: string) => string;
  /** The picked personal runner's busy boxes against its slots, when it has one. */
  readonly personal: { readonly name: string; readonly busy: number; readonly slots: number } | null;
};

/**
 * Why a queued task waits, as one sentence. The four reasons milestones 3 and 4 already word in
 * their own blocks on the task page (`needs-services-runner`, `provider-not-allowed`,
 * `installation-not-linked`, `no-provider-for-model`) are worded here too, for the task list.
 */
export const waitReasonText = (reason: Reason, context: WaitContext): string => {
  switch (reason.code) {
    case "no-model":
      return t("waitLine.noModel");
    case "provider-held":
      return t("waitLine.providerHeld", { until: new Date(reason.until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) });
    case "provider-cap":
      return t("waitLine.providerCap", { cap: reason.cap });
    case "personal-runner-not-allowed":
      return t("waitLine.personalNotAllowed");
    case "personal-runner-unavailable":
      return context.personal === null
        ? t("waitLine.personalUnavailable")
        : context.personal.busy >= context.personal.slots
          ? t("waitLine.personalBusy", { runner: context.personal.name, busy: context.personal.busy, slots: context.personal.slots })
          : t("waitLine.personalOffline", { runner: context.personal.name });
    case "no-runner-online":
      return t("waitLine.noRunnerOnline", { project: context.project });
    case "offer-declined":
      return t("waitLine.offerDeclined");
    case "offer-timed-out":
      return t("waitLine.offerTimedOut");
    case "needs-services-runner":
      return t("waitLine.needsServices", { project: context.project });
    case "needs-protocol":
      return t("waitLine.needsProtocol", { minor: reason.minor });
    case "no-provider-for-model":
      return t("waitLine.noProviderForModel", { model: reason.modelName });
    case "provider-not-allowed":
      return t("waitLine.providerNotAllowed", { project: context.project });
    case "budget-reached":
      return reason.scope === "project" ? t("waitLine.budgetProject", { project: context.project }) : t("waitLine.budgetOrganization");
    case "model-unpriced":
      return t("waitLine.modelUnpriced");
    case "installation-not-linked":
      return t("waitLine.installationNotLinked", { repo: reason.repo });
    case "needs-registry":
      return t("waitLine.needsRegistry", { pool: context.poolName(reason.poolId) || t("waitLine.aPool") });
    case "needs-services":
      return t("waitLine.needsServices", { project: context.project });
    case "no-runner-with-labels":
      return plural(reason.labels.length, "waitLine.noLabels.one", "waitLine.noLabels.other", {
        pools: context.poolNames.length === 0 ? t("waitLine.itsPools", { project: context.project }) : orList(context.poolNames),
        labels: reason.labels.join(", "),
      });
    case "size-too-large":
      return t("waitLine.sizeTooLarge", { project: context.project, size: reason.size });
    case "project-share-reached":
      return plural(reason.cap, "waitLine.shareReached.one", "waitLine.shareReached.other", { project: context.project, pool: context.poolName(reason.poolId) || t("waitLine.aPool") });
    case "pool-full":
      return t("waitLine.poolFull", { pool: context.poolName(reason.poolId) || t("waitLine.aPool") });
    case "queued":
      return t("waitLine.queued", { pool: context.poolName(reason.poolId) || t("waitLine.aPool") });
    default:
      return reason satisfies never;
  }
};

/** `3rd in build-fleet's queue`, or `null` when the task is in no pool's queue. */
export const queuePlaceText = (queue: QueuePlace | null): string | null =>
  queue === null ? null : t("waitLine.place", { place: ordinal(queue.place), pool: queue.poolName });

/** The whole line: the place, then why (`3rd in build-fleet's queue · test1 is at its share …`), or an open offer. */
export const waitLine = (waiting: Waiting | null, queue: QueuePlace | null, context: WaitContext): string | null => {
  if (waiting?.kind === "offered") return t("waitLine.offered", { runner: waiting.runner.name });
  const place = queuePlaceText(queue);
  // `queued` says only that its turn hasn't come: the place says that better.
  const why = waiting === null || (waiting.reason.code === "queued" && place !== null) ? null : waitReasonText(waiting.reason, context);
  const parts = [place, why].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
};

/** `Waiting for a node · 2m`: a box the cluster has no node for yet, or whose image is being pulled. */
export const boxWaitText = (waiting: { readonly reason: BoxWaitingReason; readonly since: number }, now: number): string =>
  `${waiting.reason === "node" ? t("waitLine.waitingForNode") : t("waitLine.pullingImage")} · ${waitedFor(now - waiting.since)}`;

/** How long a box has waited: `40s`, `3m`, `1h 5m`. */
export const waitedFor = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
};

/** `small · 2 vCPU · 4 GiB` for the properties panel. */
export const boxSizeText = (size: { readonly name: string; readonly cpuMillis: number; readonly memoryMiB: number }): string =>
  t("waitLine.size", { name: size.name, cpu: String(Math.round(size.cpuMillis / 100) / 10), memory: String(Math.round((size.memoryMiB / 1024) * 10) / 10) });
