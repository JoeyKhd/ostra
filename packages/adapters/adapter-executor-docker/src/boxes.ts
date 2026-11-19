import { randomBytes } from "node:crypto";
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
};

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
  };
};

export type BoxResources = {
  readonly network: { readonly Name: string; readonly Driver: "bridge"; readonly Internal: true; readonly Labels: Readonly<Record<string, string>> };
  readonly volume: { readonly Name: string; readonly Labels: Readonly<Record<string, string>> };
  readonly agent: ContainerSpec;
  readonly sidecar: ContainerSpec;
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
  return {
    network: { Name: n.network, Driver: "bridge", Internal: true, Labels: labels("network") },
    volume: { Name: n.volume, Labels: labels("volume") },
    egressNetwork: options.egressNetwork ?? DEFAULT_EGRESS_NETWORK,
    bridgeNonce: nonce,
    agent: {
      name: n.agent,
      body: {
        Image: input.baseImage ?? options.images.base,
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
        Labels: labels("agent"),
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
/** How often the runner looks at a box's sidecar while the task runs. */
export const WAIT_POLL_MS = 2_000;

export type CreatedDockerBox = { readonly agentId: string; readonly sidecarId: string; readonly resources: BoxResources };

export type DockerBoxes = {
  /** Can the runner use the Engine here (`docker version` answers)? */
  readonly ping: () => Promise<boolean>;
  readonly createBox: (input: BoxInput) => Promise<EngineResult<CreatedDockerBox>>;
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
      // The sidecar first: its image's /task, owned by the agent's user, seeds the new volume.
      const sidecar = await engine.call("POST", `/containers/create?name=${resources.sidecar.name}`, createdSchema, resources.sidecar.body);
      if (!sidecar.ok) {
        return fail(sidecar.error);
      }
      const agent = await engine.call("POST", `/containers/create?name=${resources.agent.name}`, createdSchema, resources.agent.body);
      if (!agent.ok) {
        return fail(agent.error);
      }
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
