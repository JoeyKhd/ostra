#!/usr/bin/env node
// The `ostra` CLI's entry point (ADR 0046). `pnpm ostra ...` runs it from source.
import http from "node:http";
import { runCli } from "./cli/cli.ts";
import { createTerminal } from "./cli/terminal.ts";
import { runSidecarCommand } from "./run-sidecar.ts";
import { runSignedInRunner } from "./run-runner.ts";

// HTTPS_PROXY, HTTP_PROXY and NO_PROXY for every call the CLI makes with fetch (the token, the spec,
// the credentials), as the carriers' own agents do (ADR 0034, "Networks"). Where this Node lacks
// it, only the carriers go through the proxy.
const setGlobalProxyFromEnv: unknown = Reflect.get(http, "setGlobalProxyFromEnv");
if (typeof setGlobalProxyFromEnv === "function" && [process.env["HTTPS_PROXY"], process.env["https_proxy"], process.env["HTTP_PROXY"], process.env["http_proxy"]].some((value) => value !== undefined && value !== "")) {
  Reflect.apply(setGlobalProxyFromEnv, http, [process.env]);
}

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
