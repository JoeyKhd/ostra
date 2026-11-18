import { parseArgs } from "node:util";
import { startDatabase } from "./context.ts";
import { describeLoad, fullOptions, loadCriteria, runLoad, scaledOptions, type LoadOptions } from "./load.ts";
import { printCriteria } from "./report.ts";

// `pnpm load` runs the scaled-down shape. `pnpm load --full` runs the pass bar's own shape (5,000/s,
// a burst of 10,000, 1,000 tasks, 3 server processes). Any number can be set with a flag.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    full: { type: "boolean", default: false },
    rate: { type: "string" },
    burst: { type: "string" },
    duration: { type: "string" },
    tasks: { type: "string" },
    viewers: { type: "string" },
    replicas: { type: "string" },
    runners: { type: "string" },
  },
});
const base = values.full ? fullOptions : scaledOptions;
const pick = (flag: string | undefined, fallback: number): number => (flag === undefined ? fallback : Number(flag));
const options: LoadOptions = {
  ...base,
  rate: pick(values.rate, base.rate),
  burst: pick(values.burst, base.burst),
  durationSec: pick(values.duration, base.durationSec),
  tasks: pick(values.tasks, base.tasks),
  viewersPerTask: pick(values.viewers, base.viewersPerTask),
  replicas: pick(values.replicas, base.replicas),
  runners: pick(values.runners, base.runners),
};

const database = await startDatabase();
try {
  const result = await runLoad({ url: database.dev.url, postmasterPid: database.dev.postmasterPid, pool: database.pool }, options, (line) => {
    process.stdout.write(`${line}\n`);
  });
  process.stdout.write(`\n${describeLoad(result)}\n`);
  printCriteria(loadCriteria(result, values.full, null));
} finally {
  await database.stop();
}
