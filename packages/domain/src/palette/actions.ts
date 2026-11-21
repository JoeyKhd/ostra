import type { OrganizationRole } from "../access.ts";

// The command palette's actions and the panel's shortcuts (F-081; milestone 7, ticket 36; spec
// section 12, item 11). One registry: the palette lists these, the keyboard fires them, the `?`
// sheet prints them, and the API checks the same conditions the panel offers them under, so a
// shortcut can't exist without its sheet line and the panel can't offer what the API refuses.
// Shortcuts never take a modifier (⌘K or Ctrl+K, which opens the palette, is the one exception and
// isn't an action), and none fires while typing in a field: that is the panel's to enforce.

/**
 * Where an action is offered. `global` is everywhere; `needs-you-item` needs a focused "needs you"
 * item (an approval or a question); `task` needs a task page.
 */
export const paletteScopes = ["global", "needs-you-item", "task"] as const;
export type PaletteScope = (typeof paletteScopes)[number];

/** The keys pressed one after the other, without a modifier: `["g", "n"]` is `g` then `n`. */
export type PaletteShortcut = readonly [string] | readonly [string, string];

/** The panel's own destinations an action can go to. */
export const paletteRoutes = ["needs-you", "home", "tasks", "new-task", "new-project", "projects", "organization"] as const;
export type PaletteRoute = (typeof paletteRoutes)[number];

/** The tRPC procedures an action calls. The API's routers name these same paths. */
export const paletteProcedures = [
  "approvals.answer",
  "questions.answer",
  "tasks.takeOver",
  "tasks.reopen",
  "tasks.stop",
  "tasks.send",
  "account.setTheme",
] as const;
export type PaletteProcedure = (typeof paletteProcedures)[number];

/** What an action does: call a procedure, go to a page, or work the panel itself. */
export type PaletteEffect =
  | { readonly kind: "call"; readonly procedure: PaletteProcedure }
  | { readonly kind: "navigate"; readonly route: PaletteRoute }
  | { readonly kind: "panel"; readonly does: "focus-search" | "open-shortcut-sheet" | "toggle-sidebar" | "toggle-side-pane" | "expand-preview" };

export type PaletteActionId =
  | "go-needs-you"
  | "go-home"
  | "go-tasks"
  | "go-projects"
  | "go-organization"
  | "toggle-sidebar"
  | "search"
  | "shortcut-sheet"
  | "new-task"
  | "new-project"
  | "toggle-theme"
  | "approve"
  | "deny"
  | "answer"
  | "take-over"
  | "reopen"
  | "stop"
  | "steer"
  | "toggle-side-pane"
  | "expand-preview";

/** One action of the registry: its ID, its words, its shortcut, when it's offered and what it does. */
export type PaletteAction = {
  readonly id: PaletteActionId;
  /** The key of its words in `apps/web/messages/en.json`. */
  readonly messageKey: `palette.actions.${string}`;
  readonly shortcut: PaletteShortcut | null;
  readonly scope: PaletteScope;
  /** The least organization role that is offered it. The API still checks project access. */
  readonly role: OrganizationRole;
  readonly effect: PaletteEffect;
  /** The panel asks to confirm before it runs (stop). */
  readonly confirm: boolean;
};

const action = (
  id: PaletteActionId,
  shortcut: PaletteShortcut | null,
  scope: PaletteScope,
  effect: PaletteEffect,
  options: { readonly role?: OrganizationRole; readonly confirm?: boolean } = {},
): PaletteAction => ({
  id,
  messageKey: `palette.actions.${id}`,
  shortcut,
  scope,
  role: options.role ?? "member",
  effect,
  confirm: options.confirm ?? false,
});

/**
 * Spec section 12, item 11: every action and shortcut of milestone 7, milestone 8's three for the
 * double sidebar (F-147, app-shell.md "Keyboard"): `g p`, `g o` and `[`, and its two for the task
 * page's preview (F-141, task-preview.md "Keyboard"): `p` switches the side pane between the
 * preview and the properties, and `f` expands the preview to the page's width and back.
 */
export const paletteActions: readonly PaletteAction[] = Object.freeze([
  action("go-needs-you", ["g", "n"], "global", { kind: "navigate", route: "needs-you" }),
  action("go-home", ["g", "h"], "global", { kind: "navigate", route: "home" }),
  action("go-tasks", ["g", "t"], "global", { kind: "navigate", route: "tasks" }),
  action("go-projects", ["g", "p"], "global", { kind: "navigate", route: "projects" }),
  action("go-organization", ["g", "o"], "global", { kind: "navigate", route: "organization" }),
  action("toggle-sidebar", ["["], "global", { kind: "panel", does: "toggle-sidebar" }),
  action("search", ["/"], "global", { kind: "panel", does: "focus-search" }),
  action("shortcut-sheet", ["?"], "global", { kind: "panel", does: "open-shortcut-sheet" }),
  action("new-task", ["c"], "global", { kind: "navigate", route: "new-task" }),
  action("new-project", null, "global", { kind: "navigate", route: "new-project" }, { role: "admin" }),
  action("toggle-theme", null, "global", { kind: "call", procedure: "account.setTheme" }),
  action("approve", ["a"], "needs-you-item", { kind: "call", procedure: "approvals.answer" }),
  action("deny", ["d"], "needs-you-item", { kind: "call", procedure: "approvals.answer" }),
  action("answer", ["r"], "needs-you-item", { kind: "call", procedure: "questions.answer" }),
  action("take-over", ["t"], "task", { kind: "call", procedure: "tasks.takeOver" }),
  action("reopen", ["o"], "task", { kind: "call", procedure: "tasks.reopen" }),
  action("stop", ["s"], "task", { kind: "call", procedure: "tasks.stop" }, { confirm: true }),
  action("steer", null, "task", { kind: "call", procedure: "tasks.send" }),
  action("toggle-side-pane", ["p"], "task", { kind: "panel", does: "toggle-side-pane" }),
  action("expand-preview", ["f"], "task", { kind: "panel", does: "expand-preview" }),
]);

