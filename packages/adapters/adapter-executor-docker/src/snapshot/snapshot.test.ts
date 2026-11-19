import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, zstdCompress } from "node:zlib";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { projectIdSchema, repoIdSchema, sha256HexSchema, snapshotCredentialsSchema, snapshotIdSchema } from "@ostra/protocol";
import type { SnapshotBuildEnvironment, SnapshotCredentials } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../engine.ts";
import { startFakeEngine, tarOf } from "../testing/fake-engine.ts";
import type { FakeEngine } from "../testing/fake-engine.ts";
import { planSnapshotBuild, SETUP_FAILED_MARKER, SNAPSHOT_LABEL, SNAPSHOT_WORKSPACE, snapshotTag } from "./dockerfile.ts";
import { needlesOf, scanImageArchive } from "./image-scan.ts";
import { createDockerSnapshots } from "./snapshots.ts";
import type { SnapshotBuilder } from "./snapshots.ts";

// Milestone 3's ticket 14 (F-051): the snapshot's Dockerfile, the scan before use with its negative
// control, and the build kept in this host's Docker, against the fake Engine API and a fake BuildKit
// that makes an image from what it's given. The live build waits for a Linux host with Docker
// (`snapshot.live.test.ts`).

const gzipped = promisify(gzip);
const zstded = promisify(zstdCompress);

const API_TOKEN = "sk-setup-secret-0123456789abcdef";
const NPMRC = "//registry.npmjs.org/:_authToken=npm_SecretFileValue42";
const GIT_TOKEN = "ghs_snapshotBuildToken0123456789abcdefXYZ";
const snapshotId = snapshotIdSchema.parse("0196f1a0-snapshot-17");
const projectId = projectIdSchema.parse("0196f1a0-Project-A");
const web = repoIdSchema.parse("repo-web");
const api = repoIdSchema.parse("repo-api");

const environment = (cloneBase = "https://github.com"): SnapshotBuildEnvironment => ({
  baseImage: "node:24-bookworm",
  setupScript: "pnpm install --frozen-lockfile\n",
  repos: [
    {
      repoId: web,
      fullName: "ostra-test/test1",
      cloneUrl: `${cloneBase}/ostra-test/test1.git`,
      defaultBranch: "main",
      checkoutDir: "test1",
      variables: [
        { name: "NODE_ENV", value: "it's test", availableDuringSetup: true },
        { name: "LATER_ONLY", value: "not during setup", availableDuringSetup: false },
      ],
      files: [{ path: "config/app.json", content: '{ "plain": true }\n' }],
      envFile: ".env",
      setupSecrets: { variables: ["API_TOKEN"], files: [".npmrc"] },
    },
    {
      repoId: api,
      fullName: "ostra-test/test2",
      cloneUrl: `${cloneBase}/ostra-test/test2.git`,
      defaultBranch: "main",
      checkoutDir: "test2",
      variables: [],
      files: [],
      envFile: ".env",
      setupSecrets: { variables: [], files: [] },
    },
  ],
  inputsHash: sha256HexSchema.parse("a".repeat(64)),
});

const credentials: SnapshotCredentials = snapshotCredentialsSchema.parse({
  snapshotId,
  repos: [
    { repoId: web, gitToken: GIT_TOKEN, expiresAt: Date.now() + 3_600_000 },
    { repoId: api, gitToken: GIT_TOKEN, expiresAt: Date.now() + 3_600_000 },
  ],
  secrets: [
    {
      repoId: web,
      entries: [
        { kind: "variable", name: "API_TOKEN", value: API_TOKEN, availableDuringSetup: true },
        { kind: "file", path: ".npmrc", content: NPMRC, availableDuringSetup: true },
      ],
    },
  ],
});

