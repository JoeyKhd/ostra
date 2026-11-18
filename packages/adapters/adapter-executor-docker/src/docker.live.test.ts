import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
