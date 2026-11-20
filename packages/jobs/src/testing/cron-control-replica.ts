// One replica of the schedule hunt's control (milestone 6's ticket 37): pg-boss's own cron with
// its defaults, as spike 8's C4 ran it (`spikes/durable-queue-choice/src/replica.ts`). It migrates,
// supervises and runs the cron pass, and works `control.fire`, recording each fire it gets, so the
// harness can count the starts of each (schedule, minute). Nothing here is ostra's fix: the
// forwarding queue keeps pg-boss's own settings (no heartbeat, a 15-minute expiry), and the
// schedules carry no singleton slot. Settings come from the environment (CONTROL_DATABASE_URL,
// CONTROL_REPLICA); it prints `{ "ready": <name> }` once it works, and stops on `{ "stop": true }`
// on stdin.

import { createInterface } from "node:readline";

import { PgBoss } from "pg-boss";
import { z } from "zod";

const CONTROL_QUEUE = "control.fire";

const env = z.object({ CONTROL_DATABASE_URL: z.string().min(1), CONTROL_REPLICA: z.string().min(1) }).parse(process.env);
const payloadSchema = z.object({ board: z.string() });

const boss = new PgBoss({
  connectionString: env.CONTROL_DATABASE_URL,
  max: 6,
  instanceName: env.CONTROL_REPLICA,
  // Spike 8's passes (`spikes/durable-queue-choice/src/kit.ts`): 5 s, so a dead worker's jobs come back quickly.
  superviseIntervalSeconds: 5,
  monitorIntervalSeconds: 5,
});
boss.on("error", () => {
  // A killed peer's connection, or the database going away at the end: nothing to do.
});

const log = (event: string, fields: Readonly<Record<string, string | number>> = {}): void => {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), replica: env.CONTROL_REPLICA, event, ...fields })}\n`);
};

await boss.start();
if ((await boss.getQueue(CONTROL_QUEUE)) === null) {
  await boss.createQueue(CONTROL_QUEUE).catch(() => undefined);
}
const db = boss.getDb();
const workOptions = { includeMetadata: true, localConcurrency: 4, pollingIntervalSeconds: 0.5 } as const;
await boss.work<unknown, undefined, typeof workOptions>(CONTROL_QUEUE, workOptions, async (jobs) => {
  for (const job of jobs) {
    const payload = payloadSchema.parse(job.data);
    await db.executeSql("INSERT INTO control_fire (schedule_key, job_id, replica, job_created) VALUES ($1, $2::uuid, $3, $4)", [payload.board, job.id, env.CONTROL_REPLICA, job.createdOn]);
  }
  return undefined;
});
log("control.ready");
process.stdout.write(`${JSON.stringify({ ready: env.CONTROL_REPLICA })}\n`);

let stopping = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  if (stopping || !line.includes('"stop"')) {
    return;
  }
  stopping = true;
  log("control.stopping");
  boss.stop({ graceful: true, timeout: 15_000 }).then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
