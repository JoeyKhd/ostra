// The load generator: thousands of simulated runners in one process, each a
// full protocol peer (seq, acks, commands, heartbeats) with an in-memory spool.
//
//   node src/loadgen/loadgen.ts --server=https://localhost:8443 --count=500 --prefix=lg
// Env: SPIKE_AUTH_SECRET (to mint the simulated runners' tokens), NODE_EXTRA_CA_CERTS.
// stdin: {"cmd":"report"} prints a summary line; {"cmd":"exit"} stops every peer.

import readline from "node:readline";
import { z } from "zod";
import { RunnerId } from "../protocol/ids.ts";
import { SERVER_MINOR, parseJson } from "../protocol/messages.ts";
import { TimeScale, scaledTimers } from "../protocol/timers.ts";
import { startPeer, type PeerHandle } from "../runner/peer.ts";
import { exitWithParent, parseArgs } from "../shared/args.ts";
import { mintToken } from "../shared/auth.ts";
import { errorFields, makeLogger } from "../shared/log.ts";
import { sleep, summarize } from "../shared/stats.ts";

const args = parseArgs(
  z.object({
    server: z.url(),
    count: z.coerce.number().int().positive(),
    prefix: z.string().regex(/^[a-z0-9-]+$/),
    "events-per-sec": z.coerce.number().nonnegative().default(2),
    "event-bytes": z.coerce.number().int().nonnegative().default(200),
    "connect-per-sec": z.coerce.number().positive().default(200),
    "time-scale": TimeScale.default(1),
    "parent-pid": z.coerce.number().int().positive().optional(),
  }),
);
const env = z.object({ SPIKE_AUTH_SECRET: z.string().min(16) }).parse(process.env);
exitWithParent(args["parent-pid"]);
const log = makeLogger({ loadgen: args.prefix });

const ackLatency: number[] = [];
const connectAt: number[] = [];
const counts = { welcomes: 0, closes: 0, steers: 0, fallbacks: 0, stale: 0 };
const started = performance.now();

// Peers log through this: only a few events are counted, nothing is printed per peer.
const peerLog =
  () =>
  (t: string): void => {
    if (t === "welcome") counts.welcomes += 1;
    else if (t === "ws-closed") counts.closes += 1;
    else if (t === "fallback-http") counts.fallbacks += 1;
    else if (t === "stale-lease-refused") counts.stale += 1;
  };

const peers: PeerHandle[] = [];

const main = async (): Promise<void> => {
  const timers = scaledTimers(args["time-scale"]);
  const gap = 1000 / args["connect-per-sec"];
  for (let i = 0; i < args.count; i += 1) {
    const id = RunnerId.parse(`${args.prefix}-${String(i)}`);
    const t0 = performance.now();
    let first = true;
    peers.push(
      await startPeer({
        runnerId: id,
        serverUrl: args.server.replace(/\/$/, ""),
        token: mintToken(env.SPIKE_AUTH_SECRET, id),
        minor: SERVER_MINOR,
        transport: "auto",
        timers,
        eventsPerSec: args["events-per-sec"],
        eventBytes: args["event-bytes"],
        dataDir: undefined,
        spoolQuotaBytes: 64 * 1024 * 1024,
        labels: [],
        log: peerLog(),
        onAckLatency: (ms) => {
          if (ackLatency.length < 2_000_000) ackLatency.push(ms);
        },
        onSteer: () => {
          counts.steers += 1;
        },
        onConnected: () => {
          if (first) connectAt.push(performance.now() - t0);
          first = false;
        },
      }),
    );
    await sleep(gap);
  }
  log("all-started", { count: args.count, ms: Math.round(performance.now() - started) });

  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const p = parseJson(line);
    const c = p.ok ? z.object({ cmd: z.enum(["report", "reset-latency", "exit"]) }).safeParse(p.value) : undefined;
    if (c?.success !== true) return;
    if (c.data.cmd === "reset-latency") {
      ackLatency.length = 0;
      return;
    }
    if (c.data.cmd === "exit") {
      void Promise.all(peers.map((x) => x.stop())).then(() => process.exit(0));
      return;
    }
    const sessions: Record<string, { lastSeq: number; ackedUpTo: number; state: string }> = {};
    let connected = 0;
    for (const peer of peers) {
      const r = peer.report();
      if (r.carrier !== "none") connected += 1;
      Object.assign(sessions, r.sessions);
    }
    const mem = process.memoryUsage();
    process.stdout.write(
      `${JSON.stringify({
        t: "report",
        ts: Date.now(),
        peers: peers.length,
        connected,
        ...counts,
        connectMs: summarize(connectAt),
        ackMs: summarize(ackLatency),
        rss: mem.rss,
        sessions,
      })}\n`,
    );
  });
};

main().catch((err: unknown) => {
  log("fatal", errorFields(err));
  process.exit(1);
});
