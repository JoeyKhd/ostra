import type { RunSignedIn } from "./cli/cli.ts";
import { exitCodes } from "./cli/cli.ts";
import { startConnection } from "./connection/peer.ts";
import type { CommandHandlers, CommandOutcome } from "./connection/peer.ts";
import { updateStatus } from "./identity/store.ts";

// `ostra runner` once it's signed in: hold the connection to the server until Ctrl-C or a
// revocation. Tasks come with the task host (ticket 21); until then every command is refused.

const notYet = (): Promise<CommandOutcome> => Promise.resolve({ result: "rejected", reason: "no-task-host" });

const noTaskHost: CommandHandlers = {
  dispatch: notYet,
  steer: notYet,
  interrupt: notYet,
  stop: notYet,
  "approval-answer": notYet,
  drain: () => Promise.resolve({ result: "done" }),
  "update-hint": () => Promise.resolve({ result: "done" }),
};

export const runSignedInRunner: RunSignedIn = async ({ signedIn, config, dataDir, terminal, signal }) => {
  const { record } = signedIn.identity;
  const logger = terminal.logger.child({ runnerId: record.runnerId });
  const connection = await startConnection({
    serverUrl: config.serverUrl,
    peer: { kind: "runner", runnerId: record.runnerId },
    tokens: signedIn.tokens,
    dataDir,
    handlers: noTaskHost,
    status: () => ({ executor: config.executor, capacity: config.capacity, freeSlots: 0, labels: config.labels, running: [] }),
    logger,
    hooks: {
      onConnected: (at) => {
        updateStatus(dataDir, { lastConnectedAt: at }).catch(() => undefined);
      },
      onRefused: (reason, message) => {
        updateStatus(dataDir, { lastRefusal: { at: Date.now(), reason, message } }).catch(() => undefined);
      },
    },
  });
  terminal.say(`Runner ${record.runnerId} is connecting to ${config.serverUrl}. Press Ctrl-C to stop.`);
  signal.addEventListener("abort", () => {
    void connection.stop();
  });
  const end = await connection.done;
  await connection.stop();
  if (end.kind === "revoked") {
    terminal.warn(`${end.message}. To sign in again, delete the identity folder in ${dataDir} and start the runner again.`);
    return exitCodes.refused;
  }
  terminal.say("Runner stopped.");
  return exitCodes.ok;
};