/** A shortcut as the sheet and the clash check spell it: `g n`. */
export const shortcutText = (shortcut: PaletteShortcut): string => shortcut.join(" ");

/** The scopes an action's shortcut is live in: a global one fires in every scope. */
const liveIn = (scope: PaletteScope): readonly PaletteScope[] => (scope === "global" ? paletteScopes : [scope]);

/** Two shortcuts that can't both be live: the same keys, or one is the other's first key. */
const clashes = (a: PaletteShortcut, b: PaletteShortcut): boolean => {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.every((key, at) => longer[at] === key);
};

export type ShortcutClash = { readonly scope: PaletteScope; readonly actions: readonly [PaletteActionId, PaletteActionId]; readonly keys: string };

/**
 * Every pair of actions whose shortcuts would fight in one scope: the same keys, or a single key
 * that is another's first (so the sequence could never be typed). A global shortcut is live in
 * every scope. Empty for a sound registry.
 */
export const shortcutClashes = (actions: readonly PaletteAction[]): readonly ShortcutClash[] => {
  const found: ShortcutClash[] = [];
  for (const scope of paletteScopes) {
    const live = actions.filter((entry) => entry.shortcut !== null && liveIn(entry.scope).includes(scope));
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i];
        const b = live[j];
        if (a === undefined || b === undefined || a.shortcut === null || b.shortcut === null) {
          continue;
        }
        if (clashes(a.shortcut, b.shortcut)) {
          found.push({ scope, actions: [a.id, b.id], keys: shortcutText(a.shortcut.length <= b.shortcut.length ? a.shortcut : b.shortcut) });
        }
      }
    }
  }
  return found;
};

/** One printable key: a single character that isn't a space. Modifiers aren't keys here. */
const plainKey = /^[^\s]$/u;

/**
 * What is wrong with a registry, in words for a test's failure: a duplicate ID, an action without
 * its words, a key that isn't one plain character, and every shortcut clash. (A scope and a role
 * the type already requires.)
 */
export const registryProblems = (actions: readonly PaletteAction[]): readonly string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of actions) {
    if (seen.has(entry.id)) {
      problems.push(`${entry.id}: listed twice`);
    }
    seen.add(entry.id);
    if (!/^palette\.actions\.[a-z][a-z-]*$/.test(entry.messageKey)) {
      problems.push(`${entry.id}: no message key`);
    }
    for (const key of entry.shortcut ?? []) {
      if (!plainKey.test(key)) {
        problems.push(`${entry.id}: the key "${key}" isn't one plain character`);
      }
    }
  }
  for (const clash of shortcutClashes(actions)) {
    problems.push(`${clash.actions[0]} and ${clash.actions[1]} share "${clash.keys}" in ${clash.scope}`);
  }
  return problems;
};

/** What the panel has in focus when it offers actions, and who is looking. */
export type PaletteContext = {
  readonly role: OrganizationRole;
  /** The scopes present: `global` always; `needs-you-item` with a focused item; `task` on a task page. */
  readonly scopes: readonly PaletteScope[];
};

/** Whether an action is offered: its scope is present and the member's role reaches its role. */
export const isPaletteActionOffered = (entry: PaletteAction, context: PaletteContext): boolean => {
  const scoped = entry.scope === "global" || context.scopes.includes(entry.scope);
  const allowed = entry.role === "member" || context.role === "admin";
  return scoped && allowed;
};

/** The actions offered in a context, in the registry's order: what the palette lists. */
export const offeredPaletteActions = (context: PaletteContext, actions: readonly PaletteAction[] = paletteActions): readonly PaletteAction[] =>
  actions.filter((entry) => isPaletteActionOffered(entry, context));

/** The action a shortcut fires in a context, or `null`. Never one the context doesn't offer. */
export const actionForShortcut = (
  keys: readonly string[],
  context: PaletteContext,
  actions: readonly PaletteAction[] = paletteActions,
): PaletteAction | null =>
  offeredPaletteActions(context, actions).find(
    (entry) => entry.shortcut !== null && entry.shortcut.length === keys.length && entry.shortcut.every((key, at) => keys[at] === key),
  ) ?? null;
