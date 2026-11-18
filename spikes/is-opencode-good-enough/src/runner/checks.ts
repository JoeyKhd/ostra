// What the harness checks about a run's result, on a copy of it so the
// workspace is never touched:
//   - CI, as a reviewer would see it: the repo's own tests, and the strict typecheck.
//   - Acceptance, which the agent never saw: a hidden test file for a bug, a
//     feature or a refactor; for an "add tests" ticket, the agent's tests run
//     against the pristine code (they must pass) and against seeded faults
//     (they must fail on most of them).
// These are signals next to the human rating, not a replacement for it.
//
// They run the agent's code: its tests, and the command line it changed. Every
// child gets an allowlisted environment and a HOME and temp folder inside the
// verify folder, so whatever LINEAR_*, GITHUB_* or model key the harness's own
// shell holds never reaches it. That is all it is: the code runs as the
// member's account (see sandbox.ts).

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exec } from "./exec.ts";
import { cleanEnv } from "./sandbox.ts";
import { ACCEPTANCE_DIR, copyRepo, SAMPLE_REPO, TSC_BIN, TYPES_ROOT, writeText } from "./workspace.ts";
import type { Mutant, Ticket } from "../tickets/schema.ts";
import type { AcceptanceResult, CiResult, MutationResult, TestCounts } from "./schemas.ts";

export type { AcceptanceResult, CiResult, MutationResult, TestCounts };

const TEST_TIMEOUT_MS = 120_000;
const TYPECHECK_TIMEOUT_MS = 120_000;

const TAP_COUNT = /^# (tests|pass|fail) (\d+)$/gm;

/** Reads the totals off node:test's TAP output. */
export const parseTap = (output: string): TestCounts => {
  const counts = { tests: 0, pass: 0, fail: 0 };
  for (const match of output.matchAll(TAP_COUNT)) {
    const name = match[1];
    const value = Number(match[2]);
    if (name === "tests") counts.tests = value;
    else if (name === "pass") counts.pass = value;
    else if (name === "fail") counts.fail = value;
  }
  return { total: counts.tests, pass: counts.pass, fail: counts.fail };
};

/** The number of errors tsc reported. */
export const countTypeErrors = (output: string): number => (output.match(/ error TS\d+:/g) ?? []).length;

const tail = (text: string, chars = 1500): string => (text.length <= chars ? text : `...${text.slice(-chars)}`);

/** A verify folder: the result under test at sample-repo/, the hidden tests at src/tickets/acceptance/. */
export type VerifyDir = { readonly root: string; readonly repo: string };

/** The environment of every process that runs a verify folder's code. */
const envOf = (verify: VerifyDir): Record<string, string> => cleanEnv(path.join(verify.root, "scratch"));

const tsconfigFor = (): string =>
  JSON.stringify({
    extends: "./sample-repo/tsconfig.json",
    compilerOptions: { typeRoots: [TYPES_ROOT], types: ["node"] },
    include: ["sample-repo/src/**/*.ts", "sample-repo/test/**/*.ts"],
  });

export const prepareVerifyDir = async (root: string, repoSource: string, options: { readonly withAcceptance: boolean }): Promise<VerifyDir> => {
  const repo = path.join(root, "sample-repo");
  await mkdir(path.join(root, "scratch"), { recursive: true });
  await copyRepo(repoSource, repo);
  await writeText(path.join(root, "package.json"), JSON.stringify({ name: "verify", private: true, type: "module" }));
  await writeText(path.join(root, "tsconfig.check.json"), tsconfigFor());
  if (options.withAcceptance) await copyRepo(ACCEPTANCE_DIR, path.join(root, "src", "tickets", "acceptance"));
  return { root, repo };
};

const runSuite = async (verify: VerifyDir): Promise<{ counts: TestCounts; ran: boolean; ok: boolean; output: string }> => {
  const result = await exec(process.execPath, ["--test", "--test-reporter=tap", "test/**/*.test.ts"], { cwd: verify.repo, timeoutMs: TEST_TIMEOUT_MS, env: envOf(verify) });
  const counts = parseTap(result.stdout);
  return { counts, ran: counts.total > 0, ok: result.code === 0 && counts.fail === 0 && counts.total > 0, output: result.stdout + result.stderr };
};

export const runCi = async (verify: VerifyDir): Promise<{ result: CiResult; output: string }> => {
  const suite = await runSuite(verify);
  const tsc = await exec(process.execPath, [TSC_BIN, "-p", path.join(verify.root, "tsconfig.check.json")], { cwd: verify.root, timeoutMs: TYPECHECK_TIMEOUT_MS, env: envOf(verify) });
  const errors = countTypeErrors(tsc.stdout + tsc.stderr);
  const typecheckOk = tsc.code === 0 && errors === 0;
  return {
    result: {
      tests: { ...suite.counts, ran: suite.ran },
      typecheck: { ok: typecheckOk, errors },
      green: suite.ok && typecheckOk,
    },
    output: `${suite.ok ? "" : `tests:\n${tail(suite.output)}\n`}${typecheckOk ? "" : `typecheck:\n${tail(tsc.stdout + tsc.stderr)}\n`}`,
  };
};

