import { InfoIcon } from "lucide-react";

import type { TaskMessageMeta } from "@ostra/task-view";

import { effortLabel } from "@/components/effort/effort-words";
import { formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";

// The thread's reasoning-effort marks (F-137, F-084; task-effort.md, "The thread"): each turn's
// usage line with its level and reasoning tokens, and the clamp's line under it. Milestone 10
// (ticket 12): the marker for `effort.changed` is a divider (`thread/divider.tsx`).

/** `Max · 48k in · 9.1k out · 6.4k reasoning`: the level is left out at `Default`, the reasoning when none was reported. */
export const turnUsageText = (meta: Pick<TaskMessageMeta, "effort" | "usage">): string | null => {
  const usage = meta.usage;
  if (usage === undefined || usage.inputTokens + usage.outputTokens === 0) return null;
  const parts = [
    ...(meta.effort === undefined || meta.effort === "default" ? [] : [effortLabel(meta.effort)]),
    t("taskAnswers.usage.turn", { input: formatTokens(usage.inputTokens), output: formatTokens(usage.outputTokens) }),
    ...(usage.reasoningTokens === undefined ? [] : [t("tasks.effort.usageReasoning", { n: formatTokens(usage.reasoningTokens) })]),
  ];
  return `${usage.estimated ? "≈ " : ""}${parts.join(" · ")}`;
};

/** `Ran at Max: this model has no Extra high.`, or `null` for a turn the clamp didn't move. */
export const clampText = (meta: Pick<TaskMessageMeta, "effort" | "adjustedFrom">): string | null => {
  if (meta.adjustedFrom === undefined) return null;
  const ran = meta.effort ?? "default";
  return ran === "default"
    ? t("tasks.effort.ranAtDefault")
    : t("tasks.effort.ranAt", { level: effortLabel(ran), asked: effortLabel(meta.adjustedFrom) });
};

/** A turn's usage line and, when the clamp moved its level, the line that says so. */
export const TurnUsage = ({ meta }: { readonly meta: TaskMessageMeta }) => {
  const usage = turnUsageText(meta);
  const clamp = clampText(meta);
  return (
    <>
      {usage === null ? null : <div data-part="turn-usage" className="mt-1 font-mono text-[12.5px] text-faint">{usage}</div>}
      {clamp === null ? null : (
        <div data-part="turn-clamp" className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted">
          <InfoIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75]" />
          {clamp}
        </div>
      )}
    </>
  );
};
