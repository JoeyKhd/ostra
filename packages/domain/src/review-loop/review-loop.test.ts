import { randomUUID } from "node:crypto";

import type { CiCheckRun, CiResults, CiStatus } from "@ostra/adapter-sdk";
import { repoIdSchema } from "@ostra/protocol";
import type { Finding } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { ciVerdict, failingChecks } from "./ci-verdict.ts";
import { ownersFor, ownersOf, parseCodeOwners, patternMatcher } from "./codeowners.ts";
import { findingCommentBody, placeFindings, reviewBody } from "./place-findings.ts";
import { countRound, NO_ROUNDS, resetOnPersonAction, roundAllowed } from "./rounds.ts";
import type { RoundCounters } from "./rounds.ts";

// The review loop's pure parts (F-035, F-100, F-101, F-102, F-105; ADR 0041, ADR 0058).

const pushedAt = Date.UTC(2026, 10, 20, 10);
const run = (fields: Partial<CiCheckRun>): CiCheckRun => ({
  id: randomUUID(),
  name: "test",
  appSlug: "github-actions",
  status: "completed",
  conclusion: "success",
  detailsUrl: null,
  startedAt: pushedAt,
  completedAt: pushedAt + 60_000,
  ...fields,
});
const status = (fields: Partial<CiStatus>): CiStatus => ({ context: "ci/legacy", state: "success", targetUrl: null, description: null, ...fields });
const results = (checkRuns: readonly CiCheckRun[], statuses: readonly CiStatus[] = []): CiResults => ({ checkRuns, statuses });

describe("CI's verdict", () => {
  const own = "ostra-app";

  it("F-035: fails on a failing check run or status, and passes when everything finished otherwise", () => {
    expect(ciVerdict(results([run({}), run({ conclusion: "skipped" }), run({ conclusion: "neutral" })]), own, pushedAt + 300_000, pushedAt)).toBe("passed");
    for (const conclusion of ["failure", "timed_out", "action_required", "startup_failure"] as const) {
      expect(ciVerdict(results([run({}), run({ conclusion })]), own, pushedAt + 300_000, pushedAt), conclusion).toBe("failed");
    }
    expect(ciVerdict(results([run({})], [status({ state: "error" })]), own, pushedAt + 300_000, pushedAt)).toBe("failed");
    expect(ciVerdict(results([run({})], [status({ state: "failure" })]), own, pushedAt + 300_000, pushedAt)).toBe("failed");
    // A failure doesn't wait for the rest.
    expect(ciVerdict(results([run({ status: "in_progress", conclusion: null }), run({ conclusion: "failure" })]), own, pushedAt + 1_000, pushedAt)).toBe("failed");
  });

  it("F-035: leaves ostra's own check runs out, so the independent-review check never holds CI", () => {
    const reviewCheck = run({ appSlug: own, status: "in_progress", conclusion: null, name: "ostra / independent review" });
    expect(ciVerdict(results([run({}), reviewCheck]), own, pushedAt + 300_000, pushedAt)).toBe("passed");
    expect(ciVerdict(results([run({ appSlug: own, conclusion: "failure" })]), own, pushedAt + 300_000, pushedAt)).toBe("none");
  });

  it("F-035: says no CI after 2 minutes with nothing, and times out after 60 pending", () => {
    expect(ciVerdict(results([]), own, pushedAt + 119_000, pushedAt)).toBe("pending");
    expect(ciVerdict(results([]), own, pushedAt + 120_000, pushedAt)).toBe("none");
    const pending = results([run({ status: "queued", conclusion: null })], [status({ state: "pending" })]);
    expect(ciVerdict(pending, own, pushedAt + 59 * 60_000, pushedAt)).toBe("pending");
    expect(ciVerdict(pending, own, pushedAt + 60 * 60_000, pushedAt)).toBe("timed_out");
    expect(ciVerdict(results([], [status({ state: "pending" })]), own, pushedAt + 10_000, pushedAt)).toBe("pending");
  });

  it("F-035: names the failing checks, check runs first, at most 5", () => {
    const many = results(
      Array.from({ length: 6 }, (_, index) => run({ name: `job ${String(index)}`, conclusion: "failure" })),
      [status({ context: "ci/old", state: "error" })],
    );
    const failing = failingChecks(many, own, 5);
    expect(failing).toHaveLength(5);
    expect(failing.every((check) => check.kind === "check-run")).toBe(true);
    expect(failingChecks(results([run({})], [status({ context: "ci/old", state: "error" })]), own, 5)).toEqual([{ kind: "status", context: "ci/old", state: "error" }]);
  });
});

