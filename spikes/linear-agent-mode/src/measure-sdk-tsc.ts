import { measureImportMs, measureSdkCost, sdkCosts } from "./tsc-measure.ts";
import { formatMs, median } from "./util.ts";

// `pnpm measure:tsc`: what @linear/sdk adds to `tsc`, under the strict flags in tsconfig.base.json, with lib
// checking off and on. Two projects that differ only by the SDK (measure/baseline and measure/with-sdk), one
// warm-up and N timed runs each. The compiler is the `typescript` package this spike pins (6.0.3, the same as
// ostra's root workspace).

const runs = Number(process.argv[2] ?? "5");
if (!Number.isInteger(runs) || runs < 1 || runs > 30) throw new RangeError("usage: measure:tsc [runs 1-30]");

console.log(`tsc cost of @linear/sdk@102.0.0: ${String(runs)} timed runs per cell after a warm-up, ${process.platform}, Node ${process.version}\n`);
const measurements = await measureSdkCost({ runs, skipLibCheck: ["off", "on"] });

for (const m of measurements) {
  const own = m.runs.map((run) => run.totalTimeS).filter((value): value is number => value !== null);
  const check = m.runs.map((run) => run.checkTimeS).filter((value): value is number => value !== null);
  const memory = m.runs.map((run) => run.memoryK).filter((value): value is number => value !== null);
  console.log(
    `${m.compiler.id.padEnd(13)} skipLibCheck ${m.skipLibCheck.padEnd(3)} ${m.project.padEnd(8)} ` +
      `wall median ${formatMs(m.medianWallMs).padStart(9)} (runs ${m.runs.map((run) => formatMs(run.wallMs)).join(", ")}); ` +
      `tsc's own total ${own.length > 0 ? `${median(own).toFixed(2)} s` : "n/a"}, check ${check.length > 0 ? `${median(check).toFixed(2)} s` : "n/a"}, ` +
      `${String(m.runs[0]?.files ?? "?")} files, ${memory.length > 0 ? `${String(Math.round(median(memory) / 1024))} MB` : "n/a"}` +
      (m.clean ? "" : "  ** a run failed **"),
  );
}

console.log("");
for (const cost of sdkCosts(measurements)) {
  console.log(`${cost.compiler.id}, skipLibCheck ${cost.skipLibCheck}: the SDK adds ${formatMs(cost.addedMs)} (${formatMs(cost.baselineWallMs)} to ${formatMs(cost.withSdkWallMs)})${cost.clean ? "" : "  ** a run failed **"}`);
}

const [sdk, webhooks] = await Promise.all([measureImportMs("@linear/sdk", 5), measureImportMs("@linear/sdk/webhooks", 5)]);
console.log(`\ncold import in a fresh Node: @linear/sdk ${formatMs(sdk)}, @linear/sdk/webhooks ${formatMs(webhooks)}`);

const worst = Math.max(...sdkCosts(measurements).filter((c) => c.skipLibCheck === "off").map((c) => c.addedMs));
const failed = measurements.some((m) => !m.clean);
console.log(`\nworking value: under 20 s. Worst case here with lib checking on: ${formatMs(worst)}. ${failed || worst >= 20_000 ? "FAIL" : "PASS"}`);
process.exitCode = failed || worst >= 20_000 ? 1 : 0;
