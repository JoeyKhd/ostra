import path from "node:path";
import { createDockerBoxes, createDockerSnapshots, createEngine, engineAddressFrom } from "@ostra/adapter-executor-docker";
import { HostExecutor } from "@ostra/adapter-executor-host";
import type { RunnerConfig } from "@ostra/protocol";
import type { RunSignedIn } from "./cli/cli.ts";
import { exitCodes } from "./cli/cli.ts";
import { createBoxDispatcher } from "./box-dispatcher.ts";
import { startConnection } from "./connection/peer.ts";
import type { CommandHandlers, ConnectionHooks, PeerStatus, RunnerConnection } from "./connection/peer.ts";
import { dataPaths, signInAgainAdvice, updateStatus } from "./identity/store.ts";
import { defaultAgents } from "./task-host/agents.ts";
import { fetchServiceSecrets, fetchSnapshotCredentials, fetchTaskToken, runnerServerLink } from "./task-host/server-link.ts";
import { createTaskHost } from "./task-host/task-host.ts";
import { RUNNER_VERSION } from "./version.ts";

// `ostra runner` once it's signed in: the connection to the server, and what runs the tasks it's
// dispatched, until Ctrl-C or a refusal for good (revoked, or a key the server doesn't know).
// - `host`: the task host, in this process, on a worktree per task ("personal, not isolated").
// - `docker`: a box per task on this machine's Docker Engine; each box's sidecar runs its task.

/** How long a stopping agent has to exit on its own before its tree is killed. */
const STOP_GRACE_MS = 5_000;

/** The images a box is made of, unless the settings name others (`docs/configuration.md`). */
const imagesOf = (config: RunnerConfig): { readonly base: string; readonly runner: string } => ({
  base: config.boxBaseImage ?? `ostra/base:${RUNNER_VERSION}`,
  runner: config.boxRunnerImage ?? `ostra/runner:${RUNNER_VERSION}`,
});

type Work = {
  readonly handlers: CommandHandlers;
  readonly status: () => PeerStatus;
  readonly hooks: Pick<ConnectionHooks, "onSelfFence" | "onStaleLease">;
  readonly started: (connection: RunnerConnection) => void;
  readonly shutdown: () => Promise<void>;
  readonly describe: string;
};

