import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkProofs,
  conditionsOf,
  findTests,
  parseFeatures,
  parseProofFile,
  renderReport,
  splitSentences,
  stripNotes,
} from "./check-proof.ts";
import type { FeatureReport, Problem, ProofReport } from "./check-proof.ts";
import { writeProofFile } from "./proof-new.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("conditionsOf", () => {
  it("drops the dated notes in italics and keeps the italics that belong to a sentence", () => {
    expect(
      conditionsOf(
        "It expires after 7 days *(working value)*. An admin can revoke it. *Changed 2026-11-18: renamed (Q54).* *Building 2026-11-19: the panel works.*",
      ),
    ).toEqual(["It expires after 7 days *(working value)*.", "An admin can revoke it."]);
  });

  it("keeps bold text, and a dated note never swallows the sentences after it", () => {
    expect(
      stripNotes("The **link's ID is the secret**. *Note 2026-11-19: See Q1.* It works once."),
    ).toBe("The **link's ID is the secret**.  It works once.");
  });

  it("ends a sentence at . ? or ! before a space, outside code spans and parentheses", () => {
    expect(
      splitSentences(
        'Run `pnpm dev. Then` it starts (see demo.md. Twice). ostra lists the models. `OSTRA_X=true` turns it off! Is it "done?" Yes, e.g. this one.',
      ),
    ).toEqual([
      "Run `pnpm dev. Then` it starts (see demo.md. Twice).",
      "ostra lists the models.",
      "`OSTRA_X=true` turns it off!",
      'Is it "done?"',
      "Yes, e.g. this one.",
    ]);
  });

  it("doesn't end a sentence inside a version or a file name", () => {
    expect(
      splitSentences("The CLI needs Node 24.5 or later and reads `package.json`. It runs."),
    ).toEqual(["The CLI needs Node 24.5 or later and reads `package.json`.", "It runs."]);
  });

  it("reads every row of the real ledger into verbatim sentences of its done-when", async () => {
    const features = parseFeatures(
      await readFile(path.join(repoRoot, "context", "features.md"), "utf8"),
    );
    expect(features.length).toBeGreaterThan(100);
    for (const feature of features) {
      expect(feature.conditions.length, feature.id).toBeGreaterThan(0);
      for (const condition of feature.conditions) {
        expect(feature.doneWhen, feature.id).toContain(condition);
        expect(condition, feature.id).not.toMatch(
          /^\*(Changed|Building|Done|Note|Added|Moved|Split)\b/,
        );
      }
    }
    expect(features.find((feature) => feature.id === "F-025")?.conditions).toEqual([
      "A member stops a task's agent.",
      "The task's branches and its hidden ref, which holds any unfinished work, stay, ready to reopen (F-033, F-096).",
    ]);
  });
});

describe("parseFeatures", () => {
  it("refuses a status that isn't one of the ledger's", () => {
    expect(() => parseFeatures("| F-001 | Install | It installs. | v1 | finished |")).toThrow(
      /finished/,
    );
  });
});

describe("findTests", () => {
  const names = (source: string) =>
    findTests(source, "x.test.ts").map(({ name, run }) => `${run}: ${name}`);

  it("finds it() and test() by their own title, inside describe blocks", () => {
    expect(
      names(`
        describe("outer", () => {
          it("F-001: one", () => {});
          describe("inner", () => { test(\`F-001: two\`, async () => {}); });
        });
        test.describe.serial("serial", () => { test("F-001: three", async () => {}); });
        it.each([1, 2])("F-001: each %s", () => {});
        it.concurrent("F-001: concurrent", () => {});
      `),
    ).toEqual([
      "runs: F-001: one",
      "runs: F-001: two",
      "runs: F-001: three",
      "runs: F-001: each %s",
      "runs: F-001: concurrent",
    ]);
  });

  it("marks skipped, conditional and expected-to-fail tests, on the test or a describe around it", () => {
    expect(
      names(`
        it.skip("a", () => {});
        it.todo("b");
        test.fixme("c", async () => {});
        it.skipIf(process.platform === "win32")("d", () => {});
        it.runIf(process.env.LIVE)("e", () => {});
        it.fails("f", () => {});
        describe.skip("off", () => { it("g", () => {}); });
        describe.skipIf(true)("maybe", () => { it("h", () => {}); });
        test.describe.skip("pw off", () => { test("i", async () => {}); });
      `),
    ).toEqual([
      "skipped: a",
      "skipped: b",
      "skipped: c",
      "conditional: d",
      "conditional: e",
      "expected-to-fail: f",
      "skipped: g",
      "conditional: h",
      "skipped: i",
    ]);
  });

  it("marks a test whose body or describe block skips at run time", () => {
    expect(
      names(`
        test("a", async ({ isMobile }) => { test.skip(isMobile, "desktop only"); });
        test("b", async () => { test.skip(); });
        test.describe("phone", () => {
          test.skip(({ isMobile }) => !isMobile);
          test("c", async () => {});
        });
        test("d", async () => {});
      `),
    ).toEqual(["conditional: a", "skipped: b", "conditional: c", "runs: d"]);
  });

  it("ignores hooks, steps and titles that aren't string literals", () => {
    expect(
      names(`
        test.beforeEach(async () => {});
        test("outer", async () => { await test.step("a step", async () => {}); });
        const title = "x";
        it(title, () => {});
        it(\`with \${title}\`, () => {});
      `),
    ).toEqual(["runs: outer"]);
  });
});

