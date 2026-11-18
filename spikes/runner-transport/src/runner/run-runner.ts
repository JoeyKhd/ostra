// What the runner CLI and its harness-only twin share: the arguments, the
// peer, and the stdin control channel.

import readline from "node:readline";
import { z } from "zod";
import { RunnerId } from "../protocol/ids.ts";
import { SERVER_MINOR, parseJson } from "../protocol/messages.ts";
import { TimeScale, scaledTimers } from "../protocol/timers.ts";
import { exitWithParent } from "../shared/args.ts";
import { errorFields, makeLogger, type Logger } from "../shared/log.ts";
import { startPeer, type PeerTestHooks } from "./peer.ts";

export const RunnerArgs = z.object({
  runner: RunnerId,
  server: z.url(),
  data: z.string().min(1),
  minor: z.coerce.number().int().nonnegative().default(SERVER_MINOR),
  transport: z.enum(["auto", "websocket", "http"]).default("auto"),
  "time-scale": TimeScale.default(1),
  "events-per-sec": z.coerce.number().nonnegative().default(5),
  "event-bytes": z.coerce.number().int().nonnegative().default(200),
  "spool-quota": z.coerce.number().int().positive().default(1024 * 1024 * 1024),
  "parent-pid": z.coerce.number().int().positive().optional(),
});
export type RunnerArgs = z.infer<typeof RunnerArgs>;

const Control = z.discriminatedUnion("cmd", [z.object({ cmd: z.literal("report") }), z.object({ cmd: z.literal("exit") })]);

export type Extras = {
  readonly testHooks?: PeerTestHooks;
  readonly onSteer?: (commandId: string, at: number) => void;
  /** A control line the base channel doesn't know. */
  readonly onControl?: (value: unknown, log: Logger) => void;
};

/**
 * Start one runner. stdin takes one JSON command per line, for the harness:
 * {"cmd":"report"} prints the peer's state, {"cmd":"exit"} stops it.
 */
export const runRunner = (args: RunnerArgs, extras: Extras): void => {
  const env = z.object({ OSTRA_RUNNER_TOKEN: z.string().min(1) }).parse(process.env);
  exitWithParent(args["parent-pid"]);
  const log = makeLogger({ runner: args.runner, pid: process.pid });

  const main = async (): Promise<void> => {
    const peer = await startPeer({
      runnerId: args.runner,
      serverUrl: args.server.replace(/\/$/, ""),
      token: env.OSTRA_RUNNER_TOKEN,
      minor: args.minor,
      transport: args.transport,
      timers: scaledTimers(args["time-scale"]),
      eventsPerSec: args["events-per-sec"],
      eventBytes: args["event-bytes"],
      dataDir: args.data,
      spoolQuotaBytes: args["spool-quota"],
      labels: ["spike"],
      log,
      ...(extras.testHooks === undefined ? {} : { testHooks: extras.testHooks }),
      ...(extras.onSteer === undefined ? {} : { onSteer: extras.onSteer }),
    });
    log("runner-started", { minor: args.minor, transport: args.transport });

    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const parsed = parseJson(line);
      if (!parsed.ok) return;
      const c = Control.safeParse(parsed.value);
      if (!c.success) {
        extras.onControl?.(parsed.value, log);
        return;
      }
      switch (c.data.cmd) {
        case "report":
          process.stdout.write(`${JSON.stringify({ t: "report", ts: Date.now(), ...peer.report() })}\n`);
          return;
        case "exit":
          void peer.stop().then(() => process.exit(0));
          return;
        default:
          return c.data satisfies never;
      }
    });
  };

  main().catch((err: unknown) => {
    log("fatal", errorFields(err));
    process.exit(1);
  });
};
