import type { NotificationKind } from "@ostra/adapter-sdk";

import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

// The notification choices' pure parts (notification-settings.md, F-036, F-115): the moments in the
// page's order, the grid of boxes as a draft against the saved choices, and the panel's words.

/** A moment a member chooses for: every kind but `test`, which only proves a channel. */
export type Moment = Exclude<NotificationKind, "test">;

/** The rows, the needs-you reasons a member meets most first (notification-settings.md, "Moments"). */
export const MOMENTS = ["approval", "question", "plan", "pr_ready", "crashed", "spend_cap", "stalled", "no_changes", "setup_failed", "ticket_closed"] as const satisfies readonly Moment[];

/** The two channels a member can turn off: the panel is always on (ADR 0050). */
export const CHOOSABLE = ["tracker", "email"] as const;
export type ChoosableChannel = (typeof CHOOSABLE)[number];

export type ChoiceCell = { readonly kind: NotificationKind; readonly channel: "panel" | ChoosableChannel; readonly enabled: boolean; readonly defaultEnabled: boolean };

/** The boxes as the page holds them: `<kind>:<channel>` to on or off. */
export type Grid = ReadonlyMap<string, boolean>;

const cellKey = (kind: NotificationKind, channel: ChoosableChannel): string => `${kind}:${channel}`;

const gridOf = (cells: readonly ChoiceCell[], pick: (cell: ChoiceCell) => boolean): Grid => {
  const grid = new Map<string, boolean>();
  for (const cell of cells) {
    if (cell.channel !== "panel" && cell.kind !== "test") grid.set(cellKey(cell.kind, cell.channel), pick(cell));
  }
  return grid;
};

/** The saved choices, with the defaults for what the member never changed (ticket 37 fills them in). */
export const savedGrid = (cells: readonly ChoiceCell[]): Grid => gridOf(cells, (cell) => cell.enabled);

/** ADR 0050's defaults: every moment on the ticket; email for the first six. */
export const defaultGrid = (cells: readonly ChoiceCell[]): Grid => gridOf(cells, (cell) => cell.defaultEnabled);

export const isOn = (grid: Grid, kind: Moment, channel: ChoosableChannel): boolean => grid.get(cellKey(kind, channel)) ?? false;

export const withBox = (grid: Grid, kind: Moment, channel: ChoosableChannel, on: boolean): Grid => new Map(grid).set(cellKey(kind, channel), on);

export const sameGrid = (a: Grid, b: Grid): boolean => a.size === b.size && [...a].every(([key, on]) => b.get(key) === on);

/** What `.save` takes: every box of the draft, so the saved rows are exactly what the page shows. */
export const choicesOf = (grid: Grid): readonly { readonly kind: Moment; readonly channel: ChoosableChannel; readonly enabled: boolean }[] =>
  MOMENTS.flatMap((kind) => CHOOSABLE.map((channel) => ({ kind, channel, enabled: isOn(grid, kind, channel) })));

export const momentName = (kind: Moment): string => t(`moments.${kind}.name` satisfies MessageKey);
export const momentDescription = (kind: Moment): string => t(`moments.${kind}.description` satisfies MessageKey);

/** A mail's delay as the panel says it: `none`, `30 s`, `2 min` (in minutes when it divides by 60). */
export const delayText = (seconds: number): string => {
  if (seconds <= 0) return t("delay.none");
  if (seconds % 60 === 0) return t("delay.minutes", { n: seconds / 60 });
  return t("delay.seconds", { n: seconds });
};

/** A short date, `12 Nov`, in the member's `en-GB` form. */
export const shortDate = (at: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(at));

export const lastChangeText = (savedAt: number | null): string => (savedAt === null ? t("notificationSettings.neverChanged") : t("notificationSettings.changedOn", { date: shortDate(savedAt) }));
