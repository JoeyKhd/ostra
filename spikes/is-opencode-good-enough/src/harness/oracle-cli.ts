// `pnpm oracle [--tickets=calc-1,calc-9]`: runs the oracle and prints, per
// ticket and variant, what the checkers concluded against what they should.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expectedAcceptance, expectedCi, runOracle } from "./oracle.ts";
import { cleanWorkRoot } from "../runner/sandbox.ts";
import { removeDir, SPIKE_ROOT } from "../runner/workspace.ts";

const only = process.argv
  .find((arg) => arg.startsWith("--tickets="))
  ?.slice("--tickets=".length)
  .split(",")
  .map((s) => s.trim());

const root = path.join(SPIKE_ROOT, ".runs", `oracle-${String(Date.now())}`);
await mkdir(root, { recursive: true });
const report = await runOracle(root, only);
await removeDir(root);
await cleanWorkRoot();

let wrong = 0;
for (const o of report.outcomes) {
  const accept = o.acceptance.passed ? "pass" : "fail";
  const ci = o.ci.green ? "green" : "red";
  const ok = accept === expectedAcceptance(o.variant) && ci === expectedCi(o.variant);
  if (!ok) wrong += 1;
  const mutation = o.acceptance.mutation === undefined ? "" : ` killed ${String(o.acceptance.mutation.killed)}/${String(o.acceptance.mutation.total)}`;
  console.log(
    `${ok ? "ok   " : "WRONG"} ${o.ticket.id.padEnd(7)} ${o.variant.padEnd(8)} acceptance ${accept} (expected ${expectedAcceptance(o.variant)}${mutation}), CI ${ci} (expected ${expectedCi(o.variant)}; tests ${String(o.ci.tests.pass)}/${String(o.ci.tests.total)}, type errors ${String(o.ci.typecheck.errors)})`,
  );
  if (!ok && o.log !== "") console.log(o.log.split("\n").map((l) => `        ${l}`).join("\n"));
}
console.log(`${String(report.outcomes.length)} outcomes, ${String(wrong)} not as expected`);
process.exitCode = wrong === 0 ? 0 : 1;
