"use client";

import type { EffortLevel } from "@ostra/protocol";

import { effortHint, effortLabel, offersChoice } from "@/components/effort/effort-words";
import { PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";

// A task's effort in the properties panel (F-137, F-024; task-effort.md): the driver picks one of
// the model's levels, and it applies from the next turn (ADR 0066); everyone else reads it, with
// "Take over to change" when they may.

export type TaskEffort = {
  /** The task's level now: the last change, or the profile's at creation. */
  readonly level: EffortLevel;
  /** The levels of the session's model, `Default` first. `Default` alone offers no choice. */
  readonly levels: readonly EffortLevel[];
  /** The running turn's level, or `null` while no turn runs. */
  readonly runningTurn: EffortLevel | null;
};

/** What the row shows. */
export type TaskEffortView =
  | { readonly kind: "control"; readonly level: EffortLevel; readonly levels: readonly EffortLevel[]; readonly runsAt: EffortLevel | null }
  | { readonly kind: "text"; readonly level: EffortLevel; readonly takeOver: boolean };

/**
 * The row for one viewer: the driver of a live task gets the control (with the running turn's
 * level while it differs); anyone else, a finished task or a model with no levels reads the text.
 */
export const taskEffortView = (effort: TaskEffort, viewer: { readonly driver: boolean; readonly canTakeOver: boolean; readonly finished: boolean }): TaskEffortView => {
  if (!offersChoice(effort.levels)) return { kind: "text", level: "default", takeOver: false };
  if (viewer.finished) return { kind: "text", level: effort.level, takeOver: false };
  if (!viewer.driver) return { kind: "text", level: effort.level, takeOver: viewer.canTakeOver };
  const runsAt = effort.runningTurn !== null && effort.runningTurn !== effort.level ? effort.runningTurn : null;
  return { kind: "control", level: effort.level, levels: effort.levels, runsAt };
};

export const TaskEffortRow = ({ effort, viewer, onChange, onTakeOver, pending, error }: {
  /** `null` while it loads. */
  readonly effort: TaskEffort | null;
  readonly viewer: { readonly driver: boolean; readonly canTakeOver: boolean; readonly finished: boolean };
  readonly onChange: (level: EffortLevel) => void;
  readonly onTakeOver: () => void;
  readonly pending: boolean;
  /** Why the last change failed, or `null`. */
  readonly error: string | null;
}) => {
  if (effort === null) {
    return <PropRow label={t("tasks.effort.label")}><Skeleton className="h-5 w-[120px]" /></PropRow>;
  }
  const view = taskEffortView(effort, viewer);
  if (view.kind === "text") {
    return (
      <PropRow label={t("tasks.effort.label")}>
        <span data-testid="task-effort" data-level={view.level}>{effortLabel(view.level)}</span>
        {view.takeOver ? (
          <>
            <span aria-hidden className="text-faint">·</span>
            <Button variant="link" className="text-ui font-normal" onClick={onTakeOver} data-action="effort-take-over">{t("tasks.effort.takeOver")}</Button>
          </>
        ) : null}
      </PropRow>
    );
  }
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-2 py-[3px] text-ui">
      <span className="flex h-[26px] items-center text-muted">{t("tasks.effort.label")}</span>
      <div className="min-w-0">
        <Select value={view.level} disabled={pending} onValueChange={(next) => {
          const level = view.levels.find((candidate) => candidate === next);
          if (level !== undefined && level !== view.level) onChange(level);
        }}>
          <SelectTrigger className="h-7 w-[200px] max-w-full bg-surface text-ui" aria-label={t("tasks.effort.label")} data-testid="task-effort-trigger" data-level={view.level}>
            <SelectValue>{effortLabel(view.level)}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-[280px]">
            {view.levels.map((level) => (
              <SelectItem key={level} value={level} textValue={effortLabel(level)} className="h-auto min-h-[30px] py-1.5">
                <span className="flex min-w-0 flex-col">
                  <span>{effortLabel(level)}</span>
                  <span className="text-[12.5px] text-muted">{effortHint(level, view.levels)}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {view.runsAt === null ? null : (
          <p className="mt-1.5 text-[12.5px] leading-[1.45] text-muted" data-testid="task-effort-next">
            {t("tasks.effort.nextTurn")}
            <br />
            {t("tasks.effort.thisTurn", { level: effortLabel(view.runsAt) })}
          </p>
        )}
        {error === null ? null : <p role="alert" className="mt-1.5 text-[12.5px] text-red">{t("tasks.effort.failed", { reason: error })}</p>}
      </div>
    </div>
  );
};

/**
 * Milestone 10 (F-137, F-151; parts.md part 14): under the composer at its right, the next turn's
 * model and level in `--muted` with a 13px chevron, the same menu as the panel's row for the
 * driver. A model with no levels to choose, or a member who can't change it, reads the words alone.
 */
export const NextTurnMenu = ({ model, effort, canChange, onChange, pending }: {
  /** The model the next message goes to, by name; `null` while nobody knows it. */
  readonly model: string | null;
  /** `null` while it loads. */
  readonly effort: TaskEffort | null;
  /** The driver of a live task (`capabilities.setEffort`). */
  readonly canChange: boolean;
  readonly onChange: (level: EffortLevel) => void;
  readonly pending: boolean;
}) => {
  if (effort === null) return null;
  const choice = offersChoice(effort.levels);
  const words = (
    <>
      {model === null ? null : <span className="truncate">{model}</span>}
      {/* The spaces are the text's (a flex row draws the gaps); the dot is only drawn. */}
      {model === null || !choice ? null : <>{" "}<span aria-hidden className="mx-0.5">·</span>{" "}</>}
      {choice ? <span className="shrink-0">{effortLabel(effort.level)}</span> : null}
    </>
  );
  if (!choice || !canChange) {
    return <span className="flex min-w-0 items-center gap-1 text-muted" data-testid="composer-next-turn" title={t("task.composer.nextTurn")}>{words}</span>;
  }
  return (
    <Select value={effort.level} disabled={pending} onValueChange={(next) => {
      const level = effort.levels.find((candidate) => candidate === next);
      if (level !== undefined && level !== effort.level) onChange(level);
    }}>
      <SelectTrigger
        aria-label={t("task.composer.nextTurn")}
        title={t("task.composer.nextTurn")}
        data-testid="composer-next-turn"
        data-level={effort.level}
        className="-my-[3px] -mr-1 h-6 min-w-0 gap-1 max-md:-my-2 rounded-sm border-0 px-1 text-[12.5px] text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-teal [&_svg]:size-[13px] [&_svg]:text-faint"
      >
        <SelectValue><span className="flex min-w-0 items-center gap-1">{words}</span></SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="w-[280px]">
        {effort.levels.map((level) => (
          <SelectItem key={level} value={level} textValue={effortLabel(level)} className="h-auto min-h-[30px] py-1.5">
            <span className="flex min-w-0 flex-col">
              <span>{effortLabel(level)}</span>
              <span className="text-[12.5px] text-muted">{effortHint(level, effort.levels)}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/** `Reasoning`: the task's reasoning tokens, inside `out` (ADR 0066, "Cost"); `—` when no turn reported any. */
export const ReasoningRow = ({ tokens }: { readonly tokens: number }) => (
  <PropRow label={t("tasks.effort.reasoning")}>
    <Tooltip content={t("tasks.effort.reasoningTip")}>
      <span className="truncate font-mono text-ui" data-testid="task-reasoning" title={t("tasks.effort.reasoningTip")}>
        {tokens === 0 ? "—" : t("tasks.effort.reasoningTokens", { n: formatTokens(tokens) })}
      </span>
    </Tooltip>
  </PropRow>
);
