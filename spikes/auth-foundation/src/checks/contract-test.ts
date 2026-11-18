import fs from "node:fs/promises";
import path from "node:path";
import * as z from "zod";
import { dataDir, nodeModulesBin, spikeRoot, toolEnv } from "../paths.ts";
import { runProcess } from "../proc.ts";

const vitestReportSchema = z
  .object({
    success: z.boolean(),
    numTotalTests: z.number(),
    numPassedTests: z.number(),
    numFailedTests: z.number(),
  })
  .loose();

/** Runs test/contract.test.ts in its own process and its own database, and reads Vitest's JSON report. */
export const runContractTest = async (): Promise<string> => {
  // Vitest 5 writes its JSON report to a file, not to stdout.
  await fs.mkdir(dataDir, { recursive: true });
  const reportPath = path.join(dataDir, "vitest-report.json");
  await fs.rm(reportPath, { force: true });
  const result = await runProcess(
    process.execPath,
    [nodeModulesBin.vitest, "run", "--reporter=json", `--outputFile.json=${reportPath}`],
    { cwd: spikeRoot, env: toolEnv({}), timeoutMs: 300_000 },
  );
  let raw: string;
  try {
    raw = await fs.readFile(reportPath, "utf8");
  } catch {
    throw new Error(`vitest produced no report (exit ${String(result.code)}): ${result.stderr.trim().slice(-400)}`);
  }
  const report = vitestReportSchema.parse(JSON.parse(raw));
  if (!report.success || report.numFailedTests > 0 || report.numTotalTests === 0) {
    throw new Error(
      `${String(report.numFailedTests)} of ${String(report.numTotalTests)} contract tests failed; run \`pnpm test\` for the report`,
    );
  }
  return `${String(report.numPassedTests)} of ${String(report.numTotalTests)} contract tests pass (sign up, the session, a role; pinned version)`;
};
