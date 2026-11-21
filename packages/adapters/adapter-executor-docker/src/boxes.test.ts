import { boxIdSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { boxResources, createDockerBoxes, SIDECAR_DATA_DIR, TASK_ROOT } from "./boxes.ts";
import type { BoxInput, DockerBoxes } from "./boxes.ts";
import { createEngine, engineAddressFrom } from "./engine.ts";
import { startFakeEngine } from "./testing/fake-engine.ts";
import type { FakeEngine } from "./testing/fake-engine.ts";

// Ticket 22's unit tests, against a fake Engine API: the containers, network, mounts, users and
// environment a box gets; that no credential is in the agent's container's spec; and that release
// removes everything.

const input: BoxInput = {
  taskId: taskIdSchema.parse("0196f1a0-task-docker"),
  sessionId: sessionIdSchema.parse("0196f1a0-session-docker"),
  boxId: boxIdSchema.parse("0196f1a0-box-docker"),
  leaseEpoch: leaseEpochSchema.parse(3),
  serverUrl: "http://ostra-server:8787",
  baseImage: null,
  tokenDir: "/var/lib/ostra-runner/boxes/0196f1a0-box-docker",
};
const images = { base: "ghcr.io/ostra/base:0.0.0", runner: "ghcr.io/ostra/runner:0.0.0" };

let engine: FakeEngine;
let boxes: DockerBoxes;

beforeEach(async () => {
  engine = await startFakeEngine();
  boxes = createDockerBoxes(createEngine(engine.address), { images });
});

afterEach(async () => {
  await engine.close();
});

const envOf = (body: Readonly<Record<string, unknown>>): readonly string[] => {
  const env: unknown = body["Env"];
  return Array.isArray(env) ? env.map(String) : [];
};

describe("a box's resources", () => {
  it("puts the agent on an internal network only, as the init under tini, with the task volume", () => {
    const resources = boxResources(input, { images }, "n".repeat(43));
    expect(resources.network).toMatchObject({ Name: `ostra-box-${input.boxId}`, Internal: true, Driver: "bridge" });
    const agent = resources.agent.body;
    expect(agent.Image).toBe(images.base);
    expect(agent.Cmd).toEqual(["node", "/opt/ostra/init/main.ts"]);
    expect(agent.User).toBe("0:0");
    expect(agent.HostConfig).toMatchObject({
      Init: true,
      NetworkMode: resources.network.Name,
      CapDrop: ["ALL"],
      CapAdd: ["SETUID", "SETGID", "KILL"],
      SecurityOpt: ["no-new-privileges:true"],
      Mounts: [{ Type: "volume", Source: resources.volume.Name, Target: TASK_ROOT }],
    });
    expect(envOf(agent).map((line) => line.split("=")[0])).toEqual(["OSTRA_BOX_ID", "OSTRA_BRIDGE_NONCE", "OSTRA_BRIDGE_ADDR", "OSTRA_AGENT_UID", "OSTRA_AGENT_GID", "OSTRA_BRIDGE_FEATURES"]);
    // Milestone 8: the bridge features this sidecar reads, which the init announces back.
    expect(envOf(agent)).toContain("OSTRA_BRIDGE_FEATURES=app,browser,forward");
  });

  it("F-050/c1: uses the environment's own base image when it names one", () => {
    expect(boxResources({ ...input, baseImage: "node:24-bookworm" }, { images }).agent.body.Image).toBe("node:24-bookworm");
  });

  it("F-017/c3: gives the sidecar the token file, read-only, and the server; the agent gets neither", () => {
    const resources = boxResources(input, { images, runtime: "runsc" });
    const sidecar = resources.sidecar.body;
    expect(sidecar.Image).toBe(images.runner);
    expect(sidecar.Cmd).toEqual(["sidecar"]);
    expect(sidecar.User).toBe("1000:1000");
    expect(sidecar.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      Runtime: "runsc",
      Mounts: [
        { Type: "volume", Target: TASK_ROOT },
        { Type: "bind", Source: input.tokenDir, Target: "/run/ostra", ReadOnly: true },
      ],
    });
    expect(envOf(sidecar)).toContain("OSTRA_SERVER_URL=http://ostra-server:8787");
    expect(envOf(sidecar)).toContain(`OSTRA_LEASE_EPOCH=${String(input.leaseEpoch)}`);
    // ADR 0030: nothing in the agent's container's spec reaches a credential.
    const agentSpec = JSON.stringify(resources.agent);
    expect(agentSpec).not.toContain(input.tokenDir);
    expect(agentSpec).not.toContain("/run/ostra");
    expect(agentSpec).not.toContain("TOKEN");
    expect(agentSpec).not.toContain(input.serverUrl);
    expect(agentSpec).not.toContain("SECRET");
  });

  it("keeps the sidecar's state on a tmpfs only it mounts, never on the task volume the agent shares", () => {
    const resources = boxResources(input, { images });
    const sidecar = resources.sidecar.body;
    const tmpfs = z.record(z.string(), z.string()).parse(sidecar.HostConfig["Tmpfs"]);
    expect(tmpfs[SIDECAR_DATA_DIR]).toMatch(/uid=1000,gid=1000,mode=0700/);
    expect(envOf(sidecar)).toContain(`OSTRA_SIDECAR_DATA_DIR=${SIDECAR_DATA_DIR}`);
    expect(SIDECAR_DATA_DIR.startsWith(`${TASK_ROOT}/`)).toBe(false);
    const agentSpec = JSON.stringify(resources.agent);
    expect(agentSpec).not.toContain(SIDECAR_DATA_DIR);
    expect(JSON.stringify(resources.agent.body.HostConfig)).not.toContain("Tmpfs");
  });

  it("adds the token file's group to the sidecar only when the runner gave one", () => {
    expect(boxResources(input, { images }).sidecar.body.HostConfig).not.toHaveProperty("GroupAdd");
    const grouped = boxResources({ ...input, tokenGroup: 1234 }, { images });
    expect(grouped.sidecar.body.HostConfig).toMatchObject({ GroupAdd: ["1234"] });
    expect(grouped.agent.body.HostConfig).not.toHaveProperty("GroupAdd");
  });

  it("makes a fresh bridge nonce for every box, shared by the init and the sidecar only", () => {
    const one = boxResources(input, { images });
    const two = boxResources(input, { images });
    expect(one.bridgeNonce).not.toBe(two.bridgeNonce);
    expect(one.bridgeNonce.length).toBeGreaterThanOrEqual(43);
    expect(envOf(one.agent.body)).toContain(`OSTRA_BRIDGE_NONCE=${one.bridgeNonce}`);
    expect(envOf(one.sidecar.body)).toContain(`OSTRA_BRIDGE_NONCE=${one.bridgeNonce}`);
  });
});

