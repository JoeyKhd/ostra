// What a release publishes, and the checks that it's ready to (milestone 7's ticket 30, ADR 0045,
// ADR 0064): the published packages and their manifests, the server packages kept private, one
// licensor line everywhere, and one version on every package. `pnpm check:release` runs the
// checks; `release.yml` runs them before it publishes anything.
//
// - **Published:** `@ostra/protocol`, `@ostra/adapter-sdk` and every adapter, each from its build
//   (`dist`, made by `tsconfig.build.json`) with its LICENSE, public, with npm's provenance, and the
//   CLI, which `apps/runner`'s `pack:cli` bundles into a package of its own (`pack-cli.ts`).
// - **Not published:** every other workspace package, the server's above all, is `private: true`.
// - **The licensor line** (ADR 0048) is `LICENSOR`, in `licensor.ts` and nowhere else in code: the root
//   LICENSE, NOTICE and every published package's `author` must say it, and any LICENSE that names a
//   copyright holder must name it. `node scripts/release.ts --write-licensor` writes it everywhere.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { COPYRIGHT_YEAR, LICENSOR, REPOSITORY_URL } from "./licensor.ts";

export { COPYRIGHT_YEAR, LICENSOR, REPOSITORY_URL } from "./licensor.ts";

/** The folders whose package is published from its build. The CLI is published from its pack. */
export const isPublishedDir = (dir: string): boolean => dir === "packages/protocol" || dir === "packages/adapter-sdk" || /^packages\/adapters\/[^/]+$/.test(dir);

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// package.json is npm's format, so unknown fields are tolerated.
const manifestSchema = z.looseObject({
  name: z.string().min(1),
  version: z.string().optional(),
  private: z.boolean().optional(),
  license: z.string().optional(),
  author: z.unknown().optional(),
  files: z.array(z.string()).optional(),
  exports: z.record(z.string(), z.string()).optional(),
  publishConfig: z.looseObject({ access: z.string().optional(), provenance: z.boolean().optional(), exports: z.unknown().optional() }).optional(),
  repository: z.unknown().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;

export type WorkspaceManifest = { readonly dir: string; readonly manifest: Manifest; readonly text: string };

/** The workspace's folders, from pnpm-workspace.yaml's `folder/*` and `folder` globs, with their package.json. */
export const readWorkspace = async (root: string): Promise<readonly WorkspaceManifest[]> => {
  const yaml = await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s*-\s+["']?([^"'#\s]+)["']?\s*$/gm)].map((match) => match[1] ?? "").filter((glob) => glob !== "" && !glob.startsWith("!"));
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -2);
      const entries = await readdir(path.join(root, parent), { withFileTypes: true }).catch(() => []);
      dirs.push(...entries.filter((entry) => entry.isDirectory() && entry.name !== "node_modules").map((entry) => `${parent}/${entry.name}`));
    } else if (!glob.includes("*")) {
      dirs.push(glob);
    }
  }
  const found: WorkspaceManifest[] = [];
  for (const dir of [...new Set(dirs)].sort()) {
    const text = await readFile(path.join(root, dir, "package.json"), "utf8").catch(() => null);
    if (text !== null) {
      found.push({ dir, manifest: manifestSchema.parse(JSON.parse(text)), text });
    }
  }
  return found;
};

/** A published package's exports, as its build has them: `./src/x.ts` becomes `./dist/x.js` with `./dist/x.d.ts`. */
export const builtExports = (exports: Readonly<Record<string, string>>): Record<string, { readonly types: string; readonly default: string }> =>
  Object.fromEntries(
    Object.entries(exports).map(([subpath, source]) => {
      const built = source.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "");
      return [subpath, { types: `${built}.d.ts`, default: `${built}.js` }];
    }),
  );

export type ReleaseProblem = { readonly file: string; readonly message: string };

