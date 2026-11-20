import type { HistoryRun } from "./automation-words";

// An automation's history in bands (automation-history.md, "Bands"): a schedule's runs under each
// occurrence, a "Start all" press's matches under the press, and a rule's own matches by day. The
// rows are `AutomationRun`s as the API returns them, newest first; a match a schedule's occurrence
// started has no `occurrenceAt` of its own, so it goes under the latest occurrence before it.

export type Band =
  | { readonly kind: "occurrence"; readonly key: string; readonly run: HistoryRun; readonly rows: readonly HistoryRun[] }
  | { readonly kind: "start-all"; readonly key: string; readonly run: HistoryRun; readonly rows: readonly HistoryRun[] }
  | { readonly kind: "day"; readonly key: string; readonly day: string; readonly at: number; readonly rows: readonly HistoryRun[] };

type Open = { kind: "occurrence" | "start-all"; key: string; run: HistoryRun; rows: HistoryRun[] } | { kind: "day"; key: string; day: string; at: number; rows: HistoryRun[] };

/**
 * Groups runs into bands, newest band first, each band's rows newest first. `dayOf` names a match's
 * day in the viewer's zone, for a rule's day bands.
 */
export const bandsOf = (runs: readonly HistoryRun[], dayOf: (at: number) => string): readonly Band[] => {
  const oldestFirst = [...runs].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const bands: Open[] = [];
  const pressBand = new Map<string, Open>();
  let lastOccurrence: Open | null = null;
  for (const run of oldestFirst) {
    if (run.kind === "occurrence") {
      const band: Open = { kind: "occurrence", key: run.id, run, rows: [] };
      bands.push(band);
      lastOccurrence = band;
    } else if (run.kind === "start_all") {
      const band: Open = { kind: "start-all", key: run.id, run, rows: [] };
      bands.push(band);
      if (run.bulkStartId !== null) pressBand.set(run.bulkStartId, band);
    } else {
      const press = run.bulkStartId === null ? undefined : pressBand.get(run.bulkStartId);
      if (press !== undefined) {
        press.rows.push(run);
      } else if (lastOccurrence !== null) {
        lastOccurrence.rows.push(run);
      } else {
        const day = dayOf(run.at);
        const last = bands.at(-1);
        if (last?.kind === "day" && last.day === day) last.rows.push(run);
        else bands.push({ kind: "day", key: `day-${day}-${run.id}`, day, at: run.at, rows: [run] });
      }
    }
  }
  return bands.reverse().map((band) => ({ ...band, rows: [...band.rows].reverse() }));
};

/** The matches in a list of runs (a match is a ticket's run). */
export const matchCount = (runs: readonly HistoryRun[]): number => runs.filter((run) => run.kind === "ticket_match").length;
export const occurrenceCount = (runs: readonly HistoryRun[]): number => runs.filter((run) => run.kind === "occurrence").length;
