import { boxIdSchema, DEFAULT_BOX_SUBNET_POOL, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDockerBoxes } from "./boxes.ts";
import type { BoxInput } from "./boxes.ts";
import { createEngine } from "./engine.ts";
import { freeSubnet, parsePool, subnetsOverlap } from "./subnet-pool.ts";
import { DOCKER_DEFAULT_SUBNETS, startFakeEngine } from "./testing/fake-engine.ts";
import type { FakeEngine } from "./testing/fake-engine.ts";

// F-017 (ADR 0029, Q154): the `docker` executor owns its boxes' subnets. Against the fake Engine
// API, which gives a network that names no subnet the next of Docker's 31 default ones and refuses
// the 32nd, as moby does, and refuses a subnet that overlaps another network's. The live run of 50
// boxes on one Linux host is `docker.live.test.ts`.

const images = { base: "ghcr.io/ostra/base:0.0.0", runner: "ghcr.io/ostra/runner:0.0.0" };

const boxFor = (n: number): BoxInput => ({
  taskId: taskIdSchema.parse(`0196f1a0-task-net-${String(n)}`),
  sessionId: sessionIdSchema.parse(`0196f1a0-session-net-${String(n)}`),
  boxId: boxIdSchema.parse(`0196f1a0-box-net-${String(n)}`),
  leaseEpoch: leaseEpochSchema.parse(1),
  serverUrl: "http://ostra-server:8787",
  baseImage: null,
  tokenDir: `/var/lib/ostra-runner/boxes/0196f1a0-box-net-${String(n)}`,
});

let engine: FakeEngine;

beforeEach(async () => {
  engine = await startFakeEngine();
});

afterEach(async () => {
  await engine.close();
});

/** The subnet the fake Engine holds for a network. */
const subnetOf = (name: string): string | undefined => {
  const config: unknown = Reflect.get(Object(engine.networks.get(name)?.["IPAM"]), "Config");
  const subnet: unknown = Array.isArray(config) ? Reflect.get(Object(config[0]), "Subnet") : undefined;
  return typeof subnet === "string" ? subnet : undefined;
};

describe("the docker executor's own subnets (F-017)", () => {
  it("F-017/c5: 50 boxes made at once on one host each get a network of their own, a /24 carved from the executor's pool, past Docker's 31 default networks, and none overlaps", async () => {
    const boxes = createDockerBoxes(createEngine(engine.address), { images });
    const inputs = Array.from({ length: 50 }, (_, index) => boxFor(index + 1));
    const created = await Promise.all(inputs.map((input) => boxes.createBox(input)));
    expect(created.map((result) => (result.ok ? "ok" : result.error.message))).toEqual(inputs.map(() => "ok"));
    // 50 box networks and the shared egress network: more than Docker's default pools hold.
    expect(engine.networks.size).toBe(51);
    expect(engine.networks.size).toBeGreaterThan(DOCKER_DEFAULT_SUBNETS.length);
    const subnets = inputs.map((input) => subnetOf(`ostra-box-${input.boxId}`) ?? "none");
    for (const [index, subnet] of subnets.entries()) {
      // Pinned by the executor inside its pool, a /24 each; never one of Docker's own.
      expect(subnet).toMatch(/^10\.89\.\d{1,3}\.0\/24$/);
      expect(subnetsOverlap(subnet, DEFAULT_BOX_SUBNET_POOL)).toBe(true);
      expect(DOCKER_DEFAULT_SUBNETS.some((docker) => subnetsOverlap(docker, subnet))).toBe(false);
      expect(subnets.filter((other, at) => at !== index && subnetsOverlap(other, subnet))).toEqual([]);
      // What createBox answers is what the Engine holds.
      const answer = created[index];
      expect(answer?.ok === true ? answer.value.subnet : null).toBe(subnet);
    }
    // The one network Docker's pools still give: the boxes' shared egress network.
    expect(subnetOf("ostra-egress")).toBe("172.17.0.0/16");

    // A released box's /24 goes back to the pool: the next box takes it.
    const first = subnets[0] ?? "";
    expect(await boxes.removeBox(boxFor(1).boxId)).toEqual({ ok: true, value: undefined });
    const again = await boxes.createBox(boxFor(51));
    expect(again.ok ? again.value.subnet : again.error.message).toBe(first);
  });

  it("F-017/c5: the pool is the runner's setting, a /24 another network on the host holds is skipped, and a full pool refuses the box and leaves nothing of it", async () => {
    // An admin's own network, inside the pool the runner was given.
    engine.networks.set("the-admins-own", { Name: "the-admins-own", IPAM: { Config: [{ Subnet: "10.200.0.0/24" }] } });
    const boxes = createDockerBoxes(createEngine(engine.address), { images, subnetPool: "10.200.0.0/23" });
    const one = await boxes.createBox(boxFor(1));
    expect(one.ok ? one.value.subnet : one.error.message).toBe("10.200.1.0/24");
    const full = await boxes.createBox(boxFor(2));
    expect(full.ok ? "made" : full.error.message).toBe("the box subnet pool 10.200.0.0/23 has no free /24 left");
    // Nothing of the refused box is left on the Engine.
    expect([...engine.containers.values()].filter((container) => container.name.includes(boxFor(2).boxId))).toEqual([]);
    expect(engine.networks.has(`ostra-box-${boxFor(2).boxId}`)).toBe(false);
    expect(engine.volumes.has(`ostra-box-${boxFor(2).boxId}-task`)).toBe(false);
    // A pool that isn't a network is refused before anything is made.
    const wrong = createDockerBoxes(createEngine(engine.address), { images, subnetPool: "10.200.0.1/16" });
    const refused = await wrong.createBox(boxFor(3));
    expect(refused.ok ? "made" : refused.error.message).toBe("the box subnet pool 10.200.0.1/16 isn't an IPv4 network of /8 to /24");
    expect(engine.networks.has(`ostra-box-${boxFor(3).boxId}`)).toBe(false);
  });

  it("F-017/c5: the pool's /24s, in order, skipping every subnet a network holds, whatever its size", () => {
    const pool = parsePool("10.89.0.0/16");
    expect(pool).toEqual({ first: (10 * 256 + 89) * 65_536, size: 256 });
    if (pool === null) return;
    expect(freeSubnet(pool, [])).toBe("10.89.0.0/24");
    expect(freeSubnet(pool, ["10.89.0.0/24", "10.89.1.0/24"])).toBe("10.89.2.0/24");
    // A wider network inside the pool takes every /24 it covers; an IPv6 one takes none.
    expect(freeSubnet(pool, ["10.89.0.0/22", "fd00:ab::/64"])).toBe("10.89.4.0/24");
    // One that holds the whole pool leaves it full.
    expect(freeSubnet(pool, ["10.0.0.0/8"])).toBeNull();
    expect(parsePool("10.89.0.0/24")).toEqual({ first: (10 * 256 + 89) * 65_536, size: 1 });
    for (const wrong of ["10.89.0.0/25", "10.89.0.0/7", "10.89.0.1/16", "10.89.0/16", "fd00::/64"]) {
      expect(parsePool(wrong), wrong).toBeNull();
    }
  });
});
