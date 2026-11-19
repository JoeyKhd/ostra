// `node e2e/m3-step-in/src/runner-process.ts [--second]` (ticket 50): the demo's personal runner on
// the `host` executor, in a process of its own that outlives each demo step. It writes the device
// code it shows (or "signed-in") to `runner-code.txt` in the state folder, for the demo's setup
// step to approve in the panel, and stops with the process.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { startRunner } from "@ostra/e2e-m1/runner";
import { say } from "@ostra/e2e-m1/setup";

import { m3Settings } from "./settings.ts";

const settings = m3Settings(process.env);
const second = process.argv.includes("--second");
const runnerSettings = second ? settings.secondRunner : settings;
const name = second ? "runner-2" : "runner";
const runner = await startRunner(runnerSettings, path.join(settings.m3StateDir, `${name}.log`));
const code = await runner.deviceCode;
await writeFile(path.join(settings.m3StateDir, `${name}-code.txt`), code ?? "signed-in");
say(code === null ? `${runnerSettings.runnerName} is signed in` : `${runnerSettings.runnerName} waits for its code to be approved`);
await runner.online;
say(`${runnerSettings.runnerName} is online`);
const stop = () => {
  void runner.stop().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