describe("the rounds and their caps", () => {
  const at = (ciRounds: number, reviewRounds: number, automaticTurns: number): RoundCounters => ({ ciRounds, reviewRounds, automaticTurns });

  it("F-101: allows 2 CI rounds and 2 findings rounds, and 4 automatic turns together, before a person has to act", () => {
    expect(roundAllowed(NO_ROUNDS, "ci")).toEqual({ kind: "allowed" });
    expect(roundAllowed(at(1, 0, 1), "ci")).toEqual({ kind: "allowed" });
    expect(roundAllowed(at(2, 0, 2), "ci")).toEqual({ kind: "capped", reason: "rounds" });
    expect(roundAllowed(at(0, 2, 2), "findings")).toEqual({ kind: "capped", reason: "rounds" });
    expect(roundAllowed(at(1, 1, 4), "ci")).toEqual({ kind: "capped", reason: "automatic-turns" });
    expect(roundAllowed(at(1, 1, 4), "findings")).toEqual({ kind: "capped", reason: "automatic-turns" });
    // Walk it: CI, findings, CI, findings, then nothing more without a person.
    let counters = NO_ROUNDS;
    for (const kind of ["ci", "findings", "ci", "findings"] as const) {
      expect(roundAllowed(counters, kind)).toEqual({ kind: "allowed" });
      counters = countRound(counters, kind);
    }
    expect(counters).toEqual(at(2, 2, 4));
    expect(roundAllowed(counters, "ci").kind).toBe("capped");
    expect(roundAllowed(counters, "findings").kind).toBe("capped");
  });

  it("F-101: a person's action resets the counters, and a changes-requested round is one", () => {
    const capped = at(2, 2, 4);
    expect(roundAllowed(capped, "ci").kind).toBe("capped");
    expect(resetOnPersonAction()).toEqual(NO_ROUNDS);
    expect(roundAllowed(resetOnPersonAction(), "ci")).toEqual({ kind: "allowed" });
    // "Changes requested" has no cap, and resets the counts as it starts.
    expect(roundAllowed(capped, "changes_requested")).toEqual({ kind: "allowed" });
    expect(countRound(capped, "changes_requested")).toEqual(NO_ROUNDS);
  });

  it("takes other limits from the settings", () => {
    expect(roundAllowed(at(2, 0, 2), "ci", { ciRounds: 3, reviewRounds: 2, automaticTurns: 6 })).toEqual({ kind: "allowed" });
    expect(roundAllowed(at(0, 0, 0), "ci", { ciRounds: 0, reviewRounds: 2, automaticTurns: 4 })).toEqual({ kind: "capped", reason: "rounds" });
  });
});