// A throwaway repo: a ledger, proof files, tests and evidence, checked through checkProofs.
describe("checkProofs", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ostra-check-proof-"));
    await mkdir(path.join(root, "context", "proof"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (relative: string, text: string): Promise<void> => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  };

  type Row = { id: string; title?: string; doneWhen: string; status: string };
  const ledger = async (...rows: Row[]): Promise<void> => {
    await write(
      "context/features.md",
      [
        "# Feature ledger",
        "",
        "| ID | Feature | Done when | Priority | Status |",
        "|---|---|---|---|---|",
        ...rows.map(
          (row) =>
            `| ${row.id} | ${row.title ?? "A feature"} | ${row.doneWhen} | v1 | ${row.status} |`,
        ),
        "",
      ].join("\n"),
    );
  };
  const proof = async (id: string, ...rows: string[]): Promise<void> => {
    await write(
      `context/proof/${id}.md`,
      [
        `# ${id}`,
        "",
        "| Condition | Proved by | Kind | Break-it | Status |",
        "|---|---|---|---|---|",
        ...rows,
        "",
        "Notes.",
        "",
      ].join("\n"),
    );
  };
  const baseline = (...rows: string[]): Promise<void> =>
    write("context/proof/baseline.json", JSON.stringify({ rows }));
  const tests = (relative: string, ...names: string[]): Promise<void> =>
    write(relative, names.map((name) => `it(${JSON.stringify(name)}, () => {});`).join("\n"));

  const check = (): Promise<ProofReport> => checkProofs({ root });
  const reportOf = async (id: string): Promise<FeatureReport | undefined> =>
    (await check()).features.find((entry) => entry.feature.id === id);
  const problemsOf = async (id: string): Promise<Problem[]> => (await reportOf(id))?.problems ?? [];
  const errorsOf = async (): Promise<number> => renderReport(await check()).errors;

  const twoConditions = "A member stops it. Its branches stay.";
  const provedRows = [
    '| A member stops it. | `src/stop.test.ts` > "F-025: stops the agent" | integration | dropped the call to `stop` | proved |',
    '| Its branches stay. | `src/stop.test.ts` > "F-025: keeps the branches"<br>live: `evidence/run.log` | integration, live | deleted the branch in `stop` | proved |',
  ];

  it("passes a done row whose every condition is proved by a test that exists, runs and names the row", async () => {
    await ledger({
      id: "F-025",
      doneWhen: `${twoConditions} *Done 2026-11-19: the demo.*`,
      status: "done",
    });
    await tests("src/stop.test.ts", "F-025: stops the agent", "F-025: keeps the branches");
    await write("evidence/run.log", "ok\n");
    await proof("F-025", ...provedRows);
    const report = await check();
    expect(report.ledgerProblems).toEqual([]);
    expect(report.features).toMatchObject([
      { feature: { id: "F-025" }, enforced: true, problems: [], proved: 2 },
    ]);
    expect(renderReport(report).errors).toBe(0);
  });

  it("fails a done row with no proof file, and names the command that writes one", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "done" });
    expect(await problemsOf("F-025")).toEqual([
      { kind: "no-proof-file", file: "context/proof/F-025.md" },
    ]);
    expect(renderReport(await check()).lines.join("\n")).toContain("pnpm proof:new F-025");
    expect(await errorsOf()).toBe(1);
  });

  it("fails a done row when a condition has no row, or a row quotes a sentence the done-when no longer has", async () => {
    await ledger({
      id: "F-025",
      doneWhen: "A member stops it. Its branches and its hidden ref stay.",
      status: "done",
    });
    await tests("src/stop.test.ts", "F-025: stops the agent", "F-025: keeps the branches");
    await write("evidence/run.log", "ok\n");
    await proof("F-025", ...provedRows);
    expect(await problemsOf("F-025")).toEqual([
      { kind: "row-not-a-condition", line: 6, condition: "Its branches stay." },
      { kind: "condition-without-row", condition: "Its branches and its hidden ref stay." },
    ]);
  });

  it("fails a done row whose rows are missing or partial, and only warns for a building row", async () => {
    await ledger(
      { id: "F-025", doneWhen: twoConditions, status: "done" },
      { id: "F-026", doneWhen: twoConditions, status: "building" },
    );
    await tests("src/stop.test.ts", "F-025: stops the agent");
    const rows = [
      '| A member stops it. | `src/stop.test.ts` > "F-025: stops the agent" | unit | returned early from `stop` | partial |',
      "| Its branches stay. | — | — | — | missing |",
    ];
    await proof("F-025", ...rows);
    await proof("F-026", ...rows);
    expect(await problemsOf("F-025")).toEqual([
      { kind: "not-proved", line: 5, condition: "A member stops it.", status: "partial" },
      { kind: "not-proved", line: 6, condition: "Its branches stay.", status: "missing" },
    ]);
    const report = await check();
    expect(report.features.map(({ feature, enforced }) => [feature.id, enforced])).toEqual([
      ["F-025", true],
      ["F-026", false],
    ]);
    // F-026's own citation lacks its ID, which is a warning too.
    expect(renderReport(report)).toMatchObject({ errors: 2, warnings: 3 });
  });

  it("fails a citation of a test file that doesn't exist, a test it doesn't hold, or a name without the row's ID", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "done" });
    await tests(
      "src/stop.test.ts",
      "F-025: stops the agent",
      "keeps the branches",
      "F-0251: other row",
    );
    await proof(
      "F-025",
      '| A member stops it. | `src/gone.test.ts` > "F-025: stops the agent"<br>`src/stop.test.ts` > "F-025: stops the agen" | unit | dropped the call | proved |',
      '| Its branches stay. | `src/stop.test.ts` > "keeps the branches"<br>`src/stop.test.ts` > "F-0251: other row" | unit | dropped the call | proved |',
    );
    expect(await problemsOf("F-025")).toEqual([
      { kind: "test-file-missing", line: 5, file: "src/gone.test.ts" },
      { kind: "test-not-found", line: 5, file: "src/stop.test.ts", name: "F-025: stops the agen" },
      { kind: "test-name-lacks-id", line: 6, name: "keeps the branches" },
      { kind: "test-name-lacks-id", line: 6, name: "F-0251: other row" },
    ]);
  });

  it("fails a citation of a skipped or conditional test, of a file that isn't a test, or of a path outside the repo", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "done" });
    await write(
      "src/stop.test.ts",
      'it.skip("F-025: stops the agent", () => {});\nit.runIf(process.env.LIVE)("F-025: keeps the branches", () => {});\n',
    );
    await write("src/stop.ts", 'it("F-025: in source", () => {});\n');
    await proof(
      "F-025",
      '| A member stops it. | `src/stop.test.ts` > "F-025: stops the agent"<br>`src/stop.ts` > "F-025: in source" | unit | dropped the call | proved |',
      '| Its branches stay. | `src/stop.test.ts` > "F-025: keeps the branches"<br>`../outside.test.ts` > "F-025: x" | unit | dropped the call | proved |',
    );
    expect(await problemsOf("F-025")).toEqual([
      {
        kind: "test-does-not-run",
        line: 5,
        file: "src/stop.test.ts",
        name: "F-025: stops the agent",
        run: "skipped",
      },
      { kind: "not-a-test-file", line: 5, file: "src/stop.ts" },
      {
        kind: "test-does-not-run",
        line: 6,
        file: "src/stop.test.ts",
        name: "F-025: keeps the branches",
        run: "conditional",
      },
      { kind: "test-file-missing", line: 6, file: "../outside.test.ts" },
    ]);
  });

  it("fails a proved row with no break-it, no citation, an unknown kind or status, or a kind that doesn't match what it cites", async () => {
    await ledger({ id: "F-025", doneWhen: "One. Two. Three. Four. Five.", status: "done" });
    await tests("src/a.test.ts", "F-025: a");
    await proof(
      "F-025",
      '| One. | `src/a.test.ts` > "F-025: a" | unit | — | proved |',
      "| Two. | — | unit | broke it | proved |",
      '| Three. | `src/a.test.ts` > "F-025: a" | smoke | broke it | done |',
      "| Four. | live: `evidence/gone.png` | unit | — | proved |",
      "| Five. | src/a.test.ts F-025: a | e2e | broke it | proved |",
    );
    expect(await problemsOf("F-025")).toEqual([
      { kind: "no-break-it", line: 5 },
      { kind: "no-citation", line: 6 },
      { kind: "kind-mismatch", line: 6, reason: "its kind says unit, but it cites no test" },
      { kind: "bad-status", line: 7, status: "done" },
      { kind: "kind-mismatch", line: 8, reason: "its kind says unit, but it cites no test" },
      {
        kind: "kind-mismatch",
        line: 8,
        reason: "it cites live evidence, so its kind includes live",
      },
      { kind: "evidence-missing", line: 8, evidence: "evidence/gone.png" },
      { kind: "bad-citation", line: 9, text: "src/a.test.ts F-025: a" },
      { kind: "kind-mismatch", line: 9, reason: "its kind says e2e, but it cites no test" },
    ]);
  });

  it("accepts live evidence as a file in the repo or an https link, and nothing else", async () => {
    await ledger({
      id: "F-030",
      doneWhen: "It opens a PR. Its title holds the ID. Its body links the task.",
      status: "done",
    });
    await write("context/specs/demo/run-1.log", "PR opened\n");
    await proof(
      "F-030",
      "| It opens a PR. | live: `context/specs/demo/run-1.log` | live | — | proved |",
      "| Its title holds the ID. | live: https://github.com/ostra-test/test1/pull/7 | live | — | proved |",
      "| Its body links the task. | live: http://example.com/pr | live | — | proved |",
    );
    expect(await problemsOf("F-030")).toEqual([
      { kind: "evidence-missing", line: 7, evidence: "http://example.com/pr" },
    ]);
  });

  it("fails a second row for the same condition, and a table it can't read", async () => {
    await ledger(
      { id: "F-025", doneWhen: "One.", status: "done" },
      { id: "F-026", doneWhen: "One.", status: "done" },
    );
    await tests("src/a.test.ts", "F-025: a");
    const row = '| One. | `src/a.test.ts` > "F-025: a" | unit | broke it | proved |';
    await proof("F-025", row, row);
    await write(
      "context/proof/F-026.md",
      "# F-026\n\n| Condition | Proof |\n|---|---|\n| One. | yes |\n",
    );
    expect(await problemsOf("F-025")).toEqual([
      { kind: "duplicate-row", line: 6, condition: "One." },
    ]);
    expect(await problemsOf("F-026")).toMatchObject([
      { kind: "unreadable-proof-file", file: "context/proof/F-026.md" },
    ]);
  });

  it("only warns for a done row in the baseline, and fails once it is proved, so the baseline shrinks", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "done" });
    await baseline("F-025");
    await proof(
      "F-025",
      "| A member stops it. | — | — | — | missing |",
      "| Its branches stay. | — | — | — | missing |",
    );
    expect(await reportOf("F-025")).toMatchObject({ enforced: false, baselined: true });
    expect(renderReport(await check())).toMatchObject({ errors: 0, warnings: 2 });

    await tests("src/stop.test.ts", "F-025: stops the agent", "F-025: keeps the branches");
    await write("evidence/run.log", "ok\n");
    await proof("F-025", ...provedRows);
    expect((await check()).ledgerProblems).toEqual([{ kind: "baseline-proved", id: "F-025" }]);
    expect(await errorsOf()).toBe(1);
  });

  it("fails a baseline that names a row that isn't done or isn't in the ledger, or that it can't read", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "building" });
    await baseline("F-025", "F-404");
    expect((await check()).ledgerProblems).toEqual([
      { kind: "baseline-not-done", id: "F-025", status: "building" },
      { kind: "baseline-unknown", id: "F-404" },
    ]);
    await write("context/proof/baseline.json", JSON.stringify({ rows: ["F-025"], extra: true }));
    expect((await check()).ledgerProblems).toMatchObject([{ kind: "bad-baseline" }]);
  });

  it("fails a proof file that isn't named after a feature row", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "building" });
    await write("context/proof/F-404.md", "# F-404\n");
    await write("context/proof/notes.md", "# notes\n");
    await write("context/proof/README.md", "# rules\n");
    expect((await check()).ledgerProblems).toEqual([
      { kind: "unknown-proof-file", file: "context/proof/F-404.md" },
      { kind: "unknown-proof-file", file: "context/proof/notes.md" },
    ]);
  });

  it("checks a planned row's proof file as warnings, and leaves rows with no proof file alone unless done", async () => {
    await ledger(
      { id: "F-017", doneWhen: twoConditions, status: "planned" },
      { id: "F-018", doneWhen: twoConditions, status: "planned" },
      { id: "F-019", doneWhen: twoConditions, status: "dropped" },
    );
    await proof("F-017", "| A member stops it. | — | — | — | missing |");
    const report = await check();
    expect(report.features.map(({ feature }) => feature.id)).toEqual(["F-017"]);
    expect(renderReport(report)).toMatchObject({ errors: 0, warnings: 2 });
  });

  it("reports each problem of an enforced row with its condition, and sums up the rows that only warn", async () => {
    await ledger(
      { id: "F-025", title: "Stop", doneWhen: twoConditions, status: "done" },
      { id: "F-026", title: "Approvals", doneWhen: twoConditions, status: "building" },
    );
    await tests("src/a.test.ts", "F-025: a", "F-026: a");
    const rows = (id: string): string[] => [
      "| A member stops it. | — | — | — | missing |",
      `| Its branches stay. | \`src/a.test.ts\` > "${id}: a" | unit | broke it | partial |`,
    ];
    await proof("F-025", ...rows("F-025"));
    await proof("F-026", ...rows("F-026"));
    const { lines } = renderReport(await check());
    expect(lines).toEqual([
      "error  F-025 Stop (done), context/proof/F-025.md: 0 of 2 conditions proved",
      '         line 5: missing: "A member stops it."',
      '         line 6: partial: "Its branches stay."',
      "warn   F-026 Approvals (building), context/proof/F-026.md: 0 of 2 conditions proved, 1 partial, 1 missing",
      "check:proof: 1 done rows, 0 fully proved, 0 in the baseline; 2 error(s), 2 warning(s)",
    ]);
    expect(renderReport(await check(), { verbose: true }).lines).toContain(
      '         line 5: missing: "A member stops it."',
    );
  });

  describe("proof:new", () => {
    it("writes a proof file with every condition missing, which check:proof reads back", async () => {
      await ledger({
        id: "F-025",
        doneWhen: `${twoConditions} *Changed 2026-11-18: renamed.*`,
        status: "building",
      });
      const [feature] = parseFeatures(
        await readFile(path.join(root, "context", "features.md"), "utf8"),
      );
      expect(feature).toBeDefined();
      if (feature === undefined) return;
      expect(await writeProofFile(root, feature)).toEqual({
        kind: "created",
        file: "context/proof/F-025.md",
        conditions: 2,
      });
      const parsed = parseProofFile(
        await readFile(path.join(root, "context", "proof", "F-025.md"), "utf8"),
      );
      expect(parsed.ok && parsed.rows.map(({ condition, status }) => [condition, status])).toEqual([
        ["A member stops it.", "missing"],
        ["Its branches stay.", "missing"],
      ]);
      expect(await problemsOf("F-025")).toMatchObject([
        { kind: "not-proved", status: "missing" },
        { kind: "not-proved", status: "missing" },
      ]);
      expect(await writeProofFile(root, feature)).toEqual({
        kind: "unchanged",
        file: "context/proof/F-025.md",
      });
    });

    it("brings an existing file up to a changed done-when, keeping its proofs, its stale rows and its notes", async () => {
      await ledger({
        id: "F-025",
        doneWhen: "A member stops it. Its branches \\| refs stay. A third.",
        status: "building",
      });
      await proof("F-025", provedRows[1] ?? "", provedRows[0] ?? "");
      const [feature] = parseFeatures(
        await readFile(path.join(root, "context", "features.md"), "utf8"),
      );
      if (feature === undefined) throw new Error("no feature");
      expect(await writeProofFile(root, feature)).toEqual({
        kind: "updated",
        file: "context/proof/F-025.md",
        added: 2,
        stale: 1,
      });
      const text = await readFile(path.join(root, "context", "proof", "F-025.md"), "utf8");
      expect(text.split("\n").slice(4, 9)).toEqual([
        provedRows[0],
        "| Its branches \\| refs stay. | — | — | — | missing |",
        "| A third. | — | — | — | missing |",
        provedRows[1],
        "",
      ]);
      expect(text).toContain("Notes.");
      const parsed = parseProofFile(text);
      expect(parsed.ok && parsed.rows[1]?.condition).toBe("Its branches | refs stay.");
    });
  });
});
