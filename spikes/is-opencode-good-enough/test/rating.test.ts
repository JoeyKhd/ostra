import { describe, expect, it } from "vitest";
import { fenced, seededRandom, shuffled } from "../src/rating/make-sheet.ts";
import { BlindIdSchema, KeyFileSchema, type KeyFile } from "../src/rating/schemas.ts";
import { agreement, mergeableShare, parseRatings, scoreRater, verdictOf, verdictsBySet } from "../src/rating/score.ts";

const key = (entries: readonly { id: string; ticket: string; set: string }[]): KeyFile =>
  KeyFileSchema.parse({
    schema: 1,
    seed: 1,
    createdAt: "2026-11-18T00:00:00.000Z",
    entries: entries.map((e, i) => ({ id: BlindIdSchema.parse(e.id), runId: `${e.ticket}-r${String((i % 3) + 1)}`, ticketId: e.ticket, setDir: e.set })),
  });

const csv = (rows: readonly (readonly [string, string])[]): string => `id,rating,notes\n${rows.map(([id, rating]) => `${id},${rating},`).join("\n")}\n`;

const four = key([
  { id: "R-000001", ticket: "calc-1", set: ".runs/real-a" },
  { id: "R-000002", ticket: "calc-1", set: ".runs/real-a" },
  { id: "R-000003", ticket: "calc-2", set: ".runs/real-a" },
  { id: "R-000004", ticket: "calc-2", set: ".runs/real-a" },
]);

describe("the seeded shuffle", () => {
  it("gives the same order for the same seed, another for another, and keeps every item", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const a = shuffled(items, seededRandom(7));
    expect(shuffled(items, seededRandom(7))).toEqual(a);
    expect(shuffled(items, seededRandom(8))).not.toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(a).not.toEqual(items);
  });
});

describe("fenced", () => {
  it("uses a fence longer than any run of backticks in the text, so the text cannot close it", () => {
    const hostile = "before\n```\n## injected heading\n````\nafter";
    const out = fenced(hostile, "text");
    expect(out.startsWith("`````text\n")).toBe(true);
    expect(out.endsWith("\n`````")).toBe(true);
    expect(out).toContain(hostile);
  });

  it("uses three backticks for plain text", () => {
    expect(fenced("plain\n", "diff")).toBe("```diff\nplain\n```");
  });
});

describe("scoring", () => {
  it("passes at exactly half, and fails below it", () => {
    const half = scoreRater(four, "a", parseRatings(csv([["R-000001", "merge-as-is"], ["R-000002", "merge-with-small-edits"], ["R-000003", "reject"], ["R-000004", "reject"]])));
    expect(half.mergeable).toBe(2);
    expect(mergeableShare(half)).toBe(0.5);
    expect(verdictOf([half]).status).toBe("PASS");
    const under = scoreRater(four, "a", parseRatings(csv([["R-000001", "merge-as-is"], ["R-000002", "reject"], ["R-000003", "reject"], ["R-000004", "reject"]])));
    expect(verdictOf([under]).status).toBe("FAIL");
  });

  it("is skipped, not failed, when ratings are missing, off the scale, doubled or for IDs not on the sheet", () => {
    const missing = scoreRater(four, "a", parseRatings(csv([["R-000001", "merge-as-is"]])));
    expect(missing.missing).toHaveLength(3);
    expect(verdictOf([missing]).status).toBe("SKIPPED");
    const invalid = scoreRater(four, "a", parseRatings(csv([["R-000001", "lgtm"], ["R-000002", "reject"], ["R-000003", "reject"], ["R-000004", "reject"]])));
    expect(invalid.invalid).toEqual([{ id: "R-000001", value: "lgtm" }]);
    expect(verdictOf([invalid]).status).toBe("SKIPPED");
    const doubled = scoreRater(four, "a", parseRatings(csv([["R-000001", "reject"], ["R-000001", "reject"], ["R-000002", "reject"], ["R-000003", "reject"], ["R-000004", "reject"]])));
    expect(doubled.duplicated).toEqual(["R-000001"]);
    const stranger = scoreRater(four, "a", parseRatings(csv([["R-000001", "reject"], ["R-000002", "reject"], ["R-000003", "reject"], ["R-000004", "reject"], ["R-ffffff", "reject"]])));
    expect(stranger.unknown).toEqual(["R-ffffff"]);
    expect(stranger.complete).toBe(true);
  });

  it("accepts any case in the rating column, and rejects a file with no header", () => {
    expect(scoreRater(four, "a", parseRatings(csv([["R-000001", "MERGE-AS-IS"]]))).counts["merge-as-is"]).toBe(1);
    expect(parseRatings("R-000001,reject\n").problems).toHaveLength(1);
  });

  it("holds the bar against the strictest of several raters, and reports agreement", () => {
    const strict = scoreRater(four, "strict", parseRatings(csv([["R-000001", "merge-as-is"], ["R-000002", "reject"], ["R-000003", "reject"], ["R-000004", "reject"]])));
    const kind = scoreRater(four, "kind", parseRatings(csv([["R-000001", "merge-as-is"], ["R-000002", "merge-as-is"], ["R-000003", "merge-with-small-edits"], ["R-000004", "reject"]])));
    const verdict = verdictOf([strict, kind]);
    expect(verdict.status).toBe("FAIL");
    expect(verdict.note).toContain("strictest rater (strict)");
    const agree = agreement([strict, kind]);
    expect(agree?.exact).toBe(0.5);
    expect(agree?.sameSide).toBe(0.5);
  });

  it("scores each set of runs against its own bar", () => {
    const two = key([
      { id: "R-000001", ticket: "calc-1", set: ".runs/real-a" },
      { id: "R-000002", ticket: "calc-2", set: ".runs/real-a" },
      { id: "R-000003", ticket: "calc-1", set: ".runs/real-b" },
      { id: "R-000004", ticket: "calc-2", set: ".runs/real-b" },
    ]);
    const parsed = parseRatings(csv([["R-000001", "merge-as-is"], ["R-000002", "merge-as-is"], ["R-000003", "reject"], ["R-000004", "reject"]]));
    const verdicts = verdictsBySet(two, [{ rater: "a", parsed }]);
    expect(verdicts.map((v) => [v.setDir, v.verdict.status])).toEqual([
      [".runs/real-a", "PASS"],
      [".runs/real-b", "FAIL"],
    ]);
  });

  it("counts a run with no change as a run that was not mergeable, not as a missing one", () => {
    const rated = scoreRater(four, "a", parseRatings(csv([["R-000001", "reject"], ["R-000002", "reject"], ["R-000003", "merge-as-is"], ["R-000004", "merge-as-is"]])));
    expect(rated.byTicket).toEqual([
      { ticketId: "calc-1", runs: 2, mergeable: 0 },
      { ticketId: "calc-2", runs: 2, mergeable: 2 },
    ]);
  });
});
