import type { InboxTicket } from "./inbox-words";

// The Inbox's ticks for a bulk start (inbox-bulk-start.md, F-107): which tickets are ticked, kept by
// ID, never by a row's place. The list refreshes every few seconds and a changed ticket moves to
// the top, so a row's index names another ticket after a refresh: a tick, the panel's order and a
// Shift range's anchor all follow the ticket itself. "A ticket changes while ticked: it keeps its
// tick; its preview line refreshes" (the build spec).

export type Ticks = {
  /** Each ticked ticket by its ID, with the copy last seen: the list's own when it still shows it. */
  readonly byId: ReadonlyMap<string, InboxTicket>;
  /** The ticket a Shift range starts from: the one last ticked or unticked. */
  readonly anchor: string | null;
};

export const noTicks: Ticks = { byId: new Map(), anchor: null };

/**
 * Ticks or unticks one row; with `range`, every row between the anchor's row and it, as the list
 * stands now. The anchor no longer listed: just the row.
 */
export const toggleTick = (ticks: Ticks, rows: readonly InboxTicket[], ticket: InboxTicket, range: boolean): Ticks => {
  const id = String(ticket.id);
  const on = !ticks.byId.has(id);
  const at = rows.findIndex((row) => String(row.id) === id);
  const anchorAt = !range || ticks.anchor === null ? -1 : rows.findIndex((row) => String(row.id) === ticks.anchor);
  const span = at < 0 || anchorAt < 0 ? [ticket] : rows.slice(Math.min(anchorAt, at), Math.max(anchorAt, at) + 1);
  const next = new Map(ticks.byId);
  for (const row of span) {
    if (on) next.set(String(row.id), row);
    else next.delete(String(row.id));
  }
  return { byId: next, anchor: id };
};

/** Every loaded row ticked (⌘A). */
export const tickAll = (rows: readonly InboxTicket[]): Ticks => {
  const last = rows.at(-1);
  return { byId: new Map(rows.map((row) => [String(row.id), row] as const)), anchor: last === undefined ? null : String(last.id) };
};

/** These tickets unticked (a started row unticks as its result lands). */
export const untick = (ticks: Ticks, ids: Iterable<string>): Ticks => {
  const next = new Map(ticks.byId);
  let changed = false;
  for (const id of ids) changed = next.delete(id) || changed;
  return changed ? { byId: next, anchor: ticks.anchor !== null && next.has(ticks.anchor) ? ticks.anchor : null } : ticks;
};

/**
 * The ticked tickets in the list's order, each as the list has it now (a refresh's copy: a ticket
 * that gained a task previews as skipped); a ticked one the list no longer shows keeps its last
 * copy, after the rest.
 */
export const tickedRows = (ticks: Ticks, rows: readonly InboxTicket[]): readonly InboxTicket[] => {
  const listed = rows.filter((row) => ticks.byId.has(String(row.id)));
  const shown = new Set(listed.map((row) => String(row.id)));
  return [...listed, ...[...ticks.byId.values()].filter((ticket) => !shown.has(String(ticket.id)))];
};
