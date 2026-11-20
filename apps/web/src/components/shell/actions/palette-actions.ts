import { isPaletteActionOffered } from "@ostra/domain/palette";

import { t } from "@/lib/messages";

import { actionWords, offeredPaletteActions, registry } from "./registry";
import type { PaletteAction, PaletteActionId, PaletteContext, PaletteShortcut } from "./registry";
import type { ActionScope } from "./use-scope";

// The palette's action rows (command-palette.md, "The groups, in order"): `On this page` (the task's
// or the focused item's actions, or on a list page the actions that pick their item in a second
// step), `Actions` (anywhere), then `Go to`. Pure, so the groups are tested without a browser.

export type ActionRow = {
  readonly id: PaletteActionId;
  readonly label: string;
  /** What waits, after the label (`3 waiting`); `null` for none. */
  readonly hint: string | null;
  readonly shortcut: PaletteShortcut | null;
  /** The row opens a second step inside the palette (its label ends in `…`). */
  readonly step: boolean;
};

export type ActionGroups = {
  readonly page: readonly ActionRow[];
  readonly actions: readonly ActionRow[];
  readonly goTo: readonly ActionRow[];
};

/** What waits for the member across the organization, for the list pages' `Approve…` and its kin. */
export type Waiting = { readonly approvals: number; readonly questions: number } | null;

export type PaletteRowsInput = {
  readonly role: PaletteContext["role"];
  readonly scope: ActionScope;
  /** The theme on screen, for `Switch to the light theme` or its opposite. */
  readonly shownTheme: "dark" | "light";
  readonly waiting: Waiting;
  readonly query: string;
  readonly actions?: readonly PaletteAction[];
};

/** The list actions a page without a task picks the item of in a second step. */
const PICKS: readonly PaletteActionId[] = ["approve", "deny", "answer", "reopen"];

const words = (id: PaletteActionId): string => `${t(actionWords[id].palette)} ${t(actionWords[id].sheet)} ${t(actionWords[id].keywords)}`.toLowerCase();

/** Every word typed is in the row's label or keywords. An empty query keeps every row. */
export const matchesQuery = (id: PaletteActionId, label: string, query: string): boolean => {
  const typed = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  const haystack = `${label.toLowerCase()} ${words(id)}`;
  return typed.every((word) => haystack.includes(word));
};

const row = (entry: PaletteAction, label: string, hint: string | null, step: boolean): ActionRow => ({ id: entry.id, label, hint, shortcut: entry.shortcut, step });

/** The task page's own row for an action, or `null` when its viewer can't take it there. */
const taskRow = (entry: PaletteAction, scope: ActionScope): ActionRow | null => {
  const task = scope.task;
  const item = scope.item;
  switch (entry.id) {
    case "approve":
    case "deny":
      return item?.kind === "approval" ? row(entry, t(entry.id === "approve" ? "palette.labels.approveThis" : "palette.labels.denyThis"), null, false) : null;
    case "answer":
      return item?.kind === "question" ? row(entry, t("palette.labels.answerThis"), null, false) : null;
    case "steer":
      return task?.canSend === true ? row(entry, t(actionWords.steer.palette), null, false) : null;
    case "take-over":
      return task?.canTakeOver === true ? row(entry, t(actionWords["take-over"].palette), null, false) : null;
    case "stop":
      return task?.canStop === true ? row(entry, t(actionWords.stop.palette), null, false) : null;
    case "reopen":
      return task?.canReopen === true ? row(entry, t("palette.labels.reopenThis"), null, true) : null;
    case "go-needs-you":
    case "go-home":
    case "go-tasks":
    case "search":
    case "shortcut-sheet":
    case "new-task":
    case "new-project":
    case "toggle-theme":
      return null;
    default:
      return entry.id satisfies never;
  }
};

/** A list page's row for an action that picks its item in a second step, hidden when nothing waits. */
const pickRow = (entry: PaletteAction, waiting: Waiting): ActionRow | null => {
  const label = t(actionWords[entry.id].palette);
  switch (entry.id) {
    case "approve":
    case "deny":
      if (waiting !== null && waiting.approvals === 0) return null;
      return row(entry, label, waiting === null ? null : t("palette.hint.waiting", { n: waiting.approvals }), true);
    case "answer":
      if (waiting !== null && waiting.questions === 0) return null;
      return row(entry, label, waiting === null ? null : waiting.questions === 1 ? t("palette.hint.questionOne") : t("palette.hint.questionOther", { n: waiting.questions }), true);
    case "reopen":
      return row(entry, label, null, true);
    case "go-needs-you":
    case "go-home":
    case "go-tasks":
    case "search":
    case "shortcut-sheet":
    case "new-task":
    case "new-project":
    case "toggle-theme":
    case "take-over":
    case "stop":
    case "steer":
      return null;
    default:
      return entry.id satisfies never;
  }
};

/** The palette's action groups for this page, this member and what's typed. */
export const paletteRows = ({ role, scope, shownTheme, waiting, query, actions = registry }: PaletteRowsInput): ActionGroups => {
  const offered = offeredPaletteActions({ role, scopes: scope.scopes }, actions);
  const page: ActionRow[] = [];
  if (scope.task !== null || scope.item !== null) {
    for (const entry of offered) {
      if (entry.scope === "global") continue;
      const made = taskRow(entry, scope);
      if (made !== null) page.push(made);
    }
  } else {
    // A list page: the item is chosen in the palette, so the role alone decides.
    for (const entry of actions) {
      if (!PICKS.includes(entry.id) || !isPaletteActionOffered(entry, { role, scopes: ["global", entry.scope] })) continue;
      const made = pickRow(entry, waiting);
      if (made !== null) page.push(made);
    }
  }
  const anywhere: ActionRow[] = [];
  const goTo: ActionRow[] = [];
  for (const entry of offered) {
    if (entry.scope !== "global") continue;
    switch (entry.effect.kind) {
      case "navigate":
        if (entry.shortcut === null || entry.effect.route === "new-task") anywhere.push(row(entry, t(actionWords[entry.id].palette), null, false));
        else goTo.push(row(entry, t(actionWords[entry.id].palette), null, false));
        break;
      case "call":
        anywhere.push(row(entry, entry.id === "toggle-theme" ? t(shownTheme === "dark" ? "palette.labels.toLight" : "palette.labels.toDark") : t(actionWords[entry.id].palette), null, false));
        break;
      case "panel":
        // Search and the sheet are the palette itself and its footer's `?`: no row.
        break;
      default:
        entry.effect satisfies never;
    }
  }
  const keep = (list: readonly ActionRow[]) => list.filter((one) => matchesQuery(one.id, one.label, query));
  return { page: keep(page), actions: keep(anywhere), goTo: keep(goTo) };
};
