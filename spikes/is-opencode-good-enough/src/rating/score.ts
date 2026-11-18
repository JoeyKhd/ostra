// Scoring the ratings. The pass bar: of the runs, at least half are rated
// "merge as it is" or "merge with small edits" (a working value). The
// share is of all runs, not only the ones that finished: a run that left
// nothing, or timed out, counts as a run that wasn't mergeable.
//
// With more than one rater the bar is held against the strictest one, and
// their agreement is reported.

import { parseCsv } from "./csv.ts";
import type { TicketId } from "../tickets/schema.ts";
import { isMergeable, RATINGS, RatingSchema, type KeyEntry, type KeyFile, type Rating } from "./schemas.ts";

export type RatingRow = { readonly id: string; readonly rating: string; readonly notes: string };

export type ParsedRatings = { readonly rows: readonly RatingRow[]; readonly problems: readonly string[] };

/** Reads a ratings file: a header of id, rating, notes, then a row per pull request. */
export const parseRatings = (csv: string): ParsedRatings => {
  const table = parseCsv(csv);
  const header = table[0]?.map((cell) => cell.trim().toLowerCase());
  if (header?.[0] !== "id" || header[1] !== "rating") {
    return { rows: [], problems: ["the first row must be the header: id,rating,notes"] };
  }
  const rows = table.slice(1).map((cells) => ({ id: (cells[0] ?? "").trim(), rating: (cells[1] ?? "").trim().toLowerCase(), notes: (cells[2] ?? "").trim() }));
  return { rows, problems: [] };
};

export type TicketScore = { readonly ticketId: TicketId; readonly runs: number; readonly mergeable: number };

export type RaterScore = {
  readonly rater: string;
  readonly total: number;
  readonly rated: number;
  readonly counts: Readonly<Record<Rating, number>>;
  readonly mergeable: number;
  /** The key's IDs with no rating in the file. */
  readonly missing: readonly string[];
  /** Rows whose rating is not one of the scale's words. */
  readonly invalid: readonly { readonly id: string; readonly value: string }[];
  /** Rows whose ID is not on the sheet. */
  readonly unknown: readonly string[];
  /** Rows that rate one ID twice. */
  readonly duplicated: readonly string[];
  readonly problems: readonly string[];
  readonly complete: boolean;
  readonly byTicket: readonly TicketScore[];
  /** Each key ID's rating, for agreement. */
  readonly byId: ReadonlyMap<string, Rating>;
};

export const scoreRater = (key: KeyFile, rater: string, parsed: ParsedRatings): RaterScore => {
  const known = new Map<string, KeyEntry>(key.entries.map((entry) => [entry.id, entry]));
  const byId = new Map<string, Rating>();
  const invalid: { id: string; value: string }[] = [];
  const unknown: string[] = [];
  const duplicated: string[] = [];
  for (const row of parsed.rows) {
    if (!known.has(row.id)) {
      unknown.push(row.id);
      continue;
    }
    if (row.rating === "") continue;
    const rating = RatingSchema.safeParse(row.rating);
    if (!rating.success) {
      invalid.push({ id: row.id, value: row.rating });
      continue;
    }
    if (byId.has(row.id)) duplicated.push(row.id);
    byId.set(row.id, rating.data);
  }
  const counts: Record<Rating, number> = { "merge-as-is": 0, "merge-with-small-edits": 0, reject: 0 };
  for (const rating of byId.values()) counts[rating] += 1;
  const missing: string[] = key.entries.map((entry) => entry.id).filter((id) => !byId.has(id));
  const tickets = new Map<TicketId, { runs: number; mergeable: number }>();
  for (const entry of key.entries) {
    const slot = tickets.get(entry.ticketId) ?? { runs: 0, mergeable: 0 };
    slot.runs += 1;
    const rating = byId.get(entry.id);
    if (rating !== undefined && isMergeable(rating)) slot.mergeable += 1;
    tickets.set(entry.ticketId, slot);
  }
  const ticketNumber = (id: string): number => Number(id.replace(/^\D+/, ""));
  return {
    rater,
    total: key.entries.length,
    rated: byId.size,
    counts,
    mergeable: counts["merge-as-is"] + counts["merge-with-small-edits"],
    missing,
    invalid,
    unknown,
    duplicated,
    problems: parsed.problems,
    complete: missing.length === 0 && invalid.length === 0 && duplicated.length === 0 && parsed.problems.length === 0,
    byTicket: [...tickets.entries()].map(([ticketId, slot]) => ({ ticketId, ...slot })).sort((a, b) => ticketNumber(a.ticketId) - ticketNumber(b.ticketId)),
    byId,
  };
};

