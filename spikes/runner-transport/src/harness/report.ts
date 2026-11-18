export type Result = "PASS" | "FAIL" | "SKIPPED";
export type Check = { readonly name: string; readonly result: Result; readonly note: string; readonly data?: unknown };

export const pass = (name: string, note: string, data?: unknown): Check => ({ name, result: "PASS", note, data });
export const fail = (name: string, note: string, data?: unknown): Check => ({ name, result: "FAIL", note, data });
export const skipped = (name: string, note: string): Check => ({ name, result: "SKIPPED", note });
export const check = (name: string, ok: boolean, note: string, data?: unknown): Check => (ok ? pass(name, note, data) : fail(name, note, data));

/** The platforms the bar names. A PASS on fewer is a partial pass, and says so. */
export const BAR_PLATFORMS = ["win32", "darwin", "linux"] as const;
export type BarPlatform = (typeof BAR_PLATFORMS)[number];
const platformName = (p: BarPlatform): string => {
  switch (p) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return p satisfies never;
  }
};

export type Verdict = { readonly result: Result; readonly label: string };

/**
 * A criterion is FAIL if any check failed, SKIPPED if any was skipped, and PASS
 * only if all passed, on every platform the bar names. On fewer, the label says
 * which ran: "PASS (Windows only; macOS, Linux not run)".
 */
export const overall = (checks: readonly Check[], platformsRun: ReadonlySet<string>): Verdict => {
  if (checks.length === 0) return { result: "SKIPPED", label: "SKIPPED" };
  if (checks.some((c) => c.result === "FAIL")) return { result: "FAIL", label: "FAIL" };
  if (checks.some((c) => c.result === "SKIPPED")) return { result: "SKIPPED", label: "SKIPPED" };
  const ran = BAR_PLATFORMS.filter((p) => platformsRun.has(p));
  const missing = BAR_PLATFORMS.filter((p) => !platformsRun.has(p));
  if (missing.length === 0) return { result: "PASS", label: "PASS" };
  return {
    result: "PASS",
    label: `PASS (${ran.map(platformName).join(", ")} only; ${missing.map(platformName).join(", ")} not run)`,
  };
};

/** Run a scenario; a crash becomes one failed check instead of ending the run. */
export const guarded = async (name: string, fn: () => Promise<Check[]>): Promise<Check[]> => {
  try {
    return await fn();
  } catch (err) {
    return [fail(name, `scenario crashed: ${err instanceof Error ? err.message : "unknown error"}`)];
  }
};