/** The manifest problems of one published package (its folder's LICENSE is checked by the caller). */
export const publishedManifestProblems = (dir: string, manifest: Manifest): readonly ReleaseProblem[] => {
  const file = `${dir}/package.json`;
  const problems: string[] = [];
  if (manifest.private === true) {
    problems.push("is published, so it can't be private");
  }
  if (manifest.license !== "Apache-2.0") {
    problems.push("is published under Apache-2.0 (ADR 0048)");
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(["dist", "LICENSE"])) {
    problems.push('must publish only its build and its LICENSE: "files": ["dist", "LICENSE"]');
  }
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig.provenance !== true) {
    problems.push('needs "publishConfig": { "access": "public", "provenance": true }');
  }
  if (manifest.exports === undefined || JSON.stringify(manifest.publishConfig?.exports) !== JSON.stringify(builtExports(manifest.exports))) {
    problems.push("publishConfig.exports must point each export at its build (dist/*.js and dist/*.d.ts)");
  }
  if (JSON.stringify(manifest.repository) !== JSON.stringify({ type: "git", url: REPOSITORY_URL, directory: dir })) {
    problems.push(`needs "repository": { "type": "git", "url": "${REPOSITORY_URL}", "directory": "${dir}" }`);
  }
  if (manifest.author !== LICENSOR) {
    problems.push("its author must be the licensor line (scripts/licensor.ts, LICENSOR)");
  }
  if (manifest.scripts?.["build"] !== "tsc -p tsconfig.build.json") {
    problems.push('needs "build": "tsc -p tsconfig.build.json", which makes dist');
  }
  return problems.map((message) => ({ file, message }));
};

/** The packages a source file imports at run time: bare specifiers, not `node:`, relative or `import type`. */
export const runtimeImports = (source: string): readonly string[] => {
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? "";
    if (specifier === "" || specifier.startsWith("node:") || specifier.startsWith(".")) {
      continue;
    }
    names.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier));
  }
  return [...names];
};

/** The `.ts` files of a folder, tests left out (the build leaves them out too), by path. */
const sourceFiles = async (dir: string): Promise<readonly string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
};

/** A published package imports at run time only what it declares: a dev dependency isn't installed for its users. */
const undeclaredImports = async (root: string, dir: string, manifest: Manifest): Promise<readonly ReleaseProblem[]> => {
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
  const problems: ReleaseProblem[] = [];
  for (const file of await sourceFiles(path.join(root, dir, "src"))) {
    for (const name of runtimeImports(await readFile(file, "utf8"))) {
      if (!declared.has(name) && name !== manifest.name) {
        problems.push({ file: path.relative(root, file).replaceAll("\\", "/"), message: `imports ${name}, which ${manifest.name} doesn't declare in its dependencies` });
      }
    }
  }
  return problems;
};

/** The licensor line in the root LICENSE and NOTICE, and in any LICENSE that names a copyright holder. */
export const licensorProblems = (files: Readonly<Record<string, string>>): readonly ReleaseProblem[] => {
  const problems: ReleaseProblem[] = [];
  const copyright = `Copyright (c) ${COPYRIGHT_YEAR} ${LICENSOR}`;
  const required: Readonly<Record<string, readonly string[]>> = {
    LICENSE: [`Licensor and copyright holder: ${LICENSOR}`, copyright],
    NOTICE: [copyright],
  };
  for (const [file, lines] of Object.entries(required)) {
    for (const line of lines) {
      if (!(files[file] ?? "").split(/\r?\n/).includes(line)) {
        problems.push({ file, message: `must say "${line}"` });
      }
    }
  }
  for (const [file, text] of Object.entries(files)) {
    for (const match of text.matchAll(/^(?:Licensor and copyright holder: |Copyright \(c\) \d{4} )(.+)$/gm)) {
      if (match[1] !== LICENSOR) {
        problems.push({ file, message: `names "${match[1] ?? ""}" as the licensor, not "${LICENSOR}"` });
      }
    }
  }
  return problems;
};

/** The folders a NOTICE section lists, one indented path or `folder/*` per line, up to the next blank-line-then-text. */
const noticeFolders = (notice: string, heading: RegExp): readonly string[] => {
  const lines = notice.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return [];
  }
  const folders: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const folder = /^ {2}(\S+)$/.exec(line)?.[1];
    if (folder !== undefined) {
      folders.push(folder);
    } else if (folders.length > 0 && line.trim() !== "") {
      break;
    }
  }
  return folders;
};

