// A runner peer in its own process, for the test that kills it between spool write and ack
// (ticket 16). Usage: node peer-child.ts <serverUrl> <dataDir> <events>, with the access token in
// OSTRA_TEST_ACCESS_TOKEN. It prints "spooled" once every event is on disk, then waits to be killed.
import { leaseEpochSchema, runnerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { silentLogger } from "@ostra/adapter-sdk";
import { startConnection } from "../connection/peer.ts";
import { rejectAllHandlers } from "./handlers.ts";

const [serverUrl, dataDir, countText] = process.argv.slice(2);
const token = process.env["OSTRA_TEST_ACCESS_TOKEN"];
if (serverUrl === undefined || dataDir === undefined || countText === undefined || token === undefined) {
  process.stderr.write("usage: peer-child.ts <serverUrl> <dataDir> <events>\n");
  process.exit(2);
}

const connection = await startConnection({
  serverUrl,
  peer: { kind: "runner", runnerId: runnerIdSchema.parse("runner-child") },
  tokens: { get: () => Promise.resolve({ ok: true, token, expiresAt: Date.now() + 600_000 }), invalidate: () => undefined },
  dataDir,
  handlers: rejectAllHandlers,
  status: () => ({ executor: "host", capacity: 1, freeSlots: 0, labels: [], running: [] }),
  logger: silentLogger,
});
const channel = await connection.openSession({
  taskId: taskIdSchema.parse("task-child"),
  sessionId: sessionIdSchema.parse("session-child"),
  leaseEpoch: leaseEpochSchema.parse(1),
});
for (let index = 0; index < Number(countText); index += 1) {
  await channel.emit({ kind: "environment.setup_output", stream: "stdout", text: `line ${String(index)}` });
}
process.stdout.write("spooled\n");
setInterval(() => undefined, 60_000);
