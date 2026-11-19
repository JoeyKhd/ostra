import type { CheckResult } from "@ostra/e2e-m1/checks";
import { say } from "@ostra/e2e-m1/setup";

// One case of spec section 3's table (ticket 38): what it does, its checks, and how long it took.
// A case that throws fails with the error's message, and the run goes on to the next.

export type CaseResult = {
  readonly name: string;
  /** The table's row, in the spec's words. */
  readonly row: string;
  readonly ok: boolean;
  readonly seconds: number;
  readonly checks: readonly CheckResult[];
  /** What it measured: seconds and counts, never content. */
  readonly timings: Readonly<Record<string, number>>;
};

export type CaseContext = {
  readonly check: (name: string, ok: boolean, detail: string) => void;
  readonly add: (result: CheckResult) => void;
  readonly time: (name: string, seconds: number) => void;
  readonly say: (line: string) => void;
};

export const seconds = (fromMs: number): number => Math.round((Date.now() - fromMs) / 100) / 10;

export const runCase = async (name: string, row: string, body: (context: CaseContext) => Promise<void>): Promise<CaseResult> => {
  const started = Date.now();
  const checks: CheckResult[] = [];
  const timings: Record<string, number> = {};
  const context: CaseContext = {
    check: (checkName, ok, detail) => {
      checks.push({ name: checkName, ok, detail });
      say(`${name}: ${ok ? "PASS" : "FAIL"} ${checkName}: ${detail}`);
    },
    add: (result) => {
      checks.push(result);
      say(`${name}: ${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
    },
    time: (timing, value) => {
      timings[timing] = value;
    },
    say: (line) => {
      say(`${name}: ${line}`);
    },
  };
  say(`---- ${name}: ${row}`);
  try {
    await body(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "the case ran to its end", ok: false, detail: message });
    say(`${name}: FAIL the case ran to its end: ${message}`);
  }
  const result: CaseResult = { name, row, ok: checks.length > 0 && checks.every((one) => one.ok), seconds: seconds(started), checks, timings };
  say(`---- ${name}: ${result.ok ? "PASSED" : "FAILED"} in ${String(result.seconds)} s`);
  return result;
};
