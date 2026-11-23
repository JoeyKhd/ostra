import type { StoredEvent, TurnId } from "@ostra/protocol";
import { turnOrdinalsOf } from "@ostra/task-view";
import type { CheckCounts } from "@ostra/task-view";

import { formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { formatSize } from "@/task/marker-words";
import { pricedTurnsOf } from "@/task/thread/turn-spend";
import type { UsageTurn } from "@/task/thread/turn-spend";

import { boxParts } from "./task-ticket";

// Owner: ticket 16 (milestone 10, F-151/c3: the properties panel's Usage and Session groups,
// parts.md part 15). Where the bookkeeping lives for the task as a whole: the box, the work saved
// after the last turn that saved, and how many turns it ran. Pure, from `tasks.get` and the log.

type Task = RouterOutputs["tasks"]["get"];

/** What the Session group's `Saved work` says: the newest save, a turn still open with none, or none at all. */
export type SavedWork =
  | { readonly kind: "saved"; readonly turn: number | null; readonly archiveBytes: number | null }
  | { readonly kind: "open" }
  | { readonly kind: "none" };

/**
 * The work saved after the newest turn that saved (`session.saved`, which the runner writes after a
 * turn's end and before the next turn starts, ADR 0039, so it follows its session's last turn, as
 * the fold reads it), numbered as the task's turns are; with no save yet, whether a turn is open.
 */
export const savedWorkOf = (events: readonly StoredEvent[], ordinals: ReadonlyMap<TurnId, number>, turnOpen: boolean): SavedWork => {
  const lastTurn = new Map<string, TurnId>();
  let saved: SavedWork | null = null;
  for (const { sessionId, event } of events) {
    if (event.kind === "turn.started") lastTurn.set(String(sessionId), event.turnId);
    else if (event.kind === "session.saved") {
      const turnId = lastTurn.get(String(sessionId));
      saved = { kind: "saved", turn: turnId === undefined ? null : (ordinals.get(turnId) ?? null), archiveBytes: event.archive === null ? null : event.archive.size };
    }
  }
  return saved ?? (turnOpen ? { kind: "open" } : { kind: "none" });
};

/** A value and, `--faint` after ` · `, what follows it. */
export type RowWords = { readonly value: string; readonly detail: string | null };

/** `After turn 4` · `193 kB`; `Not yet: the turn is open`; `None yet`. */
export const savedWorkWords = (saved: SavedWork): RowWords => {
  switch (saved.kind) {
    case "saved":
      return {
        value: saved.turn === null ? t("taskPage.panel.afterATurn") : t("taskPage.panel.afterTurn", { n: saved.turn }),
        detail: saved.archiveBytes === null ? t("taskPage.panel.noArchive") : formatSize(saved.archiveBytes),
      };
    case "open":
      return { value: t("taskPage.panel.notYetOpen"), detail: null };
    case "none":
      return { value: t("taskPage.panel.noneYet"), detail: null };
    default:
      return saved satisfies never;
  }
};

/** The `Box` row: `Running` (`· waits on you` while the task needs a member), `Idle · stops in 11 min`, `Released · the PRs closed`. */
export const boxRowWords = (box: NonNullable<Task["box"]>, taskState: Task["state"], now: number): RowWords => {
  const { state, detail } = boxParts(box, now);
  return { value: state, detail: box.state === "running" && taskState === "needs_you" ? t("taskPage.box.waitsOnYou") : detail };
};

/** The `Tokens` row: `≈ 168k in · 24.1k out`, the stream's count when it's ahead of what `tasks.get` last read. */
export const tokensWords = (counted: { readonly inputTokens: number; readonly outputTokens: number }, live: { readonly inputTokens: number; readonly outputTokens: number }, estimated: boolean): string =>
  `${estimated ? "≈ " : ""}${formatTokens(Math.max(counted.inputTokens, live.inputTokens))} ${t("taskPage.in")} · ${formatTokens(Math.max(counted.outputTokens, live.outputTokens))} ${t("taskPage.out")}`;

/**
 * ostra's checks in the box as the newest save counted them (`session.saved`'s `checks`, as the
 * push's line reads them); `null` when no save counted any.
 */
export const savedChecksOf = (events: readonly StoredEvent[]): CheckCounts | null => {
  const saved = events.findLast(({ event }) => event.kind === "session.saved" && (event.checks?.length ?? 0) > 0)?.event;
  if (saved?.kind !== "session.saved" || saved.checks === undefined) return null;
  const passed = saved.checks.filter((check) => check.status === "passed").length;
  return { passed, failed: saved.checks.length - passed, total: saved.checks.length };
};

/** One of `tasks.get`'s `usage.turns`, as far as the Session group reads it. */
type UsageTurnRow = UsageTurn & { readonly endedAt: number | null };

/** What the panel reads of the task's turns: how many, whether one ended, the newest saved work and the checks it counted. */
export type PanelTurns = { readonly count: number; readonly anyEnded: boolean; readonly saved: SavedWork; readonly savedChecks: CheckCounts | null };

/**
 * The Session group's turns (parts.md part 15): how many the task ran (`usage.turns`, across its
 * sessions), whether one has ended yet (`Turns` shows from then on), and the newest saved work,
 * its turn numbered as the thread numbers it (`turnOrdinalsOf`), with the checks it counted.
 */
export const panelTurnsOf = (events: readonly StoredEvent[], turns: readonly UsageTurnRow[], turnOpen: boolean): PanelTurns => ({
  count: turns.length,
  anyEnded: turns.some((turn) => turn.endedAt !== null),
  saved: savedWorkOf(events, turnOrdinalsOf(pricedTurnsOf(events, turns)), turnOpen),
  savedChecks: savedChecksOf(events),
});
