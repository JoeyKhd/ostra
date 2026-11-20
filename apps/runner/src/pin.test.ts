import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packFakeCli, packNpmPackage, startFakeNpmRegistry } from "@ostra/adapter-sdk/testing/net";
import type { FakeNpmRegistry, PackedPackage } from "@ostra/adapter-sdk/testing/net";
import { createCapturingTerminal } from "./cli/terminal.ts";
import { exitCodes, runCli } from "./cli/cli.ts";
import { afterEach, describe, expect, it } from "vitest";
import { applyPin, integrityMatches, PIN_REEXEC_ENV, sha512Integrity } from "./pin.ts";
import type { PinInput } from "./pin.ts";
import { startFakeServer } from "./testing/fake-server.ts";
import type { FakeServer } from "./testing/fake-server.ts";
import { RUNNER_VERSION } from "./version.ts";

// Ticket 19 (F-061): the pin, against ticket 06's fake npm registry and npm's real install. The
// stand-in CLI the registry serves writes what it was started with to a file the test names, so a
// run of it, or the lack of one, can be checked.

const folders: string[] = [];
const servers: (FakeNpmRegistry | FakeServer)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ostra-pin-"));
  folders.push(dir);
  return dir;
};

/** A stand-in CLI at `version` that records its arguments and its environment's marks, then exits 7. */
const recordingCli = (version: string): Promise<PackedPackage> =>
  packNpmPackage(
    { name: "ostra", version, bin: { ostra: "bin/ostra.js" }, license: "Apache-2.0" },
    {
      "bin/ostra.js": [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `fs.writeFileSync(process.env.PIN_TEST_OUT, JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2), reexec: process.env.${PIN_REEXEC_ENV} ?? null, kept: process.env.PIN_TEST_KEPT ?? null }));`,
        "process.exit(7);",
        "",
      ].join("\n"),
    },
  );

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

const silent = createCapturingTerminal().logger;

const baseInput = (dataDir: string, registry: string, out: string): PinInput => ({
  info: {
    protocolMajor: 1,
    serverMinor: 4,
    supported: { min: 3, max: 4 },
    serverVersion: "1.4.1",
    panelUrl: "http://127.0.0.1:1",
    deviceClientId: "ostra-runner",
    npm: { package: "ostra", registry },
  },
  install: "npm",
  version: "1.4.0",
  enabled: true,
  registryOverride: null,
  dataDir,
  args: ["runner", "--server", "http://127.0.0.1:1"],
  env: { PIN_TEST_OUT: out, PIN_TEST_KEPT: "yes", PATH: process.env["PATH"] },
  logger: silent,
});

