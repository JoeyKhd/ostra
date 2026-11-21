import path from "node:path";
import { createDockerBoxes, createDockerSnapshots, createEngine, engineAddressFrom } from "@ostra/adapter-executor-docker";
import { baseEnv, HostExecutor, localShellProbe, machineBrowserSource, resolveMachineBrowser, resolveSetupShell } from "@ostra/adapter-executor-host";
import { KubernetesExecutor } from "@ostra/adapter-executor-kubernetes";
import { noBrowserWords } from "@ostra/protocol";
import type { RunnerConfig } from "@ostra/protocol";
import type { RunSignedIn } from "./cli/cli.ts";
import { exitCodes } from "./cli/cli.ts";
import { createBoxDispatcher } from "./box-dispatcher.ts";
import { startConnection } from "./connection/peer.ts";
import type { CommandHandlers, ConnectionHooks, PeerStatus, RunnerConnection } from "./connection/peer.ts";
import { dataPaths, signInAgainAdvice, updateStatus } from "./identity/store.ts";
import { kubernetesCluster } from "./kubernetes-cluster.ts";
import { createKubernetesDispatcher } from "./kubernetes-dispatcher.ts";
import { defaultAgents } from "./task-host/agents.ts";
import { fetchPullCredential, fetchPushCredential, fetchServiceSecrets, fetchSnapshotCredentials, fetchTaskToken, runnerServerLink } from "./task-host/server-link.ts";
import { RUNNER_PREVIEW_SUPPORT } from "./task-host/preview-views.ts";
import { createTaskHost } from "./task-host/task-host.ts";
import { approvalHooks, DOCKER_CAPABILITIES, withApprovalStatus } from "./pool-approval.ts";
import { hostSlots, reportedCapabilities } from "./reports.ts";
import { releaseImage } from "./version.ts";

// `ostra runner` once it's signed in: the connection to the server, and what runs the tasks it's
// dispatched, until Ctrl-C or a refusal for good (revoked, or a key the server doesn't know).
// - `host`: the task host, in this process, on a worktree per task ("personal, not isolated").
// - `docker`: a box per task on this machine's Docker Engine; each box's sidecar runs its task.

/** How long a stopping agent has to exit on its own before its tree is killed. */
const STOP_GRACE_MS = 5_000;

/**
 * The images a box is made of: its own release's base and runner images, under the namespace and
 * at the version the release's stamp wrote, unless the settings name others (`docs/configuration.md`).
 */
export const imagesOf = (config: Pick<RunnerConfig, "boxBaseImage" | "boxRunnerImage">): { readonly base: string; readonly runner: string } => ({
  base: config.boxBaseImage ?? releaseImage("base"),
  runner: config.boxRunnerImage ?? releaseImage("runner"),
});

type Work = {
  readonly handlers: CommandHandlers;
  readonly status: () => PeerStatus;
  readonly hooks: Pick<ConnectionHooks, "onSelfFence" | "onStaleLease">;
  readonly started: (connection: RunnerConnection) => void;
  readonly shutdown: () => Promise<void>;
  readonly describe: string;
};

