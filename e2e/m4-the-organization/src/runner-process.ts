// `node e2e/m4-the-organization/src/runner-process.ts` (ticket 41): the demo's personal runner on
// the `host` executor (Demo's, or Sam's with `--second`), in a process of its own that outlives each demo step. It writes the device
// code it shows (or "signed-in") to `runner-code.txt` in the state folder, for the demo's setup
// step to approve in the panel, and stops with the process.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { startRunner } from "@ostra/e2e-m1/runner";
import { say } from "@ostra/e2e-m1/setup";

import { m4Settings } from "./settings.ts";

// `--second`: Sam's own personal runner, which Sam approves once Sam has joined (steps 2 and 9).
const all = m4Settings(process.env);
const second = process.argv.includes("--second");
const settings = second ? all.secondRunner : all;
const name = second ? "runner-2" : "runner";
await mkdir(all.m4StateDir, { recursive: true });
const runner = await startRunner(settings, path.join(all.m4StateDir, `${name}.log`));
const code = await runner.deviceCode;
await writeFile(path.join(all.m4StateDir, `${name}-code.txt`), code ?? "signed-in");
say(code === null ? `${settings.runnerName} is signed in` : `${settings.runnerName} waits for its code to be approved`);
await runner.online;
say(`${settings.runnerName} is online`);
const stop = () => {
  void runner.stop().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
