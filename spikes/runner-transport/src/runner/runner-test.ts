// The runner with the harness's test hooks: the same peer as runner.ts, plus
// switches no real runner should have. Only the harness starts this file, and
// it refuses to start without OSTRA_SPIKE_TEST_HOOKS=1.
//
//   --self-fence=false     turn the self-fence off (the sleep test: the server's refusal must hold alone)
//   --crash-on-steer=true  SIGKILL this process when a steer starts (the outcome-unknown test)
// stdin, on top of runner.ts's commands: {"cmd":"freeze","ms":N} blocks the event
// loop for N ms, like a laptop asleep: no timers, no I/O, no heartbeats.

import { z } from "zod";
import { boolArg, parseArgs } from "../shared/args.ts";
import { RunnerArgs, runRunner } from "./run-runner.ts";

if (process.env["OSTRA_SPIKE_TEST_HOOKS"] !== "1") {
  process.stderr.write("runner-test.ts is the harness's runner: it needs OSTRA_SPIKE_TEST_HOOKS=1. Use runner.ts.\n");
  process.exit(2);
}

const args = parseArgs(
  RunnerArgs.extend({
    "self-fence": boolArg.default(true),
    "crash-on-steer": boolArg.default(false),
  }),
);

const Freeze = z.object({ cmd: z.literal("freeze"), ms: z.number().int().positive() });

runRunner(args, {
  testHooks: { disableSelfFence: !args["self-fence"] },
  ...(args["crash-on-steer"]
    ? {
        onSteer: () => {
          process.kill(process.pid, "SIGKILL");
        },
      }
    : {}),
  onControl: (value, log) => {
    const f = Freeze.safeParse(value);
    if (!f.success) return;
    log("freeze", { ms: f.data.ms });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, f.data.ms);
    log("thaw", { ms: f.data.ms });
  },
});
