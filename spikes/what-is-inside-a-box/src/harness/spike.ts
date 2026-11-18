// `pnpm spike`: runs every pass-bar criterion it can, and prints PASS / FAIL
// / SKIPPED (with the missing input) per criterion and per check. It never
// fakes a PASS: a check that needs Docker, a cluster, a registry or a model
// endpoint that isn't here is SKIPPED with that input.
//
// Always: the file validation and the loopback rehearsal (the whole box on
// this machine, without containers). With the model.env inputs: one real
// turn through the key proxy. With --real: the box on Docker and/or
// Kubernetes (real-box.ts).
//
// Flags:
//   --real=docker,k8s   run the real-box mode on these targets
//   --long=<seconds>    the long turn's length (default 20; the bar's is 1200)
//   --boxes=<n>         Docker: boxes started at once (default 50 with --real=docker; 0 skips)
//   --runtime=<name>    Docker: the agent container's runtime (runc; runsc for gVisor)
//   --runtime-class=<n> Kubernetes: the RuntimeClass ("" for the default; gvisor)
//   --no-snapshot       Docker: skip the snapshot build
//   --no-box            skip the loopback rehearsal and the endpoint turn
//   --only=P1,V1        print only these criteria (the summary and the exit code still cover all)
//   --json              print report.json to stdout as well

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { formatCriterion, statusOf, type Criterion, type Status } from "./report.ts";
import { buildPassBar, platformLine, type EndpointSmoke } from "./pass-bar.ts";
import { runValidation } from "./validate-files.ts";
import { runEndpointSmoke, runLoopbackBox, type BoxRunResult } from "./box-run.ts";
import { MODEL_INPUT_HINT, detectApiFormat, loadInputs } from "./model-inputs.ts";
import { runRealTarget, type RealRun, type RealTarget } from "./real-box.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const runsDir = path.resolve(here, "..", "..", ".runs");

const arg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const describeError = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "error");

const longSeconds = z.coerce.number().int().min(1).max(7200).parse(arg("long") ?? "20");
const targets: RealTarget[] = (arg("real") ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter((t) => t !== "")
  .map((t) => z.enum(["docker", "k8s", "kubernetes"]).parse(t))
  .map((t) => (t === "docker" ? "docker" : "kubernetes"));
const boxes = z.coerce.number().int().min(0).max(250).parse(arg("boxes") ?? (targets.includes("docker") ? "50" : "0"));
const dockerRuntime = z.string().regex(/^[a-z0-9-]{1,32}$/).parse(arg("runtime") ?? "runc");
const runtimeClass = z.string().regex(/^[a-z0-9-]{0,63}$/).parse(arg("runtime-class") ?? "");

const files = await runValidation();

let loopback: BoxRunResult | undefined;
let loopbackError: string | undefined;
if (!flag("no-box")) {
  try {
    loopback = await runLoopbackBox({ longSeconds });
  } catch (error) {
    loopbackError = describeError(error);
  }
}

const inputs = await loadInputs();
let endpoint: EndpointSmoke;
if (flag("no-box")) endpoint = { skipped: "it was turned off (--no-box)" };
else if (inputs.model === undefined) endpoint = { skipped: MODEL_INPUT_HINT };
else {
  try {
    const format = await detectApiFormat(inputs.model);
    endpoint = { checks: await runEndpointSmoke({ baseUrl: inputs.model.baseUrl, apiKey: inputs.model.apiKey, modelId: inputs.model.modelId, format }) };
  } catch (error) {
    endpoint = { error: describeError(error) };
  }
}

const real: RealRun[] = [];
for (const target of targets) real.push(await runRealTarget(target, { longSeconds, boxes, dockerRuntime, runtimeClass, snapshot: !flag("no-snapshot") }));

const criteria: Criterion[] = buildPassBar({ loopback, loopbackError, endpoint, real, files });

// The summary and the exit code cover every criterion; --only filters the print.
const counts: Record<Status, number> = { PASS: 0, FAIL: 0, SKIPPED: 0 };
for (const criterion of criteria) counts[statusOf(criterion.checks)] += 1;
const bullets = criteria.filter((c) => /^P\d$/.test(c.id));
const bulletsPassing = bullets.filter((c) => statusOf(c.checks) === "PASS").length;

const only = arg("only")?.split(",").map((s) => s.trim());
const shown = only === undefined ? criteria : criteria.filter((c) => only.includes(c.id));

console.log(`spike 3: what is inside a box — ${platformLine()}`);
console.log(`run at ${new Date().toISOString()}; long turn ${String(longSeconds)} s; real: ${targets.length === 0 ? "none" : targets.join(", ")}\n`);
for (const criterion of shown) {
  console.log(formatCriterion(criterion));
  console.log("");
}
console.log(`summary: ${String(counts.PASS)} PASS, ${String(counts.FAIL)} FAIL, ${String(counts.SKIPPED)} SKIPPED (of ${String(criteria.length)} criteria)`);
console.log(`bar: ${String(bulletsPassing)} of ${String(bullets.length)} bullets PASS (V1 is not a bullet)`);

const report = {
  spike: "what-is-inside-a-box",
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  at: new Date().toISOString(),
  longSeconds,
  real: real.map((run) => ({ target: run.target, runtime: run.runtime, gvisor: run.gvisor, skippedFor: run.skippedFor ?? null })),
  loopbackError: loopbackError ?? null,
  summary: counts,
  bulletsPassing,
  passBar: criteria,
};
await mkdir(runsDir, { recursive: true });
const file = path.join(runsDir, `report-${String(Date.now())}.json`);
await writeFile(file, JSON.stringify(report, null, 2));
if (flag("json")) console.log(`\n${JSON.stringify(report, null, 2)}`);
console.log(`\nreport: ${file}`);

if (counts.FAIL > 0) process.exitCode = 1;
