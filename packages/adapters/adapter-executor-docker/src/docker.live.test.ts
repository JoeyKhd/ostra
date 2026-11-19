import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { baselineHeld, egressProbePlan, parseProbeOutput, probeCommand, runEgressProbes } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDockerBoxes } from "./boxes.ts";
import { createEngine, engineAddressFrom } from "./engine.ts";

// The live suite (ticket 22): a real box on a real Docker Engine. It runs only where Docker answers
// and the images are built (`OSTRA_TEST_BASE_IMAGE`, `OSTRA_TEST_RUNNER_IMAGE`, from `deploy/`),
// and skips itself otherwise: on the Windows machine that built milestone 1 there's no Docker, so
// it waits for the Linux machine (build-order.md, "Outside the code"). Until it passes, F-017
// stays planned.

const engine = createEngine(engineAddressFrom(process.env["DOCKER_HOST"]), 10_000);
const images = { base: process.env["OSTRA_TEST_BASE_IMAGE"], runner: process.env["OSTRA_TEST_RUNNER_IMAGE"] };
const dockerAnswers = (await engine.call("GET", "/_ping", z.unknown())).ok;
const ready = dockerAnswers && images.base !== undefined && images.runner !== undefined;
const reason = dockerAnswers ? "the images aren't built (OSTRA_TEST_BASE_IMAGE, OSTRA_TEST_RUNNER_IMAGE)" : "no Docker on this machine";

describe.skipIf(!ready)(`a box on Docker, live (skipped: ${ready ? "no" : reason})`, () => {
  it("creates a box whose agent's container has no route out and no credential, and removes it", async () => {
    const base = images.base;
    const runner = images.runner;
    if (base === undefined || runner === undefined) {
      return;
    }
    const tokenDir = await mkdtemp(path.join(os.tmpdir(), "ostra-box-token-"));
    await writeFile(path.join(tokenDir, "token"), "ostra-runner-live-test-token-not-real");
    const boxes = createDockerBoxes(engine, { images: { base, runner } });
    const boxId = boxIdSchema.parse(`live-${String(Date.now())}`);
    const created = await boxes.createBox({
      taskId: taskIdSchema.parse("live-task"),
      sessionId: sessionIdSchema.parse("live-session"),
      boxId,
      leaseEpoch: leaseEpochSchema.parse(1),
      serverUrl: "http://ostra-server.invalid:8787",
      baseImage: null,
      tokenDir,
    });
    try {
      expect(created.ok, created.ok ? "" : created.error.message).toBe(true);
      if (!created.ok) {
        return;
      }
      const agentEnv = await engine.exec(created.value.agentId, ["env"], "1000:1000");
      expect(agentEnv.ok).toBe(true);
      if (agentEnv.ok) {
        expect(agentEnv.value.output).not.toContain("ostra-runner-live-test-token-not-real");
        expect(agentEnv.value.output).not.toContain("OSTRA_BRIDGE_NONCE");
      }
      // The box network is internal: the agent's container reaches nothing outside.
      const out = await engine.exec(created.value.agentId, ["node", "-e", "require('node:net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),3000)"], "1000:1000");
      expect(out.ok && out.value.exitCode).toBe(1);
      const metadata = await engine.exec(created.value.agentId, ["node", "-e", "require('node:net').connect(80,'169.254.169.254').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),3000)"], "1000:1000");
      expect(metadata.ok && metadata.value.exitCode).toBe(1);
    } finally {
      expect(await boxes.removeBox(boxId)).toEqual({ ok: true, value: undefined });
      expect(await boxes.boxState(boxId)).toBe("released");
      await rm(tokenDir, { recursive: true, force: true });
    }
  }, 180_000);
});

// Milestone 5 (ticket 09), live, for ticket 35's Linux job: a box's size read back from `docker
// inspect` and from the agent container's own cgroup, a stress held at the limit, a push to a
// `registry:2` the job starts (`OSTRA_TEST_REGISTRY`, such as `localhost:5000`) and a pull of it by
// digest on a second Engine (`OSTRA_TEST_SECOND_DOCKER_HOST`), and a box that keeps running while
// the runner that made it is replaced by a new one. The registry cases skip without their settings.

const registry = process.env["OSTRA_TEST_REGISTRY"];
const secondHost = process.env["OSTRA_TEST_SECOND_DOCKER_HOST"];

