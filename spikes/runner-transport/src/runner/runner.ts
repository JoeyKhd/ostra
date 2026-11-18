// The runner CLI for the spike: one peer, a fake agent, a disk spool.
//
//   node src/runner/runner.ts --runner=r1 --server=https://localhost:8443 --data=.data/r1
// Env: OSTRA_RUNNER_TOKEN, and the proxy and CA variables a runner honours:
// HTTPS_PROXY, NO_PROXY (and lowercase), NODE_EXTRA_CA_CERTS.
//
// It has no test hooks: those live in runner-test.ts, which only the harness starts.

import { parseArgs } from "../shared/args.ts";
import { RunnerArgs, runRunner } from "./run-runner.ts";

runRunner(parseArgs(RunnerArgs), {});
