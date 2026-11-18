import { parseArgs } from "node:util";
import { z } from "zod";
import { TaskId } from "../shared/ids.ts";
import { replayFile } from "./replay.ts";
import { createRunnerClient } from "./runner-client.ts";
import { buildAllKindsEvents, buildLongSession, streamingTurn } from "./scenarios.ts";

// A producer as its own process (the stand-in for a runner), with the runner token in the environment:
//   OSTRA_SPIKE_RUNNER_TOKEN=<the server's token> node src/producer/main.ts --base http://127.0.0.1:3000 --task demo
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    task: { type: "string" },
    scenario: { type: "string", default: "all-kinds" },
    file: { type: "string" },
    turns: { type: "string", default: "100" },
  },
});

const base = z.url().parse(values.base);
const taskId = TaskId.parse(values.task);
// No default: the token is a secret, and a public constant would be no secret at all.
const token = z.string().min(24).parse(process.env["OSTRA_SPIKE_RUNNER_TOKEN"]);
const client = createRunnerClient({ baseUrl: base, token, batchMs: 20 });
client.start();

const scenario = z.enum(["all-kinds", "streaming", "long", "replay"]).parse(values.scenario);
switch (scenario) {
  case "all-kinds": {
    for (const event of buildAllKindsEvents(taskId).events) client.emit(taskId, event);
    break;
  }
  case "streaming":
    await streamingTurn(client, taskId, { turnId: `${taskId}-s1`, segmentId: `${taskId}-s1-m`, totalWords: 200, streamMs: 6000 });
    break;
  case "long":
    for (const event of buildLongSession(taskId, z.coerce.number().int().parse(values.turns))) client.emit(taskId, event);
    break;
  case "replay": {
    const file = z.string().parse(values.file);
    await replayFile(client, taskId, file, { delayMs: 0 });
    break;
  }
  default:
    scenario satisfies never;
}
await client.stop();
process.stdout.write(`${JSON.stringify({ emitted: client.stats.emitted, acked: client.stats.acked })}\n`);