export const runSignedInRunner: RunSignedIn = async ({ signedIn, config, dataDir, terminal, signal }) => {
  const { record } = signedIn.identity;
  const logger = terminal.logger.child({ runnerId: record.runnerId });
  // The task host and the connection need each other: the host reaches the connection through this.
  const holder: { connection: RunnerConnection | undefined } = { connection: undefined };
  const link = runnerServerLink({
    serverUrl: config.serverUrl,
    tokens: signedIn.tokens,
    connection: {
      openSession: (ref) => {
        if (holder.connection === undefined) {
          throw new Error("the connection isn't started yet");
        }
        return holder.connection.openSession(ref);
      },
      statusChanged: () => {
        holder.connection?.statusChanged();
      },
    },
  });

  let work: Work;
  switch (config.executor) {
    case "host": {
      const context = { logger, clock: { now: () => Date.now() } };
      // Milestone 5 (ticket 10): a pool runs the agent as a separate OS user, and refuses to start
      // where it can't (Windows), without that user, or on the development switch in production.
      let executor: HostExecutor;
      if (record.kind === "pool") {
        const started = await HostExecutor.startPool(
          { dataDir: path.resolve(dataDir), shell: config.shell, agentUser: config.hostPoolAgentUser, secrets: [dataPaths(path.resolve(dataDir)).privateKey] },
          context,
        );
        if (!started.ok) {
          terminal.warn(`${started.reason}.`);
          return exitCodes.failed;
        }
        executor = started.value;
      } else {
        executor = await HostExecutor.start({ dataDir: path.resolve(dataDir), shell: config.shell }, context);
      }
      const health = await executor.health();
      // A pool on the development switch says so and runs; anything else short of ok stops here.
      if (health.status === "degraded" && executor.agentUser.kind === "same-user-development") {
        terminal.warn(`The host pool runs the agent as this runner's own user: ${health.reason}.`);
      } else if (health.status !== "ok") {
        terminal.warn(`The host executor can't run tasks here: ${health.reason}.`);
        return exitCodes.failed;
      }
      const host = createTaskHost({
        link,
        executor,
        agents: defaultAgents(),
        logger,
        listenHost: "127.0.0.1",
        stopGraceMs: STOP_GRACE_MS,
        capacity: config.capacity,
        executorKind: "host",
        labels: config.labels,
      });
      work = {
        handlers: host.handlers,
        status: host.status,
        hooks: {
          onSelfFence: (sessions) => {
            host.fence(sessions);
          },
          onStaleLease: (sessionId) => {
            host.abandon(sessionId);
          },
        },
        started: (connection) => {
          const restored = connection.restoredSessions();
          if (restored.length > 0) {
            void host.restored(restored);
          }
        },
        shutdown: host.shutdown,
        describe: `host, not isolated, ${executor.capabilities.processContainment} containment${executor.agentUser.kind === "same-user-development" ? ", same user (development only)" : ""}`,
      };
      break;
    }
    case "docker": {
      let address;
      try {
        address = engineAddressFrom(process.env["DOCKER_HOST"]);
      } catch {
        terminal.warn("DOCKER_HOST isn't unix://, npipe:// or tcp://host:port.");
        return exitCodes.usage;
      }
      const engine = createEngine(address);
      const boxes = createDockerBoxes(engine, { images: imagesOf(config) });
      if (!(await boxes.ping())) {
        terminal.warn("The docker executor needs a Docker Engine, and none answers here (DOCKER_HOST, or the default socket).");
        return exitCodes.failed;
      }
      const dispatcher = createBoxDispatcher({
        boxes,
        link,
        taskToken: fetchTaskToken({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        dataDir: path.resolve(dataDir),
        serverUrl: config.boxServerUrl ?? config.serverUrl,
        capacity: config.capacity,
        labels: config.labels,
        logger,
        // Milestone 3 (ticket 14): the services' secrets, and the snapshots built and kept here.
        serviceSecrets: fetchServiceSecrets({ serverUrl: config.serverUrl }),
        snapshots: createDockerSnapshots({ engine, workDir: path.resolve(dataDir), defaultBaseImage: imagesOf(config).base, logger }),
        snapshotCredentials: fetchSnapshotCredentials({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        reportRunnerEvent: (event) => {
          holder.connection?.sendRunnerEvent(event);
        },
      });
      work = {
        handlers: dispatcher.handlers,
        status: dispatcher.status,
        hooks: {},
        started: () => undefined,
        shutdown: () => Promise.resolve(),
        describe: "docker, a box per task",
      };
      break;
    }
    default:
      return config.executor satisfies never;
  }

  const live = await startConnection({
    serverUrl: config.serverUrl,
    peer: { kind: "runner", runnerId: record.runnerId },
    tokens: signedIn.tokens,
    dataDir,
    handlers: work.handlers,
    status: work.status,
    logger,
    hooks: {
      ...work.hooks,
      onConnected: (at) => {
        updateStatus(dataDir, { lastConnectedAt: at }).catch(() => undefined);
      },
      onRefused: (reason, message) => {
        updateStatus(dataDir, { lastRefusal: { at: Date.now(), reason, message } }).catch(() => undefined);
      },
    },
  });
  holder.connection = live;
  work.started(live);
  terminal.say(`Runner ${record.runnerId} (${record.kind}, ${work.describe}) is connecting to ${config.serverUrl}. Press Ctrl-C to stop.`);
  signal.addEventListener("abort", () => {
    void work.shutdown().then(() => live.stop());
  });
  const end = await live.done;
  await work.shutdown();
  await live.stop();
  if (end.kind !== "stopped") {
    // Refused for good (revoked, or a key the server doesn't know): only then is a new identity the fix.
    terminal.warn(`${end.message} ${signInAgainAdvice(dataDir)}`);
    return exitCodes.refused;
  }
  terminal.say("Runner stopped.");
  return exitCodes.ok;
};
