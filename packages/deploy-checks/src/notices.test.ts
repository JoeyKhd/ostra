import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { isKnownBundledLicense } from "../../../scripts/known-licenses.ts";
import { checkoutNotices } from "./checkout-notices.ts";
import { imageNames } from "./images.ts";
import { runNotices } from "./notices-main.ts";
import { installedInPnpmStore, isAgentPackage, listedInNotices, packagesFromNodeModules, readExtraNotice, refOf, renderNotices } from "./notices.ts";
import { repoRoot } from "./repo.ts";

// Milestone 7's ticket 29 (F-039): each image's THIRD_PARTY_NOTICES. The first block makes the
// three images' notices from this checkout's install, as `pnpm check:images` does; the rest run the
// generator each image's build runs (`notices-main.ts`) on a small install written to a temp folder.

const temp = await mkdtemp(path.join(tmpdir(), "ostra-notices-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

describe("each image's notices, from this checkout's install", () => {
  const all = Promise.all(imageNames.map((name) => checkoutNotices(name)));

  it("F-039/c1: the notices list every package each image bundles, each with its license, and the runner's no agent", async () => {
    for (const image of await all) {
      expect(image.problems, image.image).toEqual([]);
      expect(image.bundled.length, image.image).toBeGreaterThan(0);
      const listed = new Set(listedInNotices(image.notices).map(refOf));
      for (const item of image.bundled) {
        expect(listed.has(refOf(item)), `${image.image}: ${refOf(item)}`).toBe(true);
      }
      // The two accounts of the install agree: pnpm list names exactly what the notices list.
      expect(new Set(image.bundled.map(refOf)), image.image).toEqual(listed);
      for (const item of image.packages) {
        expect(isKnownBundledLicense(item.license), `${image.image}: ${refOf(item)}`).toBe(true);
      }
    }
    const [server, runner, base] = await all;
    // zod is in all three, with its license file's own text.
    for (const image of [server, runner, base]) {
      expect(image?.notices).toMatch(/^Package: zod@\d+\.\d+\.\d+\nLicense: MIT\n(?:Homepage: .*\n)?-{78}\n--- LICENSE(?:\.md)? ---\nMIT License/m);
    }
    // The server keeps OpenCode (core depends on its adapter); the runner's install drops it.
    expect(server?.bundled.some(isAgentPackage)).toBe(true);
    expect(runner?.bundled.some(isAgentPackage)).toBe(false);
    expect(runner?.packages.some(isAgentPackage)).toBe(false);
  });

  it("F-039/c1: a bundled package left out of the notices fails, naming it", async () => {
    const dropped = await checkoutNotices("runner", (packages) => renderNotices("runner", packages.filter((item) => item.name !== "ws")));
    expect(dropped.problems.map((problem) => problem.message)).toEqual([expect.stringMatching(/^ws@\S+ is bundled but missing from the notices$/)]);
    expect(dropped.problems[0]?.rule).toBe("notices");
  });
});

/** Writes a package folder: its package.json and, when given, a LICENSE. */
const writePackage = async (dir: string, manifest: Record<string, unknown>, license?: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(manifest), "utf8");
  if (license !== undefined) {
    await writeFile(path.join(dir, "LICENSE"), license, "utf8");
  }
};

type PnpmReport = Record<string, { name: string; versions: string[]; paths: string[]; license: string }[]>;

/** A pnpm install's store, as an image's build has it, and pnpm's report of it. */
const pnpmInstall = async (name: string, packages: readonly { name: string; version: string; license: string; text?: string }[]): Promise<{ store: string; report: PnpmReport }> => {
  const store = path.join(temp, name, "node_modules", ".pnpm");
  const report: PnpmReport = {};
  for (const item of packages) {
    const folder = path.join(store, `${item.name.replace("/", "+")}@${item.version}`, "node_modules");
    const dir = path.join(folder, ...item.name.split("/"));
    await writePackage(dir, { name: item.name, version: item.version, license: item.license }, item.text);
    (report[item.license] ??= []).push({ name: item.name, versions: [item.version], paths: [dir], license: item.license });
  }
  // A dependency's link beside the package, which isn't a second package (a junction works on Windows too).
  const [first, second] = packages;
  if (first !== undefined && second !== undefined) {
    const from = path.join(store, `${first.name.replace("/", "+")}@${first.version}`, "node_modules", ...second.name.split("/"));
    await mkdir(path.dirname(from), { recursive: true });
    await symlink(path.join(store, `${second.name.replace("/", "+")}@${second.version}`, "node_modules", ...second.name.split("/")), from, "junction");
  }
  return { store, report };
};

const writeJson = async (file: string, value: unknown): Promise<string> => {
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
};

const MIT = "MIT License\n\nCopyright (c) a maker";

describe("the generator an image's build runs", () => {
  it("F-039/c1: the notices list every package of the install with its license and license file, and match its store", async () => {
    const { store, report } = await pnpmInstall("complete", [
      { name: "left-pad", version: "1.3.0", license: "MIT", text: MIT },
      { name: "@scope/thing", version: "2.0.0", license: "(MIT OR CC0-1.0)", text: "CC0 text" },
      { name: "no-file", version: "0.1.0", license: "ISC" },
    ]);
    const out = path.join(temp, "complete", "THIRD_PARTY_NOTICES");
    const result = await runNotices(["--image", "runner", "--pnpm-licenses", await writeJson(path.join(temp, "complete.json"), report), "--pnpm-store", store, "--without-agent", "--out", out]);
    expect(result).toEqual({ code: 0, lines: [expect.stringContaining("3 third-party packages")] });
    const notices = await readFile(out, "utf8");
    expect(listedInNotices(notices).map(refOf)).toEqual(["@scope/thing@2.0.0", "left-pad@1.3.0", "no-file@0.1.0"]);
    expect(notices).toContain("Package: left-pad@1.3.0\nLicense: MIT\n" + "-".repeat(78) + "\n--- LICENSE ---\n" + MIT);
    expect(notices).toContain("Package: no-file@0.1.0\nLicense: ISC\n" + "-".repeat(78) + "\nThe package ships no license file; its package.json names ISC.");
    // The link in left-pad's folder isn't read as a package of its own.
    expect((await installedInPnpmStore(store)).map(refOf).sort()).toEqual(["@scope/thing@2.0.0", "left-pad@1.3.0", "no-file@0.1.0"]);
  });

  it("F-039/c1: a package in the install that pnpm's report leaves out fails the build", async () => {
    const { store, report } = await pnpmInstall("left-out", [
      { name: "kept", version: "1.0.0", license: "MIT", text: MIT },
      { name: "forgotten", version: "4.5.6", license: "MIT", text: MIT },
    ]);
    const partial = { MIT: (report["MIT"] ?? []).filter((item) => item.name !== "forgotten") };
    const result = await runNotices(["--image", "server", "--pnpm-licenses", await writeJson(path.join(temp, "left-out.json"), partial), "--pnpm-store", store, "--out", path.join(temp, "left-out", "N")]);
    expect(result).toEqual({ code: 1, lines: ["notices: forgotten@4.5.6 is bundled but missing from the notices"] });
  });

  it("F-039/c1: an unknown license fails the build: GPL, SSPL, a missing license and an expression with an unknown id", async () => {
    for (const license of ["GPL-3.0-only", "SSPL-1.0", "Unknown", "(MIT OR WTFPL)", "MIT AND AGPL-3.0-or-later"]) {
      const { store, report } = await pnpmInstall(`unknown-${String(license.length)}-${license.replaceAll(/\W/g, "")}`, [{ name: "odd", version: "1.0.0", license, text: "text" }]);
      const result = await runNotices(["--image", "base", "--pnpm-licenses", await writeJson(path.join(temp, `u-${license.replaceAll(/\W/g, "")}.json`), report), "--pnpm-store", store, "--out", path.join(temp, "u", "N")]);
      expect(result.code, license).toBe(1);
      expect(result.lines, license).toEqual([expect.stringMatching(/^notices: odd@1\.0\.0 is under .*, which the license check doesn't know \(scripts\/known-licenses\.ts\)$/)]);
    }
    for (const license of ["MIT", "Apache-2.0 AND LGPL-3.0-or-later", "(AFL-2.1 OR BSD-3-Clause)", "MIT and ISC", "BlueOak-1.0.0"]) {
      expect(isKnownBundledLicense(license), license).toBe(true);
    }
    expect(isKnownBundledLicense(null)).toBe(false);
  });

  it("F-039/c1: the runner's build fails when OpenCode is in its install", async () => {
    const { store, report } = await pnpmInstall("agent", [
      { name: "@opencode/cli", version: "2.3.2", license: "MIT", text: MIT },
      { name: "zod", version: "4.6.7", license: "MIT", text: MIT },
    ]);
    const args = ["--image", "runner", "--pnpm-licenses", await writeJson(path.join(temp, "agent.json"), report), "--pnpm-store", store, "--out", path.join(temp, "agent", "N")];
    expect(await runNotices([...args, "--without-agent"])).toEqual({ code: 1, lines: ["notices: @opencode/cli@2.3.2 is in the pnpm install, but the runner image carries no agent"] });
    expect((await runNotices(args)).code).toBe(0);
  });

  it("F-039/c1: the base image's notices add OpenCode's npm install, nested packages included, and the catalog's MIT notice", async () => {
    const modules = path.join(temp, "opencode", "node_modules");
    await writePackage(path.join(modules, "@opencode", "cli"), { name: "@opencode/cli", version: "2.3.2", license: "MIT" }, MIT);
    await writePackage(path.join(modules, "@opencode", "cli-linux-x64"), { name: "@opencode/cli-linux-x64", version: "2.3.2", license: { type: "MIT" } });
    await writePackage(path.join(modules, "@opencode", "cli", "node_modules", "nested"), { name: "nested", version: "0.0.1", license: "ISC" });
    expect((await packagesFromNodeModules(modules)).map((item) => `${refOf(item)} ${item.license ?? ""}`)).toEqual(["@opencode/cli@2.3.2 MIT", "nested@0.0.1 ISC", "@opencode/cli-linux-x64@2.3.2 MIT"]);

    const catalog = await readExtraNotice(path.join(repoRoot, "deploy", "notices", "models-dev.json"));
    expect(catalog).toMatchObject({ name: "models.dev", license: "MIT" });
    expect(catalog.texts[0]?.text).toMatch(/^MIT License\n\nCopyright \(c\) 2025 models\.dev/);

    const { store, report } = await pnpmInstall("base", [{ name: "zod", version: "4.6.7", license: "MIT", text: MIT }]);
    const out = path.join(temp, "base", "N");
    const result = await runNotices(["--image", "base", "--pnpm-licenses", await writeJson(path.join(temp, "base.json"), report), "--pnpm-store", store, "--without-agent", "--npm-modules", modules, "--extra", path.join(repoRoot, "deploy", "notices", "models-dev.json"), "--out", out]);
    expect(result.code).toBe(0);
    expect(listedInNotices(await readFile(out, "utf8")).map(refOf)).toEqual(["@opencode/cli@2.3.2", "@opencode/cli-linux-x64@2.3.2", "models.dev@catalog", "nested@0.0.1", "zod@4.6.7"]);
  });

  it("F-039/c1: an extra notice is ostra's own format: an unknown field fails", async () => {
    const file = await writeJson(path.join(temp, "extra.json"), { name: "x", version: "1", license: "MIT", homepage: "https://x", licenseFile: "x.LICENSE", note: "extra" });
    await expect(readExtraNotice(file)).rejects.toThrow(/must have exactly/);
  });
});
