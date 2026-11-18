import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { median } from "./util.ts";

// Times `tsc` on this machine, with and without @linear/sdk, under the strict flags in tsconfig.base.json.
// Everything is spawned with an argument array: no shell, no string built from outside input.

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Compiler = {
  readonly id: "typescript-6";
  readonly label: string;
  readonly entry: string;
};

const resolveEntry = (packageName: string): string => {
  const resolver = createRequire(join(PACKAGE_ROOT, "package.json"));
  return join(dirname(resolver.resolve(`${packageName}/package.json`)), "bin", "tsc");
};

// One compiler: the `typescript` package ostra's root workspace pins (6.0.3). The entry is the package's own bin,
// not whatever `tsc` the package manager linked, so which compiler runs never depends on bin-link order.
export const compilers = (): readonly Compiler[] => [
  { id: "typescript-6", label: "TypeScript 6.0.3", entry: resolveEntry("typescript") },
];

export type TscRun = {
  readonly code: number;
  readonly wallMs: number;
  readonly timedOut: boolean;
  readonly errorLines: readonly string[];
  readonly totalTimeS: number | null;
  readonly checkTimeS: number | null;
  readonly files: number | null;
  readonly memoryK: number | null;
};

const killTree = (pid: number | undefined): void => {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Kill the whole tree on Windows, or a child of the compiler's process outlives the harness.
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
};

const grabNumber = (text: string, label: string): number | null => {
  const match = new RegExp(`^\\s*${label}:\\s+([\\d.]+)`, "im").exec(text);
  const value = match?.[1];
  return value === undefined ? null : Number(value);
};

export const runTsc = (compiler: Compiler, project: string, extraArgs: readonly string[], timeoutMs: number): Promise<TscRun> =>
  new Promise((resolve) => {
    const started = performance.now();
    let timedOut = false;
    const child = execFile(
      process.execPath,
      [compiler.entry, "-p", project, "--noEmit", "--extendedDiagnostics", ...extraArgs],
      { cwd: PACKAGE_ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        clearTimeout(timer);
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({
          code,
          wallMs: performance.now() - started,
          timedOut,
          errorLines: stdout.split(/\r?\n/).filter((line) => /error TS\d+/.test(line)),
          totalTimeS: grabNumber(stdout, "Total time"),
          checkTimeS: grabNumber(stdout, "Check time"),
          files: grabNumber(stdout, "Files"),
          memoryK: grabNumber(stdout, "Memory used"),
        });
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
  });

export type SkipLibCheck = "off" | "on";

export type Measurement = {
  readonly compiler: Compiler;
  readonly skipLibCheck: SkipLibCheck;
  readonly project: "baseline" | "with-sdk";
  readonly runs: readonly TscRun[];
  readonly medianWallMs: number;
  readonly medianTotalS: number | null;
  readonly clean: boolean;
};

export type MeasureOptions = { readonly runs: number; readonly skipLibCheck: readonly SkipLibCheck[]; readonly timeoutMs?: number };

const measureOne = async (
  compiler: Compiler,
  project: "baseline" | "with-sdk",
  skipLibCheck: SkipLibCheck,
  runs: number,
  timeoutMs: number,
): Promise<Measurement> => {
  const args = skipLibCheck === "on" ? ["--skipLibCheck"] : [];
  const projectFile = join("measure", project, "tsconfig.json");
  await runTsc(compiler, projectFile, args, timeoutMs); // warm-up: file cache, not counted
  const results: TscRun[] = [];
  for (let i = 0; i < runs; i += 1) results.push(await runTsc(compiler, projectFile, args, timeoutMs));
  const totals = results.flatMap((run) => (run.totalTimeS === null ? [] : [run.totalTimeS]));
  return {
    compiler,
    skipLibCheck,
    project,
    runs: results,
    medianWallMs: median(results.map((run) => run.wallMs)),
    medianTotalS: totals.length === results.length ? median(totals) : null,
    clean: results.every((run) => run.code === 0 && !run.timedOut),
  };
};

/** Baseline first, then with the SDK, one after the other: two compilers at once would time each other. */
export const measureSdkCost = async (options: MeasureOptions): Promise<readonly Measurement[]> => {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const out: Measurement[] = [];
  for (const compiler of compilers()) {
    for (const skip of options.skipLibCheck) {
      for (const project of ["baseline", "with-sdk"] as const) {
        out.push(await measureOne(compiler, project, skip, options.runs, timeoutMs));
      }
    }
  }
  return out;
};

export type SdkCost = {
  readonly compiler: Compiler;
  readonly skipLibCheck: SkipLibCheck;
  readonly baselineWallMs: number;
  readonly withSdkWallMs: number;
  readonly addedMs: number;
  readonly clean: boolean;
};

export const sdkCosts = (measurements: readonly Measurement[]): readonly SdkCost[] => {
  const costs: SdkCost[] = [];
  for (const withSdk of measurements.filter((m) => m.project === "with-sdk")) {
    const baseline = measurements.find((m) => m.project === "baseline" && m.compiler.entry === withSdk.compiler.entry && m.skipLibCheck === withSdk.skipLibCheck);
    if (baseline === undefined) continue;
    costs.push({
      compiler: withSdk.compiler,
      skipLibCheck: withSdk.skipLibCheck,
      baselineWallMs: baseline.medianWallMs,
      withSdkWallMs: withSdk.medianWallMs,
      addedMs: withSdk.medianWallMs - baseline.medianWallMs,
      clean: withSdk.clean && baseline.clean,
    });
  }
  return costs;
};

/** Cold `import()` of an SDK entry point in a fresh Node: what starting a server that uses it costs. */
export const measureImportMs = async (specifier: "@linear/sdk" | "@linear/sdk/webhooks" | "zod", runs: number): Promise<number> => {
  const code = `const t = performance.now(); await import(${JSON.stringify(specifier)}); process.stdout.write(String(performance.now() - t));`;
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const text = await new Promise<string>((resolve) => {
      execFile(process.execPath, ["--input-type=module", "-e", code], { cwd: PACKAGE_ROOT, windowsHide: true }, (_error, stdout) => {
        resolve(stdout);
      });
    });
    const ms = Number(text);
    if (Number.isFinite(ms)) samples.push(ms);
  }
  return median(samples);
};
