import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { z } from "zod";

import { LICENSOR, REPOSITORY_URL } from "../../../../scripts/licensor.ts";

// The npm CLI (ADR 0046, milestone 5's ticket 19, F-013): `pnpm --filter @ostra/runner pack:cli`
// bundles the `ostra` program and everything it imports into one file, `dist/npm/dist/ostra.js`,
// beside a package.json with no dependencies, the `ostra` bin and `engines` (Node 24.5 or later,
// for `proxyEnv`), and packs that folder with npm into `dist/npm/<name>-<version>.tgz`. Node won't
// strip types under `node_modules`, and the workspace's packages aren't published, so the tarball
// carries JavaScript only, and nothing for npm to fetch.
//
// The package's name is the maintainer's to register before milestone 7 (ADR 0046: npm's `ostra`
// is taken): the root package.json's `cliPackage`, which the release's stamp writes
// (`node scripts/version.ts`), and the placeholder `ostra` in a clone.
//
// The bundle inlines the root package.json, which `version.ts` imports for the release's names, as
// those two fields alone: the rest of it (the workspace's scripts, its license) isn't the CLI's.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootManifest = path.resolve(packageRoot, "..", "..", "package.json");

const runnerPackageSchema = z.looseObject({ version: z.string().min(1), license: z.string().min(1), engines: z.looseObject({ node: z.string().min(1) }) });

/** The release's names on the root package.json, as the stamp writes them. */
const releaseNamesSchema = z.looseObject({ imageNamespace: z.string().min(1), cliPackage: z.string().min(1) });

/** Loads the root package.json into the bundle as the release's names, and nothing else of it. */
const releaseNamesOnly = (names: z.infer<typeof releaseNamesSchema>): Plugin => ({
  name: "release-names-only",
  setup: (bundle) => {
    bundle.onLoad({ filter: /package\.json$/ }, (args) =>
      path.resolve(args.path) === rootManifest ? { contents: JSON.stringify({ imageNamespace: names.imageNamespace, cliPackage: names.cliPackage }), loader: "json" } : undefined,
    );
  },
});

/**
 * The CLI package's manifest (milestone 7's ticket 30): the bundle and its LICENSE only, public,
 * with npm's provenance, the repository and the licensor as its author (`scripts/licensor.ts`).
 */
export const cliManifest = (name: string, runner: z.infer<typeof runnerPackageSchema>): Record<string, unknown> => ({
  name,
  version: runner.version,
  description: "The ostra CLI: a runner for ostra's coding agents, its sidecar, and a member's login and checkout",
  license: runner.license,
  author: LICENSOR,
  repository: { type: "git", url: REPOSITORY_URL, directory: "apps/runner" },
  type: "module",
  bin: { ostra: "dist/ostra.js" },
  files: ["dist", "LICENSE"],
  engines: { node: runner.engines.node },
  publishConfig: { access: "public", provenance: true },
});

export type PackedCli ={ readonly tarball: string; readonly name: string; readonly version: string; readonly folder: string };

/** npm's own CLI, run by this Node with no shell: beside `node` on Windows, under `lib/` elsewhere. */
const npmCli = async (): Promise<readonly string[]> => {
  const beside = path.dirname(process.execPath);
  for (const candidate of [path.join(beside, "node_modules", "npm", "bin", "npm-cli.js"), path.join(beside, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (await stat(candidate).then(() => true, () => false)) {
      return [process.execPath, candidate];
    }
  }
  return ["npm"];
};

const run = async (args: readonly string[], cwd: string): Promise<string> => {
  const [command = "npm", ...prefix] = await npmCli();
  return new Promise((resolve, reject) => {
    execFile(command, [...prefix, ...args], { cwd, windowsHide: true, timeout: 300_000 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
      } else {
        reject(new Error(`npm ${args.join(" ")} failed: ${stderr.slice(0, 2000)}`));
      }
    });
  });
};

export const packCli = async (options: { readonly outDir?: string; readonly name?: string } = {}): Promise<PackedCli> => {
  const runner = runnerPackageSchema.parse(JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")));
  const names = releaseNamesSchema.parse(JSON.parse(await readFile(rootManifest, "utf8")));
  const folder = options.outDir ?? path.join(packageRoot, "dist", "npm");
  const name = options.name ?? names.cliPackage;
  await rm(folder, { recursive: true, force: true });
  await mkdir(path.join(folder, "dist"), { recursive: true });
  await build({
    entryPoints: [path.join(packageRoot, "src", "main.ts")],
    outfile: path.join(folder, "dist", "ostra.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // `ws`'s optional native speed-ups: it runs without them.
    external: ["bufferutil", "utf-8-validate"],
    // Some of the bundled packages are CommonJS and `require` Node's own modules.
    banner: { js: 'import { createRequire as __ostraCreateRequire } from "node:module"; const require = __ostraCreateRequire(import.meta.url);' },
    legalComments: "linked",
    logLevel: "warning",
    plugins: [releaseNamesOnly(names)],
  });
  await writeFile(path.join(folder, "package.json"), `${JSON.stringify(cliManifest(name, runner), null, 2)}\n`);
  await writeFile(path.join(folder, "LICENSE"), await readFile(path.join(packageRoot, "LICENSE"), "utf8"));
  const packed = await run(["pack", "--json", "--pack-destination", folder], folder);
  const filename = z.array(z.looseObject({ filename: z.string().min(1) })).min(1).parse(JSON.parse(packed))[0]?.filename ?? "";
  return { tarball: path.join(folder, filename), name, version: runner.version, folder };
};

if (import.meta.main) {
  const packed = await packCli();
  process.stdout.write(`${packed.tarball}\n`);
}
