import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startFakeServer } from "../testing/fake-server.ts";
import type { FakeServer } from "../testing/fake-server.ts";
import { RUNNER_VERSION } from "../version.ts";
import { LICENSOR, REPOSITORY_URL } from "../../../../scripts/licensor.ts";
import { cliManifest, packCli } from "./pack-cli.ts";

// Ticket 19 (F-013, ADR 0046): the npm CLI. Its tarball installs with npm on its own, with nothing
// to fetch, and the program it installs is `ostra runner`, which signs in against a server.

const folders: string[] = [];
let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
});

/** npm's own CLI, run by this Node with no shell: beside `node` on Windows, under `lib/` elsewhere. */
const npmCli = async (): Promise<readonly string[]> => {
  const beside = path.dirname(process.execPath);
  for (const candidate of [path.join(beside, "node_modules", "npm", "bin", "npm-cli.js"), path.join(beside, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (await stat(candidate).then(() => true, () => false)) return [process.execPath, candidate];
  }
  return ["npm"];
};

type Ran = { readonly code: number; readonly stdout: string; readonly stderr: string };

const exec = (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Ran> =>
  new Promise((resolve) => {
    execFile(command, [...args], { cwd, env, windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
    });
  });

const manifestSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  bin: z.record(z.string(), z.string()),
  engines: z.looseObject({ node: z.string() }),
  dependencies: z.record(z.string(), z.string()).optional(),
});

describe("the npm CLI (F-013)", () => {
  it("F-013/c1: the packed CLI installs from its tarball alone, needs Node 24.5, and its ostra runner starts and signs in", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ostra-pack-"));
    folders.push(dir);
    const packed = await packCli({ outDir: path.join(dir, "stage"), name: "ostra" });
    expect(path.basename(packed.tarball)).toBe(`ostra-${RUNNER_VERSION}.tgz`);

    // Installed by npm from the tarball, with no registry to reach: it has no dependencies.
    const prefix = path.join(dir, "install");
    const [npm = "npm", ...npmArgs] = await npmCli();
    const installed = await exec(npm, [...npmArgs, "install", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(dir, "cache"), packed.tarball], dir);
    expect(installed.code, installed.stderr).toBe(0);
    const root = path.join(prefix, "node_modules", "ostra");
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
    expect(manifest).toMatchObject({ name: "ostra", version: RUNNER_VERSION, bin: { ostra: "dist/ostra.js" }, engines: { node: ">=24.5" } });
    expect(manifest.dependencies ?? {}).toEqual({});

    // The bin, run as npm's shim runs it.
    const program = path.join(root, manifest.bin["ostra"] ?? "");
    const version = await exec(process.execPath, [program, "--version"], dir);
    expect(version.code, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(RUNNER_VERSION);

    // `ostra runner` with a pool's join token: it reads the server, registers, and keeps its key. A
    // `host` pool then refuses to run tasks without a separate agent user (ticket 10), so it stops there.
    server = await startFakeServer({ joinTokens: ["ostra_jt_packed"] });
    const dataDir = path.join(dir, "data");
    const env = { PATH: process.env["PATH"], SYSTEMROOT: process.env["SYSTEMROOT"], HOME: dir, USERPROFILE: dir };
    const started = await exec(process.execPath, [program, "runner", "--server", server.url, "--join-token", "ostra_jt_packed", "--data-dir", dataDir, "--name", "packed", "--pin", "false"], dir, env);
    expect(`${started.stdout}${started.stderr}`).toContain("Signed in.");
    expect([...server.runners.values()].map((runner) => ({ name: runner.request.name, version: runner.request.version, proof: runner.proof }))).toEqual([
      { name: "packed", version: RUNNER_VERSION, proof: "join-token" },
    ]);
    const status = await exec(process.execPath, [program, "runner", "status", "--data-dir", dataDir], dir, env);
    expect(status.stdout).toContain(`This runner     ostra ${RUNNER_VERSION} (from npm)`);
  }, 180_000);
});

// Milestone 7's ticket 30 (F-039's publishing): the manifest packCli writes is what npm publishes.
describe("the CLI's published package", () => {
  it("F-039/c2: the CLI publishes its bundle and LICENSE only, public, with npm's provenance, the repository and the licensor", () => {
    expect(cliManifest("ostra", { version: "1.0.0", license: "Apache-2.0", engines: { node: ">=24.5" } })).toMatchObject({
      name: "ostra",
      version: "1.0.0",
      license: "Apache-2.0",
      author: LICENSOR,
      repository: { type: "git", url: REPOSITORY_URL, directory: "apps/runner" },
      type: "module",
      bin: { ostra: "dist/ostra.js" },
      files: ["dist", "LICENSE"],
      engines: { node: ">=24.5" },
      publishConfig: { access: "public", provenance: true },
    });
  });

  it("F-039/c2: the pack is named the root package.json's cliPackage, and its bundle carries the release's names the stamp wrote there and nothing else of that file", async () => {
    const release = z.looseObject({ imageNamespace: z.string(), cliPackage: z.string(), license: z.string() }).parse(JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf8")));
    const dir = await mkdtemp(path.join(os.tmpdir(), "ostra-pack-names-"));
    folders.push(dir);
    const packed = await packCli({ outDir: path.join(dir, "stage") });
    expect(packed.name).toBe(release.cliPackage);
    expect(manifestSchema.parse(JSON.parse(await readFile(path.join(packed.folder, "package.json"), "utf8"))).name).toBe(release.cliPackage);
    // The box images' defaults and the CLI's name read these two fields (version.ts), which esbuild
    // inlines from the stamped file; the root's own license and scripts stay out of the bundle.
    const bundle = await readFile(path.join(packed.folder, "dist", "ostra.js"), "utf8");
    expect(bundle).toContain(`{ imageNamespace: ${JSON.stringify(release.imageNamespace)}, cliPackage: ${JSON.stringify(release.cliPackage)} }`);
    expect(bundle).not.toContain(release.license);
  }, 180_000);
});
