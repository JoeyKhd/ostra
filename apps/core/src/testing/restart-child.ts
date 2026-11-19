// Core as its own process, for the restart harness (ticket 21): `src/testing/restart.ts` starts it,
// kills it, and starts it again against the same database. Settings come from the environment as
// core's own `main.ts` reads them; two more are this harness's: CORE_TEST_KILL_POINT arms one named
// kill point (`src/kill-points.ts`), and CORE_TEST_LINEAR_API_URL points the trackers at a fake
// Linear. Once listening it prints one JSON line, `{ "listening": <port> }`. Logs go to stderr, one
// JSON object per line, IDs and fields only.

import { createLogger } from "@ostra/adapter-sdk";
import { parseServerSettings } from "@ostra/domain";

import { startCore } from "../core.ts";
import { armKillPoint, isKillPointName } from "../kill-points.ts";

const point = process.env["CORE_TEST_KILL_POINT"] ?? "";
armKillPoint(isKillPointName(point) ? point : null);

const parsed = parseServerSettings(process.env);
if (!parsed.ok) {
  for (const error of parsed.errors) {
    process.stderr.write(`core: ${error}\n`);
  }
  process.exit(1);
}

const logger = createLogger((record) => {
  if (record.level === "debug") {
    return;
  }
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: record.level, msg: record.message, ...record.fields })}\n`);
});

const linearApiUrl = process.env["CORE_TEST_LINEAR_API_URL"];
const core = await startCore(parsed.settings, logger, {
  host: "127.0.0.1",
  jobIntervals: { pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1 },
  ...(linearApiUrl === undefined || linearApiUrl === "" ? {} : { linearApiUrl }),
});
process.stdout.write(`${JSON.stringify({ listening: core.port })}\n`);

const stop = (): void => {
  core.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
