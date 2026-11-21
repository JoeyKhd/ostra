// The box's init for the tests (milestone 8, ticket 03): the real init, whose browser is the fake
// box browser over the same DevTools pipe instead of the image's Chromium, which this machine
// lacks. `node init-with-fake-browser.ts <the fake browser's script>`: the docker suite spawns it,
// and the kubernetes suite's fake kubelet starts it from the pod's command.
import { initEnvSchema, runInit } from "../init/init.ts";

const script = process.argv[2];
if (script === undefined) {
  throw new Error("give the fake browser's script as the first argument");
}
await runInit(initEnvSchema.parse(process.env), { browser: { command: process.execPath, args: [script] } });