describe("the snapshot's Dockerfile (F-051)", () => {
  it("F-051: a two-repo environment with setup secrets: each checkout copied, the setup once per repo, each secret mounted for its own repo's step only and in no file", () => {
    const planned = planSnapshotBuild({ snapshotId, projectId, environment: environment(), credentials, defaultBaseImage: "ghcr.io/ostra/base:0.0.0" });
    if (!planned.ok) throw new Error(planned.detail);
    const { dockerfile, contextFiles, secrets, scanFor } = planned.plan;
    const lines = dockerfile.split("\n");
    expect(lines[0]).toBe("# syntax=docker/dockerfile:1.7");
    expect(lines).toContain("FROM node:24-bookworm");
    expect(dockerfile).toContain(`LABEL "${SNAPSHOT_LABEL}"="${snapshotId}" "ostra.project"="${projectId}"`);
    expect(lines).toContain(`COPY --chown=1000:1000 repos/test1 ${SNAPSHOT_WORKSPACE}/test1`);
    expect(lines).toContain(`COPY --chown=1000:1000 repos/test2 ${SNAPSHOT_WORKSPACE}/test2`);
    // One step per repo; the secrets are mounts on the first repo's step only.
    const steps = lines.filter((line) => line.startsWith("RUN ") && line.includes("/tmp/ostra/setup-"));
    expect(steps).toEqual([
      'RUN --mount=type=secret,id=s0_0,uid=1000,mode=0400,required=true --mount=type=secret,id=s0_1,uid=1000,mode=0400,required=true ["bash","/tmp/ostra/setup-0.sh"]',
      'RUN ["bash","/tmp/ostra/setup-1.sh"]',
    ]);
    expect(secrets.map((secret) => secret.id)).toEqual(["s0_0", "s0_1"]);
    // No secret is in the Dockerfile or in any file of the context: not a build argument, an ENV or a COPY.
    for (const text of [dockerfile, ...contextFiles.map((file) => file.content)]) {
      for (const value of [API_TOKEN, NPMRC, GIT_TOKEN]) {
        expect(text).not.toContain(value);
      }
    }
    expect(dockerfile).not.toMatch(/^(ARG|ENV) /m);
    // The first repo's step: its folder, its setup variables quoted, the secret read from its mount,
    // the secret file copied in and removed before the step ends.
    const first = contextFiles.find((file) => file.path === "ostra/setup-0.sh")?.content ?? "";
    expect(first).toContain(`cd '${SNAPSHOT_WORKSPACE}/test1' || exit 1`);
    expect(first).toContain("export OSTRA_REPO='ostra-test/test1'");
    expect(first).toContain("export NODE_ENV='it'\\''s test'");
    expect(first).not.toContain("LATER_ONLY");
    expect(first).toContain('export API_TOKEN="$(cat /run/secrets/s0_0)"');
    expect(first).toContain(`cp /run/secrets/s0_1 '${SNAPSHOT_WORKSPACE}/test1/.npmrc'`);
    expect(first).toContain("trap ostra_clean EXIT");
    expect(first).toContain(SETUP_FAILED_MARKER);
    const second = contextFiles.find((file) => file.path === "ostra/setup-1.sh")?.content ?? "";
    expect(second).toContain(`cd '${SNAPSHOT_WORKSPACE}/test2'`);
    expect(second).not.toContain("/run/secrets/");
    expect(contextFiles.find((file) => file.path === "ostra/setup.sh")?.content).toBe("pnpm install --frozen-lockfile\n");
    // The scan looks for every setup secret, by its name, and the repos' tokens.
    expect(scanFor.map((target) => target.name)).toEqual(["API_TOKEN", ".npmrc", `the git token of ${web}`, `the git token of ${api}`]);
    // Tagged in this host's Docker by project and snapshot, as a reference allows.
    expect(snapshotTag(projectId, snapshotId)).toBe("ostra-snapshot/0196f1a0-project-a:0196f1a0-snapshot-17");
  });

  it("F-051: a base image a FROM line can't carry as one word is refused", () => {
    const refused = planSnapshotBuild({ snapshotId, projectId, environment: { ...environment(), baseImage: "node:24\nRUN curl evil" }, credentials, defaultBaseImage: "ghcr.io/ostra/base:0.0.0" });
    expect(refused).toEqual({ ok: false, detail: "the environment's base image isn't an image name" });
  });
});

