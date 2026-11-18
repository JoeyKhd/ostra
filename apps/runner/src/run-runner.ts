import path from "node:path";
import { HostExecutor } from "@ostra/adapter-executor-host";
import type { ExecutorAdapter } from "@ostra/adapter-sdk";
import type { RunnerConfig } from "@ostra/protocol";
import type { RunSignedIn } from "./cli/cli.ts";
import { exitCodes } from "./cli/cli.ts";
import type { Terminal } from "./cli/terminal.ts";
import { startConnection } from "./connection/peer.ts";
import type { RunnerConnection } from "./connection/peer.ts";
import { updateStatus } from "./identity/store.ts";
import { defaultAgents } from "./task-host/agents.ts";
import { runnerServerLink } from "./task-host/server-link.ts";
import { createTaskHost } from "./task-host/task-host.ts";

// `ostra runner` once it's signed in: the connection to the server, and the task host that runs
// what it's dispatched, until Ctrl-C or a revocation.

/** How long a stopping agent has to exit on its own before its tree is killed. */
const STOP_GRACE_MS = 5_000;

const executorFor = async (config: RunnerConfig, dataDir: string, terminal: Terminal): Promise<ExecutorAdapter | null> => {
  switch (config.executor) {
    case "host":
      return HostExecutor.start({ dataDir, shell: config.shell }, { logger: terminal.logger, clock: { now: () => Date.now() } });
    case "docker":
      terminal.warn("The docker executor runs on a Linux machine with Docker (ticket 22); start this runner with --executor host.");
      return null;
    default:
      return config.executor satisfies never;
  }
};

export const runSignedInRunner: RunSignedIn = async ({ signedIn, config, dataDir, terminal, signal }) => {
  const { record } = signedIn.identity;
  const logger = terminal.logger.child({ runnerId: record.runnerId });
  const executor = await executorFor(config, path.resolve(dataDir), terminal);
  if (executor === null) {
    return exitCodes.usage;
  }
  const health = await executor.health();
  if (health.status !== "ok") {
    terminal.warn(`The ${executor.name} executor can't run tasks here: ${health.reason}.`);
    return exitCodes.failed;
  }
  // The task host and the connection need each other: the host reaches the connection through this.
  const holder: { connection: RunnerConnection | undefined } = { connection: undefined };
  const connected = (): RunnerConnection => {
    if (holder.connection === undefined) {
      throw new Error("the connection isn't started yet");
    }
    return holder.connection;
  };
  const host = createTaskHost({
    link: runnerServerLink({
      serverUrl: config.serverUrl,
      tokens: signedIn.tokens,
      connection: {
        openSession: (ref) => connected().openSession(ref),
        statusChanged: () => {
          holder.connection?.statusChanged();
        },
      },
    }),
    executor,
    agents: defaultAgents(),
    logger,
    listenHost: "127.0.0.1",
    stopGraceMs: STOP_GRACE_MS,
    capacity: config.capacity,
    executorKind: config.executor,
    labels: config.labels,
  });
  const live = await startConnection({
    serverUrl: config.serverUrl,
    peer: { kind: "runner", runnerId: record.runnerId },
    tokens: signedIn.tokens,
    dataDir,
    handlers: host.handlers,
    status: host.status,
    logger,
    hooks: {
      onConnected: (at) => {
        updateStatus(dataDir, { lastConnectedAt: at }).catch(() => undefined);
      },
      onRefused: (reason, message) => {
        updateStatus(dataDir, { lastRefusal: { at: Date.now(), reason, message } }).catch(() => undefined);
      },
      onSelfFence: (sessions) => {
        host.fence(sessions);
      },
      onStaleLease: (sessionId) => {
        host.abandon(sessionId);
      },
    },
  });
  holder.connection = live;
  const restored = live.restoredSessions();
  if (restored.length > 0) {
    void host.restored(restored);
  }
  terminal.say(
    `Runner ${record.runnerId} (${record.kind}, ${config.executor}${executor.capabilities.isolation === "none" ? ", not isolated" : ""}) is connecting to ${config.serverUrl}. Press Ctrl-C to stop.`,
  );
  signal.addEventListener("abort", () => {
    void host.shutdown().then(() => live.stop());
  });
  const end = await live.done;
  await host.shutdown();
  await live.stop();
  if (end.kind === "revoked") {
    terminal.warn(`${end.message}. To sign in again, delete the identity folder in ${dataDir} and start the runner again.`);
    return exitCodes.refused;
  }
  terminal.say("Runner stopped.");
  return exitCodes.ok;
};
