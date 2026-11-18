// CALC-8: runCli(args, io) returns the exit code and writes through io; the
// script behaves as before; importing the file has no effect.
//
// runCli is loaded by a dynamic import, because the sample doesn't export it
// yet: the module's shape is checked at run time, where a missing export is a
// plain test failure instead of a type error in the harness.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCliProcess } from "./support.ts";

type Io = { out: (line: string) => void; err: (line: string) => void };
type RunCli = (args: readonly string[], io: Io) => number;

const isRunCli = (value: unknown): value is RunCli => typeof value === "function";

const exitCodeBeforeImport = process.exitCode;
const loaded: unknown = await import("../../../sample-repo/src/cli.ts");
const exitCodeAfterImport = process.exitCode;

const runCli = (): RunCli => {
  const candidate: unknown = typeof loaded === "object" && loaded !== null && "runCli" in loaded ? loaded.runCli : undefined;
  if (!isRunCli(candidate)) throw new Error("src/cli.ts does not export a function named runCli");
  return candidate;
};

const capture = (args: readonly string[]): { code: number; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli()(args, {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
  });
  return { code, out, err };
};

describe("CALC-8: runCli", () => {
  it("importing the file has no effect on the process", () => {
    assert.equal(exitCodeAfterImport, exitCodeBeforeImport);
  });

  it("prints a result and returns 0", () => {
    const result = capture(["1+2"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ["3"]);
    assert.deepEqual(result.err, []);
  });

  it("prints each expression's result on its own line", () => {
    const result = capture(["1 + 1", "2 + 2"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ["2", "4"]);
  });

  it("groups thousands with --thousands", () => {
    const result = capture(["--thousands", "1000 * 1000"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ["1,000,000"]);
  });

  it("reports a wrong expression on err and returns 1", () => {
    const result = capture(["1 +"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, []);
    assert.equal(result.err.length, 1);
    assert.match(result.err[0] ?? "", /^error: /);
  });

  it("stops at the first wrong expression", () => {
    const result = capture(["1 + 1", "nope", "3 + 3"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, ["2"]);
    assert.match(result.err.join("\n"), /error: Unknown name 'nope'/);
  });

  it("returns 2 and the usage on err when there is nothing to calculate", () => {
    const result = capture([]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.out, []);
    assert.match(result.err.join("\n"), /Usage: calc/);
  });

  it("returns 2 for an unknown option", () => {
    const result = capture(["--nope", "1"]);
    assert.equal(result.code, 2);
    assert.match(result.err.join("\n"), /error: unknown option --nope/);
  });

  it("prints the usage on out for --help and returns 0", () => {
    const result = capture(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.out.join("\n"), /Usage: calc/);
    assert.deepEqual(result.err, []);
  });

  it("-h is --help", () => {
    const result = capture(["-h"]);
    assert.equal(result.code, 0);
    assert.match(result.out.join("\n"), /Usage: calc/);
  });
});

describe("CALC-8: the script", () => {
  it("still prints a result and exits 0", async () => {
    const run = await runCliProcess(["1+2"]);
    assert.equal(run.code, 0);
    assert.equal(run.stdout.trim(), "3");
  });

  it("still exits 1 on a wrong expression, with the message on stderr", async () => {
    const run = await runCliProcess(["nope"]);
    assert.equal(run.code, 1);
    assert.equal(run.stdout.trim(), "");
    assert.match(run.stderr, /error: Unknown name 'nope'/);
  });

  it("still exits 2 when used wrongly", async () => {
    const run = await runCliProcess([]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /Usage: calc/);
  });
});
