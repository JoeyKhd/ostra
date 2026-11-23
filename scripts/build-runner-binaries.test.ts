import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEVELOPMENT_VERSION, releaseFiles } from "@ostra/protocol";
import { afterAll, describe, expect, it } from "vitest";

import { buildBinaries, buildPlan, CHECKSUMS, checkoutRoot, selectTargets, stampedVersion, UNSIGNED_SUMS } from "./build-runner-binaries.ts";
import type { RunCommand, ZipFiles } from "./build-runner-binaries.ts";

// F-085's binary build (ticket 01, ADR 0075): the plan is data, `--dry-run` prints it and runs
// nothing, a clone's 0.0.0 and a non-empty output folder are refused, and the run makes the
// binaries, their zips and both checksum files. Bun isn't installed or run: the test's commands
// stand in for it, so the plan is what's checked.

const temp = await mkdtemp(path.join(tmpdir(), "ostra-binaries-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const fakeRun = (): RunCommand => async (command) => {
  await writeFile(command[command.length - 1] ?? "", command.join(" "));
};

const fakeZip = (): ZipFiles => async (archive, files) => {
  await writeFile(archive, `zip of ${files.map((file) => path.basename(file)).join(" ")}`);
};

describe("the build's plan", () => {
  it("F-085/c6: three targets, their Bun targets, folders, executable names and the release's own zip names", () => {
    const plan = buildPlan(checkoutRoot, path.join(temp, "plan"));
    expect(plan.targets.map((target) => target.target.name)).toEqual(["darwin-arm64", "darwin-x64", "windows-x64"]);
    expect(plan.targets.map((target) => target.target.bunTarget)).toEqual(["bun-darwin-arm64", "bun-darwin-x64", "bun-windows-x64"]);
    expect(plan.targets.map((target) => target.relativeBinary)).toEqual(["darwin-arm64/ostra", "darwin-x64/ostra", "windows-x64/ostra.exe"]);
    expect(plan.targets.map((target) => path.basename(target.zip))).toEqual([releaseFiles.darwinArm64, releaseFiles.darwinX64, releaseFiles.windowsX64]);
    expect(plan.targets[0]?.command).toEqual(["bun", "build", "--compile", "--target=bun-darwin-arm64", "apps/runner/src/main.ts", "--external=bufferutil", "--external=utf-8-validate", "--outfile", path.join(temp, "plan", "darwin-arm64", "ostra")]);
    expect(plan.targets[2]?.zipCommand).toEqual(["zip", "-X", "-j", path.join(temp, "plan", releaseFiles.windowsX64), path.join(temp, "plan", "windows-x64", "ostra.exe"), path.join(temp, "plan", "windows-x64", "LICENSE")]);
    expect(selectTargets("darwin-x64").map((target) => target.name)).toEqual(["darwin-x64"]);
    expect(selectTargets(null)).toHaveLength(3);
    expect(() => selectTargets("linux-x64")).toThrow(/unknown target linux-x64: the targets are darwin-arm64, darwin-x64, windows-x64/);
  });

  it("F-085/c6: --dry-run prints one bun build --compile line per target and runs no command", async () => {
    const out = path.join(temp, "dry-out");
    const plan = buildPlan(checkoutRoot, out);
    const lines = await buildBinaries(plan, {
      dryRun: true,
      run: () => {
        throw new Error("a command ran in a dry run");
      },
      zip: () => {
        throw new Error("a zip ran in a dry run");
      },
    });
    expect(lines).toHaveLength(6);
    const builds = lines.filter((line) => line.startsWith("bun build --compile"));
    expect(builds).toHaveLength(3);
    expect(builds[0]).toContain("--target=bun-darwin-arm64");
    expect(builds[2]).toContain("--target=bun-windows-x64");
    await expect(readdir(out)).rejects.toThrow();
  });

  it("F-085/c6: a clone's 0.0.0 is refused until the tree is stamped, and the stamped version is the build's", async () => {
    const clone = path.join(temp, "clone");
    await mkdir(clone, { recursive: true });
    await writeFile(path.join(clone, "package.json"), `${JSON.stringify({ version: DEVELOPMENT_VERSION })}\n`);
    await expect(stampedVersion(clone)).rejects.toThrow(/run node scripts\/version\.ts/);
    await writeFile(path.join(clone, "package.json"), `${JSON.stringify({ version: "1.2.3" })}\n`);
    expect(await stampedVersion(clone)).toBe("1.2.3");
  });
});

describe("the build's output", () => {
  it("F-085/c6: each binary beside its LICENSE, one zip per target, unsigned-sha256.txt for signing and SHA256SUMS over the zips", async () => {
    const out = path.join(temp, "made");
    const plan = buildPlan(checkoutRoot, out);
    const made = await buildBinaries(plan, { run: fakeRun(), zip: fakeZip() });
    expect((await readdir(out)).sort()).toEqual([...plan.targets.map((target) => target.target.folder), ...plan.targets.map((target) => path.basename(target.zip)), CHECKSUMS, UNSIGNED_SUMS].sort());
    const license = await readFile(path.join(checkoutRoot, "LICENSE"), "utf8");
    const unsigned = (await readFile(path.join(out, UNSIGNED_SUMS), "utf8")).trim().split("\n");
    expect(unsigned.map((line) => line.split("  ")[1])).toEqual(plan.targets.map((target) => target.relativeBinary));
    for (const target of plan.targets) {
      expect(await readFile(target.license, "utf8")).toBe(license);
      expect(unsigned).toContain(`${sha256(await readFile(target.binary))}  ${target.relativeBinary}`);
    }
    const sums = (await readFile(path.join(out, CHECKSUMS), "utf8")).trim().split("\n");
    expect(sums.map((line) => line.split("  ")[1])).toEqual([releaseFiles.darwinArm64, releaseFiles.darwinX64, releaseFiles.windowsX64]);
    for (const target of plan.targets) {
      expect(sums).toContain(`${sha256(await readFile(target.zip))}  ${path.basename(target.zip)}`);
    }
    expect(made.map((line) => line.split("  ")[1])).toEqual([releaseFiles.darwinArm64, releaseFiles.darwinX64, releaseFiles.windowsX64]);
    // A second run into the same folder ships nothing stale.
    await expect(buildBinaries(plan, { run: fakeRun(), zip: fakeZip() })).rejects.toThrow(/already holds/);
  });
});
