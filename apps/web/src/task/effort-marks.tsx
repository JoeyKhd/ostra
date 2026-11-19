import { InfoIcon, SlidersHorizontalIcon } from "lucide-react";

import type { EffortChangeData, TaskMessageMeta } from "@ostra/task-view";

import { effortLabel } from "@/components/effort/effort-words";
import { formatClock, formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";

// The thread's reasoning-effort marks (F-137, F-084; task-effort.md, "The thread"): each turn's
// usage line with its level and reasoning tokens, the clamp's line under it, and the marker for
// `effort.changed`, in time order among the thread's items.

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

/** `Alex Kim set effort to Low, from the next turn`: the tail only when a turn was running. */
export const effortMarkerText = (data: EffortChangeData, name: string): string =>
  t(data.duringTurn ? "tasks.effort.markerDuringTurn" : "tasks.effort.marker", { name, level: effortLabel(data.to) });

export const EffortMarker = ({ data, name }: { readonly data: EffortChangeData; readonly name: string }) => (
  <div data-part="effort" data-level={data.to} className="flex min-h-7 min-w-0 items-center text-ui text-muted">
    <span className="flex w-8 shrink-0 pl-1.5 text-muted">
      <SlidersHorizontalIcon aria-hidden className="size-[15px] stroke-[1.75]" />
    </span>
    <span className="min-w-0">{effortMarkerText(data, name)}</span>
    <span className="ml-3 shrink-0 font-mono text-sm text-faint">{formatClock(data.at)}</span>
  </div>
);
