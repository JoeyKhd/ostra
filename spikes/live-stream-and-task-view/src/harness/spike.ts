import { parseArgs } from "node:util";
import { hardeningChecks, streamChecks, watcherAndApprovalChecks } from "./checks-api.ts";
import { browserChecks } from "./checks-browser.ts";
import { buildWeb, staticChecks } from "./checks-static.ts";
import { startContext } from "./context.ts";
import { killAll, leftoverProcesses } from "./infra.ts";
import { sleep } from "../shared/time.ts";
import { fullOptions, loadCriteria, runLoad, scaledOptions } from "./load.ts";
import { fail, printCriteria, skipped, type Criterion, type Finding, type Status } from "./report.ts";

// `pnpm spike` runs every pass-bar criterion it can on this machine, and prints PASS, FAIL or SKIPPED
// (with the missing input) for each. `--full-load` also runs the load bar's own shape (5,000/s).
const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { "full-load": { type: "boolean", default: false }, "skip-load": { type: "boolean", default: false } } });
const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const BAR_LOAD = "5,000 events a second sustained and a burst of 10,000, at p99 under 500 ms from runner to browser, with Postgres under 50% of 4 vCPU.";

const criteria: Criterion[] = [];
const findings: Finding[] = [];
const started = Date.now();

log(`ostra spike 7: live-stream-and-task-view (${new Date().toISOString().slice(0, 10)}, ${process.platform}, node ${process.version})`);

log("static checks: typecheck, lint, unit tests");
criteria.push(...(await staticChecks()));
log("building the page (vite)");
const built = await buildWeb();
if (built.code !== 0) criteria.push(fail(BAR_LOAD, "The page builds", built.output.slice(0, 300)));

let ctx: Awaited<ReturnType<typeof startContext>> | null = null;
try {
  log("starting Postgres and two server replicas");
  const active = await startContext();
  ctx = active;
  log("api and stream checks");
  criteria.push(...(await watcherAndApprovalChecks(active)));
  criteria.push(...(await streamChecks(active)));
  criteria.push(...(await hardeningChecks(active)));
  log("browser checks (this takes about four minutes)");
  const browser = await browserChecks(active);
  criteria.push(...browser.criteria);
  findings.push(...browser.findings);
  if (browser.executable !== null) findings.push({ topic: "browser", text: `headless ${browser.executable}` });

  if (values["skip-load"]) {
    criteria.push(skipped(BAR_LOAD, "Load run", "no --skip-load"));
  } else {
    const run = async (full: boolean): Promise<void> => {
      try {
        const result = await runLoad({ url: active.dev.url, postmasterPid: active.dev.postmasterPid, pool: active.pool }, full ? fullOptions : scaledOptions, log);
        criteria.push(...loadCriteria(result, full, null));
      } catch (error) {
        criteria.push(...loadCriteria(null, full, error instanceof Error ? error.message : "unknown error"));
      }
    };
    log(`load run (${values["full-load"] ? "full shape: 5,000/s" : "scaled down: 1,000/s"})`);
    await run(values["full-load"]);
  }
} catch (error) {
  criteria.push(fail(BAR_LOAD, "The harness ran to completion", error instanceof Error ? error.message : "unknown error"));
} finally {
  if (ctx !== null) await ctx.stop();
  await killAll();
}

await sleep(1500);
const leftovers = await leftoverProcesses();
criteria.push(
  leftovers.length === 0
    ? { bar: "Hygiene", label: "No process left running after the run", status: "PASS", detail: "no process with this spike's folder in its command line, and every process the run started (the browser's included, by pid) is gone" }
    : { bar: "Hygiene", label: "No process left running after the run", status: "FAIL", detail: leftovers.join(", ") },
);

printCriteria(criteria);
for (const f of findings) log(`\nfinding: ${f.topic}\n  ${f.text}`);

const count = (status: Status): number => criteria.filter((c) => c.status === status).length;
log(`\nsummary: ${String(count("PASS"))} PASS, ${String(count("FAIL"))} FAIL, ${String(count("SKIPPED"))} SKIPPED in ${String(Math.round((Date.now() - started) / 1000))} s`);
process.exit(count("FAIL") > 0 ? 1 : 0);
