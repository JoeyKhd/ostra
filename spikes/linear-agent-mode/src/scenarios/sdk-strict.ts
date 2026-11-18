import { compilers, measureImportMs, measureSdkCost, runTsc, sdkCosts } from "../tsc-measure.ts";
import type { SkipLibCheck } from "../tsc-measure.ts";
import { formatMs } from "../util.ts";
import { guarded } from "./common.ts";
import type { ScenarioReport } from "./common.ts";

/** The working value in the pass bar: the SDK may add under 20 s to `tsc`. */
export const SDK_BUDGET_MS = 20_000;

export type SdkStrictOptions = {
  /** Timed runs per cell, after one warm-up. */
  readonly runs: number;
  readonly skipLibCheck: readonly SkipLibCheck[];
};

export const runSdkStrictScenario = (options: SdkStrictOptions): Promise<ScenarioReport> =>
  guarded("sdk-strict", async (r) => {
    // 1. Under the strict flags, in the two ways ostra could configure lib checking.
    for (const compiler of compilers()) {
      const own = await runTsc(compiler, "tsconfig.json", [], 5 * 60_000);
      r.check(
        `this spike (strict flags, skipLibCheck off) typechecks with ${compiler.label}`,
        own.code === 0 && !own.timedOut,
        own.code === 0 ? `${formatMs(own.wallMs)}, ${String(own.files ?? "?")} files` : `${String(own.errorLines.length)} errors: ${own.errorLines.slice(0, 3).join(" | ")}`,
      );
      // ostra's root tsconfig has skipLibCheck on and no DOM. measure/root-style is the SDK's usage under exactly
      // that, with no shim file in the project.
      const rootStyle = await runTsc(compiler, "measure/root-style/tsconfig.json", [], 5 * 60_000);
      r.check(
        `the SDK's usage typechecks with ostra's root-style settings (strict flags, skipLibCheck on, no DOM, no shim) with ${compiler.label}`,
        rootStyle.code === 0 && !rootStyle.timedOut,
        rootStyle.code === 0 ? `${formatMs(rootStyle.wallMs)}, ${String(rootStyle.files ?? "?")} files` : `${String(rootStyle.errorLines.length)} errors: ${rootStyle.errorLines.slice(0, 3).join(" | ")}`,
      );
    }

    // 2. What the SDK adds, as the difference between two projects that differ only by it.
    const measurements = await measureSdkCost({ runs: options.runs, skipLibCheck: options.skipLibCheck });
    const costs = sdkCosts(measurements);
    for (const cost of costs) {
      const where = `${cost.compiler.label}, skipLibCheck ${cost.skipLibCheck}`;
      r.note(`tsc, ${where}: without the SDK ${formatMs(cost.baselineWallMs)}, with it ${formatMs(cost.withSdkWallMs)}, so it adds ${formatMs(cost.addedMs)} (median of ${String(options.runs)} runs after a warm-up, wall time of the whole process).`);
    }
    const strict = costs.filter((c) => c.skipLibCheck === "off");
    for (const cost of strict) {
      r.check(
        `the SDK adds under ${formatMs(SDK_BUDGET_MS)} to tsc with ${cost.compiler.label}, lib checking on`,
        cost.clean && cost.addedMs < SDK_BUDGET_MS,
        `adds ${formatMs(cost.addedMs)}${cost.clean ? "" : " (a run failed)"}`,
      );
    }
    r.check("the strict-flags comparison actually ran", strict.length === compilers().length);

    // 3. Start-up: what importing it costs a server process.
    const [sdk, webhooks, zod] = await Promise.all([
      measureImportMs("@linear/sdk", 3),
      measureImportMs("@linear/sdk/webhooks", 3),
      measureImportMs("zod", 3),
    ]);
    r.note(`Cold import in a fresh Node 24 (median of 3): @linear/sdk ${formatMs(sdk)}, @linear/sdk/webhooks ${formatMs(webhooks)}, zod ${formatMs(zod)}.`);
    r.note("ostra's root config has skipLibCheck on, where the SDK typechecks with no shim and no errors (checked above). The SDK's declarations name two DOM types (JsonWebKey, CryptoKeyPair), so with no DOM lib and skipLibCheck off, tsc reports two errors in the SDK's own d.ts; src/sdk-shims.d.ts is the four-line alias that fixes it, needed only if ostra turns skipLibCheck off.");
    r.note("Node typings: @types/node 26.6.6, the version ostra's root workspace pins. TypeScript: 6.0.3, also the root's. The measure is of tsc on a small project, not ostra's whole repo, and not the editor's language server.");
  });
