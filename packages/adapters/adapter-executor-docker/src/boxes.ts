import { randomBytes } from "node:crypto";
import type { BoxImage, BoxSize, ExecutorCapacity, ServiceHealth } from "@ostra/adapter-sdk";
import { DEFAULT_BOX_SUBNET_POOL } from "@ostra/protocol";
import type { BoxId, BoxState, DispatchPurpose, LeaseEpoch, SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";
import { BRIDGE_FEATURES } from "./bridge/protocol.ts";
import { emptySchema } from "./engine.ts";
import type { Engine, EngineResult } from "./engine.ts";
import { freeSubnet, parsePool } from "./subnet-pool.ts";

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
//
// Milestone 5 (ticket 09, ADR 0059, ADR 0060):
//
// - **Sizes** (F-095): the agent's container gets the box's size as `NanoCpus` and `Memory`, with
//   `MemorySwap` equal to `Memory` (no swap past the limit) and a `PidsLimit`; the sidecar and each
//   service get their own fixed limits (`OSTRA_SIDECAR_*`, `OSTRA_SERVICE_*`), which the box's
//   footprint counts beside the size.
// - **Registry images** (F-120): a box whose dispatch names an image pulls `ref@digest` before
//   anything of the box is made, with the pull credential in the Engine call's header only, and the
//   agent's container runs exactly that digest. With no registry, milestone 3's local snapshot.
// - **Capacity** (ADR 0059): the runner's whole offer, the engine's CPUs and memory less its
//   reserve, and its slots; core subtracts the boxes it placed, from its own rows.
//
// F-017 (ADR 0029, Q154): the box network's subnet is a /24 of the runner's own pool
// (`OSTRA_BOX_SUBNET_POOL`, `subnet-pool.ts`), never one of Docker's default pools, which hold about
// 31 networks. The runner makes one box's networks at a time, so two boxes made at once never pick
// the same /24; a /24 another runner on the Engine takes in between is refused (403) and the next
// free one tried.

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
  /** Milestone 5 (F-095): the project's box size, the agent's container's limits. Absent or `null`: none. */
  readonly size?: BoxSize | null;
  /**
   * Milestone 5 (F-120): the registry image the agent's container starts from, pulled by digest with
   * its pull credential, which goes to the Engine's pull call and nowhere else. Wins over `snapshotImage`.
   */
  readonly image?: BoxImage | null;
  /**
   * Milestone 8 (Q300, ticket 12): the dispatch's purpose, for the sidecar, which starts the task
   * itself: `app` starts the box and its app with no agent until a member's message. Absent: a turn.
   */
  readonly purpose?: DispatchPurpose;
};

/** A container's CPU and memory limits. */
export type Resources = { readonly cpuMillis: number; readonly memoryMiB: number };

/** The fixed limits beside the agent's container (ADR 0059): the runner's settings. */
export type FixedLimits = {
  /** `OSTRA_SIDECAR_CPU_MILLIS`, `OSTRA_SIDECAR_MEMORY_MIB`. */
  readonly sidecar: Resources;
  /** `OSTRA_SERVICE_CPU_MILLIS`, `OSTRA_SERVICE_MEMORY_MIB`. */
  readonly service: Resources;
};

/** ADR 0059's working values, the settings' defaults: the sidecar 1 vCPU and 256 MiB, a service 1 vCPU and 1 GiB. */
export const DEFAULT_FIXED_LIMITS: FixedLimits = {
  sidecar: { cpuMillis: 1000, memoryMiB: 256 },
  service: { cpuMillis: 1000, memoryMiB: 1024 },
};

/** Every box container's process cap: a fork bomb stays in its container. */
export const BOX_PIDS_LIMIT = 4096;

const MIB = 1024 * 1024;

/** A limit as the Engine API takes it: nano-CPUs, bytes, and swap equal to memory, so no swap past the limit. */
export const limitsHostConfig = (resources: Resources): { readonly NanoCpus: number; readonly Memory: number; readonly MemorySwap: number } => ({
  NanoCpus: resources.cpuMillis * 1_000_000,
  Memory: resources.memoryMiB * MIB,
  MemorySwap: resources.memoryMiB * MIB,
});

/** The settings a `docker` runner's offer comes from (ADR 0059). */
export type CapacitySettings = {
  /** `OSTRA_RUNNER_SLOTS`; absent: the host's CPUs / 2, at least 1. */
  readonly slots?: number;
  /** `OSTRA_RUNNER_RESERVE_CPU_MILLIS`, 1000 by default. */
  readonly reserveCpuMillis: number;
  /** `OSTRA_RUNNER_RESERVE_MEMORY_MIB`, 2048 by default. */
  readonly reserveMemoryMiB: number;
};

/** The engine's `info`, the two fields the offer reads. */
export type EngineInfo = { readonly cpus: number; readonly memoryBytes: number };