describe("the scan before use (F-051)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ostra-image-scan-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const archive = async (name: string, layers: readonly Buffer[]): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(
      file,
      tarOf([
        { name: "manifest.json", content: Buffer.from('[{"Layers":["blobs/sha256/1"]}]') },
        ...layers.map((content, index) => ({ name: `blobs/sha256/${String(index + 1)}`, content })),
      ]),
    );
    return file;
  };
  const layer = (files: Readonly<Record<string, string>>): Buffer => tarOf(Object.entries(files).map(([name, content]) => ({ name, content: Buffer.from(content) })));
  const targets = [
    { name: "API_TOKEN", value: API_TOKEN },
    { name: ".npmrc", value: NPMRC },
  ];

  it("F-051: the scan finds a planted setup secret in a plain, a gzip and a zstd layer, raw and in base64, and passes a clean image (its negative control)", async () => {
    // The negative control: the values planted in an image the scan must fail.
    const raw = await archive("raw.tar", [layer({ "task/snapshot/workspace/test1/.env.local": `API_TOKEN=${API_TOKEN}\n` })]);
    expect((await scanImageArchive(raw, targets)).found).toEqual(["API_TOKEN"]);
    const gzipFile = await archive("gzip.tar", [await gzipped(layer({ "home/agent/.npmrc": NPMRC }))]);
    expect((await scanImageArchive(gzipFile, targets)).found).toEqual([".npmrc"]);
    const zstd = await archive("zstd.tar", [await zstded(layer({ "opt/app/config": `prefix ${API_TOKEN} suffix` }))]);
    expect((await scanImageArchive(zstd, targets)).found).toEqual(["API_TOKEN"]);
    // Base64 at each of its three alignments, inside a longer text.
    for (const prefix of ["", "a", "ab"]) {
      const encoded = Buffer.from(`${prefix}${API_TOKEN}!`).toString("base64");
      const file = await archive(`b64-${String(prefix.length)}.tar`, [layer({ "etc/blob": `data:${encoded}:end` })]);
      expect((await scanImageArchive(file, targets)).found).toEqual(["API_TOKEN"]);
    }
    // A value cut across two read chunks is still found: a layer bigger than one chunk.
    const padding = "x".repeat(1024 * 1024 - 7);
    const across = await archive("across.tar", [layer({ "big.bin": `${padding}${API_TOKEN}` })]);
    expect((await scanImageArchive(across, targets)).found).toEqual(["API_TOKEN"]);
    // The clean image passes.
    const clean = await archive("clean.tar", [layer({ "task/snapshot/workspace/test1/README.md": "# test1\n" }), await gzipped(layer({ "usr/bin/tool": "binary" }))]);
    const passed = await scanImageArchive(clean, targets);
    expect(passed.found).toEqual([]);
    expect(passed.entries).toBe(3);
    expect(passed.bytesScanned).toBeGreaterThan(0);
  });

  it("F-051: a value under 6 characters isn't searched for, and a file that isn't a tar fails the scan", async () => {
    expect(needlesOf("abc12")).toEqual([]);
    expect(needlesOf("abcdef").length).toBeGreaterThan(0);
    const notTar = path.join(dir, "not.tar");
    await writeFile(notTar, Buffer.alloc(2048, 1));
    await expect(scanImageArchive(notTar, targets)).rejects.toThrow("isn't a tar");
  });
});