export const runBehaviorAcceptance = async (verify: VerifyDir, file: string): Promise<AcceptanceResult> => {
  const result = await exec(process.execPath, ["--test", "--test-reporter=tap", path.join("src", "tickets", "acceptance", file)], {
    cwd: verify.root,
    timeoutMs: TEST_TIMEOUT_MS,
    env: envOf(verify),
  });
  const counts = parseTap(result.stdout);
  const passed = result.code === 0 && counts.fail === 0 && counts.total > 0;
  return { kind: "behavior", passed, tests: counts, detail: passed ? "" : tail(result.stdout + result.stderr, 3000) };
};

/** Applies a seeded fault to the text of a file. Throws if the fault doesn't apply exactly once: that is a harness bug. */
export const applyMutant = (text: string, mutant: Mutant): string => {
  const parts = text.split(mutant.find);
  if (parts.length !== 2) throw new Error(`mutant ${mutant.id}: its text occurs ${String(parts.length - 1)} times, expected 1`);
  return parts.join(mutant.replace);
};

const mutationNeeded = (total: number): number => Math.ceil((total * 2) / 3);

/**
 * `verify.repo` must hold the pristine sample with the agent's `test/` folder
 * in place of the sample's. The mutants are applied to the pristine target one
 * at a time.
 */
export const runMutationAcceptance = async (verify: VerifyDir, target: string, mutants: readonly Mutant[]): Promise<AcceptanceResult> => {
  const baseline = await runSuite(verify);
  const file = path.join(verify.repo, target);
  const original = await readFile(file, "utf8");
  const survivors: string[] = [];
  let killed = 0;
  try {
    for (const mutant of mutants) {
      await writeText(file, applyMutant(original, mutant));
      const run = await runSuite(verify);
      // A suite that fails, crashes or hangs on the mutated module has noticed it.
      if (!run.ok) killed += 1;
      else survivors.push(mutant.id);
    }
  } finally {
    await writeText(file, original);
  }
  const needed = mutationNeeded(mutants.length);
  const mutation: MutationResult = { greenOnPristine: baseline.ok, killed, total: mutants.length, survivors, needed };
  const passed = baseline.ok && killed >= needed;
  return {
    kind: "mutation",
    passed,
    tests: baseline.counts,
    mutation,
    detail: passed ? "" : `${baseline.ok ? "" : `the suite is not green on the pristine code:\n${tail(baseline.output)}\n`}killed ${String(killed)} of ${String(mutants.length)} seeded faults (needed ${String(needed)}); survivors: ${survivors.join(", ")}`,
  };
};

const packageJson = z.looseObject({ name: z.string() });

/** True when the sample repo's package.json can be read: a guard for harness set-up mistakes. */
export const sampleIsPresent = async (): Promise<boolean> => {
  try {
    return packageJson.safeParse(JSON.parse(await readFile(path.join(SAMPLE_REPO, "package.json"), "utf8"))).success;
  } catch {
    return false;
  }
};

/**
 * Checks one run's result. For behaviour tickets, the result is the workspace.
 * For "add tests" tickets, the agent's test folder goes onto a pristine sample
 * for the mutation check, and the CI is run on the real result.
 */
export const checkResult = async (
  ticket: Ticket,
  workspace: string,
  verifyRoot: string,
): Promise<{ ci: CiResult; acceptance: AcceptanceResult; log: string }> => {
  const resultDir = path.join(verifyRoot, "result");
  const result = await prepareVerifyDir(resultDir, workspace, { withAcceptance: ticket.acceptance.kind === "behavior" });
  const ci = await runCi(result);
  let acceptance: AcceptanceResult;
  if (ticket.acceptance.kind === "behavior") {
    acceptance = await runBehaviorAcceptance(result, ticket.acceptance.file);
  } else {
    const pristine = await prepareVerifyDir(path.join(verifyRoot, "pristine"), SAMPLE_REPO, { withAcceptance: false });
    // The agent's tests go onto the pristine code in place of the sample's.
    await rm(path.join(pristine.repo, "test"), { recursive: true, force: true });
    await copyRepo(path.join(workspace, "test"), path.join(pristine.repo, "test")).catch(() => undefined);
    acceptance = await runMutationAcceptance(pristine, ticket.acceptance.target, ticket.acceptance.mutants);
  }
  return { ci: ci.result, acceptance, log: [ci.output, acceptance.detail].filter((s) => s !== "").join("\n") };
};
