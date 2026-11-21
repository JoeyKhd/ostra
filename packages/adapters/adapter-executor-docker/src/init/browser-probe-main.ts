// The box's browser probe (ticket 11), in a container of the base image, as root under a box's
// hardening: `node /opt/ostra/app/packages/adapters/adapter-executor-docker/src/init/browser-probe-main.ts`.
// The `live-docker` and `live-kind` jobs run it (scripts/live/). It prints its result as one JSON
// line and exits 0 only when the browser named itself, loaded the page, took a PNG and left no profile.
import { fileURLToPath } from "node:url";
import { probeBoxBrowser } from "./browser-probe.ts";

const result = await probeBoxBrowser({
  init: { command: process.execPath, args: [fileURLToPath(new URL("./main.ts", import.meta.url))] },
  env: {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    ...(process.env["OSTRA_BOX_BROWSER"] === undefined ? {} : { OSTRA_BOX_BROWSER: process.env["OSTRA_BOX_BROWSER"] }),
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok && result.profileRemoved ? 0 : 1;