const liveBox = async (name: string, extra: Partial<Parameters<ReturnType<typeof createDockerBoxes>["createBox"]>[0]> = {}) => {
  const base = images.base ?? "";
  const runner = images.runner ?? "";
  const tokenDir = await mkdtemp(path.join(os.tmpdir(), "ostra-box-token-"));
  await writeFile(path.join(tokenDir, "token"), "ostra-runner-live-test-token-not-real");
  const boxes = createDockerBoxes(engine, { images: { base, runner } });
  const boxId = boxIdSchema.parse(`live-${name}-${String(Date.now())}`);
  const created = await boxes.createBox({
    taskId: taskIdSchema.parse(`live-task-${name}`),
    sessionId: sessionIdSchema.parse(`live-session-${name}`),
    boxId,
    leaseEpoch: leaseEpochSchema.parse(1),
    serverUrl: "http://ostra-server.invalid:8787",
    baseImage: null,
    tokenDir,
    ...extra,
  });
  if (!created.ok) throw new Error(created.error.message);
  return {
    boxes,
    boxId,
    created: created.value,
    dispose: async () => {
      await boxes.removeBox(boxId);
      await rm(tokenDir, { recursive: true, force: true });
    },
  };
};

describe.skipIf(!ready)(`a box's size and registry image on Docker, live (skipped: ${ready ? "no" : reason})`, () => {
  it("F-095: the size reads back from docker inspect and from the agent container's cgroup, and a stress is held at it", async () => {
    const box = await liveBox("size", { size: { cpuMillis: 1500, memoryMiB: 512 } });
    try {
      const limits = await box.boxes.limitsOf(box.boxId);
      expect(limits.find((each) => each.role === "agent")).toMatchObject({ cpuMillis: 1500, memoryMiB: 512, memorySwapMiB: 512, pidsLimit: 4096 });
      const cgroup = await engine.exec(box.created.agentId, ["sh", "-c", "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max"], "1000:1000");
      expect(cgroup.ok && cgroup.value.output.trim().split(/\s+/)).toEqual([String(512 * 1024 * 1024), "150000", "100000", "0", "4096"]);
      // A process that asks for twice the limit is killed by the kernel (137), and the cgroup never passed it.
      const stress = await engine.exec(box.created.agentId, ["node", "-e", "const keep = []; for (;;) keep.push(Buffer.alloc(16 * 1024 * 1024, 1));"], "1000:1000");
      expect(stress.ok && stress.value.exitCode).toBe(137);
      const peak = await engine.exec(box.created.agentId, ["cat", "/sys/fs/cgroup/memory.peak"], "1000:1000");
      expect(peak.ok && Number(peak.value.output.trim())).toBeLessThanOrEqual(512 * 1024 * 1024);
    } finally {
      await box.dispose();
    }
  }, 180_000);

  it("F-015: a box keeps running, its sidecar untouched, while the runner that made it is replaced", async () => {
    const box = await liveBox("restart");
    try {
      const startedOf = async (): Promise<string | null> => {
        const inspected = await engine.call("GET", `/containers/${box.created.sidecarId}/json`, z.looseObject({ State: z.looseObject({ StartedAt: z.string(), Running: z.boolean() }), RestartCount: z.number() }));
        return inspected.ok && inspected.value.State.Running && inspected.value.RestartCount === 0 ? inspected.value.State.StartedAt : null;
      };
      const before = await startedOf();
      expect(before).not.toBeNull();
      // The runner goes: a new one, with a fresh Engine client, finds the box as it was.
      const again = createDockerBoxes(createEngine(engineAddressFrom(process.env["DOCKER_HOST"]), 10_000), { images: { base: images.base ?? "", runner: images.runner ?? "" } });
      expect(await again.boxState(box.boxId)).toBe("ready");
      expect(await startedOf()).toBe(before);
    } finally {
      await box.dispose();
    }
  }, 180_000);

  it.skipIf(registry === undefined || secondHost === undefined)("F-120: an image pushed to registry:2 with the push credential is pulled by digest on a second Engine, and no credential is left in a file", async () => {
    const repository = `${registry ?? ""}/ostra/live-project`;
    const tagged = await engine.call("POST", `/images/${encodeURIComponent(images.base ?? "")}/tag?repo=${encodeURIComponent(repository)}&tag=live`, z.unknown());
    expect(tagged.ok).toBe(true);
    const credential = { username: process.env["OSTRA_TEST_REGISTRY_USER"] ?? "ostra", token: process.env["OSTRA_TEST_REGISTRY_TOKEN"] ?? "ostra-live-registry" };
    const pushed = await engine.push(repository, "live", credential);
    if (!pushed.ok) throw new Error(pushed.error.message);
    const second = createEngine(engineAddressFrom(secondHost), 60_000);
    const box = createDockerBoxes(second, { images: { base: images.base ?? "", runner: images.runner ?? "" } });
    const tokenDir = await mkdtemp(path.join(os.tmpdir(), "ostra-box-token-"));
    const boxId = boxIdSchema.parse(`live-pull-${String(Date.now())}`);
    try {
      const created = await box.createBox({
        taskId: taskIdSchema.parse("live-task-pull"),
        sessionId: sessionIdSchema.parse("live-session-pull"),
        boxId,
        leaseEpoch: leaseEpochSchema.parse(1),
        serverUrl: "http://ostra-server.invalid:8787",
        baseImage: null,
        tokenDir,
        image: { ref: repository, digest: pushed.value.digest, pull: credential },
      });
      if (!created.ok) throw new Error(created.error.message);
      expect(created.value.resources.agent.body.Image).toBe(`${repository}@${pushed.value.digest}`);
      const env = await second.exec(created.value.agentId, ["sh", "-c", "env; cat ~/.docker/config.json 2>/dev/null; true"], "1000:1000");
      expect(env.ok && env.value.output.includes(credential.token)).toBe(false);
    } finally {
      await box.removeBox(boxId);
      await rm(tokenDir, { recursive: true, force: true });
    }
  }, 300_000);
});

