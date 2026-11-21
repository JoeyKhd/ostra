import { actionForShortcut, offeredPaletteActions, paletteActions, paletteScopes } from "@ostra/domain/palette";
import type { PaletteAction, PaletteActionId, PaletteContext, PaletteScope, PaletteShortcut } from "@ostra/domain/palette";

import type { MessageKey } from "@/lib/messages";

// The panel's one registry of actions (F-081, ticket 13; command-palette.md, shortcut-sheet.md): the
// domain's `paletteActions` with the panel's words. The palette lists them, the key listener
// (`use-shortcuts.ts`) fires them, and the `?` sheet prints them, so a shortcut can't exist without
// its sheet line. Nothing here keeps a list of its own.

export type { PaletteAction, PaletteActionId, PaletteContext, PaletteScope, PaletteShortcut };
export { actionForShortcut, offeredPaletteActions };

/** The registry the panel reads. Tests pass their own to `sheetLines` to show a new action gets its line. */
export const registry: readonly PaletteAction[] = paletteActions;

/**
 * Each action's words: `sheet` is the domain's `messageKey` (the action named plainly, as the sheet
 * prints it), `palette` the palette's row (`Approve…` for one that needs a choice), `keywords` the
 * other words the palette's filter matches (`allow` finds approve).
 */
export const actionWords = {
  "go-needs-you": { sheet: "palette.actions.go-needs-you", palette: "palette.labels.go-needs-you", keywords: "palette.keywords.go-needs-you" },
  "go-home": { sheet: "palette.actions.go-home", palette: "palette.labels.go-home", keywords: "palette.keywords.go-home" },
  "go-tasks": { sheet: "palette.actions.go-tasks", palette: "palette.labels.go-tasks", keywords: "palette.keywords.go-tasks" },
  "go-projects": { sheet: "palette.actions.go-projects", palette: "palette.labels.go-projects", keywords: "palette.keywords.go-projects" },
  "go-organization": { sheet: "palette.actions.go-organization", palette: "palette.labels.go-organization", keywords: "palette.keywords.go-organization" },
  "toggle-sidebar": { sheet: "palette.actions.toggle-sidebar", palette: "palette.labels.toggle-sidebar", keywords: "palette.keywords.toggle-sidebar" },
  search: { sheet: "palette.actions.search", palette: "palette.labels.search", keywords: "palette.keywords.search" },
  "shortcut-sheet": { sheet: "palette.actions.shortcut-sheet", palette: "palette.labels.shortcut-sheet", keywords: "palette.keywords.shortcut-sheet" },
  "new-task": { sheet: "palette.actions.new-task", palette: "palette.labels.new-task", keywords: "palette.keywords.new-task" },
  "new-project": { sheet: "palette.actions.new-project", palette: "palette.labels.new-project", keywords: "palette.keywords.new-project" },
  "toggle-theme": { sheet: "palette.actions.toggle-theme", palette: "palette.labels.toggle-theme", keywords: "palette.keywords.toggle-theme" },
  approve: { sheet: "palette.actions.approve", palette: "palette.labels.approve", keywords: "palette.keywords.approve" },
  deny: { sheet: "palette.actions.deny", palette: "palette.labels.deny", keywords: "palette.keywords.deny" },
  answer: { sheet: "palette.actions.answer", palette: "palette.labels.answer", keywords: "palette.keywords.answer" },
  "take-over": { sheet: "palette.actions.take-over", palette: "palette.labels.take-over", keywords: "palette.keywords.take-over" },
  reopen: { sheet: "palette.actions.reopen", palette: "palette.labels.reopen", keywords: "palette.keywords.reopen" },
  stop: { sheet: "palette.actions.stop", palette: "palette.labels.stop", keywords: "palette.keywords.stop" },
  steer: { sheet: "palette.actions.steer", palette: "palette.labels.steer", keywords: "palette.keywords.steer" },
  "toggle-side-pane": { sheet: "palette.actions.toggle-side-pane", palette: "palette.labels.toggle-side-pane", keywords: "palette.keywords.toggle-side-pane" },
  "expand-preview": { sheet: "palette.actions.expand-preview", palette: "palette.labels.expand-preview", keywords: "palette.keywords.expand-preview" },
} as const satisfies Record<PaletteActionId, { readonly sheet: MessageKey; readonly palette: MessageKey; readonly keywords: MessageKey }>;

/** The sheet's scopes, in its order, each with its label and the condition it holds under. */
export const scopeWords = {
  global: { label: "shortcuts.scope.global", note: null },
  "needs-you-item": { label: "shortcuts.scope.needs-you-item", note: "shortcuts.scopeNote.needs-you-item" },
  task: { label: "shortcuts.scope.task", note: "shortcuts.scopeNote.task" },
} as const satisfies Record<PaletteScope, { readonly label: MessageKey; readonly note: MessageKey | null }>;

export type SheetLine = { readonly id: PaletteActionId; readonly shortcut: PaletteShortcut; readonly confirm: boolean };
export type SheetSection = { readonly scope: PaletteScope; readonly lines: readonly SheetLine[] };

/**
 * The `?` sheet's lines: every action with a shortcut, by scope, in the registry's order. A scope
 * with no shortcut has no section.
 */
export const sheetLines = (actions: readonly PaletteAction[] = registry): readonly SheetSection[] =>
  paletteScopes.flatMap((scope) => {
    const lines = actions.flatMap((entry): SheetLine[] => (entry.scope === scope && entry.shortcut !== null ? [{ id: entry.id, shortcut: entry.shortcut, confirm: entry.confirm }] : []));
    return lines.length === 0 ? [] : [{ scope, lines }];
  });

/** The registry's action by its ID. */
export const actionById = (id: PaletteActionId, actions: readonly PaletteAction[] = registry): PaletteAction | null => actions.find((entry) => entry.id === id) ?? null;
