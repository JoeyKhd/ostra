#!/usr/bin/env node
// The `ostra` CLI's entry point (ADR 0046). `pnpm ostra ...` runs it from source.
import { runCli } from "./cli/cli.ts";
import { createTerminal } from "./cli/terminal.ts";
import { runSidecarCommand } from "./run-sidecar.ts";
import { runSignedInRunner } from "./run-runner.ts";

const controller = new AbortController();
let interrupts = 0;
process.on("SIGINT", () => {
  interrupts += 1;
  if (interrupts > 1) {
    process.exit(130);
  }
  controller.abort();
});
process.on("SIGTERM", () => {
  controller.abort();
});

const terminal = createTerminal({
  stdout: process.stdout,
  stderr: process.stderr,
  verbose: process.argv.includes("--verbose"),
});

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  terminal,
  signal: controller.signal,
  runSignedIn: runSignedInRunner,
  runSidecar: runSidecarCommand,
});
process.exitCode = code;
