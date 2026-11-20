import type { SubagentNode, SubagentState, SubagentTree } from "@ostra/task-view";

import { plural, t } from "@/lib/messages";

// F-138: the subagents' words (task-subagents-tree.md), kept apart from the components so a test
// reads them: the badge's count and its one state, durations, and each node's name for a reader.

/** `4 subagents`, `1 subagent`. */
export const subagentCount = (n: number): string => plural(n, "task.subagents.count.one", "task.subagents.count.other");

/** `14 calls`, `1 call`. */
export const callCount = (n: number): string => plural(n, "task.subagents.calls.one", "task.subagents.calls.other");

/** The one state the badge names after the count, in this order: approval, failure, running, stopped. */
export type BadgeState = { readonly state: "needs-approval" | "failed" | "running" | "stopped"; readonly n: number };

export const badgeState = (counts: SubagentTree["counts"]): BadgeState | null => {
  if (counts.needsApproval > 0) return { state: "needs-approval", n: counts.needsApproval };
  if (counts.failed > 0) return { state: "failed", n: counts.failed };
  if (counts.running > 0) return { state: "running", n: counts.running };
  if (counts.stopped > 0) return { state: "stopped", n: counts.stopped };
  return null;
};

/** The badge's state words: `1 needs approval`, `2 need approval`, `1 failed`, `1 running`. */
export const badgeStateText = (badge: BadgeState): string => {
  switch (badge.state) {
    case "needs-approval":
      return plural(badge.n, "task.subagents.badgeState.needsApprovalOne", "task.subagents.badgeState.needsApprovalOther");
    case "failed":
      return t("task.subagents.badgeState.failed", { n: badge.n });
    case "running":
      return t("task.subagents.badgeState.running", { n: badge.n });
    case "stopped":
      return t("task.subagents.badgeState.stopped", { n: badge.n });
    default:
      return badge.state satisfies never;
  }
};

/** The badge's name for a reader: `4 subagents, 1 running`, or the count alone when all are done. */
export const badgeName = (counts: SubagentTree["counts"]): string => {
  const state = badgeState(counts);
  const count = subagentCount(counts.total);
  return state === null ? count : t("task.subagents.badgeName", { count, state: badgeStateText(state) });
};

export const stateWord = (state: SubagentState): string => t(`task.subagents.state.${state}`);

/** A subagent as the thread and the approval name it: `explore · Find the version source`. */
export const subagentLabel = (node: Pick<SubagentNode, "type" | "description">): string => {
  if (node.type === null) return node.description;
  return node.description === "" ? node.type : `${node.type} · ${node.description}`;
};

/** How long a subagent ran, or has run so far. `null` when its start wasn't reported. */
export const nodeDurationMs = (node: Pick<SubagentNode, "startedAt" | "endedAt">, now: number): number | null =>
  node.startedAt === null ? null : Math.max(0, (node.endedAt ?? now) - node.startedAt);

/** A duration, short: `31s`, `1m 12s`, `2h 04m`. */
export const shortDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t("task.subagents.duration.seconds", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("task.subagents.duration.minutes", { m: minutes, s: String(seconds % 60).padStart(2, "0") });
  return t("task.subagents.duration.hours", { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, "0") });
};

/** A duration in words, for a reader: `1 minute 12 seconds`. */
export const durationWords = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts = [
    hours > 0 ? plural(hours, "task.subagents.durationWords.hourOne", "task.subagents.durationWords.hourOther") : "",
    minutes > 0 ? plural(minutes, "task.subagents.durationWords.minuteOne", "task.subagents.durationWords.minuteOther") : "",
    rest > 0 || (hours === 0 && minutes === 0) ? plural(rest, "task.subagents.durationWords.secondOne", "task.subagents.durationWords.secondOther") : "",
  ];
  return parts.filter((part) => part !== "").join(" ");
};

/** A card's line 2: `explore · 1m 12s · 14 calls`. */
export const nodeLine = (node: SubagentNode, now: number): string => {
  const ms = nodeDurationMs(node, now);
  const duration = ms === null ? "–" : shortDuration(ms);
  return node.type === null
    ? t("task.subagents.nodeLineNoType", { duration, calls: callCount(node.callCount) })
    : t("task.subagents.nodeLine", { type: node.type, duration, calls: callCount(node.callCount) });
};

/** A card's whole name for a reader: `explore subagent, Find the version source, done, 1 minute 12 seconds, 14 calls`. */
export const cardName = (node: SubagentNode, now: number): string => {
  const ms = nodeDurationMs(node, now);
  return t("task.subagents.cardName", {
    type: node.type ?? "",
    description: node.description,
    state: stateWord(node.state),
    duration: ms === null ? "" : durationWords(ms),
    calls: callCount(node.callCount),
  });
};

/**
 * The subagent the window opens on: the one asked for (a `Subagent` row), else the first that needs
 * approval, else the first running, else the first (task-subagents-tree.md, "Opening").
 */
export const initialSelection = (tree: SubagentTree, wanted: string | null): string | null => {
  if (wanted !== null && tree.nodes.some((node) => node.id === wanted)) return wanted;
  return (
    tree.nodes.find((node) => node.state === "needs-approval")?.id ??
    tree.nodes.find((node) => node.state === "running")?.id ??
    tree.nodes[0]?.id ??
    null
  );
};

/** The nodes a node leads to, deeper ones included: what a folded chip counts. */
export const descendantCount = (tree: SubagentTree, id: string): number => {
  const node = tree.nodes.find((one) => one.id === id);
  return (node?.children ?? []).reduce((sum, child) => sum + 1 + descendantCount(tree, child), 0);
};
