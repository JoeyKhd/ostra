import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { z } from "zod";

// A real Postgres on this machine, with no Docker: embedded-postgres (MIT). Run as its own process
// so the database is measured separately from the servers.
const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
  });

const dir = z.string().min(1).parse(process.argv[2] ?? ".pgdata");
const databaseDir = path.resolve(dir);
await rm(databaseDir, { recursive: true, force: true });
await mkdir(path.dirname(databaseDir), { recursive: true });
const port = await freePort();
const password = `spike-${Math.random().toString(36).slice(2)}`;
const pg = new EmbeddedPostgres({
  databaseDir,
  user: "postgres",
  password,
  port,
  persistent: false,
  postgresFlags: ["-c", "max_connections=300", "-c", "shared_buffers=256MB", "-c", "log_min_messages=warning"],
  onLog: () => undefined,
  onError: () => undefined,
});
await pg.initialise();
await pg.start();
await pg.createDatabase("spike");

// The postmaster's pid, so the harness can measure the database's CPU time.
const readPostmasterPid = async (): Promise<number> => {
  try {
    const first = (await readFile(path.join(databaseDir, "postmaster.pid"), "utf8")).split("\n")[0];
    return Number(first);
  } catch {
    return 0;
  }
};
const postmasterPid = await readPostmasterPid();
const url = `postgres://postgres:${password}@127.0.0.1:${String(port)}/spike`;
process.stdout.write(`${JSON.stringify({ databaseUrl: url, postmasterPid, port })}\n`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void pg.stop().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// The harness holds our stdin open and sets OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE=1: when the harness dies, the pipe
// closes and the database stops with it, so a hard-killed harness leaves no Postgres running.
if (z.enum(["0", "1"]).default("0").parse(process.env["OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE"]) === "1") {
  process.stdin.on("end", stop);
  process.stdin.on("error", stop);
  process.stdin.resume();
}
// keep the process alive
setInterval(() => undefined, 60_000);
