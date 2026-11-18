import { z } from "zod";
import { CRITERIA, CRITERION_IDS, INPUTS } from "./criteria.ts";
import type { CriterionId, CriterionSpec } from "./criteria.ts";
import { missingForCriterion, presentInputs } from "./env.ts";
import { runHardeningScenario } from "./scenarios/hardening.ts";
import { runInstallScenario } from "./scenarios/install.ts";
import { runKeepAliveScenario } from "./scenarios/keep-alive.ts";
import { runLatencyScenario } from "./scenarios/latency.ts";
import { runSdkStrictScenario } from "./scenarios/sdk-strict.ts";
import { runStopFollowUpScenario } from "./scenarios/stop-follow-up.ts";
import type { ScenarioReport } from "./scenarios/common.ts";
import { formatMs } from "./util.ts";

// `pnpm spike`: runs every pass-bar criterion that can run on this machine and prints PASS, FAIL or SKIPPED for
// each bullet. A bullet is PASS only when a real Linear run backs it, or when it never needed one. Passing against the
// local fake Linear is printed as what it is, on its own lines, and never counts as the bullet.

const argsSchema = z.object({
  realTime: z.boolean(),
  tscRuns: z.number().int().min(1).max(20),
  only: z.enum([...CRITERION_IDS, "hardening"]).nullable(),
  bothSkipLibCheckModes: z.boolean(),
});

const parseArgs = (argv: readonly string[]): z.infer<typeof argsSchema> => {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return argsSchema.parse({
    realTime: argv.includes("--real-time"),
    tscRuns: Number(value("--tsc-runs") ?? "3"),
    only: value("--only") ?? null,
    bothSkipLibCheckModes: argv.includes("--both-skip-lib-check-modes"),
  });
};

const scaleSchema = z.coerce.number().int().min(1).max(5000);

const marks = { PASS: "PASS    ", FAIL: "FAIL    ", SKIPPED: "SKIPPED " } as const;

/** `tier` is what the check ran against: the fake Linear, or this machine alone. */
const printReport = (report: ScenarioReport, indent: string, tier: "fake" | "local"): { passed: number; failed: number } => {
  let passed = 0;
  let failed = 0;
  for (const check of report.checks) {
    if (check.status === "PASS") passed += 1;
    else failed += 1;
    const detail = check.detail.length > 0 ? `  (${check.detail})` : "";
    console.log(`${indent}${marks[check.status]} ${tier.padEnd(5)} ${check.name}${detail}`);
  }
  for (const note of report.notes) console.log(`${indent}note: ${note}`);
  return { passed, failed };
};

type Verdict = "PASS" | "FAIL" | "SKIPPED";

type Row = {
  readonly spec: CriterionSpec;
  readonly fake: { readonly passed: number; readonly failed: number } | null;
  readonly verdict: Verdict;
  readonly why: string;
};

