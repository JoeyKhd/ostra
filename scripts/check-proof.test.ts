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
  proofFileIntro,
  renderReport,
  splitSentences,
  stripNotes,
  syncProofs,
  titleKeys,
} from "./check-proof.ts";
import type { FeatureReport, Problem, ProofReport } from "./check-proof.ts";
import { migrateProofs, renameSnapshotKey } from "./proof-migrate.ts";
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

  it("doesn't take a * inside a code span for the start of a note", () => {
    expect(
      conditionsOf(
        "It pushes to `refs/ostra/wip/*` only. It took 1 second *(working figure)*. *Added 2026-11-18: pushes to `refs/*` and `a*b`.* It runs `pnpm dev`. *Changed 2026-11-19.*",
      ),
    ).toEqual([
      "It pushes to `refs/ostra/wip/*` only.",
      "It took 1 second *(working figure)*.",
      "It runs `pnpm dev`.",
    ]);
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

describe("titleKeys", () => {
  it("reads the keys of each feature from the head of a test's name", () => {
    expect(titleKeys("F-025/c1: stops the agent")).toEqual({
      features: [{ id: "F-025", keys: ["c1"] }],
      malformed: false,
    });
    expect(titleKeys("F-099/c1,c3, F-100/c2 and F-113: the tools")).toEqual({
      features: [
        { id: "F-099", keys: ["c1", "c3"] },
        { id: "F-100", keys: ["c2"] },
        { id: "F-113", keys: [] },
      ],
      malformed: false,
    });
    expect(titleKeys("F-021, Q189: archiving keeps the profile").features).toEqual([
      { id: "F-021", keys: [] },
    ]);
  });

  it("reads no key outside the head, and flags a key it can't read", () => {
    expect(titleKeys("stops the agent (F-025/c1)")).toEqual({ features: [], malformed: true });
    expect(titleKeys("F-025/c1 stops the agent")).toEqual({ features: [], malformed: true });
    expect(titleKeys("F-025/2: stops the agent").malformed).toBe(true);
    expect(titleKeys("F-025: keeps F-033/c2's branches").malformed).toBe(true);
    expect(titleKeys("F-025: keeps F-033's branches")).toEqual({
      features: [{ id: "F-025", keys: [] }],
      malformed: false,
    });
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
  const read = (relative: string): Promise<string> => readFile(path.join(root, relative), "utf8");

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
        "| Key | Condition | Tests | Live | Break-it | Status |",
        "|---|---|---|---|---|---|",
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
  const sync = (): Promise<string[]> => syncProofs({ root });
  const reportOf = async (id: string): Promise<FeatureReport | undefined> =>
    (await check()).features.find((entry) => entry.feature.id === id);
  const problemsOf = async (id: string): Promise<Problem[]> => (await reportOf(id))?.problems ?? [];
  const errorsOf = async (): Promise<number> => renderReport(await check()).errors;

  const twoConditions = "A member stops it. Its branches stay.";
  const stopTests = ["F-025/c1: stops the agent", "F-025/c2: keeps the branches"] as const;
  const provedRows = [
    '| c1 | A member stops it. | `src/stop.test.ts` > "F-025/c1: stops the agent" | — | dropped the call to `stop` | proved |',
    '| c2 | Its branches stay. | `src/stop.test.ts` > "F-025/c2: keeps the branches" | `evidence/run.log` | deleted the branch in `stop` | proved |',
  ];
  const provedLedger = async (status = "done"): Promise<void> => {
    await ledger({
      id: "F-025",
      doneWhen: `${twoConditions} *Done 2026-11-19: the demo.*`,
      status,
    });
    await tests("src/stop.test.ts", ...stopTests);
    await write("evidence/run.log", "ok\n");
    await proof("F-025", ...provedRows);
  };

  it("passes a done row whose every condition is proved by a keyed test that runs, or by live evidence", async () => {
    await provedLedger();
    const report = await check();
    expect(report.ledgerProblems).toEqual([]);
    expect(report.features).toMatchObject([
      { feature: { id: "F-025" }, enforced: true, problems: [], proved: 2 },
    ]);
    expect(report.features[0]?.synced).toBeUndefined();
    expect(renderReport(report).errors).toBe(0);
  });

  it("writes each row's tests and status from the code, and keeps what people wrote", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "done" });
    await tests(
      "src/stop.test.ts",
      "F-025/c2: keeps the branches",
      "F-025: names the feature without a condition",
      "F-025/c1,c2, F-033: stops the agent and keeps the branches",
    );
    await tests("src/a/stop.spec.ts", "F-025/c1: Stop stops the task");
    await proof(
      "F-025",
      "| c1 | A member stops it. | — | — | dropped the call to `stop` | missing |",
      "| c2 | Its branches stay. | — | — | deleted the branch in `stop` | missing: waits for a run |",
    );
    expect(await sync()).toEqual(["context/proof/F-025.md"]);
    const text = await read("context/proof/F-025.md");
    expect(text.split("\n").slice(4, 9)).toEqual([
      '| c1 | A member stops it. | `src/a/stop.spec.ts` > "F-025/c1: Stop stops the task"<br>`src/stop.test.ts` > "F-025/c1,c2, F-033: stops the agent and keeps the branches" | — | dropped the call to `stop` | proved |',
      '| c2 | Its branches stay. | `src/stop.test.ts` > "F-025/c2: keeps the branches"<br>`src/stop.test.ts` > "F-025/c1,c2, F-033: stops the agent and keeps the branches" | — | deleted the branch in `stop` | proved |',
      "",
      "Notes.",
      "",
    ]);
    expect(await problemsOf("F-025")).toEqual([]);
    expect(await sync()).toEqual([]);
  });

  it("break-it: a test renamed away from its key, or deleted, fails the check until proof:sync, and then its condition is missing", async () => {
    await provedLedger();
    expect(await errorsOf()).toBe(0);

    await tests("src/stop.test.ts", "stops the agent", stopTests[1]);
    expect(await problemsOf("F-025")).toEqual([
      { kind: "not-proved", line: 5, condition: "A member stops it.", status: "missing" },
      { kind: "stale-tests", line: 5, key: "c1", added: 0, gone: 1 },
      {
        kind: "stale-status",
        line: 5,
        key: "c1",
        written: "proved",
        status: "missing",
      },
    ]);
    expect(await errorsOf()).toBe(3);

    await sync();
    expect(await problemsOf("F-025")).toEqual([
      { kind: "not-proved", line: 5, condition: "A member stops it.", status: "missing" },
    ]);
    expect(await errorsOf()).toBe(1);

    // c2 keeps its live evidence when its test goes, so only its list is out of date.
    await rm(path.join(root, "src/stop.test.ts"));
    expect(await problemsOf("F-025")).toEqual([
      { kind: "not-proved", line: 5, condition: "A member stops it.", status: "missing" },
      { kind: "stale-tests", line: 6, key: "c2", added: 0, gone: 1 },
    ]);
  });

  it("fails a renamed test that keeps its key only until proof:sync writes its new name", async () => {
    await provedLedger();
    await tests("src/stop.test.ts", "F-025/c1: stops the agent at once", stopTests[1]);
    expect(await problemsOf("F-025")).toEqual([
      { kind: "stale-tests", line: 5, key: "c1", added: 1, gone: 1 },
    ]);
    await sync();
    expect(await problemsOf("F-025")).toEqual([]);
    expect(await read("context/proof/F-025.md")).toContain('"F-025/c1: stops the agent at once"');
  });

  it("fails a done row whose conditions are missing or partial, and only warns for a building row, except for its out-of-date cells", async () => {
    await ledger(
      { id: "F-025", doneWhen: twoConditions, status: "done" },
      { id: "F-026", doneWhen: twoConditions, status: "building" },
    );
    await tests("src/stop.test.ts", "F-025/c1: stops the agent", "F-026/c1: stops the agent");
    const rows = (id: string): string[] => [
      `| c1 | A member stops it. | \`src/stop.test.ts\` > "${id}/c1: stops the agent" | — | returned early from \`stop\` | partial: only the API |`,
      "| c2 | Its branches stay. | — | — | — | missing |",
    ];
    await proof("F-025", ...rows("F-025"));
    await proof(
      "F-026",
      "| c1 | A member stops it. | — | — | broke it | partial |",
      rows("F-026")[1] ?? "",
    );
    expect(await problemsOf("F-025")).toEqual([
      { kind: "not-proved", line: 5, condition: "A member stops it.", status: "partial" },
      { kind: "not-proved", line: 6, condition: "Its branches stay.", status: "missing" },
    ]);
    const report = await check();
    expect(report.features.map(({ feature, enforced }) => [feature.id, enforced])).toEqual([
      ["F-025", true],
      ["F-026", false],
    ]);
    // F-026's c1 has a test its file doesn't list yet: an error even though the row is building.
    expect(renderReport(report)).toMatchObject({ errors: 3, warnings: 2 });
  });

  it("holds a partial row back whatever its tests, and keeps a missing row's reason while it lacks evidence", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "building" });
    await tests("src/stop.test.ts", "F-025/c1: stops the agent");
    await proof(
      "F-025",
      "| c1 | A member stops it. | — | — | returned early | partial:   the panel isn't built |",
      "| c2 | Its branches stay. | — | — | — | missing: waits for the Linux run |",
    );
    await sync();
    const rows = parseProofFile(await read("context/proof/F-025.md"));
    expect(rows.ok && rows.rows.map(({ status }) => status)).toEqual([
      "partial: the panel isn't built",
      "missing: waits for the Linux run",
    ]);
    await write("evidence/run.log", "ok\n");
    await proof(
      "F-025",
      '| c1 | A member stops it. | `src/stop.test.ts` > "F-025/c1: stops the agent" | — | returned early | partial: the panel isn\'t built |',
      "| c2 | Its branches stay. | — | `evidence/run.log` | — | missing: waits for the Linux run |",
    );
    await sync();
    const after = parseProofFile(await read("context/proof/F-025.md"));
    expect(after.ok && after.rows.map(({ status }) => status)).toEqual([
      "partial: the panel isn't built",
      "proved",
    ]);
  });

  it("proves nothing with a test lacking a break-it, or live evidence that is neither in the repo nor https", async () => {
    await ledger({
      id: "F-030",
      doneWhen: "It opens a PR. Its title holds the ID. Its body links it.",
      status: "done",
    });
    await tests("src/pr.test.ts", "F-030/c1: opens a PR");
    await write("context/specs/demo/run-1.log", "PR opened\n");
    await proof(
      "F-030",
      '| c1 | It opens a PR. | `src/pr.test.ts` > "F-030/c1: opens a PR" | `context/specs/demo/run-1.log` | — | missing |',
      "| c2 | Its title holds the ID. | — | https://github.com/ostra-test/test1/pull/7 | — | proved |",
      "| c3 | Its body links it. | — | http://example.com/pr<br>`../outside.log` | — | missing |",
    );
    expect(await problemsOf("F-030")).toEqual([
      { kind: "not-proved", line: 5, condition: "It opens a PR.", status: "missing" },
      { kind: "no-break-it", line: 5 },
      { kind: "not-proved", line: 7, condition: "Its body links it.", status: "missing" },
      { kind: "evidence-missing", line: 7, evidence: "http://example.com/pr" },
      { kind: "evidence-missing", line: 7, evidence: "../outside.log" },
    ]);
  });

  it("lists no skipped, conditional or expected-to-fail test, and names each one", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "done" });
    await write(
      "src/stop.test.ts",
      [
        'it.skip("F-025/c1: stops the agent", () => {});',
        'it.runIf(process.env.LIVE)("F-025/c2: keeps the branches", () => {});',
        'it("F-025/c2: keeps the branches on host", () => {});',
      ].join("\n"),
    );
    await proof(
      "F-025",
      "| c1 | A member stops it. | — | — | — | missing |",
      '| c2 | Its branches stay. | `src/stop.test.ts` > "F-025/c2: keeps the branches on host" | — | broke it | proved |',
    );
    expect(await problemsOf("F-025")).toEqual([
      { kind: "not-proved", line: 5, condition: "A member stops it.", status: "missing" },
      {
        kind: "test-does-not-run",
        line: 5,
        file: "src/stop.test.ts",
        name: "F-025/c1: stops the agent",
        run: "skipped",
      },
      {
        kind: "test-does-not-run",
        line: 6,
        file: "src/stop.test.ts",
        name: "F-025/c2: keeps the branches",
        run: "conditional",
      },
    ]);
  });

  it("fails a bad or second key, a key no row has, and a test that keys an unknown feature or a key it can't read", async () => {
    await ledger({ id: "F-025", doneWhen: "One. Two. Three.", status: "done" });
    await tests(
      "src/a.test.ts",
      "F-025/c1: one",
      "F-025/c9: nine",
      "F-404/c1: nobody",
      "F-025/1: typo",
    );
    await tests("node_modules/x/a.test.ts", "F-404/c2: installed, not ours");
    await proof(
      "F-025",
      '| c1 | One. | `src/a.test.ts` > "F-025/c1: one" | — | broke it | proved |',
      "| 2 | Two. | — | — | — | missing |",
      "| c1 | Three. | — | — | — | missing |",
    );
    const report = await check();
    expect(report.ledgerProblems).toEqual([
      { kind: "malformed-test-key", file: "src/a.test.ts", line: 4, name: "F-025/1: typo" },
      {
        kind: "test-key-unknown-feature",
        file: "src/a.test.ts",
        line: 3,
        name: "F-404/c1: nobody",
        id: "F-404",
      },
    ]);
    expect(await problemsOf("F-025")).toEqual([
      { kind: "bad-key", line: 6, key: "2" },
      { kind: "duplicate-key", line: 7, key: "c1" },
      { kind: "condition-without-row", condition: "Two." },
      { kind: "condition-without-row", condition: "Three." },
      { kind: "unknown-key", key: "c9", file: "src/a.test.ts", name: "F-025/c9: nine" },
    ]);
  });

  it("fails a done row when a condition has no row, or a row quotes a sentence the done-when no longer has", async () => {
    await provedLedger();
    await ledger({
      id: "F-025",
      doneWhen: "A member stops it. Its branches and its hidden ref stay.",
      status: "done",
    });
    expect(await problemsOf("F-025")).toEqual([
      { kind: "row-not-a-condition", line: 6, condition: "Its branches stay." },
      { kind: "condition-without-row", condition: "Its branches and its hidden ref stay." },
    ]);
  });

  it("fails a second row for the same condition, and a table it can't read, naming the migration for a former one", async () => {
    await ledger(
      { id: "F-025", doneWhen: "One.", status: "done" },
      { id: "F-026", doneWhen: "One.", status: "done" },
      { id: "F-027", doneWhen: "One.", status: "done" },
    );
    await proof(
      "F-025",
      "| c1 | One. | — | — | — | missing |",
      "| c2 | One. | — | — | — | missing |",
    );
    await write(
      "context/proof/F-026.md",
      "# F-026\n\n| Condition | Proof |\n|---|---|\n| One. | yes |\n",
    );
    await write(
      "context/proof/F-027.md",
      "# F-027\n\n| Condition | Proved by | Kind | Break-it | Status |\n|---|---|---|---|---|\n| One. | — | — | — | missing |\n",
    );
    expect(await problemsOf("F-025")).toEqual([
      { kind: "not-proved", line: 5, condition: "One.", status: "missing" },
      { kind: "duplicate-row", line: 6, condition: "One." },
    ]);
    expect(await problemsOf("F-026")).toMatchObject([
      { kind: "unreadable-proof-file", file: "context/proof/F-026.md" },
    ]);
    const [former] = await problemsOf("F-027");
    expect(former?.kind === "unreadable-proof-file" && former.reason).toContain(
      "scripts/proof-migrate.ts",
    );
  });

  it("only warns for a done row in the baseline, and fails once it is proved, so the baseline shrinks", async () => {
    await ledger({ id: "F-025", doneWhen: twoConditions, status: "done" });
    await baseline("F-025");
    await proof(
      "F-025",
      "| c1 | A member stops it. | — | — | — | missing |",
      "| c2 | Its branches stay. | — | — | — | missing |",
    );
    expect(await reportOf("F-025")).toMatchObject({ enforced: false, baselined: true });
    expect(renderReport(await check())).toMatchObject({ errors: 0, warnings: 2 });

    await provedLedger();
    await baseline("F-025");
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

  it("warns about a planned row's proof file and its keys without one, and leaves the other rows alone unless done", async () => {
    await ledger(
      { id: "F-017", doneWhen: twoConditions, status: "planned" },
      { id: "F-018", doneWhen: twoConditions, status: "planned" },
      { id: "F-019", doneWhen: twoConditions, status: "dropped" },
      { id: "F-020", doneWhen: twoConditions, status: "building" },
    );
    await tests("src/a.test.ts", "F-020/c1: one", "F-020/c2: two");
    await proof("F-017", "| c1 | A member stops it. | — | — | — | missing |");
    const report = await check();
    expect(report.features.map(({ feature }) => feature.id)).toEqual(["F-017", "F-020"]);
    expect(await problemsOf("F-020")).toEqual([
      { kind: "keys-without-proof-file", file: "context/proof/F-020.md", tests: 2 },
    ]);
    expect(renderReport(report)).toMatchObject({ errors: 0, warnings: 3 });
  });

  it("warns about a row that isn't done though every condition is proved", async () => {
    await provedLedger("building");
    expect(await problemsOf("F-025")).toEqual([{ kind: "could-be-done" }]);
    expect(renderReport(await check())).toMatchObject({ errors: 0, warnings: 1 });
  });

  it("reports each problem of an enforced row with its condition, and sums up the rows that only warn", async () => {
    await ledger(
      { id: "F-025", title: "Stop", doneWhen: twoConditions, status: "done" },
      { id: "F-026", title: "Approvals", doneWhen: twoConditions, status: "building" },
    );
    const rows = [
      "| c1 | A member stops it. | — | — | — | missing |",
      "| c2 | Its branches stay. | — | — | — | partial |",
    ];
    await proof("F-025", ...rows);
    await proof("F-026", ...rows);
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
    it("writes a proof file with every condition keyed and missing, which check:proof reads back", async () => {
      await ledger({
        id: "F-025",
        doneWhen: `${twoConditions} *Changed 2026-11-18: renamed.*`,
        status: "building",
      });
      const [feature] = parseFeatures(await read("context/features.md"));
      if (feature === undefined) throw new Error("no feature");
      expect(await writeProofFile(root, feature)).toEqual({
        kind: "created",
        file: "context/proof/F-025.md",
        conditions: 2,
      });
      const parsed = parseProofFile(await read("context/proof/F-025.md"));
      expect(
        parsed.ok && parsed.rows.map(({ key, condition, status }) => [key, condition, status]),
      ).toEqual([
        ["c1", "A member stops it.", "missing"],
        ["c2", "Its branches stay.", "missing"],
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

    it("brings an existing file up to a changed done-when under new keys, keeping its rows, their keys and its notes", async () => {
      await ledger({
        id: "F-025",
        doneWhen: "A member stops it. Its branches \\| refs stay. A third.",
        status: "building",
      });
      await proof("F-025", provedRows[1] ?? "", provedRows[0] ?? "");
      const [feature] = parseFeatures(await read("context/features.md"));
      if (feature === undefined) throw new Error("no feature");
      expect(await writeProofFile(root, feature)).toEqual({
        kind: "updated",
        file: "context/proof/F-025.md",
        added: 2,
        stale: 1,
      });
      const text = await read("context/proof/F-025.md");
      expect(text.split("\n").slice(4, 9)).toEqual([
        provedRows[0],
        "| c3 | Its branches \\| refs stay. | — | — | — | missing |",
        "| c4 | A third. | — | — | — | missing |",
        provedRows[1],
        "",
      ]);
      expect(text).toContain("Notes.");
      const parsed = parseProofFile(text);
      expect(parsed.ok && parsed.rows[1]?.condition).toBe("Its branches | refs stay.");
    });
  });

  describe("proof-migrate", () => {
    it("converts a former proof file: keys its rows, renames the cited tests and their snapshots, and proves nothing that wasn't", async () => {
      await ledger({ id: "F-025", doneWhen: "One. Two. Three.", status: "done" });
      await write(
        "src/stop.test.ts",
        [
          'describe("stop", () => {',
          '  it("F-025: one", () => { expect(1).toMatchSnapshot(); });',
          "  it('F-025, F-033: one and two', () => {});",
          '  it("on host: the third", () => {});',
          "});",
        ].join("\r\n"),
      );
      await write("src/__snapshots__/stop.test.ts.snap", "exports[`stop > F-025: one 1`] = `1`;\n");
      await write("evidence/run.log", "ok\n");
      await write(
        "context/proof/F-025.md",
        [
          "# F-025: A feature",
          "",
          `The proof of F-025's "done when" in \`context/features.md\`: one row per condition, quoted verbatim. The rules are in \`context/proof/README.md\`, and \`pnpm check:proof\` checks this file.`,
          "",
          "| Condition | Proved by | Kind | Break-it | Status |",
          "|---|---|---|---|---|",
          '| One. | `src/stop.test.ts` > "F-025: one"<br>`src/stop.test.ts` > "F-025, F-033: one and two" | unit | dropped it | proved |',
          '| Two. | `src/stop.test.ts` > "F-025, F-033: one and two"<br>live: `evidence/run.log` | unit, live | dropped it | proved |',
          '| Three. | `src/stop.test.ts` > "on host: the third" | unit | broke it | missing |',
          "",
          "Notes.",
          "",
        ].join("\n"),
      );
      expect(await migrateProofs(root)).toEqual({
        files: ["context/proof/F-025.md"],
        renamedTests: 3,
        unmatched: [],
      });
      expect((await read("src/stop.test.ts")).split("\r\n")).toEqual([
        'describe("stop", () => {',
        '  it("F-025/c1: one", () => { expect(1).toMatchSnapshot(); });',
        "  it('F-025/c1,c2, F-033: one and two', () => {});",
        '  it("F-025/c3: on host: the third", () => {});',
        "});",
      ]);
      expect(await read("src/__snapshots__/stop.test.ts.snap")).toBe(
        "exports[`stop > F-025/c1: one 1`] = `1`;\n",
      );
      const text = await read("context/proof/F-025.md");
      expect(text.split("\n").slice(2, 10)).toEqual([
        proofFileIntro("F-025"),
        "",
        "| Key | Condition | Tests | Live | Break-it | Status |",
        "|---|---|---|---|---|---|",
        '| c1 | One. | `src/stop.test.ts` > "F-025/c1: one"<br>`src/stop.test.ts` > "F-025/c1,c2, F-033: one and two" | — | dropped it | proved |',
        '| c2 | Two. | `src/stop.test.ts` > "F-025/c1,c2, F-033: one and two" | `evidence/run.log` | dropped it | proved |',
        '| c3 | Three. | `src/stop.test.ts` > "F-025/c3: on host: the third" | — | broke it | partial |',
        "",
      ]);
      expect(await problemsOf("F-025")).toEqual([
        { kind: "not-proved", line: 9, condition: "Three.", status: "partial" },
      ]);
      expect(await migrateProofs(root)).toEqual({ files: [], renamedTests: 0, unmatched: [] });
    });

    it("matches a cited name the code already keys, as after a rebase onto the keyed form", async () => {
      await ledger({ id: "F-025", doneWhen: "One. Two.", status: "building" });
      await tests("src/a.test.ts", "F-025/c1: one");
      await write(
        "context/proof/F-025.md",
        [
          "| Condition | Proved by | Kind | Break-it | Status |",
          "|---|---|---|---|---|",
          "| One. | — | — | — | missing |",
          '| Two. | `src/a.test.ts` > "F-025: one" | unit | broke it | proved |',
          "",
        ].join("\n"),
      );
      expect(await migrateProofs(root)).toMatchObject({ renamedTests: 1, unmatched: [] });
      expect(await read("src/a.test.ts")).toBe('it("F-025/c1,c2: one", () => {});');
    });

    it("renames the snapshots of an it.each test, whose keys fill in its placeholders, and no other", () => {
      const rename = { from: "F-115: the %s mail, $kind", length: 5, head: "F-115/c1" };
      expect(
        renameSnapshotKey("exports[`the mails > F-115: the plan mail, pr 1`] = `", rename),
      ).toBe("exports[`the mails > F-115/c1: the plan mail, pr 1`] = `");
      expect(renameSnapshotKey("exports[`F-115: the plan mail, pr 2`] = `", rename)).toBe(
        "exports[`F-115/c1: the plan mail, pr 2`] = `",
      );
      expect(
        renameSnapshotKey("exports[`the mails > F-116: the plan mail, pr 1`] = `", rename),
      ).toBeUndefined();
      expect(renameSnapshotKey('  "subject": "F-115: the plan mail",', rename)).toBeUndefined();
    });
  });
});