/** The share of runs rated mergeable, as the pass bar counts them. */
export const mergeableShare = (score: RaterScore): number => (score.total === 0 ? 0 : score.mergeable / score.total);

export type Agreement = {
  readonly raters: readonly string[];
  /** The share of runs every rater rated the same. */
  readonly exact: number;
  /** The share of runs every rater put on the same side of the bar (mergeable or not). */
  readonly sameSide: number;
};

export const agreement = (scores: readonly RaterScore[]): Agreement | undefined => {
  if (scores.length < 2) return undefined;
  const first = scores[0];
  if (first === undefined) return undefined;
  const ids = [...first.byId.keys()];
  const all = ids.filter((id) => scores.every((score) => score.byId.has(id)));
  if (all.length === 0) return undefined;
  const exact = all.filter((id) => new Set(scores.map((score) => score.byId.get(id))).size === 1).length;
  const sameSide = all.filter((id) => new Set(scores.map((score) => (isMergeable(score.byId.get(id) ?? "reject") ? "m" : "r"))).size === 1).length;
  return { raters: scores.map((score) => score.rater), exact: exact / all.length, sameSide: sameSide / all.length };
};

export type Verdict = { readonly status: "PASS" | "FAIL" | "SKIPPED"; readonly note: string };

export const THRESHOLD = 0.5;

export const verdictOf = (scores: readonly RaterScore[]): Verdict => {
  if (scores.length === 0) {
    return { status: "SKIPPED", note: "no ratings file: a reviewer fills in the rating column of ratings-template.csv and saves it as ratings/<name>.csv next to the sheet" };
  }
  const incomplete = scores.filter((score) => !score.complete);
  if (incomplete.length > 0) {
    const detail = incomplete
      .map((score) => `${score.rater}: ${String(score.missing.length)} unrated, ${String(score.invalid.length)} not on the scale, ${String(score.duplicated.length)} rated twice${score.problems.length > 0 ? `, ${score.problems.join("; ")}` : ""}`)
      .join("; ");
    return { status: "SKIPPED", note: `the ratings are incomplete (${detail})` };
  }
  const shares = scores.map((score) => ({ rater: score.rater, share: mergeableShare(score) }));
  const strictest = shares.reduce((a, b) => (b.share < a.share ? b : a));
  const text = shares.map((s) => `${s.rater} ${(s.share * 100).toFixed(0)}%`).join(", ");
  return {
    status: strictest.share >= THRESHOLD ? "PASS" : "FAIL",
    note: `${text} of the runs rated merge-as-is or merge-with-small-edits; the bar is at least ${(THRESHOLD * 100).toFixed(0)}%${scores.length > 1 ? `, held against the strictest rater (${strictest.rater})` : ""}`,
  };
};

export const RATING_WORDS = RATINGS;

export type SetVerdict = { readonly setDir: string; readonly runs: number; readonly scores: readonly RaterScore[]; readonly verdict: Verdict };

/**
 * One verdict per set of runs: the bar is about one model's runs, and a sheet
 * may hold the runs of two models (the fallback repeats the spike on a second
 * one). Each set is scored as if it had its own sheet.
 */
export const verdictsBySet = (key: KeyFile, raters: readonly { readonly rater: string; readonly parsed: ParsedRatings }[]): SetVerdict[] => {
  const sets = [...new Set(key.entries.map((entry) => entry.setDir))];
  return sets.map((setDir) => {
    const sub: KeyFile = { ...key, entries: key.entries.filter((entry) => entry.setDir === setDir) };
    const scores = raters.map((r) => scoreRater(sub, r.rater, r.parsed));
    return { setDir, runs: sub.entries.length, scores, verdict: verdictOf(scores) };
  });
};
