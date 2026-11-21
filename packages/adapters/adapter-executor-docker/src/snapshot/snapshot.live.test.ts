import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, leaseEpochSchema, projectIdSchema, repoIdSchema, sessionIdSchema, sha256HexSchema, snapshotCredentialsSchema, snapshotIdSchema, taskIdSchema } from "@ostra/protocol";
import type { SnapshotBuildEnvironment, SnapshotCredentials, SnapshotId } from "@ostra/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDockerBoxes } from "../boxes.ts";
import { createEngine, emptySchema, engineAddressFrom } from "../engine.ts";
import { createDockerSnapshots } from "./snapshots.ts";

// Milestone 3's ticket 14, live (F-051, F-094): a real snapshot built with BuildKit on a real Docker
// Engine, scanned, kept and started from, and a box's service on its network. It runs only where
// Docker answers, the `docker` CLI builds, and the images are built (`OSTRA_TEST_BASE_IMAGE`,
// `OSTRA_TEST_RUNNER_IMAGE`, from `deploy/`), as `docker.live.test.ts` does, and skips itself
// otherwise: the Windows machine that built milestone 3 has no Docker, so it waits for the Linux
// machine (ticket 50's "waits for Linux"). The services case also needs `OSTRA_TEST_SERVICE_IMAGE`
// (default `redis:7-alpine`, pulled), which it starts with its health check `redis-cli ping`.
//
// The checks on `docker` run through the bridge to the box's init, which the executor contract
// suite drives for real in-process (`docker-executor.contract.test.ts`), and the live box of
// `docker.live.test.ts` proves the init runs the agent's user's processes in its container.

const engine = createEngine(engineAddressFrom(process.env["DOCKER_HOST"]), 10_000);
const images = { base: process.env["OSTRA_TEST_BASE_IMAGE"], runner: process.env["OSTRA_TEST_RUNNER_IMAGE"] };
const serviceImage = process.env["OSTRA_TEST_SERVICE_IMAGE"] ?? "redis:7-alpine";
const dockerAnswers = (await engine.call("GET", "/_ping", z.unknown())).ok;
const ready = dockerAnswers && images.base !== undefined && images.runner !== undefined;
const reason = dockerAnswers ? "the images aren't built (OSTRA_TEST_BASE_IMAGE, OSTRA_TEST_RUNNER_IMAGE)" : "no Docker on this machine";
const servicePulled = ready && (await engine.call("GET", `/images/${encodeURIComponent(serviceImage)}/json`, z.unknown())).ok;

const SETUP_SECRET = "sk-live-setup-secret-0123456789abcdef";
const GIT_TOKEN = "ghs_liveSnapshotToken0123456789abcdefXYZ";
const projectId = projectIdSchema.parse("live-project");
const repoId = repoIdSchema.parse("repo-live");

const environmentOf = (origin: string, setupScript: string): SnapshotBuildEnvironment => ({
  baseImage: images.base ?? null,
  setupScript,
  repos: [
    {
      repoId,
      fullName: "ostra-test/test1",
      cloneUrl: `${origin}/ostra-test/test1.git`,
      defaultBranch: "main",
      checkoutDir: "test1",
      variables: [],
      files: [],
      envFile: ".env",
      setupSecrets: { variables: ["API_TOKEN"], files: [] },
    },
  ],
  inputsHash: sha256HexSchema.parse("1".repeat(64)),
});

const credentialsOf = (snapshotId: SnapshotId): SnapshotCredentials =>
  snapshotCredentialsSchema.parse({
    snapshotId,
    repos: [{ repoId, gitToken: GIT_TOKEN, expiresAt: Date.now() + 3_600_000 }],
    secrets: [{ repoId, entries: [{ kind: "variable", name: "API_TOKEN", value: SETUP_SECRET, availableDuringSetup: true }] }],
  });

