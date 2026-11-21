// `node scripts/release-assets.ts <out-dir>`: makes the files the GitHub release carries
// (`releaseAssets`, ADR 0064 amended 2026-11-21) from the tree as the release's stamp leaves it,
// and lists each with its size and SHA-256. The compose file is copied as it is; each chart is
// packaged by Helm (`helm package`, a tool on the machine, never a dependency, ADR 0060) and kept
// under its asset name, so `releases/latest/download/ostra-server.tgz` is always the newest. A
// chart Helm packages at another version than the release's fails it, as does a missing or extra
// file. `release.yml` runs it after its checks; its real run attaches the folder to the release,
// and its dry run only lists it.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { releaseAssets } from "./release.ts";

const run = promisify(execFile);

/** Packages the chart in `chartDir` into `destination`, as `<chart>-<version>.tgz`. */
export type PackageChart = (chartDir: string, destination: string) => Promise<void>;

/** Helm's own packaging, with its arguments as an array. */
const helmPackage: PackageChart = async (chartDir, destination) => {
  await run("helm", ["package", chartDir, "--destination", destination]);
};

export type MadeAsset = { readonly name: string; readonly bytes: number; readonly sha256: string };

// package.json is npm's format, so unknown fields are tolerated.
const rootSchema = z.looseObject({ version: z.string().min(1) });

/**
 * Makes every file of `releaseAssets` in `out`, which must be empty or new, from the checkout at
 * `root`. `packageChart` is Helm's but in a test.
 */
export const makeReleaseAssets = async (root: string, out: string, packageChart: PackageChart = helmPackage): Promise<readonly MadeAsset[]> => {
  const { version } = rootSchema.parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
  await mkdir(out, { recursive: true });
  const before = await readdir(out);
  if (before.length > 0) {
    throw new Error(`${out} already holds ${before.join(", ")}: the release's files go in an empty folder`);
  }
  for (const asset of releaseAssets) {
    const target = path.join(out, asset.name);
    switch (asset.from.kind) {
      case "file":
        await copyFile(path.join(root, ...asset.from.path.split("/")), target);
        break;
      case "chart": {
        const packaged = await mkdtemp(path.join(tmpdir(), "ostra-chart-"));
        try {
          await packageChart(path.join(root, "deploy", "helm", asset.from.chart), packaged);
          const expected = `${asset.from.chart}-${version}.tgz`;
          const made = await readdir(packaged);
          if (made.length !== 1 || made[0] !== expected) {
            throw new Error(`helm package made ${made.join(", ") || "nothing"} of ${asset.from.chart}, not ${expected}: the chart isn't stamped with the release's version`);
          }
          await copyFile(path.join(packaged, expected), target);
        } finally {
          await rm(packaged, { recursive: true, force: true });
        }
        break;
      }
      default:
        asset.from satisfies never;
    }
  }
  const names = (await readdir(out)).sort();
  const expected = releaseAssets.map((asset) => asset.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`${out} holds ${names.join(", ")}, not the release's files ${expected.join(", ")}`);
  }
  return Promise.all(
    releaseAssets.map(async (asset) => {
      const bytes = await readFile(path.join(out, asset.name));
      return { name: asset.name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }),
  );
};

const main = async (): Promise<number> => {
  const out = process.argv[2];
  if (out === undefined || out === "") {
    process.stderr.write("release-assets: give the folder to make the release's files in: node scripts/release-assets.ts <out-dir>\n");
    return 1;
  }
  const made = await makeReleaseAssets(path.resolve(import.meta.dirname, ".."), path.resolve(out));
  for (const asset of made) {
    process.stdout.write(`${asset.sha256}  ${asset.name}  (${String(asset.bytes)} bytes)\n`);
  }
  process.stdout.write(`release-assets: ${String(made.length)} files in ${out}\n`);
  return 0;
};

if (import.meta.main) {
  process.exitCode = await main();
}
