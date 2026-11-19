import { randomBytes } from "node:crypto";
import type { ServiceHealth } from "@ostra/adapter-sdk";
import type { BoxId, BoxState, LeaseEpoch, SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";
import { emptySchema } from "./engine.ts";
import type { Engine, EngineResult } from "./engine.ts";

// A box on Docker (ADR 0029): what the pool runner creates for a task, and removes after.
//
//   ostra-box-<boxId>        a private network, `internal`: no route out at all
//   ostra-box-<boxId>-task   the task volume, at /task in both containers
//   agent                    the environment's base image, the box's init as root under tini,
//                            which starts every process as the agent's user (1000); only the box
//                            network; no credential in its spec (ADR 0030)
//   sidecar                  the runner image running `ostra sidecar` as 1000: the credentials,
//                            both proxies, the MCP tools and the ACP driver; on the box network as
//                            `sidecar`, and on the shared egress network, which has inter-container
//                            traffic off, so one box's sidecar can't reach another's; its own state
//                            (applied commands, the event spool) is on a tmpfs only it mounts, never
//                            on the task volume, where the agent could rewrite it
//
// The sidecar shares the agent's uid: they write the same checkouts on the task volume, and a
// second uid there would break git's ownership check and the files' modes. Separate containers,
// and mounts only the sidecar has (its state, its token file), are what keep the agent out.
//
// The egress baseline (no private ranges, no metadata address, no other box) is host rules on the
// egress network (`egress.ts`), unverified until the live run on Linux.
//
// Milestone 3 (ticket 14):
//
//   svc-<name>               each of the environment's services (F-094): its image, on the box network
//                            only, by its name, with its variables, Docker's health check when it has
//                            one; started before the agent, removed with the box
//
// A box from a snapshot (F-051, Q153) starts the agent's container from the snapshot image, and makes
// it before the sidecar: Docker fills a new, empty volume from the first container that mounts it, so
// the task volume starts with the snapshot's checkouts, and no mount hides them.

export const BRIDGE_PORT = 7101;
export const TASK_ROOT = "/task";
export const AGENT_UID = 1000;
/** The sidecar's uid and gid: the agent's, for the task volume they share (see above). */
export const SIDECAR_UID = AGENT_UID;
export const SIDECAR_GID = AGENT_UID;
/** The sidecar's own state: a tmpfs in its container only (never the task volume). */
export const SIDECAR_DATA_DIR = "/var/lib/ostra-sidecar";
/** Holds the spool's whole quota (the protocol's `spoolQuotaBytes`, 1 GiB) and the state file. */
const SIDECAR_DATA_SIZE = "1280m";
/** The shared network every sidecar reaches the server and the code host through. */
export const DEFAULT_EGRESS_NETWORK = "ostra-egress";
const LABEL = "ostra.box";

export type BoxImages = {
  /** ostra's base image, for an environment that names none (ADR 0038). */
  readonly base: string;
  /** The runner image: the `ostra` CLI, which is also the sidecar. */
  readonly runner: string;
};

export type BoxInput = {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly boxId: BoxId;
  readonly leaseEpoch: LeaseEpoch;
  /** Core's address as the sidecar reaches it. */
  readonly serverUrl: string;
  /** The environment's base image, or `null` for ostra's own. */
  readonly baseImage: string | null;
  /** A host folder holding the sidecar's token file, mounted read-only (never into the agent's container). */
  readonly tokenDir: string;
  /**
   * The group that owns the token file when the runner couldn't give it to the sidecar's uid (it
   * isn't root): added to the sidecar's supplementary groups so it can read the file.
   */
  readonly tokenGroup?: number;
  /** Milestone 3 (F-051): the snapshot image this host keeps, which the agent's container starts from. */
  readonly snapshotImage?: string;
  /** Milestone 3 (F-094): the environment's services, each with its variables, secrets included. */
  readonly services?: readonly BoxService[];
};

/** A service as a box starts it: the spec's, with its secret variables from the credentials. */
export type BoxService = {
  readonly name: string;
  readonly image: string;
  readonly port: number | null;
  /** Plain and secret together: only the service's own container gets them. Never logged. */
  readonly variables: readonly { readonly name: string; readonly value: string }[];
  readonly healthCheck: string | null;
};

/** How long a box waits for its services to be healthy (F-094, working value). */
export const SERVICES_HEALTHY_WITHIN_MS = 120_000;

export type BoxOptions = {
  readonly images: BoxImages;
  readonly egressNetwork?: string;
  /** An optional container runtime, such as gVisor's `runsc` (ADR 0031). */
  readonly runtime?: string;
};

export type ContainerSpec = {
  readonly name: string;
  readonly body: {
    readonly Image: string;
    readonly Cmd: readonly string[];
    readonly Env: readonly string[];
    readonly User: string;
    readonly WorkingDir: string;
    readonly Labels: Readonly<Record<string, string>>;
    readonly HostConfig: Readonly<Record<string, unknown>>;
    readonly NetworkingConfig: Readonly<Record<string, unknown>>;
    /** Docker's health check, for a service that names one. */
    readonly Healthcheck?: Readonly<Record<string, unknown>>;
  };
};

export type BoxResources = {
  readonly network: { readonly Name: string; readonly Driver: "bridge"; readonly Internal: true; readonly Labels: Readonly<Record<string, string>> };
  readonly volume: { readonly Name: string; readonly Labels: Readonly<Record<string, string>> };
  readonly agent: ContainerSpec;
  readonly sidecar: ContainerSpec;
  /** Milestone 3: the services' containers, in the environment's order. */
  readonly services: readonly ContainerSpec[];
  readonly egressNetwork: string;
  /** The box's one-time bridge nonce: in the init's and the sidecar's environment only. */
  readonly bridgeNonce: string;
};

const names = (boxId: BoxId) =>
  ({
    network: `ostra-box-${boxId}`,
    volume: `ostra-box-${boxId}-task`,
    agent: `ostra-box-${boxId}-agent`,
    sidecar: `ostra-box-${boxId}-sidecar`,
    service: (name: string) => `ostra-box-${boxId}-svc-${name}`,
  }) as const;

/** Everything a box gets, as the Engine API's create bodies. Pure: the unit tests read it. */
export const boxResources = (input: BoxInput, options: BoxOptions, nonce = randomBytes(32).toString("base64url")): BoxResources => {
  const n = names(input.boxId);
  const labels = (role: string): Record<string, string> => ({ [LABEL]: input.boxId, "ostra.task": input.taskId, "ostra.role": role });
  const hardening = {
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    PidsLimit: 4096,
    ...(options.runtime === undefined ? {} : { Runtime: options.runtime }),
  };
  const taskMount = { Type: "volume", Source: n.volume, Target: TASK_ROOT };
  const services = (input.services ?? []).map(
    (service): ContainerSpec => ({
      name: n.service(service.name),
      body: {
        Image: service.image,
        // The image's own command and user: a database's entrypoint drops to its own user.
        Cmd: [],
        Env: service.variables.map((variable) => `${variable.name}=${variable.value}`),
        User: "",
        WorkingDir: "",
        Labels: { ...labels("service"), "ostra.service": service.name },
        HostConfig: {
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 4096,
          ...(options.runtime === undefined ? {} : { Runtime: options.runtime }),
          // The box's network only, which is internal: the egress baseline holds for services too.
          NetworkMode: n.network,
        },
        NetworkingConfig: { EndpointsConfig: { [n.network]: { Aliases: [service.name] } } },
        ...(service.healthCheck === null
          ? {}
          : {
              // Docker runs it in the service's container; nanoseconds, as the Engine API reads them.
              Healthcheck: { Test: ["CMD-SHELL", service.healthCheck], Interval: 2_000_000_000, Timeout: 5_000_000_000, Retries: 60, StartPeriod: 0 },
            }),
      },
    }),
  );
  return {
    services,
    network: { Name: n.network, Driver: "bridge", Internal: true, Labels: labels("network") },
    volume: { Name: n.volume, Labels: labels("volume") },
    egressNetwork: options.egressNetwork ?? DEFAULT_EGRESS_NETWORK,
    bridgeNonce: nonce,
    agent: {
      name: n.agent,
      body: {
        Image: input.snapshotImage ?? input.baseImage ?? options.images.base,
        Cmd: ["node", "/opt/ostra/init/main.ts"],
        // The init's own: the box, the nonce and where the sidecar is. Never a credential.
        Env: [
          `OSTRA_BOX_ID=${input.boxId}`,
          `OSTRA_BRIDGE_NONCE=${nonce}`,
          `OSTRA_BRIDGE_ADDR=sidecar:${String(BRIDGE_PORT)}`,
          `OSTRA_AGENT_UID=${String(AGENT_UID)}`,
          `OSTRA_AGENT_GID=${String(AGENT_UID)}`,
        ],
        // The init is root to start processes as the agent's user; those are never root.
        User: "0:0",
        WorkingDir: TASK_ROOT,
        Labels: { ...labels("agent"), ...(input.snapshotImage === undefined ? {} : { "ostra.snapshot-image": input.snapshotImage }) },
        HostConfig: {
          ...hardening,
          Init: true,
          CapAdd: ["SETUID", "SETGID", "KILL"],
          NetworkMode: n.network,
          Mounts: [taskMount],
        },
        NetworkingConfig: { EndpointsConfig: { [n.network]: { Aliases: ["agent"] } } },
      },
    },
    sidecar: {
      name: n.sidecar,
      body: {
        Image: options.images.runner,
        Cmd: ["sidecar"],
        Env: [
          `OSTRA_SERVER_URL=${input.serverUrl}`,
          "OSTRA_SIDECAR_TOKEN_FILE=/run/ostra/token",
          `OSTRA_TASK_ID=${input.taskId}`,
          `OSTRA_SESSION_ID=${input.sessionId}`,
          `OSTRA_BOX_ID=${input.boxId}`,
          `OSTRA_LEASE_EPOCH=${String(input.leaseEpoch)}`,
          `OSTRA_BRIDGE_NONCE=${nonce}`,
          `OSTRA_BRIDGE_PORT=${String(BRIDGE_PORT)}`,
          "OSTRA_SIDECAR_HOST=sidecar",
          `OSTRA_TASK_ROOT=${TASK_ROOT}`,
          `OSTRA_SIDECAR_DATA_DIR=${SIDECAR_DATA_DIR}`,
        ],
        User: `${String(SIDECAR_UID)}:${String(SIDECAR_GID)}`,
        WorkingDir: TASK_ROOT,
        Labels: labels("sidecar"),
        HostConfig: {
          ...hardening,
          ReadonlyRootfs: true,
          Tmpfs: {
            "/tmp": "rw,noexec,nosuid,size=256m",
            [SIDECAR_DATA_DIR]: `rw,noexec,nosuid,uid=${String(SIDECAR_UID)},gid=${String(SIDECAR_GID)},mode=0700,size=${SIDECAR_DATA_SIZE}`,
          },
          ...(input.tokenGroup === undefined ? {} : { GroupAdd: [String(input.tokenGroup)] }),
          // Core on this host, through its published port (the compose file's layout).
          ExtraHosts: ["host.docker.internal:host-gateway"],
          NetworkMode: n.network,
          Mounts: [taskMount, { Type: "bind", Source: input.tokenDir, Target: "/run/ostra", ReadOnly: true }],
        },
        NetworkingConfig: { EndpointsConfig: { [n.network]: { Aliases: ["sidecar"] } } },
      },
    },
  };
};

const createdSchema = z.looseObject({ Id: z.string().min(1) });
const listedSchema = z.array(z.looseObject({ Id: z.string(), Labels: z.record(z.string(), z.string()).nullish(), State: z.string().optional() }));
const inspectSchema = z.looseObject({ State: z.looseObject({ Status: z.string(), Running: z.boolean() }) });
const networksSchema = z.array(z.looseObject({ Id: z.string(), Name: z.string() }));
const exitSchema = z.looseObject({ State: z.looseObject({ Status: z.string(), Running: z.boolean(), ExitCode: z.number().int().optional() }) });
const healthSchema = z.looseObject({
  State: z.looseObject({ Status: z.string(), Running: z.boolean(), ExitCode: z.number().int().optional(), Health: z.looseObject({ Status: z.string() }).nullish() }),
});

/** The port probe, run by `node -e` in the sidecar with the host and port as arguments: never built from them. */
const PORT_PROBE =
  "const [host, port] = process.argv.slice(1); const socket = require('node:net').connect(Number(port), host); socket.on('connect', () => process.exit(0)); socket.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 2000);";
/** How often the runner looks at a box's sidecar while the task runs. */
export const WAIT_POLL_MS = 2_000;

export type CreatedDockerBox = { readonly agentId: string; readonly sidecarId: string; readonly resources: BoxResources };

export type DockerBoxes = {
  /** Can the runner use the Engine here (`docker version` answers)? */
  readonly ping: () => Promise<boolean>;
  readonly createBox: (input: BoxInput) => Promise<EngineResult<CreatedDockerBox>>;
  /**
   * Milestone 3 (F-094): each service's health, in order, once each is healthy or failed, or the
   * time is up: Docker's health check, or the port reached from the box's sidecar.
   */
  readonly waitForServices: (
    boxId: BoxId,
    services: readonly Pick<BoxService, "name" | "port" | "healthCheck">[],
    options?: { readonly timeoutMs?: number; readonly pollMs?: number },
  ) => Promise<readonly ServiceHealth[]>;
  /** The box's state, from its sidecar's: no containers is `released`. */
  readonly boxState: (boxId: BoxId) => Promise<BoxState>;
  /** Resolves with the sidecar's exit code once it exits (the task is over). */
  readonly waitForSidecar: (boxId: BoxId) => Promise<number | null>;
  readonly stopBox: (boxId: BoxId) => Promise<void>;
  /** Removes the box's containers, network and volume. A box is never reused. */
  readonly removeBox: (boxId: BoxId) => Promise<EngineResult<void>>;
};

const labelFilter = (boxId: BoxId): string => encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${boxId}`] }));

export const createDockerBoxes = (engine: Engine, options: BoxOptions): DockerBoxes => {
  const containersOf = async (boxId: BoxId): Promise<z.infer<typeof listedSchema>> => {
    const listed = await engine.call("GET", `/containers/json?all=true&filters=${labelFilter(boxId)}`, listedSchema);
    return listed.ok ? listed.value : [];
  };
  const roleOf = (container: z.infer<typeof listedSchema>[number]): string | undefined => container.Labels?.["ostra.role"];

  const networkExists = async (name: string): Promise<boolean> => {
    const existing = await engine.call("GET", `/networks?filters=${encodeURIComponent(JSON.stringify({ name: [name] }))}`, networksSchema);
    return existing.ok && existing.value.some((network) => network.Name === name);
  };

  const ensureEgressNetwork = async (name: string): Promise<EngineResult<void>> => {
    if (await networkExists(name)) {
      return { ok: true, value: undefined };
    }
    const created = await engine.call("POST", "/networks/create", createdSchema, {
      Name: name,
      Driver: "bridge",
      // One box's sidecar can't reach another's (the egress baseline, F-116).
      Options: { "com.docker.network.bridge.enable_icc": "false" },
      Labels: { "ostra.role": "egress" },
    });
    return created.ok ? { ok: true, value: undefined } : created;
  };

  const removeBox = async (boxId: BoxId): Promise<EngineResult<void>> => {
    const n = names(boxId);
    for (const container of await containersOf(boxId)) {
      const removed = await engine.call("DELETE", `/containers/${container.Id}?force=true&v=true`, emptySchema);
      if (!removed.ok && removed.error.status !== 404) {
        return removed;
      }
    }
    for (const [path, wanted] of [[`/networks/${n.network}`, "network"], [`/volumes/${n.volume}`, "volume"]] as const) {
      const removed = await engine.call("DELETE", path, emptySchema);
      if (!removed.ok && removed.error.status !== 404) {
        return { ok: false, error: { status: removed.error.status, message: `removing the box's ${wanted} failed: ${removed.error.message}` } };
      }
    }
    return { ok: true, value: undefined };
  };

  return {
    ping: async () => (await engine.call("GET", "/_ping", z.unknown())).ok,
    createBox: async (input) => {
      const resources = boxResources(input, options);
      const fail = async (error: { readonly status: number; readonly message: string }): Promise<EngineResult<CreatedDockerBox>> => {
        await removeBox(input.boxId);
        return { ok: false, error };
      };
      // A box is made once and serves one task (F-017): a box ID in use is refused, and the box
      // that holds it is left as it is. The clean-up after a failed create would remove it.
      if ((await containersOf(input.boxId)).length > 0 || (await networkExists(resources.network.Name))) {
        return { ok: false, error: { status: 409, message: "the box exists already" } };
      }
      const egress = await ensureEgressNetwork(resources.egressNetwork);
      if (!egress.ok) {
        return fail(egress.error);
      }
      const network = await engine.call("POST", "/networks/create", createdSchema, resources.network);
      if (!network.ok) {
        return fail(network.error);
      }
      const volume = await engine.call("POST", "/volumes/create", z.unknown(), resources.volume);
      if (!volume.ok) {
        return fail(volume.error);
      }
      // The services first: the agent may reach for them as soon as it starts (F-094).
      for (const service of resources.services) {
        const made = await engine.call("POST", `/containers/create?name=${service.name}`, createdSchema, service.body);
        if (!made.ok) {
          return fail(made.error);
        }
        const started = await engine.call("POST", `/containers/${made.value.Id}/start`, emptySchema);
        if (!started.ok) {
          return fail(started.error);
        }
      }
      // The first container made with the new volume fills it from its image: the sidecar's /task,
      // owned by the agent's user, or, for a box from a snapshot, the snapshot's checkouts (Q153).
      const makeSidecar = () => engine.call("POST", `/containers/create?name=${resources.sidecar.name}`, createdSchema, resources.sidecar.body);
      const makeAgent = () => engine.call("POST", `/containers/create?name=${resources.agent.name}`, createdSchema, resources.agent.body);
      const fromSnapshot = input.snapshotImage !== undefined;
      const first = await (fromSnapshot ? makeAgent() : makeSidecar());
      if (!first.ok) {
        return fail(first.error);
      }
      const second = await (fromSnapshot ? makeSidecar() : makeAgent());
      if (!second.ok) {
        return fail(second.error);
      }
      const [sidecar, agent] = fromSnapshot ? [second, first] : [first, second];
      const connected = await engine.call("POST", `/networks/${resources.egressNetwork}/connect`, emptySchema, { Container: sidecar.value.Id });
      if (!connected.ok) {
        return fail(connected.error);
      }
      for (const id of [sidecar.value.Id, agent.value.Id]) {
        const started = await engine.call("POST", `/containers/${id}/start`, emptySchema);
        if (!started.ok) {
          return fail(started.error);
        }
      }
      return { ok: true, value: { agentId: agent.value.Id, sidecarId: sidecar.value.Id, resources } };
    },
    waitForServices: async (boxId, services, waitOptions = {}) => {
      const timeoutMs = waitOptions.timeoutMs ?? SERVICES_HEALTHY_WITHIN_MS;
      const pollMs = waitOptions.pollMs ?? 1_000;
      const started = Date.now();
      const results = new Map<string, ServiceHealth>();
      for (;;) {
        const containers = await containersOf(boxId);
        const sidecar = containers.find((container) => roleOf(container) === "sidecar");
        for (const service of services) {
          if (results.has(service.name)) {
            continue;
          }
          const container = containers.find((each) => roleOf(each) === "service" && each.Labels?.["ostra.service"] === service.name);
          if (container === undefined) {
            results.set(service.name, { name: service.name, outcome: "failed", reason: "The service's container is gone." });
            continue;
          }
          const inspected = await engine.call("GET", `/containers/${container.Id}/json`, healthSchema);
          if (!inspected.ok) {
            continue;
          }
          const state = inspected.value.State;
          if (!state.Running && state.Status !== "created") {
            results.set(service.name, { name: service.name, outcome: "failed", reason: `The service's container exited (exit ${String(state.ExitCode ?? "unknown")}) before it was healthy.` });
            continue;
          }
          const healthy = (): void => {
            results.set(service.name, { name: service.name, outcome: "healthy", afterMs: Date.now() - started });
          };
          if (service.healthCheck !== null) {
            if (state.Health?.Status === "healthy") {
              healthy();
            } else if (state.Health?.Status === "unhealthy") {
              results.set(service.name, { name: service.name, outcome: "failed", reason: "The service's health check kept failing." });
            }
            continue;
          }
          if (service.port === null) {
            if (state.Running) {
              healthy();
            }
            continue;
          }
          // The port, from the box's sidecar, which is on the box's network as the agent is.
          if (sidecar !== undefined) {
            const probed = await engine.exec(sidecar.Id, ["node", "-e", PORT_PROBE, service.name, String(service.port)], `${String(SIDECAR_UID)}:${String(SIDECAR_GID)}`);
            if (probed.ok && probed.value.exitCode === 0) {
              healthy();
            }
          }
        }
        if (results.size === services.length) {
          break;
        }
        if (Date.now() - started >= timeoutMs) {
          for (const service of services) {
            if (!results.has(service.name)) {
              results.set(service.name, { name: service.name, outcome: "failed", reason: `The service wasn't healthy within ${String(Math.ceil(timeoutMs / 1000))} s.` });
            }
          }
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return services.flatMap((service) => {
        const result = results.get(service.name);
        return result === undefined ? [] : [result];
      });
    },
    boxState: async (boxId) => {
      const containers = await containersOf(boxId);
      const sidecar = containers.find((container) => roleOf(container) === "sidecar");
      if (sidecar === undefined) {
        return containers.length === 0 ? "released" : "failed";
      }
      const inspected = await engine.call("GET", `/containers/${sidecar.Id}/json`, inspectSchema);
      if (!inspected.ok) {
        return "failed";
      }
      if (inspected.value.State.Running) {
        return "ready";
      }
      return inspected.value.State.Status === "created" ? "creating" : "stopped";
    },
    waitForSidecar: async (boxId) => {
      // Polled, not `/wait`: a task runs for hours, past any one call's timeout.
      for (;;) {
        const sidecar = (await containersOf(boxId)).find((container) => roleOf(container) === "sidecar");
        if (sidecar === undefined) {
          return null;
        }
        const inspected = await engine.call("GET", `/containers/${sidecar.Id}/json`, exitSchema);
        if (!inspected.ok) {
          return null;
        }
        if (!inspected.value.State.Running && inspected.value.State.Status !== "created") {
          return inspected.value.State.ExitCode ?? null;
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
      }
    },
    stopBox: async (boxId) => {
      for (const container of await containersOf(boxId)) {
        await engine.call("POST", `/containers/${container.Id}/stop?t=10`, emptySchema);
      }
    },
    removeBox,
  };
};