const realLine = (spec: CriterionSpec): string => {
  if (spec.realInputs.length === 0) return `n/a     ${spec.realNeeds}`;
  const missing = missingForCriterion(process.env, spec.id);
  return missing.length > 0
    ? `needs ${missing.join(", ")}; and ${spec.realNeeds}`
    : `inputs are present, but this needs ${spec.realNeeds}: run \`pnpm spike:real\``;
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  const scale = args.realTime ? 1 : scaleSchema.parse(process.env["SPIKE_TIME_SCALE"] ?? "300");
  const started = performance.now();
  console.log(`ostra milestone 0, spike 5: linear-agent-mode`);
  console.log(`${new Date().toISOString().slice(0, 10)} on ${process.platform}, Node ${process.version}`);
  const present = presentInputs(process.env);
  console.log(`inputs: ${INPUTS.map((i) => `${i.name} ${present[i.name] ? "present" : "missing"}`).join(", ")}`);
  console.log("");

  const runners: Readonly<Record<CriterionId, () => Promise<ScenarioReport>>> = {
    install: runInstallScenario,
    latency: runLatencyScenario,
    "stop-follow-up": runStopFollowUpScenario,
    "keep-alive": () => runKeepAliveScenario(scale),
    "sdk-strict": () =>
      runSdkStrictScenario({ runs: args.tscRuns, skipLibCheck: args.bothSkipLibCheckModes ? ["off", "on"] : ["off"] }),
  };

  const rows: Row[] = [];
  for (const spec of CRITERIA) {
    if (args.only !== null && args.only !== spec.id) continue;
    console.log(`[${String(spec.n)}] ${spec.passBar}`);
    const t0 = performance.now();
    const report = await runners[spec.id]();
    const tally = printReport(report, "    ", spec.realInputs.length === 0 ? "local" : "fake");
    const real = realLine(spec);
    if (spec.realInputs.length > 0) console.log(`    ${marks.SKIPPED} real  ${real}`);
    console.log(`    (${formatMs(performance.now() - t0)})`);
    const verdict: Verdict = tally.failed > 0 ? "FAIL" : spec.realInputs.length === 0 ? "PASS" : "SKIPPED";
    const why =
      tally.failed > 0
        ? `${String(tally.failed)} check(s) failed`
        : spec.realInputs.length === 0
          ? "runs fully on this machine"
          : `all ${String(tally.passed)} fake-Linear checks pass; real Linear not run`;
    rows.push({ spec, fake: tally, verdict, why });
    console.log("");
  }

  let hardeningFailed = 0;
  let hardeningPassed = 0;
  if (args.only === null || args.only === "hardening") {
    console.log("[H] Webhook handler edges: signed replays, tampering, duplicates (not a pass-bar bullet)");
    const t0 = performance.now();
    const report = await runHardeningScenario();
    const tally = printReport(report, "    ", "fake");
    hardeningFailed = tally.failed;
    hardeningPassed = tally.passed;
    console.log(`    (${formatMs(performance.now() - t0)})`);
    console.log("");
  }

  console.log("Pass bar");
  for (const row of rows) {
    console.log(`  ${marks[row.verdict]}${String(row.spec.n)}. ${row.spec.passBar}`);
    console.log(`           ${row.why}`);
  }
  if (hardeningFailed > 0) console.log(`  FAIL    [H] ${String(hardeningFailed)} webhook-edge check(s) failed`);
  else if (hardeningPassed > 0) console.log(`  PASS    [H] webhook handler edges: all ${String(hardeningPassed)} checks pass (not a pass-bar bullet)`);
  const numbers = (verdict: Verdict): string => rows.filter((row) => row.verdict === verdict).map((row) => String(row.spec.n)).join(", ");
  console.log(`\nBullets passed: ${numbers("PASS") || "none"}. Failed: ${numbers("FAIL") || "none"}. SKIPPED, waiting for \`pnpm spike:real\` against real Linear: ${numbers("SKIPPED") || "none"}.`);
  console.log("A pass against the fake Linear never counts as the bullet: the fake defines Linear's rules, so it can only show that ostra's side behaves as the spike assumed.");
  const failed = rows.filter((row) => row.verdict === "FAIL").length + (hardeningFailed > 0 ? 1 : 0);
  console.log(`\n${formatMs(performance.now() - started)} in all.`);
  return failed > 0 ? 1 : 0;
};

// Leaves nothing running: if a handle is still open a few seconds after the work is done, say which and exit.
const watchdog = (): void => {
  setTimeout(() => {
    const open = process.getActiveResourcesInfo().filter((name) => name !== "TTYWrap" && name !== "Timeout");
    console.error(`still running after the harness finished: ${open.join(", ") || "a timer"}`);
    process.exit(2);
  }, 8_000).unref();
};

main().then(
  (code) => {
    process.exitCode = code;
    watchdog();
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
    watchdog();
  },
);