describe("the pin (F-061)", () => {
  it("F-061: an npm install whose version differs installs the server's version from the registry into its data folder, and runs it once with the same arguments and environment", async () => {
    const registry = await startFakeNpmRegistry([await recordingCli("1.4.0"), await recordingCli("1.4.1")]);
    servers.push(registry);
    const dataDir = await tempDir();
    const out = path.join(dataDir, "ran.json");
    const outcome = await applyPin(baseInput(dataDir, registry.url, out));
    expect(outcome).toEqual({ kind: "ran", version: "1.4.1", exitCode: 7 });
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({ version: "1.4.1", args: ["runner", "--server", "http://127.0.0.1:1"], reexec: "1.4.1", kept: "yes" });
    // Installed under the data folder, by its version, and nothing of its download left beside it.
    expect(await exists(path.join(dataDir, "versions", "1.4.1", "node_modules", "ostra", "bin", "ostra.js"))).toBe(true);
    expect((await readdir(path.join(dataDir, "versions"))).filter((name) => name !== ".npm-cache")).toEqual(["1.4.1"]);
    expect(registry.requests().map((request) => request.path)).toEqual(expect.arrayContaining(["/ostra", "/ostra/-/ostra-1.4.1.tgz"]));
  }, 180_000);

  it("F-061: the integrity check refuses a tampered tarball: nothing of it runs, and the installed version starts instead", async () => {
    const good = await recordingCli("1.4.1");
    const tampered = await recordingCli("6.6.6");
    // The registry's packument names 1.4.1's integrity, and it serves another tarball under it.
    const registry = await startFakeNpmRegistry([{ ...good, tarball: tampered.tarball }]);
    servers.push(registry);
    const dataDir = await tempDir();
    const out = path.join(dataDir, "ran.json");
    const outcome = await applyPin(baseInput(dataDir, registry.url, out));
    expect(outcome).toEqual({ kind: "continue", reason: "integrity" });
    expect(await exists(out)).toBe(false);
    expect(await exists(path.join(dataDir, "versions", "1.4.1"))).toBe(false);
  }, 180_000);

  it("F-061: the loop guard: the version a pin started never pins again", async () => {
    const registry = await startFakeNpmRegistry([await recordingCli("1.4.1")]);
    servers.push(registry);
    const dataDir = await tempDir();
    const input = baseInput(dataDir, registry.url, path.join(dataDir, "ran.json"));
    const outcome = await applyPin({ ...input, env: { ...input.env, [PIN_REEXEC_ENV]: "1.4.1" } });
    expect(outcome).toEqual({ kind: "continue", reason: "reexec" });
    expect(registry.requests()).toEqual([]);
  });

  it("F-061: from the image or from source it installs nothing; OSTRA_RUNNER_PIN=false and the same version do nothing", async () => {
    const registry = await startFakeNpmRegistry([await recordingCli("1.4.1")]);
    servers.push(registry);
    const dataDir = await tempDir();
    const input = baseInput(dataDir, registry.url, path.join(dataDir, "ran.json"));
    expect(await applyPin({ ...input, install: "image" })).toEqual({ kind: "continue", reason: "not-npm" });
    expect(await applyPin({ ...input, install: "source" })).toEqual({ kind: "continue", reason: "not-npm" });
    expect(await applyPin({ ...input, enabled: false })).toEqual({ kind: "continue", reason: "off" });
    expect(await applyPin({ ...input, version: "1.4.1" })).toEqual({ kind: "continue", reason: "same-version" });
    expect(await applyPin({ ...input, info: { ...input.info, npm: null } })).toEqual({ kind: "continue", reason: "no-package" });
    expect(registry.requests()).toEqual([]);
    expect(await exists(path.join(dataDir, "versions"))).toBe(false);
  });

  it("F-061: OSTRA_RUNNER_NPM_REGISTRY wins over the server's registry", async () => {
    const mirror = await startFakeNpmRegistry([await recordingCli("1.4.1")]);
    servers.push(mirror);
    const dataDir = await tempDir();
    const out = path.join(dataDir, "ran.json");
    const outcome = await applyPin({ ...baseInput(dataDir, "http://127.0.0.1:1", out), registryOverride: mirror.url });
    expect(outcome).toMatchObject({ kind: "ran", exitCode: 7 });
    expect(mirror.requests().map((request) => request.path)).toContain("/ostra/-/ostra-1.4.1.tgz");
  }, 180_000);

  it("F-061: only a sha512 integrity that matches passes", () => {
    const bytes = Buffer.from("the tarball");
    const integrity = sha512Integrity(bytes);
    expect(integrityMatches(integrity, sha512Integrity(bytes))).toBe(true);
    expect(integrityMatches(integrity, sha512Integrity(Buffer.from("another")))).toBe(false);
    expect(integrityMatches(undefined, integrity)).toBe(false);
    expect(integrityMatches("sha1-abc", "sha1-abc")).toBe(false);
  });

  it("F-061: `ostra runner` installed from npm reads the server's version from /runner/v1/info and runs it in its place, with its arguments", async () => {
    const registry = await startFakeNpmRegistry([await packFakeCli("1.4.0"), await recordingCli("1.4.1")]);
    servers.push(registry);
    const fake = await startFakeServer({ info: { serverVersion: "1.4.1", npm: { package: "ostra", registry: registry.url } } });
    servers.push(fake);
    const dataDir = await tempDir();
    const out = path.join(dataDir, "ran.json");
    const terminal = createCapturingTerminal();
    const args = ["runner", "--server", fake.url, "--data-dir", dataDir];
    const code = await runCli(args, {
      env: { PIN_TEST_OUT: out, PATH: process.env["PATH"] },
      terminal,
      signal: new AbortController().signal,
      install: "npm",
      runSignedIn: () => Promise.resolve(exitCodes.ok),
      runSidecar: () => Promise.resolve(exitCodes.usage),
    });
    expect(RUNNER_VERSION).not.toBe("1.4.1");
    expect(code).toBe(7);
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ version: "1.4.1", args, reexec: "1.4.1" });
    // It ran instead of signing in: nothing registered with this version.
    expect(fake.runners.size).toBe(0);
  }, 180_000);
});
