import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// A parent ticket's progress (ticket-parent.md, "Progress"): over its sub-issues on the project's
// boards, merged (or done) is the green fill and in review or running the second; needs you, queued
// and not started stay in the empty track, and the sentence under it names each count. A stopped
// child counts as not done, so the parent stays visibly unfinished.

export type Child = RouterOutputs["tickets"]["parent"]["children"][number];

export type ProgressPart = { readonly kind: "merged" | "moving" | "needsYou" | "queued" | "stopped" | "notStarted"; readonly n: number };

export type Progress = {
  readonly total: number;
  readonly merged: number;
  readonly moving: number;
  /** The sentence's parts, those that are 0 left out. */
  readonly parts: readonly ProgressPart[];
};

const bucketOf = (child: Child): ProgressPart["kind"] => {
  if (child.task === null) return "notStarted";
  switch (child.task.state) {
    case "merged":
    case "done":
      return "merged";
    case "in_review":
    case "running":
    case "preparing":
      return "moving";
    case "needs_you":
      return "needsYou";
    case "queued":
    case "awaiting_approval":
      return "queued";
    case "stopped":
      return "stopped";
    default:
      return child.task.state satisfies never;
  }
};

/** The progress over the open leaves on the project's boards (a mid-level parent isn't a task's place). */
export const progressOf = (children: readonly Child[]): Progress => {
  const counted = children.filter((child) => child.open && child.leaf);
  const counts: Record<ProgressPart["kind"], number> = { merged: 0, moving: 0, needsYou: 0, queued: 0, stopped: 0, notStarted: 0 };
  for (const child of counted) counts[bucketOf(child)] += 1;
  const order: readonly ProgressPart["kind"][] = ["merged", "moving", "needsYou", "queued", "stopped", "notStarted"];
  return {
    total: counted.length,
    merged: counts.merged,
    moving: counts.moving,
    parts: order.flatMap((kind) => (counts[kind] === 0 ? [] : [{ kind, n: counts[kind] }])),
  };
};

export const partText = (part: ProgressPart): string => {
  switch (part.kind) {
    case "merged":
      return t("ticketParent.part.merged", { n: part.n });
    case "moving":
      return t("ticketParent.part.moving", { n: part.n });
    case "needsYou":
      return t("ticketParent.part.needsYou", { n: part.n });
    case "queued":
      return t("ticketParent.part.queued", { n: part.n });
    case "stopped":
      return t("ticketParent.part.stopped", { n: part.n });
    case "notStarted":
      return t("ticketParent.part.notStarted", { n: part.n });
    default:
      return part.kind satisfies never;
  }
};