const listed = (folders: readonly string[], dir: string): boolean => folders.some((folder) => folder === dir || (folder.endsWith("/*") && dir.startsWith(folder.slice(0, -1)) && !dir.slice(folder.length - 1).includes("/")));

/**
 * NOTICE is current: its Apache-2.0 list names every Apache-2.0 package's folder (by itself or by
 * `folder/*`) and nothing else, and every folder it lists under the Sustainable Use License is one.
 */
export const noticeProblems = (notice: string, workspace: readonly WorkspaceManifest[]): readonly ReleaseProblem[] => {
  const apache = noticeFolders(notice, /^Apache-2\.0\. Each of these directories/);
  const sustainable = noticeFolders(notice, /^Sustainable Use License, version 1\.0\./);
  const problems: ReleaseProblem[] = [];
  for (const { dir, manifest } of workspace) {
    const isApache = manifest.license === "Apache-2.0";
    if (isApache !== listed(apache, dir)) {
      problems.push({ file: "NOTICE", message: isApache ? `doesn't list ${dir}, which is Apache-2.0, among the Apache-2.0 directories` : `lists ${dir} among the Apache-2.0 directories, but it's ${manifest.license ?? "unlicensed"}` });
    }
    if (listed(sustainable, dir) && manifest.license !== "LicenseRef-Sustainable-Use-1.0") {
      problems.push({ file: "NOTICE", message: `lists ${dir} under the Sustainable Use License, but it's ${manifest.license ?? "unlicensed"}` });
    }
  }
  for (const folder of [...apache, ...sustainable]) {
    if (!workspace.some((item) => listed([folder], item.dir))) {
      problems.push({ file: "NOTICE", message: `lists ${folder}, which holds no package` });
    }
  }
  return problems;
};

/** The workspace's LICENSE files ostra wrote (not a third party's notice in deploy/notices), by path. */
const readLicenses = async (root: string, workspace: readonly WorkspaceManifest[]): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  for (const file of ["LICENSE", "NOTICE", ...workspace.map((item) => `${item.dir}/LICENSE`)]) {
    const text = await readFile(path.join(root, file), "utf8").catch(() => null);
    if (text !== null) {
      files[file] = text;
    }
  }
  return files;
};

/** Every release check over a checkout. Empty when it's ready to publish. */
export const releaseProblems = async (root: string): Promise<readonly ReleaseProblem[]> => {
  const workspace = await readWorkspace(root);
  const problems: ReleaseProblem[] = [];
  // One version line (ADR 0045): the CLI prints its package.json's, core tells runners its own and
  // the panel shows its own, so each must be the root's, which tags the images.
  const release = manifestSchema.parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))).version ?? "";
  for (const { dir, manifest } of workspace) {
    if (manifest.version !== release) {
      problems.push({ file: `${dir}/package.json`, message: `its version is ${manifest.version ?? "missing"}, not the root's ${release}: one version line, which node scripts/version.ts sets` });
    }
    if (isPublishedDir(dir)) {
      problems.push(...publishedManifestProblems(dir, manifest), ...(await undeclaredImports(root, dir, manifest)));
      const license = await readFile(path.join(root, dir, "LICENSE"), "utf8").catch(() => "");
      if (!license.includes("Apache License") || !license.includes("Version 2.0, January 2004")) {
        problems.push({ file: `${dir}/LICENSE`, message: "a published package carries the Apache-2.0 text in its LICENSE" });
      }
      const build = await readFile(path.join(root, dir, "tsconfig.build.json"), "utf8").catch(() => null);
      if (build?.includes('"outDir": "dist"') !== true) {
        problems.push({ file: `${dir}/tsconfig.build.json`, message: 'builds the package into dist ("outDir": "dist")' });
      }
    } else if (manifest.private !== true) {
      problems.push({ file: `${dir}/package.json`, message: `isn't published, so it must be "private": true (the server's packages never are)` });
    }
  }
  problems.push(...licensorProblems(await readLicenses(root, workspace)));
  problems.push(...noticeProblems(await readFile(path.join(root, "NOTICE"), "utf8").catch(() => ""), workspace));
  const workflow = await readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8").catch(() => "");
  const ci = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8").catch(() => "");
  problems.push(...releaseWorkflowProblems(workflow, ci));
  return problems;
};