/** The runner's whole offer (ADR 0059): its slots, and the engine's CPU and memory less its reserve, never below 0. */
export const dockerCapacity = (info: EngineInfo, settings: CapacitySettings): ExecutorCapacity => ({
  slots: settings.slots ?? Math.max(1, Math.floor(info.cpus / 2)),
  cpuMillis: Math.max(0, info.cpus * 1000 - settings.reserveCpuMillis),
  memoryMiB: Math.max(0, Math.floor(info.memoryBytes / MIB) - settings.reserveMemoryMiB),
});

/** A container's limits, as `docker inspect` reads them back: `null` parts are unset. */
export type InspectedLimits = {
  readonly role: string;
  readonly name: string;
  readonly cpuMillis: number | null;
  readonly memoryMiB: number | null;
  /** Memory and swap together, as the Engine keeps it: equal to `memoryMiB` when no swap is allowed. */
  readonly memorySwapMiB: number | null;
  readonly pidsLimit: number | null;
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
  /** Milestone 5 (F-095): the sidecar's and a service's fixed limits. Default: `DEFAULT_FIXED_LIMITS`. */
  readonly limits?: FixedLimits;
  /** The runner's `OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES`, for the sidecar, which runs the task. Absent: the sidecar's default. */
  readonly subagentWaitMinutes?: number;
  /** F-017: `OSTRA_BOX_SUBNET_POOL`, the IPv4 network each box's network is a /24 of. Default: `DEFAULT_BOX_SUBNET_POOL`. */
  readonly subnetPool?: string;
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
    PidsLimit: BOX_PIDS_LIMIT,
    ...(options.runtime === undefined ? {} : { Runtime: options.runtime }),
  };
  const fixed = options.limits ?? DEFAULT_FIXED_LIMITS;
  const size = input.size ?? null;
  const image = input.image ?? null;
  // The registry's image by its digest, then the host's own snapshot, then the environment's base.
  const agentImage = image === null ? (input.snapshotImage ?? input.baseImage ?? options.images.base) : `${image.ref}@${image.digest}`;
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
          PidsLimit: BOX_PIDS_LIMIT,
          ...limitsHostConfig(fixed.service),
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
        Image: agentImage,
        Cmd: ["node", "/opt/ostra/init/main.ts"],
        // The init's own: the box, the nonce and where the sidecar is. Never a credential.
        Env: [
          `OSTRA_BOX_ID=${input.boxId}`,
          `OSTRA_BRIDGE_NONCE=${nonce}`,
          `OSTRA_BRIDGE_ADDR=sidecar:${String(BRIDGE_PORT)}`,
          `OSTRA_AGENT_UID=${String(AGENT_UID)}`,
          `OSTRA_AGENT_GID=${String(AGENT_UID)}`,
          // Milestone 8: the bridge features this sidecar reads, which the init announces back.
          `OSTRA_BRIDGE_FEATURES=${BRIDGE_FEATURES.join(",")}`,
        ],
        // The init is root to start processes as the agent's user; those are never root.
        User: "0:0",
        WorkingDir: TASK_ROOT,
        Labels: {
          ...labels("agent"),
          ...(input.snapshotImage === undefined || image !== null ? {} : { "ostra.snapshot-image": input.snapshotImage }),
          ...(image === null ? {} : { "ostra.image-digest": image.digest }),
        },
        HostConfig: {
          ...hardening,
          // The box's size, when it has one (F-095); otherwise only the executor's own caps.
          ...(size === null ? {} : limitsHostConfig(size)),
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
          ...(options.subagentWaitMinutes === undefined ? [] : [`OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES=${String(options.subagentWaitMinutes)}`]),
          // Milestone 8 (ticket 12): "Start the app"'s dispatch, which the sidecar starts itself.
          ...(input.purpose === undefined || input.purpose === "turn" ? [] : [`OSTRA_DISPATCH_PURPOSE=${input.purpose}`]),
        ],
        User: `${String(SIDECAR_UID)}:${String(SIDECAR_GID)}`,
        WorkingDir: TASK_ROOT,
        Labels: labels("sidecar"),
        HostConfig: {
          ...hardening,
          ...limitsHostConfig(fixed.sidecar),
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

export type CreatedDockerBox = {
  readonly agentId: string;
  readonly sidecarId: string;
  readonly resources: BoxResources;
  /** F-017: the box network's subnet, a /24 of the runner's pool. */
  readonly subnet: string;
};

/** How many free /24s a box tries when other runners on the Engine keep taking the one it picked. */
const CARVE_ATTEMPTS = 5;
/** The networks' subnets, as the Engine lists them: a vendor's format, read loosely. */
const networkSubnetsSchema = z.array(
  z.looseObject({ Name: z.string(), IPAM: z.looseObject({ Config: z.array(z.looseObject({ Subnet: z.string().optional() })).nullish() }).nullish() }),
);

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
  /** Milestone 5 (F-095): each of the box's containers' limits, read back from the Engine (`docker inspect`). */
  readonly limitsOf: (boxId: BoxId) => Promise<readonly InspectedLimits[]>;
  /** Milestone 5 (ADR 0059): the runner's whole offer, from the Engine's `info`; `null` when the Engine doesn't answer. */
  readonly readCapacity: (settings: CapacitySettings) => Promise<ExecutorCapacity | null>;
};