export const runSignedInRunner: RunSignedIn = async ({ signedIn, config, dataDir, terminal, signal, install }) => {
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
      carrier: () => holder.connection?.report().carrier ?? null,
    },
  });

  let work: Work;
  switch (config.executor) {
    case "host": {
      const context = { logger, clock: { now: () => Date.now() } };
      // Milestone 8 (ticket 11, ADR 0068): the boxes' browser, the machine's or the pinned headless
      // shell, found when a box first wants one, so a runner that never takes a picture downloads nothing.
      const browserOptions = { named: config.browser, download: config.browserDownload, dataDir: path.resolve(dataDir) };
      const browser = machineBrowserSource(() => resolveMachineBrowser(browserOptions));
      const onMachine = await resolveMachineBrowser({ ...browserOptions, download: false });
      if (!onMachine.available) {
        if (onMachine.reason === "download-off" && config.browserDownload) {
          terminal.say("No Chrome, Chromium or Edge here: the runner downloads its pinned headless shell when a task first needs a browser.");
        } else {
          terminal.warn(onMachine.reason === "download-off" ? noBrowserWords("download-off") : `No browser for this runner's boxes: ${onMachine.detail}.`);
        }
      }
      // Milestone 5 (ticket 10): a pool runs the agent as a separate OS user, and refuses to start
      // where it can't (Windows), without that user, or on the development switch in production.
      let executor: HostExecutor;
      if (record.kind === "pool") {
        const started = await HostExecutor.startPool(
          { dataDir: path.resolve(dataDir), shell: config.shell, agentUser: config.hostPoolAgentUser, secrets: [dataPaths(path.resolve(dataDir)).privateKey], browser },
          context,
        );
        if (!started.ok) {
          terminal.warn(`${started.reason}.`);
          return exitCodes.failed;
        }
        executor = started.value;
      } else {
        executor = await HostExecutor.start({ dataDir: path.resolve(dataDir), shell: config.shell, browser }, context);
      }
      const health = await executor.health();
      // A pool on the development switch says so and runs; anything else short of ok stops here.
      if (health.status === "degraded" && executor.agentUser.kind === "same-user-development") {
        terminal.warn(`The host pool runs the agent as this runner's own user: ${health.reason}.`);
      } else if (health.status !== "ok") {
        terminal.warn(`The host executor can't run tasks here: ${health.reason}.`);
        return exitCodes.failed;
      }
      // Milestone 8 (ticket 12): an app process's command line runs with the setup shell, as a
      // check's: on Windows the bare `bash` is Git for Windows' own (`resolveSetupShell`).
      const appShell = await resolveSetupShell(config.shell, localShellProbe(baseEnv(), path.resolve(dataDir)));
      const host = createTaskHost({
        link,
        executor,
        agents: defaultAgents(),
        logger,
        listenHost: "127.0.0.1",
        stopGraceMs: STOP_GRACE_MS,
        subagentWaitMs: config.subagentWaitMinutes * 60_000,
        // Milestone 5 (F-014, ADR 0059): two at once unless OSTRA_RUNNER_SLOTS says otherwise.
        capacity: hostSlots(config),
        executorKind: "host",
        labels: config.labels,
        appShell: appShell.kind === "found" ? appShell.command : config.shell,
      });
      const capabilities = reportedCapabilities(executor.capabilities);
      work = {
        handlers: host.handlers,
        // `host` offers slots only: no CPU or memory (ADR 0059). Minor 7: the tunnel (ticket 22).
        status: () => ({ ...host.status(), resources: null, capabilities, install, preview: RUNNER_PREVIEW_SUPPORT }),
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
      // Each box's sidecar runs the task, so it gets the subagent wait too (runner parity).
      const boxes = createDockerBoxes(engine, { images: imagesOf(config), subagentWaitMinutes: config.subagentWaitMinutes });
      if (!(await boxes.ping())) {
        terminal.warn("The docker executor needs a Docker Engine, and none answers here (DOCKER_HOST, or the default socket).");
        return exitCodes.failed;
      }
      // Milestone 5 (ADR 0059): what this host offers, from the Engine's `info` less the reserve.
      const settings = { ...(config.slots === undefined ? {} : { slots: config.slots }), reserveCpuMillis: config.reserveCpuMillis, reserveMemoryMiB: config.reserveMemoryMiB };
      const offer = await boxes.readCapacity(settings);
      if (offer === null) {
        terminal.warn("The Docker Engine didn't say how many CPUs and how much memory it has.");
        return exitCodes.failed;
      }
      const dispatcher = createBoxDispatcher({
        boxes,
        link,
        taskToken: fetchTaskToken({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        dataDir: path.resolve(dataDir),
        serverUrl: config.boxServerUrl ?? config.serverUrl,
        capacity: offer.slots,
        labels: config.labels,
        logger,
        // Milestone 3 (ticket 14): the services' secrets, and the snapshots built and kept here.
        serviceSecrets: fetchServiceSecrets({ serverUrl: config.serverUrl }),
        snapshots: createDockerSnapshots({ engine, workDir: path.resolve(dataDir), defaultBaseImage: imagesOf(config).base, logger }),
        snapshotCredentials: fetchSnapshotCredentials({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        // Milestone 5 (F-120, ticket 21): the registry's credentials, each for one pull or one build.
        pullCredential: fetchPullCredential({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        pushCredential: fetchPushCredential({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        reportRunnerEvent: (event) => {
          holder.connection?.sendRunnerEvent(event);
        },
      });
      work = {
        handlers: dispatcher.handlers,
        // Minor 7: each box's sidecar serves the tunnel (ticket 22), with this release's image.
        status: () => ({ ...dispatcher.status(), resources: offer, capabilities: DOCKER_CAPABILITIES, install, preview: RUNNER_PREVIEW_SUPPORT }),
        hooks: {},
        started: () => undefined,
        shutdown: () => Promise.resolve(),
        describe: "docker, a box per task",
      };
      break;
    }
    case "kubernetes": {
      // Milestone 5 (ticket 20, ADR 0060): a pod per box, made in the runner's namespace.
      const cluster = await kubernetesCluster({ namespace: config.k8sNamespace }, process.env);
      if (!cluster.ok) {
        terminal.warn(cluster.reason);
        return exitCodes.failed;
      }
      const { kube, namespace } = cluster.value;
      const executor = new KubernetesExecutor(
        {
          kube,
          namespace,
          images: imagesOf(config),
          serverUrl: config.boxServerUrl ?? config.serverUrl,
          ...(config.slots === undefined ? {} : { slots: config.slots }),
          runtimeClassName: config.k8sRuntimeClass ?? null,
          nodeWaitMinutes: config.k8sNodeWaitMinutes,
          sidecarLimits: { cpuMillis: config.sidecarCpuMillis, memoryMiB: config.sidecarMemoryMiB },
          serviceLimits: { cpuMillis: config.serviceCpuMillis, memoryMiB: config.serviceMemoryMiB },
          subagentWaitMinutes: config.subagentWaitMinutes,
          ...(config.k8sBuildNamespace === undefined ? {} : { buildNamespace: config.k8sBuildNamespace }),
        },
        { logger, clock: { now: () => Date.now() } },
      );
      const health = await executor.health();
      if (health.status !== "ok") {
        terminal.warn(`The kubernetes executor can't run boxes here: ${health.reason}`);
        return exitCodes.failed;
      }
      const dispatcher = createKubernetesDispatcher({
        executor,
        kube,
        namespace,
        link,
        taskToken: fetchTaskToken({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        // Milestone 5 (F-120, ticket 21): the pull credential into the box's pull secret, and builds that push.
        pullCredential: fetchPullCredential({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        snapshotCredentials: fetchSnapshotCredentials({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        pushCredential: fetchPushCredential({ serverUrl: config.serverUrl, tokens: signedIn.tokens }),
        dataDir: path.resolve(dataDir),
        labels: config.labels,
        logger,
        reportRunnerEvent: (event) => {
          holder.connection?.sendRunnerEvent(event);
        },
      });
      work = {
        handlers: dispatcher.handlers,
        status: () => ({ ...dispatcher.status(), install, preview: RUNNER_PREVIEW_SUPPORT }),
        hooks: {},
        // The pods this runner made before it restarted: their sidecars ran on without it.
        started: () => {
          void dispatcher.adopt();
        },
        shutdown: () => {
          dispatcher.detach();
          return Promise.resolve();
        },
        describe: `kubernetes, a pod per box in ${namespace}`,
      };
      break;
    }
    default:
      return config.executor satisfies never;
  }

  const live = await startConnection({
    serverUrl: config.serverUrl,
    peer: { kind: "runner", runnerId: record.runnerId },
    // Milestone 5 (ticket 18): a WebSocket, falling back to HTTP by itself on `auto`.
    transport: config.transport,
    timers: { wsRetryMs: config.wsRetryMinutes * 60_000 },
    tokens: signedIn.tokens,
    dataDir,
    handlers: withApprovalStatus(work.handlers, dataDir),
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
      onCarrier: (carrier, fallback) => {
        updateStatus(dataDir, { carrier: { at: Date.now(), carrier, fallback } }).catch(() => undefined);
      },
      ...approvalHooks(dataDir, terminal),
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
  switch (end.kind) {
    case "stopped":
      terminal.say("Runner stopped.");
      return exitCodes.ok;
    case "replaced":
      // Another process runs as this runner: its identity is fine, and so is this one's sign-in.
      terminal.warn(end.message);
      return exitCodes.duplicate;
    case "revoked":
    case "unknown-key":
      // Refused for good: only then is a new identity the fix.
      terminal.warn(`${end.message} ${signInAgainAdvice(dataDir)}`);
      return exitCodes.refused;
    default:
      return end satisfies never;
  }
};
