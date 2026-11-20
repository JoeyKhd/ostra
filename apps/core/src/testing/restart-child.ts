// Core as its own process, for the restart harness (ticket 21) and the failure suite (ticket 38):
// `src/testing/restart.ts` and `e2e/m2-failure-suite` start it, kill it, and start it again against
// the same database. Settings come from the environment as core's own `main.ts` reads them,
// `OSTRA_DEV_BLOCK_WEBHOOKS` included; more are the harnesses': CORE_TEST_KILL_POINT arms one named
// kill point (`src/kill-points.ts`), CORE_TEST_LINEAR_API_URL points the trackers at a fake Linear
// (or the suite's fault-injecting proxy in front of the real one), and CORE_TEST_SESSION_MAX_MS and
// CORE_TEST_STALL_MS shorten the runaway timers to seconds. Once listening it prints one JSON line,
// `{ "listening": <port> }`. Logs go to stderr, one JSON object per line, IDs and fields only.
//
// Ticket 37's schedule hunt adds three: CORE_TEST_KILL_POINT_HIT arms the point for its Nth pass,
// CORE_TEST_SCHEDULER_CLOCK_OFFSET_MS moves the scheduler's clock ahead (the install "down" that
// long), and CORE_TEST_CONTROL_STDIN=1 reads one JSON command a line from stdin:
// `{ "arm": <point or null>, "hit": <n> }` arms (or disarms) a kill point now, and `{ "stop": true }`
// stops core gracefully, which a signal can't do on Windows.

import { createInterface } from "node:readline";

import { createLogger } from "@ostra/adapter-sdk";
import { parseServerSettings } from "@ostra/domain";
import { z } from "zod";

import { startCore } from "../core.ts";
import { armKillPoint, isKillPointName } from "../kill-points.ts";

const point = process.env["CORE_TEST_KILL_POINT"] ?? "";
armKillPoint(isKillPointName(point) ? point : null, Number.parseInt(process.env["CORE_TEST_KILL_POINT_HIT"] ?? "1", 10) || 1);

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
const schedulerClockOffsetMs = millis("CORE_TEST_SCHEDULER_CLOCK_OFFSET_MS");
const core = await startCore(parsed.settings, logger, {
  host: process.env["CORE_TEST_HOST"] ?? "127.0.0.1",
  jobIntervals: { pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1 },
  ...(linearApiUrl === undefined || linearApiUrl === "" ? {} : { linearApiUrl }),
  ...(devBlockWebhooks === undefined || devBlockWebhooks === "" ? {} : { devBlockWebhooks }),
  limitsMs: { ...(sessionMaxMs === undefined ? {} : { sessionMaxMs }), ...(stallMs === undefined ? {} : { stallMs }) },
  ...(schedulerClockOffsetMs === undefined ? {} : { schedulerClockOffsetMs }),
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

const commandSchema = z.union([
  z.strictObject({ arm: z.string().nullable(), hit: z.number().int().positive().optional() }),
  z.strictObject({ stop: z.literal(true) }),
]);

if (process.env["CORE_TEST_CONTROL_STDIN"] === "1") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    const command = commandSchema.safeParse(json);
    if (!command.success) {
      return;
    }
    if ("stop" in command.data) {
      stop();
      return;
    }
    const name = command.data.arm;
    armKillPoint(name !== null && isKillPointName(name) ? name : null, command.data.hit ?? 1);
    process.stdout.write(`${JSON.stringify({ armed: name, hit: command.data.hit ?? 1 })}\n`);
  });
}
