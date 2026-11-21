// The keyboard inside the rail and the context panel (F-147; app-shell.md, "Keyboard"): ↑ and ↓
// move through the items, Home and End jump to the ends. Pure: the index the focus moves to, or
// `null` for a key that isn't the list's to handle.

export const rovingKeys = ["ArrowUp", "ArrowDown", "Home", "End"] as const;
export type RovingKey = (typeof rovingKeys)[number];

const isRovingKey = (key: string): key is RovingKey => rovingKeys.some((one) => one === key);

/** Where the focus goes from `index` of `count` items on `key`; the arrows stop at the ends. */
export const nextRovingIndex = (key: string, index: number, count: number): number | null => {
  if (count <= 0 || !isRovingKey(key)) return null;
  const from = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowUp":
      return Math.max(from - 1, 0);
    case "ArrowDown":
      return Math.min(from + 1, count - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return key satisfies never;
  }
};

/** The items a list's arrows move through: its links and buttons, in order, skipping what's hidden or disabled. */
export const ROVING_ITEM = "[data-roving-item]";

/**
 * Handles an arrow key in a list whose items carry `data-roving-item`. With `roving`, only the
 * focused item is in the Tab order (the rail: one tab stop); without, every item keeps its own stop
 * and the arrows are a shortcut (the panel's rows).
 */
export const moveFocus = (event: { readonly key: string; readonly currentTarget: Element; readonly target: EventTarget | null; preventDefault: () => void }, roving: boolean): boolean => {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ROVING_ITEM)].filter((item) => item.getClientRects().length > 0 && !item.hasAttribute("disabled"));
  // Only an item itself: a key inside a menu one of them opened (a portal, outside this list) is the menu's.
  const current = items.findIndex((item) => item === event.target);
  if (current < 0) return false;
  const next = nextRovingIndex(event.key, current, items.length);
  if (next === null) return false;
  event.preventDefault();
  const target = items[next];
  if (target === undefined) return false;
  if (roving) {
    for (const item of items) item.tabIndex = item === target ? 0 : -1;
  }
  target.focus();
  return true;
};

/**
 * The list's key handler, in the capture phase: an item that opens a menu (the organization tile,
 * the account, All projects) would open it on ↓ otherwise, so a key the list moves on stops there.
 */
export const rovingKeyDown = (roving: boolean) => (event: { readonly key: string; readonly currentTarget: Element; readonly target: EventTarget | null; preventDefault: () => void; stopPropagation: () => void }): void => {
  if (moveFocus(event, roving)) event.stopPropagation();
};
