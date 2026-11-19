import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OCI_CONFIG, OCI_LAYER, OCI_MANIFEST, sha256Digest, startFakeOciRegistry } from "./fake-oci-registry.ts";
import type { FakeOciRegistry } from "./fake-oci-registry.ts";
import { packFakeCli, startFakeNpmRegistry } from "./fake-npm-registry.ts";
import type { FakeNpmRegistry } from "./fake-npm-registry.ts";
import { ociClient } from "./oci-client.ts";

// Ticket 06: the fake OCI registry (F-120) and the fake npm registry (F-061's pin, ticket 19).

const running: (FakeOciRegistry | FakeNpmRegistry)[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

/** An image as a build would push it: a config, one layer, and the manifest naming both. */
const image = (text: string): { readonly config: Buffer; readonly layer: Buffer; readonly manifest: Buffer } => {
  const layer = Buffer.from(`layer: ${text}\n`.repeat(2000));
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [sha256Digest(layer)] } }));
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: OCI_CONFIG, digest: sha256Digest(config), size: config.length },
      layers: [{ mediaType: OCI_LAYER, digest: sha256Digest(layer), size: layer.length }],
    }),
  );
  return { config, layer, manifest };
};

describe.each(["bearer", "basic"] as const)("the fake OCI registry, %s auth (ticket 06)", (auth) => {
  it("F-120: a registry client pushes with the push credential and pulls by digest with the pull credential, and each is refused the other's work and with a wrong password", async () => {
    const registry = await startFakeOciRegistry({ auth });
    running.push(registry);
    const pusher = ociClient(registry.url, registry.push);
    const puller = ociClient(registry.url, registry.pull);
    const name = "ostra/snapshots/project-a";
    const { config, layer, manifest } = image("a");

    // Monolithic for the config, chunked for the layer.
    expect(await pusher.pushBlob(name, config)).toBe(sha256Digest(config));
    expect(await pusher.pushBlob(name, layer, 4096)).toBe(sha256Digest(layer));
    const digest = await pusher.pushManifest(name, "snap-1", OCI_MANIFEST, manifest);
    expect(digest).toBe(sha256Digest(manifest));

    const pulled = await puller.pullManifest(name, digest);
    expect(pulled).toEqual({ digest, mediaType: OCI_MANIFEST, body: manifest });
    expect(await puller.pullBlob(name, sha256Digest(layer))).toEqual(layer);
    expect((await puller.pullManifest(name, "snap-1")).digest).toBe(digest);

    // The pull credential can't push, the push credential can't pull, and a wrong password gets nothing.
    await expect(puller.pushManifest(name, "snap-2", OCI_MANIFEST, manifest)).rejects.toMatchObject({ status: auth === "bearer" ? 401 : 403 });
    await expect(pusher.pullManifest(name, digest)).rejects.toMatchObject({ status: auth === "bearer" ? 401 : 403 });
    await expect(ociClient(registry.url, { username: registry.pull.username, password: "wrong" }).pullManifest(name, digest)).rejects.toMatchObject({ status: 401 });
    expect(registry.manifest(name, "snap-2")).toBeUndefined();

    // The record names who did what, and never a password.
    const record = registry.requests();
    expect(record.some((request) => request.user === "ostra-push" && request.action === "push" && request.status === 201)).toBe(true);
    expect(record.some((request) => request.user === "ostra-pull" && request.action === "pull" && request.path === `/v2/${name}/manifests/${digest}` && request.status === 200)).toBe(true);
    expect(JSON.stringify(record)).not.toContain(registry.push.password);
    expect(JSON.stringify(record)).not.toContain(registry.pull.password);
  });

  it("F-120: a manifest whose blobs aren't there is refused, and the seeded image pulls", async () => {
    const registry = await startFakeOciRegistry({ auth });
    running.push(registry);
    const pusher = ociClient(registry.url, registry.push);
    const { manifest } = image("b");
    await expect(pusher.pushManifest("ostra/snapshots/b", "x", OCI_MANIFEST, manifest)).rejects.toMatchObject({ status: 400 });
    const seeded = await ociClient(registry.url, registry.pull).pullManifest(registry.seeded.name, registry.seeded.tag);
    expect(seeded.digest).toBe(registry.seeded.digest);
  });
});

/** npm's own CLI, run by this Node with no shell: beside `node` on Windows, under `lib/` elsewhere. */
const npmCli = async (): Promise<readonly string[]> => {
  const beside = path.dirname(process.execPath);
  for (const candidate of [path.join(beside, "node_modules", "npm", "bin", "npm-cli.js"), path.join(beside, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (await stat(candidate).then(() => true, () => false)) return [process.execPath, candidate];
  }
  return ["npm"];
};

const npm = async (args: readonly string[], cwd: string): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
  const [command = "npm", ...prefix] = await npmCli();
  return new Promise((resolve) => {
    execFile(command, [...prefix, ...args, "--fetch-retries=0", "--no-audit", "--no-fund", "--no-update-notifier"], { cwd, windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
    });
  });
};

describe("the fake npm registry (ticket 06)", () => {
  it("F-061: npm install --registry installs the packed CLI from the fake registry, the version asked for, checked against its integrity", async () => {
    const packs = [await packFakeCli("1.4.0"), await packFakeCli("1.4.1")];
    const registry = await startFakeNpmRegistry(packs);
    running.push(registry);
    const dir = await mkdtemp(path.join(os.tmpdir(), "ostra-npm-"));
    folders.push(dir);
    const cache = path.join(dir, "cache");
    const prefix = path.join(dir, "versions", "1.4.0");
    const installed = await npm(["install", "--prefix", prefix, "--registry", registry.url, "--cache", cache, "ostra@1.4.0"], dir);
    expect(installed.code, installed.stderr).toBe(0);
    const manifest: unknown = JSON.parse(await readFile(path.join(prefix, "node_modules", "ostra", "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "ostra", version: "1.4.0" });
    // npm checked the tarball against the packument's integrity and wrote it to the lockfile.
    const lock: unknown = JSON.parse(await readFile(path.join(prefix, "package-lock.json"), "utf8"));
    expect(lock).toMatchObject({ packages: { "node_modules/ostra": { version: "1.4.0", integrity: packs[0]?.integrity } } });
    expect(registry.requests().map((request) => request.path)).toEqual(expect.arrayContaining(["/ostra", "/ostra/-/ostra-1.4.0.tgz"]));
  }, 180_000);

  it("F-061: a tarball that isn't what the packument says is refused by npm's integrity check", async () => {
    const good = await packFakeCli("1.4.1");
    const other = await packFakeCli("9.9.9");
    // The packument names 1.4.1's integrity, and the registry serves another tarball under it.
    const registry = await startFakeNpmRegistry([{ ...good, tarball: other.tarball }]);
    running.push(registry);
    const dir = await mkdtemp(path.join(os.tmpdir(), "ostra-npm-"));
    folders.push(dir);
    const result = await npm(["install", "--prefix", path.join(dir, "p"), "--registry", registry.url, "--cache", path.join(dir, "cache"), "ostra@1.4.1"], dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/EINTEGRITY|integrity/i);
  }, 180_000);
});