describe("placing findings on a PR", () => {
  const repoId = repoIdSchema.parse(randomUUID());
  const finding = (fields: Partial<Finding>): Finding => ({
    repoId,
    path: "src/pay.ts",
    line: 12,
    side: "new",
    severity: "blocking",
    title: "Rounds the total twice",
    body: "The total is rounded before and after the tax.",
    suggestion: null,
    ...fields,
  });
  const diff = [{ path: "src/pay.ts", new: [{ start: 10, end: 20 }], old: [{ start: 9, end: 15 }] }];

  it("F-100: puts a finding on a line the diff covers as a line comment, and the rest in the review's body", () => {
    const findings = [finding({}), finding({ line: 40 }), finding({ side: "old", line: 9, severity: "nit" }), finding({ path: "README.md", line: 1 })];
    const placed = placeFindings(findings, diff);
    expect(placed.lineComments.map((comment) => [comment.findingIndex, comment.path, comment.line, comment.side])).toEqual([
      [0, "src/pay.ts", 12, "new"],
      [2, "src/pay.ts", 9, "old"],
    ]);
    expect(placed.inBody).toEqual([1, 3]);
    const body = reviewBody({ summary: "Two problems.", findings, inBody: placed.inBody });
    expect(body).toContain("3 blocking, 1 nit");
    expect(body).toContain("`src/pay.ts:40`");
    expect(body).toContain("`README.md:1`");
    expect(body).toContain("doesn't approve or request changes");
  });

  it("F-100: keeps at most 30 findings, and fences a suggestion so it can't close itself", () => {
    expect(placeFindings(Array.from({ length: 40 }, () => finding({})), diff).lineComments).toHaveLength(30);
    const body = findingCommentBody(finding({ suggestion: "const total = round(x); // ```\n```" }));
    expect(body).toContain("````suggestion\nconst total = round(x); // ```\n```\n````");
    expect(body.startsWith("**Blocking: Rounds the total twice**")).toBe(true);
  });
});

describe("CODEOWNERS", () => {
  const file = [
    "# Owners",
    "*       @ostra-test/core",
    "*.md    @docs-writer docs@example.com",
    "/apps/web/   @ostra-test/web @ana",
    "packages/db/ @bo",
    "build/  @ci-bot",
    "/scripts/*.sh @ops",
    "!negated @nobody",
    "",
  ].join("\n");
  const rules = parseCodeOwners(file);

  it("F-102: the last matching rule wins, with users and teams, `*` and directory patterns", () => {
    expect(ownersOf(rules, "src/index.ts")).toEqual([{ kind: "team", org: "ostra-test", slug: "core" }]);
    expect(ownersOf(rules, "README.md")).toEqual([{ kind: "user", login: "docs-writer" }, { kind: "email", address: "docs@example.com" }]);
    expect(ownersOf(rules, "apps/web/src/page.tsx")).toEqual([{ kind: "team", org: "ostra-test", slug: "web" }, { kind: "user", login: "ana" }]);
    // `/apps/web/` is anchored: a web folder elsewhere isn't it.
    expect(ownersOf(rules, "other/apps/web/x.ts")).toEqual([{ kind: "team", org: "ostra-test", slug: "core" }]);
    // `build/` without a leading slash matches a build folder at any depth.
    expect(ownersOf(rules, "tools/build/run.ts")).toEqual([{ kind: "user", login: "ci-bot" }]);
    expect(ownersOf(rules, "scripts/deploy.sh")).toEqual([{ kind: "user", login: "ops" }]);
    expect(ownersOf(rules, "scripts/nested/deploy.sh")).toEqual([{ kind: "team", org: "ostra-test", slug: "core" }]);
    // A Markdown file under apps/web: the later rule wins.
    expect(ownersOf(rules, "apps/web/README.md")).toEqual([{ kind: "team", org: "ostra-test", slug: "web" }, { kind: "user", login: "ana" }]);
  });

  it("F-102: gathers a PR's owners once each, users by login and teams by org/slug", () => {
    expect(ownersFor(rules, ["apps/web/a.ts", "apps/web/b.ts", "packages/db/schema.prisma", "README.md"])).toEqual({
      users: ["ana", "bo", "docs-writer"],
      teams: ["ostra-test/web"],
    });
    expect(ownersFor(parseCodeOwners(""), ["a.ts"])).toEqual({ users: [], teams: [] });
  });

  it("matches gitignore's stars", () => {
    expect(patternMatcher("docs/**/*.md").test("docs/a/b/c.md")).toBe(true);
    expect(patternMatcher("docs/**/*.md").test("docs/c.md")).toBe(true);
    expect(patternMatcher("docs/**/*.md").test("src/docs/c.md")).toBe(false);
    expect(patternMatcher("*.js").test("deep/down/x.js")).toBe(true);
    expect(patternMatcher("/x?.ts").test("xa.ts")).toBe(true);
    expect(patternMatcher("/x?.ts").test("xab.ts")).toBe(false);
  });
});