describe("a snapshot built and kept on this host (F-051)", () => {
  let root = "";
  let upstream: GitUpstream;
  let engine: FakeEngine;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ostra-snapshots-"));
    // The repos need the build's token: the clone shows it reached git, and only git.
    upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: true });
    upstream.tokens.set(GIT_TOKEN, Date.now() + 3_600_000);
    await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n", "package.json": '{ "name": "test1" }\n' });
    await upstream.createRepo("ostra-test/test2", { "README.md": "# test2\n" });
  }, 60_000);
  afterAll(async () => {
    await upstream.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);
  beforeEach(async () => {
    engine = await startFakeEngine();
  });
  afterEach(async () => {
    await engine.close();
  });

  /** A fake BuildKit: an image of the context's checkouts, plus whatever `plant` adds to its layer. */
  const fakeBuildKit = (seen: { secretsDuringBuild?: Record<string, string>; contextFiles?: string[] }, plant?: (secrets: Record<string, string>) => Record<string, string>, exitCode = 0, say = ""): SnapshotBuilder =>
    async (input) => {
      const secrets: Record<string, string> = {};
      for (const secret of input.secrets) {
        secrets[secret.id] = await readFile(secret.file, "utf8");
      }
      seen.secretsDuringBuild = secrets;
      const readme = await readFile(path.join(input.contextDir, "repos", "test1", "README.md"), "utf8");
      const config = await readFile(path.join(input.contextDir, "repos", "test1", "config", "app.json"), "utf8");
      seen.contextFiles = [readme, config];
      if (say !== "") {
        input.onOutput("stderr", say);
      }
      if (exitCode !== 0) {
        return { exitCode };
      }
      const files: Record<string, string> = { "task/snapshot/workspace/test1/README.md": readme, ...(plant?.(secrets) ?? {}) };
      engine.addImage({ tag: input.tag, labels: { [SNAPSHOT_LABEL]: snapshotId, "ostra.project": projectId }, archive: tarOf([{ name: "blobs/sha256/1", content: await gzipped(tarOf(Object.entries(files).map(([name, content]) => ({ name, content: Buffer.from(content) })))) }]) });
      return { exitCode: 0 };
    };

  const build = (builder: SnapshotBuilder, output: string[] = []) => {
    const snapshots = createDockerSnapshots({ engine: createEngine(engine.address), workDir: path.join(root, "runner"), defaultBaseImage: "ghcr.io/ostra/base:0.0.0", builder });
    return {
      snapshots,
      run: () => snapshots.buildSnapshot({ snapshotId, projectId, environment: environment(upstream.origin), credentials, onOutput: (_stream, text) => output.push(text) }),
    };
  };

  it("F-051: a snapshot is built from the repos' checkouts with its secrets mounted, scanned clean, kept by its ID, and its staging and secret files gone", async () => {
    const seen: { secretsDuringBuild?: Record<string, string>; contextFiles?: string[] } = {};
    const { snapshots, run } = build(fakeBuildKit(seen));
    expect(await snapshots.hasSnapshot(snapshotId)).toEqual({ ok: true, value: null });
    const built = await run();
    if (!built.ok) throw new Error(built.error.message);
    expect(built.value).toMatchObject({ outcome: "built", imageRef: snapshotTag(projectId, snapshotId) });
    if (built.value.outcome !== "built") throw new Error("not built");
    expect(built.value.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The build saw each secret in its own file, and the checkouts cloned with the token.
    expect(seen.secretsDuringBuild).toEqual({ s0_0: API_TOKEN, s0_1: NPMRC });
    expect(seen.contextFiles).toEqual(["# test1\n", '{ "plain": true }\n']);
    expect(await snapshots.hasSnapshot(snapshotId)).toEqual({ ok: true, value: { imageRef: built.value.imageRef, imageDigest: built.value.imageDigest } });
    // Nothing of the build is left on disk: the secrets' files went with the staging folder.
    expect(await readdir(path.join(root, "runner", "snapshots"))).toEqual([]);
    // The image was exported for its scan before it was answered as built.
    expect(engine.calls.some((call) => call.startsWith("GET /images/") && call.endsWith("/get"))).toBe(true);
  }, 120_000);

  it("F-051: an image that holds a setup secret fails the build with secret-found, names the secret and never its value, and is deleted", async () => {
    const output: string[] = [];
    const { snapshots, run } = build(fakeBuildKit({}, (secrets) => ({ "task/snapshot/workspace/test1/.env.cache": `API_TOKEN=${secrets["s0_0"] ?? ""}` })), output);
    const built = await run();
    if (!built.ok) throw new Error(built.error.message);
    expect(built.value).toMatchObject({ outcome: "failed", reason: "secret-found" });
    if (built.value.outcome !== "failed") throw new Error("built");
    expect(built.value.detail).toContain("API_TOKEN");
    expect(built.value.detail).not.toContain(API_TOKEN);
    expect(engine.images.size).toBe(0);
    expect(await snapshots.hasSnapshot(snapshotId)).toEqual({ ok: true, value: null });
  }, 120_000);

  it("F-051: a failing setup is setup-failed, and a secret the build prints is hidden from its output", async () => {
    const output: string[] = [];
    const { run } = build(fakeBuildKit({}, undefined, 1, `npm ERR! token ${API_TOKEN} refused\n${SETUP_FAILED_MARKER}\n`), output);
    const built = await run();
    expect(built).toMatchObject({ ok: true, value: { outcome: "failed", reason: "setup-failed" } });
    expect(output.join("")).not.toContain(API_TOKEN);
    expect(output.join("")).toContain("[a setup secret]");
    const other = build(fakeBuildKit({}, undefined, 17), []);
    expect(await other.run()).toMatchObject({ ok: true, value: { outcome: "failed", reason: "build-failed", detail: "the image build failed (exit 17)" } });
  }, 120_000);
});
