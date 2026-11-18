export type Status = "PASS" | "FAIL" | "SKIPPED";

export type Criterion = {
  // The pass-bar bullet this belongs to (copied in the README).
  readonly bar: string;
  readonly label: string;
  readonly status: Status;
  readonly detail: string;
};

export const pass = (bar: string, label: string, detail: string): Criterion => ({ bar, label, status: "PASS", detail });
export const fail = (bar: string, label: string, detail: string): Criterion => ({ bar, label, status: "FAIL", detail });
export const skipped = (bar: string, label: string, needs: string): Criterion => ({
  bar,
  label,
  status: "SKIPPED",
  detail: `needs ${needs}`,
});
export const verdict = (bar: string, label: string, ok: boolean, detail: string): Criterion =>
  ok ? pass(bar, label, detail) : fail(bar, label, detail);

export type Finding = { readonly topic: string; readonly text: string };

export const printCriteria = (criteria: readonly Criterion[]): void => {
  let lastBar = "";
  for (const c of criteria) {
    if (c.bar !== lastBar) {
      process.stdout.write(`\n[${c.bar}]\n`);
      lastBar = c.bar;
    }
    process.stdout.write(`  ${c.status.padEnd(7)} ${c.label}\n          ${c.detail}\n`);
  }
};
