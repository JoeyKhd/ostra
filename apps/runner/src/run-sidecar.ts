import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DockerExecutor, listenForInit } from "@ostra/adapter-executor-docker";
import { OpenCodeAdapter, OPENCODE_VERSION } from "@ostra/adapter-opencode";
import { BOX_START_WITHIN_MS, ok } from "@ostra/adapter-sdk";
import { boxIdSchema, commandSchema, dispatchPurposeSchema, httpUrlSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";
import type { RunSidecar } from "./cli/cli.ts";
import { exitCodes } from "./cli/cli.ts";
import { startConnection } from "./connection/peer.ts";
import type { RunnerConnection, TokenSource } from "./connection/peer.ts";
import { createAgentRegistry } from "./task-host/agents.ts";
import { runnerServerLink } from "./task-host/server-link.ts";
import { createTaskHost } from "./task-host/task-host.ts";

// `ostra sidecar` (ticket 22, ADR 0029): the task host inside a `docker` box's sidecar container.
// The pool runner created the box and wrote this task's settings into the sidecar's environment;
// the sidecar connects to the server itself, as the `sidecar` peer for its one task, waits for the
// box's init to connect over the bridge, then runs the task exactly as `host` does, with the
// `docker` executor: the agent's processes in the agent's container, never a credential there.

/** Is `child` the folder `parent`, or below it? */
const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** The sidecar's settings, set by the runner. ostra owns this format: strict. */
export const sidecarEnvSchema = z
  .object({
    OSTRA_SERVER_URL: httpUrlSchema,
    /** The task token (ADR 0034, Q129), in a file the runner wrote once (read-only mount). Never logged. */
    OSTRA_SIDECAR_TOKEN_FILE: z.string().min(1),
    OSTRA_TASK_ID: taskIdSchema,
    OSTRA_SESSION_ID: sessionIdSchema,
    OSTRA_BOX_ID: boxIdSchema,
    OSTRA_LEASE_EPOCH: z.coerce.number().pipe(leaseEpochSchema),
    OSTRA_BRIDGE_NONCE: z.string().min(32).max(128),
    OSTRA_BRIDGE_PORT: z.coerce.number().int().min(1).max(65_535),
    /** The sidecar's name on the box network: the agent reaches the proxies at this address. */
    OSTRA_SIDECAR_HOST: z.string().min(1).max(253),
    OSTRA_TASK_ROOT: z.string().min(1),
    /**
     * Where the sidecar keeps its state (applied commands, the event spool): storage only the sidecar
     * mounts. Never inside the task root, which the agent shares and can rewrite.
     */
    OSTRA_SIDECAR_DATA_DIR: z.string().min(1),
    OSTRA_RUNNER_SHELL: z.string().min(1).default("bash"),
    /** The runner's `OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES`, which the executor passes on to each box. */
    OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES: z.coerce.number().pipe(z.number().int().min(1).max(1440)).default(30),
    /** OpenCode in the base image, checked against its SHA-256 when the image was built (ADR 0046). */
    OSTRA_OPENCODE_BIN: z.string().min(1).default("/opt/opencode/bin/opencode"),
    /**
     * Milestone 8 (ticket 12): which executor's box this is. A pod's containers share its
     * `localhost`, so the app's ports are reached there with no forwarder, and its services are at
     * `localhost` too (ADR 0068); a `docker` box's agent has a loopback of its own.
     */
    OSTRA_BOX_EXECUTOR: z.enum(["docker", "kubernetes"]).default("docker"),
    /** Milestone 8 (Q300): the dispatch's purpose, `app` for "Start the app". Absent: a turn. */
    OSTRA_DISPATCH_PURPOSE: dispatchPurposeSchema.optional(),
  })
  .refine((env) => !isInside(env.OSTRA_TASK_ROOT, env.OSTRA_SIDECAR_DATA_DIR), {
    path: ["OSTRA_SIDECAR_DATA_DIR"],
    message: "the sidecar's state can't live in the task root, where the agent could rewrite it",
  });
export type SidecarEnv = z.infer<typeof sidecarEnvSchema>;

/**
 * How a box's sidecar reaches the app's ports (ticket 12, ADR 0068): a pod's containers share its
 * `localhost`, so the sidecar dials it; a docker box's agent has a loopback of its own, which the
 * init's forwarder reaches.
 */
export const sidecarAppReach = (executor: SidecarEnv["OSTRA_BOX_EXECUTOR"]): "forwarder" | "loopback" => (executor === "kubernetes" ? "loopback" : "forwarder");

/** How long the box's init has to connect to the bridge: the box's start, as a pod's sidecar has to be ready. */
const INIT_CONNECT_MS = BOX_START_WITHIN_MS;

const fileTokens = (file: string): TokenSource => ({
  get: async () => {
    try {
      const token = (await readFile(file, "utf8")).trim();
      return token.length > 0
        ? { ok: true, token, expiresAt: Date.now() + 60_000 }
        : { ok: false, reason: "unreachable", message: "the sidecar's token file is empty" };
    } catch {
      return { ok: false, reason: "unreachable", message: "the sidecar's token file can't be read" };
    }
  },
  invalidate: () => undefined,
});

export const runSidecarCommand: RunSidecar = async ({ env, terminal, signal }) => {
  const parsed = sidecarEnvSchema.safeParse(env);
  if (!parsed.success) {
    terminal.warn("ostra sidecar runs inside a docker box, which the runner starts with its settings; they're missing or wrong here.");
    return exitCodes.usage;
  }
  const settings = parsed.data;
  const logger = terminal.logger.child({ taskId: settings.OSTRA_TASK_ID, boxId: settings.OSTRA_BOX_ID, component: "sidecar" });
  // The proxies listen on the box network's address only, where the agent's container reaches them.
  const listenHost = (await lookup(settings.OSTRA_SIDECAR_HOST)).address;
  const listener = await listenForInit({
    boxId: settings.OSTRA_BOX_ID,
    nonce: settings.OSTRA_BRIDGE_NONCE,
    host: listenHost,
    port: settings.OSTRA_BRIDGE_PORT,
    logger,
  });
  const bridge = await Promise.race([
    listener.connected,
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, INIT_CONNECT_MS).unref();
    }),
  ]);
  if (bridge === null) {
    logger.error("the box's init never connected to the bridge");
    await listener.close();
    return exitCodes.failed;
  }
  const tokens = fileTokens(settings.OSTRA_SIDECAR_TOKEN_FILE);
  const holder: { connection: RunnerConnection | undefined } = { connection: undefined };
  const host = createTaskHost({
    link: runnerServerLink({
      serverUrl: settings.OSTRA_SERVER_URL,
      tokens,
      connection: {
        openSession: (ref) => {
          if (holder.connection === undefined) {
            throw new Error("the sidecar isn't connected yet");
          }
          return holder.connection.openSession(ref);
        },
        statusChanged: () => {
          holder.connection?.statusChanged();
        },
        carrier: () => holder.connection?.report().carrier ?? null,
      },
    }),
    executor: new DockerExecutor({
      taskRoot: settings.OSTRA_TASK_ROOT,
      bridge,
      shell: settings.OSTRA_RUNNER_SHELL,
      // A pod's sidecar dials the app's ports at the pod's `localhost`; a docker box's, through the init's forwarder.
      appReach: sidecarAppReach(settings.OSTRA_BOX_EXECUTOR),
    }),
    agents: createAgentRegistry({
      opencode: (driver) =>
        new OpenCodeAdapter({
          driver,
          resolveBinary: () =>
            Promise.resolve(ok({ path: settings.OSTRA_OPENCODE_BIN, packageName: "@opencode/cli", packageVersion: OPENCODE_VERSION, sha256: "checked-at-image-build" })),
        }),
    }),
    logger,
    listenHost,
    advertiseHost: settings.OSTRA_SIDECAR_HOST,
    stopGraceMs: 5_000,
    subagentWaitMs: settings.OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES * 60_000,
    capacity: 1,
    executorKind: settings.OSTRA_BOX_EXECUTOR,
    labels: [],
    // Milestone 8 (ticket 12): an app process's command line runs with the setup shell, and the
    // bridge's port is the box's own, which no preview reaches.
    appShell: settings.OSTRA_RUNNER_SHELL,
    sidecarControlPort: settings.OSTRA_BRIDGE_PORT,
  });
  const connection = await startConnection({
    serverUrl: settings.OSTRA_SERVER_URL,
    peer: { kind: "sidecar", taskId: settings.OSTRA_TASK_ID, boxId: settings.OSTRA_BOX_ID, leaseEpoch: settings.OSTRA_LEASE_EPOCH },
    tokens,
    dataDir: settings.OSTRA_SIDECAR_DATA_DIR,
    handlers: host.handlers,
    status: host.status,
    logger,
    hooks: {
      onSelfFence: (sessions) => {
        host.fence(sessions);
      },
      onStaleLease: (sessionId) => {
        host.abandon(sessionId);
      },
    },
  });
  holder.connection = connection;
  signal.addEventListener("abort", () => {
    void host.shutdown();
  });
  // The runner's dispatch is this box's reason to exist: the sidecar starts its one task at once.
  const dispatch = commandSchema.parse({
    type: "command",
    seq: 1,
    id: `box-${settings.OSTRA_BOX_ID}`,
    notAfter: Date.now() + 60_000,
    kind: "dispatch",
    body: {
      taskId: settings.OSTRA_TASK_ID,
      sessionId: settings.OSTRA_SESSION_ID,
      boxId: settings.OSTRA_BOX_ID,
      leaseEpoch: settings.OSTRA_LEASE_EPOCH,
      ...(settings.OSTRA_DISPATCH_PURPOSE === undefined ? {} : { purpose: settings.OSTRA_DISPATCH_PURPOSE }),
    },
  });
  if (dispatch.kind !== "dispatch") {
    throw new Error("the box's dispatch didn't parse as one");
  }
  await host.handlers.dispatch(dispatch);
  for (const run of host.running()) {
    await run.done;
  }
  await connection.stop();
  bridge.close();
  logger.info("the box's task is over");
  return exitCodes.ok;
};
