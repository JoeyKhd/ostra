// Results of the harness: a criterion per pass-bar line, each made of checks.
// A criterion is FAIL if any check failed, SKIPPED if any check was skipped
// (and none failed), and PASS only when every check passed.

export type Status = "PASS" | "FAIL" | "SKIPPED";

export type Check = {
  readonly name: string;
  readonly status: Status;
  /** For SKIPPED: the exact input or machine it needs. For the others: what was observed. */
  readonly note: string;
};

export type Criterion = {
  readonly id: string;
  readonly title: string;
  readonly checks: readonly Check[];
  /** Numbers worth keeping: rates, timings, sizes. */
  readonly recorded?: Readonly<Record<string, string | number | boolean | null>>;
};

export const pass = (name: string, note: string): Check => ({ name, status: "PASS", note });
export const fail = (name: string, note: string): Check => ({ name, status: "FAIL", note });
export const skip = (name: string, needs: string): Check => ({ name, status: "SKIPPED", note: needs });
export const check = (name: string, ok: boolean, note: string): Check => ({ name, status: ok ? "PASS" : "FAIL", note });

export const statusOf = (checks: readonly Check[]): Status => {
  if (checks.length === 0) return "SKIPPED";
  if (checks.some((c) => c.status === "FAIL")) return "FAIL";
  if (checks.some((c) => c.status === "SKIPPED")) return "SKIPPED";
  return "PASS";
};

export const formatCriterion = (criterion: Criterion): string => {
  const lines = [`${statusOf(criterion.checks).padEnd(7)} ${criterion.id} ${criterion.title}`];
  for (const c of criterion.checks) lines.push(`          ${c.status.padEnd(7)} ${c.name}: ${c.note}`);
  if (criterion.recorded !== undefined) {
    for (const [key, value] of Object.entries(criterion.recorded)) lines.push(`          recorded ${key} = ${String(value)}`);
  }
  return lines.join("\n");
};
