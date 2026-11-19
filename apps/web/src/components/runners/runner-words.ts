import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// A runner's state in the panel's words (domain-model.md). The type comes from the database enum
// through the API, so a new state fails the typecheck here until it has a word and a dot.

export type RunnerState = RouterOutputs["runners"]["mine"][number]["state"];

export const runnerStateText = (state: RunnerState): string => {
  switch (state) {
    case "joining":
      return t("runners.state.joining");
    case "online":
      return t("runners.state.online");
    case "offline":
      return t("runners.state.offline");
    case "draining":
      return t("runners.state.draining");
    case "revoked":
      return t("runners.state.revoked");
    default:
      return state satisfies never;
  }
};

/** The state's dot (runners.md): green online, a grey half dot draining, a grey ring joining, grey otherwise. Never amber. */
export type RunnerDot = "green" | "half" | "ring" | "grey";

export const runnerDot = (state: RunnerState): RunnerDot => {
  switch (state) {
    case "online":
      return "green";
    case "draining":
      return "half";
    case "joining":
      return "ring";
    case "offline":
    case "revoked":
      return "grey";
    default:
      return state satisfies never;
  }
};

/** The row's right-hand age: `just now` while joining, `seen {age} ago` when offline, nothing otherwise. */
export const runnerAge = (state: RunnerState, lastSeenAt: number | null, now: number = Date.now()): string => {
  if (state === "joining") return t("runners.justNow");
  if (state !== "offline" || lastSeenAt === null) return "";
  const age = formatAge(lastSeenAt, now);
  return age === "now" ? t("runners.seenJustNow") : t("runners.seenAgo", { age });
};

/** A pool's runner versions as one cell: `—`, `v0.4.2`, or the range `v0.4.1–v0.4.2` (already sorted). */
export const versionRange = (versions: readonly string[]): string => {
  const first = versions[0];
  const last = versions.at(-1);
  if (first === undefined || last === undefined) return "—";
  return first === last ? `v${first}` : `v${first}–v${last}`;
};

type Counted = { readonly state: RunnerState; readonly capacity: number; readonly busy: number };

/**
 * The admin lede's numbers: runners online of all listed, and boxes busy of the slots of runners
 * that take work (online or draining).
 */
export const runnerTotals = (runners: readonly Counted[]): { readonly online: number; readonly total: number; readonly busy: number; readonly slots: number } => {
  const working = runners.filter((runner) => runner.state === "online" || runner.state === "draining");
  return {
    online: runners.filter((runner) => runner.state === "online").length,
    total: runners.length,
    busy: working.reduce((sum, runner) => sum + runner.busy, 0),
    slots: working.reduce((sum, runner) => sum + runner.capacity, 0),
  };
};

/** The admin's lede: `Where tasks run. 4 of 8 runners online, 7 of 14 boxes busy, across 2 pools and your machine.` */
export const adminLede = (runners: readonly Counted[], pools: number, ownMachine: boolean): string => {
  const totals = runnerTotals(runners);
  const across =
    pools === 1
      ? ownMachine ? t("runners.acrossPoolAndMachine") : t("runners.acrossPool")
      : ownMachine ? t("runners.acrossPoolsAndMachine", { pools }) : t("runners.acrossPools", { pools });
  return t("runners.ledeAdmin", { online: totals.online, total: totals.total, busy: totals.busy, slots: totals.slots, across });
};

/**
 * The line under Your machine (runners.md, F-014, Q126): it adds that a detached process isn't
 * contained when one of the member's runners reports `process-tree` containment, whatever its
 * system: macOS, Linux without a cgroup of its own, Windows when its job object couldn't be made.
 */
export const hostNote = (mine: readonly Pick<RouterOutputs["runners"]["mine"][number], "processContainment">[] | undefined): string =>
  `${t("runners.hostNote")}${mine?.some((runner) => runner.processContainment === "process-tree") === true ? t("runners.hostNoteTreeOnly") : ""}`;