const infoSchema = z.looseObject({ NCPU: z.number().int().nonnegative(), MemTotal: z.number().int().nonnegative() });
const limitsInspectSchema = z.looseObject({
  Name: z.string().optional(),
  HostConfig: z
    .looseObject({
      NanoCpus: z.number().nullish(),
      Memory: z.number().nullish(),
      MemorySwap: z.number().nullish(),
      PidsLimit: z.number().nullish(),
    })
    .nullish(),
});
/** A positive number from `docker inspect`, or `null` for unset (0, absent, or -1 for unlimited). */
const setOrNull = (value: number | null | undefined, unit: number): number | null => (value === null || value === undefined || value <= 0 ? null : value / unit);

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
    // 409: another runner on this Engine made it since the look.
    return created.ok || created.error.status === 409 ? { ok: true, value: undefined } : created;
  };

  /** The box network, on a free /24 of the pool: Docker is told the subnet, and never picks one. */
  const carveBoxNetwork = async (network: BoxResources["network"]): Promise<EngineResult<string>> => {
    const poolText = options.subnetPool ?? DEFAULT_BOX_SUBNET_POOL;
    const pool = parsePool(poolText);
    if (pool === null) {
      return { ok: false, error: { status: 400, message: `the box subnet pool ${poolText} isn't an IPv4 network of /8 to /24` } };
    }
    for (let attempt = 0; attempt < CARVE_ATTEMPTS; attempt += 1) {
      // Every network on the host, a box's or anything else's: none of their subnets is taken twice.
      const listed = await engine.call("GET", "/networks", networkSubnetsSchema);
      if (!listed.ok) {
        return listed;
      }
      const taken = listed.value.flatMap((each) => (each.IPAM?.Config ?? []).flatMap((config) => (config.Subnet === undefined ? [] : [config.Subnet])));
      const subnet = freeSubnet(pool, taken);
      if (subnet === null) {
        return { ok: false, error: { status: 503, message: `the box subnet pool ${poolText} has no free /24 left` } };
      }
      const created = await engine.call("POST", "/networks/create", createdSchema, { ...network, IPAM: { Driver: "default", Config: [{ Subnet: subnet }] } });
      if (created.ok) {
        return { ok: true, value: subnet };
      }
      // 403 is Docker's "Pool overlaps with other one on this address space": taken since the listing.
      if (created.error.status !== 403) {
        return created;
      }
    }
    return { ok: false, error: { status: 409, message: `the box subnet pool's free /24s kept being taken by other networks (${String(CARVE_ATTEMPTS)} tries)` } };
  };

  /** One box's networks at a time in this runner, so two boxes made at once never pick the same /24. */
  let networking: Promise<unknown> = Promise.resolve();
  const makeNetworks = (resources: BoxResources): Promise<EngineResult<string>> => {
    const made = networking.then(async (): Promise<EngineResult<string>> => {
      const egress = await ensureEgressNetwork(resources.egressNetwork);
      return egress.ok ? carveBoxNetwork(resources.network) : egress;
    });
    networking = made.catch(() => undefined);
    return made;
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
      // Milestone 5 (F-120): the registry's image by digest, before anything of the box is made, so
      // a refused pull leaves nothing. The credential is the call's header, for this one pull.
      const image = input.image ?? null;
      if (image !== null) {
        const pulled = await engine.pull(image.ref, image.digest, image.pull);
        if (!pulled.ok) {
          return { ok: false, error: { status: pulled.error.status, message: `pulling the box's image failed: ${pulled.error.message}` } };
        }
      }
      // The shared egress network once, then the box's own network on a /24 of the runner's pool.
      const network = await makeNetworks(resources);
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
      const fromSnapshot = input.snapshotImage !== undefined || (input.image ?? null) !== null;
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
      return { ok: true, value: { agentId: agent.value.Id, sidecarId: sidecar.value.Id, resources, subnet: network.value } };
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
    limitsOf: async (boxId) => {
      const found: InspectedLimits[] = [];
      for (const container of await containersOf(boxId)) {
        const inspected = await engine.call("GET", `/containers/${container.Id}/json`, limitsInspectSchema);
        if (!inspected.ok) {
          continue;
        }
        const host = inspected.value.HostConfig;
        found.push({
          role: roleOf(container) ?? "unknown",
          name: (inspected.value.Name ?? container.Id).replace(/^\//, ""),
          cpuMillis: setOrNull(host?.NanoCpus, 1_000_000),
          memoryMiB: setOrNull(host?.Memory, MIB),
          memorySwapMiB: setOrNull(host?.MemorySwap, MIB),
          pidsLimit: setOrNull(host?.PidsLimit, 1),
        });
      }
      return found;
    },
    readCapacity: async (settings) => {
      const info = await engine.call("GET", "/info", infoSchema);
      return info.ok ? dockerCapacity({ cpus: info.value.NCPU, memoryBytes: info.value.MemTotal }, settings) : null;
    },
  };
};