// Milestone 5 (ticket 24), live, for ticket 35's Linux job with `deploy/egress-baseline.sh` applied
// (`OSTRA_TEST_EGRESS_APPLIED=1`): every probe of the plan from a shell in the agent's container,
// each after its positive control (the box's own sidecar), a timeout counted inconclusive. The
// probes reach the gateway and another box's sidecar ports too.

const egressApplied = process.env["OSTRA_TEST_EGRESS_APPLIED"] === "1";

describe.skipIf(!ready || !egressApplied)(`the egress baseline on Docker, live (skipped: ${!ready ? reason : egressApplied ? "no" : "the baseline isn't applied (OSTRA_TEST_EGRESS_APPLIED)"})`, () => {
  it("F-116: from a shell in the agent's container, every blocked range, the metadata address, the gateway and another box's sidecar ports are blocked, each after its control connected", async () => {
    const box = await liveBox("egress");
    const other = await liveBox("egress-other");
    try {
      const sidecarIp = z.looseObject({ NetworkSettings: z.looseObject({ Networks: z.record(z.string(), z.looseObject({ IPAddress: z.string(), Gateway: z.string() })) }) });
      const inspectOther = await engine.call("GET", `/containers/${other.created.sidecarId}/json`, sidecarIp);
      const inspectOwn = await engine.call("GET", `/containers/${box.created.agentId}/json`, sidecarIp);
      if (!inspectOther.ok || !inspectOwn.ok) throw new Error("inspect failed");
      const otherAddress = Object.values(inspectOther.value.NetworkSettings.Networks).find((network) => network.IPAddress !== "")?.IPAddress ?? "";
      const gateway = Object.values(inspectOwn.value.NetworkSettings.Networks)[0]?.Gateway ?? "";
      const plan = egressProbePlan({ executor: "docker", control: { host: "sidecar", port: 7101 }, gateway: gateway === "" ? "172.17.0.1" : gateway, otherBox: { host: otherAddress, ports: [7101] } });
      const results = await runEgressProbes(plan, async (address) => {
        const ran = await engine.exec(box.created.agentId, probeCommand(address), "1000:1000");
        return ran.ok ? parseProbeOutput(ran.value.output) : { kind: "error", code: "exec-failed" };
      });
      expect(results.filter((result) => result.verdict !== "blocked").map((result) => `${result.id}: ${result.verdict} (${result.detail})`)).toEqual([]);
      expect(baselineHeld(results)).toBe(true);
    } finally {
      await other.dispose();
      await box.dispose();
    }
  }, 300_000);
});
