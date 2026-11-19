// Core as its own process, for the restart harness (ticket 21) and the failure suite (ticket 38):
// `src/testing/restart.ts` and `e2e/m2-failure-suite` start it, kill it, and start it again against
// the same database. Settings come from the environment as core's own `main.ts` reads them,
// `OSTRA_DEV_BLOCK_WEBHOOKS` included; more are the harnesses': CORE_TEST_KILL_POINT arms one named
// kill point (`src/kill-points.ts`), CORE_TEST_LINEAR_API_URL points the trackers at a fake Linear
// (or the suite's fault-injecting proxy in front of the real one), and CORE_TEST_SESSION_MAX_MS and
// CORE_TEST_STALL_MS shorten the runaway timers to seconds. Once listening it prints one JSON line,
// `{ "listening": <port> }`. Logs go to stderr, one JSON object per line, IDs and fields only.

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

/** A positive whole number of milliseconds from the environment, or nothing. */
const millis = (name: string): number | undefined => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const linearApiUrl = process.env["CORE_TEST_LINEAR_API_URL"];
const devBlockWebhooks = process.env["OSTRA_DEV_BLOCK_WEBHOOKS"];
const sessionMaxMs = millis("CORE_TEST_SESSION_MAX_MS");
const stallMs = millis("CORE_TEST_STALL_MS");
const core = await startCore(parsed.settings, logger, {
  host: process.env["CORE_TEST_HOST"] ?? "127.0.0.1",
  jobIntervals: { pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1 },
  ...(linearApiUrl === undefined || linearApiUrl === "" ? {} : { linearApiUrl }),
  ...(devBlockWebhooks === undefined || devBlockWebhooks === "" ? {} : { devBlockWebhooks }),
  limitsMs: { ...(sessionMaxMs === undefined ? {} : { sessionMaxMs }), ...(stallMs === undefined ? {} : { stallMs }) },
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