describe.skipIf(!ready)(`snapshots and services on Docker, live (skipped: ${ready ? "no" : reason})`, () => {
  it("F-051: a snapshot is built with its setup secret mounted, scanned clean, kept, and a box starts from it with the checkouts in its volume; one that keeps the secret is deleted", async () => {
    const base = images.base;
    const runner = images.runner;
    if (base === undefined || runner === undefined) {
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-snapshot-live-"));
    const upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: true });
    upstream.tokens.set(GIT_TOKEN, Date.now() + 3_600_000);
    await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
    const snapshots = createDockerSnapshots({ engine, workDir: path.join(root, "runner"), defaultBaseImage: base });
    const clean = snapshotIdSchema.parse(`live-clean-${String(Date.now())}`);
    const leaky = snapshotIdSchema.parse(`live-leaky-${String(Date.now())}`);
    const boxId = boxIdSchema.parse(`live-snap-${String(Date.now())}`);
    const tokenDir = path.join(root, "token");
    const boxes = createDockerBoxes(engine, { images: { base, runner } });
    try {
      // The build's own output, its setup secret already redacted (`snapshots.ts`), for a failure's message.
      let output = "";
      const built = await snapshots.buildSnapshot({
        snapshotId: clean,
        projectId,
        // The secret is read during the setup, and only its length lands in a file.
        environment: environmentOf(upstream.origin, 'printf "%s" "${#API_TOKEN}" > installed\n'),
        credentials: credentialsOf(clean),
        onOutput: (_stream, text) => {
          output = (output + text).slice(-6000);
        },
      });
      expect(built.ok && built.value.outcome, `${JSON.stringify(built)}\n${output}`).toBe("built");
      if (!built.ok || built.value.outcome !== "built") {
        return;
      }
      expect(await snapshots.hasSnapshot(clean)).toEqual({ ok: true, value: { imageRef: built.value.imageRef, imageDigest: built.value.imageDigest } });

      // A box from it: the task volume starts with the snapshot's checkouts, and no mount hides them.
      await mkdir(tokenDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(tokenDir, "token"), "ostra-runner-live-test-token-not-real");
      const created = await boxes.createBox({
        taskId: taskIdSchema.parse("live-task"),
        sessionId: sessionIdSchema.parse("live-session"),
        boxId,
        leaseEpoch: leaseEpochSchema.parse(1),
        serverUrl: "http://ostra-server.invalid:8787",
        baseImage: null,
        tokenDir,
        snapshotImage: built.value.imageDigest,
      });
      expect(created.ok, created.ok ? "" : created.error.message).toBe(true);
      if (created.ok) {
        const listed = await engine.exec(created.value.agentId, ["cat", "/task/snapshot/workspace/test1/README.md", "/task/snapshot/workspace/test1/installed", "/task/snapshot/snapshot-id"], "1000:1000");
        expect(listed.ok && listed.value.output).toBe(`# test1\n${String(SETUP_SECRET.length)}${clean}\n`);
      }

      // A setup that writes the secret's value into a file: the scan finds it, and the image goes.
      const leaked = await snapshots.buildSnapshot({
        snapshotId: leaky,
        projectId,
        environment: environmentOf(upstream.origin, 'printf "%s" "$API_TOKEN" | base64 > .cache-token\n'),
        credentials: credentialsOf(leaky),
        onOutput: () => undefined,
      });
      expect(leaked).toMatchObject({ ok: true, value: { outcome: "failed", reason: "secret-found" } });
      expect(JSON.stringify(leaked)).not.toContain(SETUP_SECRET);
      expect(await snapshots.hasSnapshot(leaky)).toEqual({ ok: true, value: null });
    } finally {
      await boxes.removeBox(boxId);
      const kept = await snapshots.hasSnapshot(clean);
      if (kept.ok && kept.value !== null) {
        await engine.call("DELETE", `/images/${encodeURIComponent(kept.value.imageDigest)}?force=true`, emptySchema);
      }
      await upstream.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 900_000);

  it.skipIf(!servicePulled)("F-094: a box's service runs on its network by its name, with its variables, is healthy by its health check, and goes with the box", async () => {
    const base = images.base;
    const runner = images.runner;
    if (base === undefined || runner === undefined) {
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-services-live-"));
    const tokenDir = path.join(root, "token");
    await mkdir(tokenDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tokenDir, "token"), "ostra-runner-live-test-token-not-real");
    const boxes = createDockerBoxes(engine, { images: { base, runner } });
    const boxId = boxIdSchema.parse(`live-svc-${String(Date.now())}`);
    try {
      const service = { name: "cache", image: serviceImage, port: 6379, variables: [{ name: "OSTRA_LIVE", value: "1" }], healthCheck: "redis-cli ping" };
      const created = await boxes.createBox({
        taskId: taskIdSchema.parse("live-task"),
        sessionId: sessionIdSchema.parse("live-session"),
        boxId,
        leaseEpoch: leaseEpochSchema.parse(1),
        serverUrl: "http://ostra-server.invalid:8787",
        baseImage: null,
        tokenDir,
        services: [service],
      });
      expect(created.ok, created.ok ? "" : created.error.message).toBe(true);
      if (!created.ok) {
        return;
      }
      const health = await boxes.waitForServices(boxId, [service], { timeoutMs: 120_000 });
      expect(health).toEqual([expect.objectContaining({ name: "cache", outcome: "healthy" })]);
      // The agent reaches it by its name on the box's network.
      const reached = await engine.exec(
        created.value.agentId,
        ["node", "-e", "require('node:net').connect(6379,'cache').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),3000)"],
        "1000:1000",
      );
      expect(reached.ok && reached.value.exitCode).toBe(0);
    } finally {
      expect(await boxes.removeBox(boxId)).toEqual({ ok: true, value: undefined });
      expect(await boxes.boxState(boxId)).toBe("released");
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