const WORKFLOW = ".github/workflows/release.yml";

/** A top-level block of a workflow file: its key's line and the indented lines under it. */
const topBlock = (text: string, key: string): string | null => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) {
    return null;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line) && !line.startsWith("#"));
  return [lines[start] ?? "", ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
};

/**
 * `release.yml` (ADR 0064): started by hand only, with `version` and `dry-run`; every action pinned
 * by its commit's SHA; `contents`, `packages` and `id-token` write and nothing else at the top; no
 * npm token, since npm's trusted publishing needs none; the dry run pushing to the job's own
 * registry and publishing nothing; and ci.yml never running it (the maintainer's CI scope).
 */
export const releaseWorkflowProblems = (workflow: string, ci: string): readonly ReleaseProblem[] => {
  const problems: string[] = [];
  const on = topBlock(workflow, "on") ?? "";
  const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1] ?? "");
  if (JSON.stringify(triggers) !== JSON.stringify(["workflow_dispatch"])) {
    problems.push(`starts by hand only: "on" holds workflow_dispatch alone, not ${triggers.join(", ") || "nothing"}`);
  }
  const inputs = [...on.matchAll(/^ {6}([a-z-]+):/gm)].map((match) => match[1] ?? "");
  if (JSON.stringify(inputs) !== JSON.stringify(["version", "dry-run"])) {
    problems.push("takes the inputs version and dry-run");
  }
  if (!/^ {6}dry-run:\n(?: {8}.*\n)*? {8}default: true$/m.test(on)) {
    problems.push("its dry run is the default");
  }
  const permissions = (topBlock(workflow, "permissions") ?? "").split("\n").slice(1).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  if (JSON.stringify([...permissions].sort()) !== JSON.stringify(["contents: write", "id-token: write", "packages: write"])) {
    problems.push("its permissions are contents, packages and id-token write, and nothing else");
  }
  for (const match of workflow.matchAll(/^\s*(?:-\s+)?uses:\s+(\S+)/gm)) {
    const action = match[1] ?? "";
    if (!action.startsWith("./") && !/@[0-9a-f]{40}$/.test(action)) {
      problems.push(`pins every action by its commit's SHA: ${action}`);
    }
  }
  if (/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/.test(workflow)) {
    problems.push("holds no npm token: npm's trusted publishing trusts the workflow itself");
  }
  if (!/^\s+npm publish "\$tarball" --tag "\$tag" --dry-run\b/m.test(workflow) || !/^\s+npm publish "\$tarball" --tag "\$tag" --access public --provenance$/m.test(workflow)) {
    problems.push("publishes each tarball with --provenance, or with --dry-run in the dry run");
  }
  if (!/^ {6}registry:\n {8}image: registry:[^\s@]+@sha256:[0-9a-f]{64}$/m.test(workflow) || !workflow.includes("inputs.dry-run && 'localhost:5000/ostra'")) {
    problems.push("its dry run pushes the images to a registry service inside the job, pinned by digest");
  }
  if (/release\.yml|npm publish|images:build/.test(ci)) {
    problems.push("ci.yml never runs the release, a publish or an image build (the maintainer's CI scope)");
  }
  return problems.map((message) => ({ file: WORKFLOW, message }));
};

/** The package.json files a version is set in: the root (the images' tags) and every workspace package. */
export const versionedFiles = async (root: string): Promise<readonly string[]> => ["package.json", ...(await readWorkspace(root)).map((item) => `${item.dir}/package.json`)];

/**
 * A place in a file the stamp writes the version into: each match of `pattern` (global, by line)
 * becomes its first group, the version and its second group. It must match `count` times, so a
 * moved or added line fails the stamp instead of shipping the old version.
 */
export type VersionSpot = { readonly pattern: RegExp; readonly count: number };

/** A file beside the package.json files that carries the release's version, and where. */
export type VersionStamp = { readonly file: string; readonly spots: readonly VersionSpot[] };

