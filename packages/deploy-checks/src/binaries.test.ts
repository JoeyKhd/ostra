import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { releaseFiles } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { BUN_LINUX_X64_SHA256, BUN_LINUX_X64_URL, BUN_VERSION, binaryFileNames, binaryProblems, binaryTargets, bunArchiveUrl, bunPin, bunPinSchema, jobBlock } from "./binaries.ts";
import type { BunPin } from "./binaries.ts";
import { installBun, sha256Of } from "./install-bun.ts";

// F-085's binary build (ticket 01, ADR 0075): the pinned Bun and the three platforms, the release's
// names, and the release.yml job that builds and hashes them. The repo's own files pass; a copy
// broken in one place fails with that rule. The installer's checks run on injected bytes, so no
// test needs the network, Bun or a certificate.

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const workflow = await readFile(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

const rules = (options: { readonly workflowText?: string; readonly releaseFiles?: Readonly<Record<string, string>>; readonly pin?: BunPin } = {}): readonly string[] =>
  binaryProblems({ releaseFiles: options.releaseFiles ?? releaseFiles }, options.workflowText ?? workflow, options.pin ?? bunPin).map((problem) => problem.rule);

const broken = (from: string | RegExp, to: string): string => {
  const changed = workflow.replace(from, to);
  expect(changed).not.toBe(workflow);
  return changed;
};

describe("the pinned Bun", () => {
  it("F-085/c7: the pin is a Bun version, the archive of that same version and its 64-character SHA-256", () => {
    expect(BUN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUN_LINUX_X64_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(BUN_LINUX_X64_URL).toBe(bunArchiveUrl(BUN_VERSION));
    expect(bunPin).toEqual({ version: BUN_VERSION, url: BUN_LINUX_X64_URL, sha256: BUN_LINUX_X64_SHA256 });
    expect(binaryProblems({ releaseFiles }, workflow)).toEqual([]);
    // A pin of another shape, or for another version's archive, is a problem the check names.
    expect(rules({ pin: { ...bunPin, sha256: bunPin.sha256.slice(1) } })).toContain("pin");
    expect(rules({ pin: { ...bunPin, sha256: `${bunPin.sha256.slice(0, 63)}g` } })).toContain("pin");
    expect(rules({ pin: { ...bunPin, version: "1.4" } })).toContain("pin");
    expect(rules({ pin: { ...bunPin, url: bunArchiveUrl("1.0.0") } })).toContain("pin");
  });

  it("F-085/c7: the installer refuses bytes whose SHA-256 isn't the pin's, naming both hashes, and accepts a well-formed pin whose hash matches", async () => {
    const archive = new TextEncoder().encode("not the archive the repository pinned");
    const out = await mkdtemp(path.join(tmpdir(), "ostra-bun-"));
    try {
      await expect(installBun({ out, download: () => Promise.resolve(archive) })).rejects.toThrow(new RegExp(`has SHA-256 ${sha256Of(archive)}, not the pinned ${bunPin.sha256}`));
      const bytes = new TextEncoder().encode("a stand-in for Bun's archive");
      const pin = bunPinSchema.parse({ version: "9.9.9", url: bunArchiveUrl("9.9.9"), sha256: sha256Of(bytes) });
      let unpacked = "";
      const installed = await installBun({
        out,
        pin,
        download: () => Promise.resolve(bytes),
        unzip: async (source, target) => {
          unpacked = source;
          await writeFile(path.join(target, "bun"), "a stand-in for bun");
        },
        version: () => Promise.resolve("9.9.9"),
      });
      expect(installed).toEqual({ binary: path.join(path.resolve(out), "bun"), version: "9.9.9" });
      expect(unpacked).toMatch(/bun-linux-x64\.zip$/);
      // The unpacked binary must be the pin's version, not just a Bun version.
      await expect(installBun({ out, pin, download: () => Promise.resolve(bytes), unzip: (_source, target) => writeFile(path.join(target, "bun"), "x"), version: () => Promise.resolve("1.0.0") })).rejects.toThrow(/bun "1\.0\.0", not the pinned 9\.9\.9/);
      await expect(installBun({ out, pin: { ...pin, sha256: "not-a-hash" } })).rejects.toThrow();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("the runner's downloads", () => {
  it("F-085/c3: releaseFiles names exactly the three platform zips and SHA256SUMS, and the repo's own names pass", () => {
    expect(binaryFileNames()).toEqual([releaseFiles.darwinArm64, releaseFiles.darwinX64, releaseFiles.windowsX64, releaseFiles.checksums]);
    expect(binaryFileNames()).toEqual(["ostra-darwin-arm64.zip", "ostra-darwin-x64.zip", "ostra-windows-x64.zip", "SHA256SUMS"]);
    expect(binaryTargets.map((target) => target.name)).toEqual(["darwin-arm64", "darwin-x64", "windows-x64"]);
    expect(binaryTargets.map((target) => target.executable)).toEqual(["ostra", "ostra", "ostra.exe"]);
    const without = Object.fromEntries(Object.entries(releaseFiles).filter(([key]) => key !== "darwinX64"));
    expect(rules({ releaseFiles: without })).toContain("names");
    expect(binaryProblems({ releaseFiles: without }, workflow).map((problem) => problem.message)).toContainEqual(expect.stringContaining("darwin-x64"));
    expect(rules({ releaseFiles: { ...releaseFiles, windowsX64: "ostra-windows-arm64.zip" } })).toContain("names");
    expect(rules({ releaseFiles: { ...releaseFiles, linuxX64: "ostra-linux-x64.zip" } })).toContain("names");
    expect(binaryProblems({ releaseFiles: { ...releaseFiles, linuxX64: "ostra-linux-x64.zip" } }, workflow).map((problem) => problem.message)).toContainEqual(expect.stringContaining("ostra-linux-x64.zip"));
  });
});

describe("release.yml's build job", () => {
  it("F-085/c5: the runner-binaries job installs the pinned Bun, builds, uploads, reads no secret, and nothing unsigned is attached", () => {
    expect(jobBlock(workflow, "runner-binaries")).not.toBeNull();
    expect(rules()).toEqual([]);
    // A missing job, installer or build, and an artifact that isn't uploaded, are each named.
    const withoutJob = workflow.replace(/^  runner-binaries:\n(?: {2,}.*\n|\n)*/m, "");
    expect(withoutJob).not.toBe(workflow);
    expect(binaryProblems({ releaseFiles }, withoutJob).map((problem) => problem.rule)).toContain("build-job");
    expect(rules({ workflowText: broken("node packages/deploy-checks/src/install-bun.ts --out \"$OUT/bin\"", "true") })).toContain("build-job");
    expect(rules({ workflowText: broken('node scripts/build-runner-binaries.ts "$OUT/binaries"', "true") })).toContain("build-job");
    expect(rules({ workflowText: broken(/^ {6}- uses: actions\/upload-artifact@[0-9a-f]{40} # v7\.0\.2$/m, "      - run: true") })).toContain("build-job");
    // A secret in the build job fails it: only the signing jobs of tickets 02 and 03 may hold one.
    expect(rules({ workflowText: broken("      - name: Install the pinned Bun", "      - name: Install the pinned Bun\n        env:\n          TOKEN: ${{ secrets.ANY }}") })).toContain("build-secrets");
    // The binaries reach a release only when the release job needs both signatures.
    const attached = broken('$prerelease "$OUT"/assets/*', '$prerelease "$OUT"/assets/* "$OUT"/binaries/*');
    expect(rules({ workflowText: attached })).toContain("attach-before-signing");
    const signed = attached.replace("  release:\n    runs-on: ubuntu-24.04", "  release:\n    needs: [runner-binaries, sign-macos, sign-windows]\n    runs-on: ubuntu-24.04");
    expect(signed).not.toBe(attached);
    expect(binaryProblems({ releaseFiles }, signed)).toEqual([]);
  });
});
