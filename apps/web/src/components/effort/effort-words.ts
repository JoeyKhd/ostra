import { clampEffort } from "@ostra/protocol";
import type { EffortLevel } from "@ostra/protocol";

import { t } from "@/lib/messages";

// The words of a reasoning level (F-137, ADR 0066), shared by the profile editor, the task page
// and the Models page (`effort.levels.*`, `effort.hints.*`). A level has no colour: it isn't good
// or bad (agent-profile-effort.md, "Tokens").

/** `Default`, `Off`, … `Extra high`, `Max`, `On`. */
export const effortLabel = (level: EffortLevel): string => t(`effort.levels.${level}`);

/**
 * The level's one-line hint. With `max` offered too, `xhigh` reads differently, so the two don't
 * say the same thing (agent-profile-effort.md, "The Effort field").
 */
export const effortHint = (level: EffortLevel, offered: readonly EffortLevel[]): string =>
  level === "xhigh" && offered.includes("max") ? t("effort.hints.xhighBesideMax") : t(`effort.hints.${level}`);

/** `a`, `a and b`, `a, b and c`: the panel's lists, with no serial comma. */
export const andList = (items: readonly string[]): string => {
  const last = items.at(-1);
  if (last === undefined) return "";
  if (items.length === 1) return last;
  return t("effort.and", { list: items.slice(0, -1).join(", "), last });
};

/** The levels a model offers as a comma-joined line without `Default`: `Off, Low, Medium, High`. */
export const levelsLine = (levels: readonly EffortLevel[]): string =>
  levels.filter((level) => level !== "default").map(effortLabel).join(", ");

/** True when the model offers a choice: more than `Default` alone. */
export const offersChoice = (levels: readonly EffortLevel[]): boolean => levels.some((level) => level !== "default");

/**
 * The level a stored one runs at when the model lacks it (ADR 0066's clamp, the same function
 * core applies), or `null` when the model has it.
 */
export const runsAt = (stored: EffortLevel, levels: readonly EffortLevel[]): EffortLevel | null => {
  if (levels.includes(stored)) return null;
  return clampEffort(stored, levels).level;
};