/**
 * The files that carry the release's version as text, beside the package.json files, because
 * Docker Compose and Helm read them as they are. The CLI, core and the panel read their version
 * from their own package.json, so they can't drift from it. Each is checked where its rule lives:
 * the compose file by `pnpm check:images` (`compose-images`), each chart by `pnpm check:helm`
 * (`chart-version`). Pinned to the release's tag, never `latest` (ADR 0046, ADR 0060).
 */
export const versionStamps: readonly VersionStamp[] = [
  // The server, runner and base images' tags, and the runner's two box images.
  { file: "deploy/compose.yaml", spots: [{ pattern: /^(\s+(?:image|OSTRA_BOX_BASE_IMAGE|OSTRA_BOX_RUNNER_IMAGE): ostra\/(?:server|runner|base):)\S+()$/gm, count: 5 }] },
  // Each chart's version and its appVersion, the default tag of its images (values.yaml's empty `tag`).
  ...["ostra-server", "ostra-runner"].map((chart) => ({
    file: `deploy/helm/${chart}/Chart.yaml`,
    spots: [
      { pattern: /^(version: )\S+()$/gm, count: 1 },
      { pattern: /^(appVersion: ")[^"\r\n]*(")$/gm, count: 1 },
    ],
  })),
];

/** A stamped file's text, or an error naming the spot that didn't match as many times as it should. */
const stampText = (stamp: VersionStamp, text: string, version: string): string =>
  stamp.spots.reduce((current, spot) => {
    const found = [...current.matchAll(spot.pattern)].length;
    if (found !== spot.count) {
      throw new Error(`${stamp.file}: the version stamp expects ${String(spot.count)} line(s) like ${String(spot.pattern)} and found ${String(found)}`);
    }
    return current.replaceAll(spot.pattern, `$1${version}$2`);
  }, text);

/**
 * Sets one version everywhere a release carries it (ADR 0045's one version line): every
 * package.json, the root's (`releaseVersion`, the images' tags), the CLI's (`ostra --version`) and
 * core's (the version a runner pins to) among them, and each file of `stamps`. Only the version
 * changes; the rest of each file is kept as it's written. Nothing is written unless every file can
 * be stamped. `stamps` is `versionStamps` but in a test.
 */
export const setVersion = async (root: string, version: string, stamps: readonly VersionStamp[] = versionStamps): Promise<readonly string[]> => {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`"${version}" isn't a release version (1.0.0, or 1.0.0-rc.1)`);
  }
  const stamped: { readonly file: string; readonly text: string }[] = [];
  for (const file of await versionedFiles(root)) {
    const text = await readFile(path.join(root, ...file.split("/")), "utf8");
    if (!/^\s*"version":/m.test(text)) {
      throw new Error(`${file} has no "version" line`);
    }
    stamped.push({ file, text: text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`) });
  }
  for (const stamp of stamps) {
    stamped.push({ file: stamp.file, text: stampText(stamp, await readFile(path.join(root, ...stamp.file.split("/")), "utf8"), version) });
  }
  for (const { file, text } of stamped) {
    await writeFile(path.join(root, ...file.split("/")), text, "utf8");
  }
  return stamped.map((item) => item.file);
};

/** Writes LICENSOR into every published package's `author` (the LICENSE and NOTICE lines are edited by hand, with it). */
export const writeLicensor = async (root: string): Promise<void> => {
  for (const { dir, text } of await readWorkspace(root)) {
    if (isPublishedDir(dir)) {
      const changed = text.replace(/^(\s*"author":\s*)"[^"]*"/m, `$1${JSON.stringify(LICENSOR)}`);
      await writeFile(path.join(root, dir, "package.json"), changed, "utf8");
    }
  }
};

const main = async (): Promise<number> => {
  const root = path.resolve(import.meta.dirname, "..");
  if (process.argv.includes("--write-licensor")) {
    await writeLicensor(root);
  }
  const problems = await releaseProblems(root);
  for (const problem of problems) {
    process.stderr.write(`check:release: ${problem.file}: ${problem.message}\n`);
  }
  process.stdout.write(problems.length === 0 ? "check:release: the published packages, the private ones and the licensor line hold\n" : `check:release: ${String(problems.length)} problem(s)\n`);
  return problems.length === 0 ? 0 : 1;
};

if (import.meta.main) {
  process.exitCode = await main();
}
