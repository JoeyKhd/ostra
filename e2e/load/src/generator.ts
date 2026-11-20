// One generator process of the load test (ticket 34): `node src/generator.ts '<json args>'`, with
// the pool's join token in OSTRA_LOAD_JOIN_TOKEN. It
// joins its share of simulated runners with the pool's join token, connects them when told, and
// reports dispatches, steers and, after a drain, every session's count, one JSON line each on
// stdout. Several of these run at once (one per 250 tasks by default), so no single event loop is
// the limit. It exits when its stdin closes, so it never outlives the harness.

import path from "node:path";
import readline from "node:readline";

import { silentLogger } from "@ostra/adapter-sdk";
import { parseJson, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { generatorArgsSchema, generatorCommandSchema } from "./generator-protocol.ts";
import type { GeneratorLine } from "./generator-protocol.ts";
import { registerSimRunner, startSimRunner } from "./sim-runner.ts";
import type { RegisteredRunner, SimRunner } from "./sim-runner.ts";

const args = generatorArgsSchema.parse({ ...z.record(z.string(), z.unknown()).parse(JSON.parse(process.argv[2] ?? "{}")), joinToken: process.env["OSTRA_LOAD_JOIN_TOKEN"] });

const say = (line: GeneratorLine): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : "an unknown error");

/** A bounded sample of ack latencies: every one until it's full, then a reservoir. */
const ACK_SAMPLE = 50_000;
let ackMs: number[] = [];
let acksSeen = 0;
const noteAck = (ms: number): void => {
  acksSeen += 1;
  if (ackMs.length < ACK_SAMPLE) ackMs.push(ms);
  else {
    const slot = Math.floor(Math.random() * acksSeen);
    if (slot < ACK_SAMPLE) ackMs[slot] = ms;
  }
};

const serverFor = (index: number): string => args.serverUrls[index % args.serverUrls.length] ?? args.serverUrls[0] ?? "";

const registerAll = async (): Promise<RegisteredRunner[]> => {
  const registered: RegisteredRunner[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < args.runners) {
      const index = next;
      next += 1;
      registered[index] = await registerSimRunner({ serverUrl: serverFor(index), joinToken: args.joinToken, name: `${args.prefix}-${String(index)}`, slots: args.slots });
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.registerConcurrency, args.runners) }, worker));
  return registered;
};

const runners: SimRunner[] = [];

const connectAll = async (registered: readonly RegisteredRunner[]): Promise<void> => {
  for (const [index, runner] of registered.entries()) {
    runners.push(
      await startSimRunner({
        serverUrl: serverFor(index),
        runner,
        slots: args.slots,
        dataDir: path.join(args.dataDir, runner.name),
        logger: silentLogger,
        transport: args.transport,
        hooks: {
          onDispatched: (task) => {
            say({ t: "dispatched", taskId: task.taskId, sessionId: task.sessionId, partialText: task.partialText });
          },
          onSteer: (id, at) => {
            say({ t: "steer", id, at });
          },
          onAckLatency: noteAck,
          onError: (error) => {
            say({ t: "error", message: errorText(error) });
          },
        },
      }),
    );
  }
};

const main = async (): Promise<void> => {
  const registered = await registerAll();
  say({ t: "registered", runners: registered.map((runner) => ({ runnerId: runner.runnerId, name: runner.name })) });

  const input = readline.createInterface({ input: process.stdin });
  input.on("close", () => {
    void Promise.allSettled(runners.map((runner) => runner.stop())).then(() => process.exit(0));
  });
  input.on("line", (line) => {
    const parsed = parseJson(line);
    const command = parsed.ok ? generatorCommandSchema.safeParse(parsed.value) : undefined;
    if (command?.success !== true) return;
    const c = command.data;
    switch (c.cmd) {
      case "connect":
        void connectAll(registered).catch((error: unknown) => {
          say({ t: "error", message: errorText(error) });
        });
        return;
      case "report":
        say({
          t: "report",
          runners: runners.length,
          connected: runners.filter((runner) => runner.connected()).length,
          tasks: runners.reduce((sum, runner) => sum + runner.tasks().length, 0),
          rssBytes: process.memoryUsage().rss,
        });
        return;
      case "acks":
        say({ t: "acks", ackMs });
        ackMs = [];
        acksSeen = 0;
        return;
      case "mark": {
        const taskId = taskIdSchema.safeParse(c.taskId);
        const task = taskId.success ? runners.flatMap((runner) => runner.tasks()).find((item) => item.taskId === taskId.data) : undefined;
        say({ t: "marked", marker: c.marker, at: task === undefined ? null : task.agent.mark(c.marker) });
        return;
      }
      case "drain":
        for (const runner of runners) runner.pause();
        void Promise.all(runners.map((runner) => runner.drained())).then(
          (all) => {
            say({ t: "drained", sessions: all.flat().map((item) => ({ taskId: item.taskId, sessionId: item.sessionId, offered: item.offered })) });
          },
          (error: unknown) => {
            say({ t: "error", message: errorText(error) });
          },
        );
        return;
      case "exit":
        input.close();
        return;
      default:
        c satisfies never;
    }
  });
};

main().catch((error: unknown) => {
  say({ t: "error", message: errorText(error) });
  process.exit(1);
});
