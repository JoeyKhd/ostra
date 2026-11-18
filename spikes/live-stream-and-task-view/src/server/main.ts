import { loadSettings } from "./config.ts";
import { startServer } from "./server.ts";

// One replica as its own process: `pnpm server` with DATABASE_URL and OSTRA_SPIKE_RUNNER_TOKEN set
// (at least 24 characters, no default). Add OSTRA_SPIKE_DEV_LOGIN=1 to get the dev sign-in stand-in.
const settings = loadSettings(process.env);
const running = await startServer(settings);
// The harness reads this line to learn the port.
process.stdout.write(`${JSON.stringify({ listening: running.port, replica: settings.OSTRA_SPIKE_REPLICA_ID })}\n`);

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  void running.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The harness holds our stdin open and sets OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE=1. When the harness dies, the pipe
// closes and so does this process: a hard-killed harness (SIGKILL cannot be caught, but its pipes close)
// leaves no server running. Off by default, so a server started by hand or by a supervisor is unaffected.
if (settings.OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE === "1") {
  process.stdin.on("end", shutdown);
  process.stdin.on("error", shutdown);
  process.stdin.resume();
}