describe("the box on the Engine API", () => {
  it("creates the egress network once, the box network, the volume and both containers, and starts them", async () => {
    const created = await boxes.createBox(input);
    expect(created.ok).toBe(true);
    expect(engine.networks.get("ostra-egress")).toMatchObject({ Options: { "com.docker.network.bridge.enable_icc": "false" } });
    expect(engine.networks.get(`ostra-box-${input.boxId}`)).toMatchObject({ Internal: true });
    expect(engine.volumes.has(`ostra-box-${input.boxId}-task`)).toBe(true);
    const containers = [...engine.containers.values()];
    expect(containers.map((container) => container.name).sort()).toEqual([`ostra-box-${input.boxId}-agent`, `ostra-box-${input.boxId}-sidecar`].sort());
    expect(containers.every((container) => container.status === "running")).toBe(true);
    const sidecar = containers.find((container) => container.name.endsWith("-sidecar"));
    const agent = containers.find((container) => container.name.endsWith("-agent"));
    expect(sidecar?.networks).toEqual([`ostra-box-${input.boxId}`, "ostra-egress"]);
    expect(agent?.networks).toEqual([`ostra-box-${input.boxId}`]);
    // The sidecar is created first: its image's /task seeds the new volume with the agent's owner.
    expect(engine.calls.filter((call) => call === "POST /containers/create")).toHaveLength(2);
    expect(await boxes.boxState(input.boxId)).toBe("ready");

    const second = await boxes.createBox({ ...input, boxId: boxIdSchema.parse("0196f1a0-box-two") });
    expect(second.ok).toBe(true);
    expect(engine.calls.filter((call) => call === "POST /networks/create")).toHaveLength(3);
  });

  it("removes everything on release, and the state is released", async () => {
    await boxes.createBox(input);
    expect(await boxes.removeBox(input.boxId)).toEqual({ ok: true, value: undefined });
    expect(engine.containers.size).toBe(0);
    expect(engine.volumes.size).toBe(0);
    expect([...engine.networks.keys()]).toEqual(["ostra-egress"]);
    expect(await boxes.boxState(input.boxId)).toBe("released");
    expect(await boxes.removeBox(input.boxId)).toEqual({ ok: true, value: undefined });
  });

  it("cleans up what it made when a create fails halfway", async () => {
    engine.failNext.set("container", 500);
    const created = await boxes.createBox(input);
    expect(created.ok).toBe(false);
    expect(engine.containers.size).toBe(0);
    expect(engine.volumes.size).toBe(0);
    expect(engine.networks.has(`ostra-box-${input.boxId}`)).toBe(false);
  });

  it("follows the sidecar: stopped once it exits, with its exit code", async () => {
    await boxes.createBox(input);
    const sidecar = [...engine.containers.values()].find((container) => container.name.endsWith("-sidecar"));
    if (sidecar === undefined) {
      throw new Error("no sidecar");
    }
    sidecar.status = "exited";
    sidecar.exitCode = 0;
    expect(await boxes.waitForSidecar(input.boxId)).toBe(0);
    expect(await boxes.boxState(input.boxId)).toBe("stopped");
    await boxes.stopBox(input.boxId);
    expect([...engine.containers.values()].every((container) => container.status === "exited")).toBe(true);
  });

  it("reads DOCKER_HOST as Docker's tools do", () => {
    expect(engineAddressFrom(undefined, "linux")).toEqual({ kind: "socket", path: "/var/run/docker.sock" });
    expect(engineAddressFrom(undefined, "win32")).toEqual({ kind: "socket", path: "//./pipe/docker_engine" });
    expect(engineAddressFrom("unix:///run/user/1000/docker.sock")).toEqual({ kind: "socket", path: "/run/user/1000/docker.sock" });
    expect(engineAddressFrom("tcp://10.0.0.5:2375")).toEqual({ kind: "tcp", host: "10.0.0.5", port: 2375 });
    expect(() => engineAddressFrom("ssh://host")).toThrow();
  });
});
