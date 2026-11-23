// What a release publishes, and the checks that it's ready to (milestone 7's ticket 30, ADR 0045,
// ADR 0064): the published packages and their manifests, the server packages kept private, one
// licensor line everywhere, and one version on every package. `pnpm check:release` runs the
// checks; `release.yml` runs them before it publishes anything.
//
// - **Published:** `@ostra/protocol`, `@ostra/adapter-sdk` and every adapter, each from its build
//   (`dist`, made by `tsconfig.build.json`) with its LICENSE, public, with npm's provenance, and the
//   CLI, which `apps/runner`'s `pack:cli` bundles into a package of its own (`pack-cli.ts`).
// - **Attached to the GitHub release:** the compose file and both Helm charts, stamped with the
//   release's version and image namespace (`releaseAssets`, made by `release-assets.ts`).
// - **Not published:** every other workspace package, the server's above all, is `private: true`.
// - **The licensor line** (ADR 0048) is `LICENSOR`, in `licensor.ts` and nowhere else in code: the root
//   LICENSE, NOTICE and every published package's `author` must say it, and any LICENSE that names a
//   copyright holder must name it. `node scripts/release.ts --write-licensor` writes it everywhere.
// - **The release's names** (the image namespace and the CLI's package) are the root package.json's,
//   which the stamp writes; the runner and the panel read them from it, and no other file types them.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { jobBlock } from "@ostra/deploy-checks/binaries";
import { RELEASES_URL, releaseFiles } from "@ostra/protocol";
import type { ReleaseFile } from "@ostra/protocol";
import { z } from "zod";

import { COPYRIGHT_YEAR, LICENSOR, REPOSITORY_URL } from "./licensor.ts";

export { COPYRIGHT_YEAR, LICENSOR, REPOSITORY_URL } from "./licensor.ts";

/** The folders whose package is published from its build. The CLI is published from its pack. */
export const isPublishedDir = (dir: string): boolean => dir === "packages/protocol" || dir === "packages/adapter-sdk" || /^packages\/adapters\/[^/]+$/.test(dir);

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** One part of an image reference's path: Docker's grammar, lowercase only. */
const PATH_PART = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";

/**
 * Where a release's images are published: a registry host, with a port if it needs one, and a
 * path, lowercase, such as `ghcr.io/joeykhd` or the dry run's `localhost:5000/ostra` (Q82). A
 * clone's is `ostra`, which `pnpm images:build` tags local builds with.
 */
const IMAGE_NAMESPACE = new RegExp(`^${PATH_PART}(?::\\d+)?(?:/${PATH_PART})*$`);

/**
 * The npm name the CLI is published under (ADR 0046: npm's `ostra` is taken, so it's the
 * maintainer's to register, Q80): a name npm accepts for a new package, lowercase, scoped or not,
 * such as `@joeykhd/ostra`. A clone's is the placeholder `ostra`, which is never published.
 */
const CLI_PACKAGE = /^(?=.{1,214}$)(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

// package.json is npm's format, so unknown fields are tolerated.
const manifestSchema = z.looseObject({
  name: z.string().min(1),
  version: z.string().optional(),
  /** The root's only: the namespace the release's images are published under (`stampRelease`). */
  imageNamespace: z.string().optional(),
  /** The root's only: the npm name the CLI is published under (`stampRelease`). */
  cliPackage: z.string().optional(),
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

/**
 * One of the release's names typed into a file: an image under a clone's namespace
 * (`ostra/<server|runner|base>:<tag>`) or the CLI by its placeholder name (`npx ostra` at a
 * version). Typed, it names what a clone builds, not what a release publishes, so a released runner
 * or the panel's join command would pull what no release pushed. The runner and the panel read both
 * names from the root package.json, which the stamp writes, and the docs write placeholders. A
 * longer name that ends in one (a registry's `<host>/ostra/runner`, the `@ostra/runner` package)
 * isn't one.
 */
const TYPED_NAME = /(?<![\w@./-])(?:ostra\/(?:server|runner|base):|npx\s+ostra@)/g;

/** Where the release's names are looked for: the shipped code, the deploy files, the workflows and every page of docs. */
const NAMED_ROOTS = ["apps", "packages", "docs", "deploy", "scripts", ".github", "README.md", "CONTRIBUTING.md"];

/** Folders not looked in: installs, builds and generated code, tests and their fakes, and kept evidence of past runs. A hidden one (`.next`, `.turbo`) neither. */
const UNNAMED_DIRS = new Set(["node_modules", "dist", "generated", "coverage", "test-results", "playwright-report", "evidence", "testing", "test", "e2e"]);

const NAMED_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|mdx?|sh)$|^Dockerfile/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Files that may type the names, by path or folder, and why. The stamp's own files may too: it writes them. */
export const typedNameExemptions: readonly { readonly path: string; readonly reason: string }[] = [
  { path: "scripts/live/", reason: "the launch gate's live jobs run a clone's own build, which `pnpm images:build` tags under the clone's `ostra`" },
  { path: "docs/development.md", reason: "the development tools' fakes, such as the fake registry's seeded image, not a release's" },
];

/** The release's names typed into these files, each as a problem naming its line; tests, exemptions and the stamp's files left out. */
export const typedNameProblems = (files: readonly { readonly file: string; readonly text: string }[]): readonly ReleaseProblem[] => {
  const stamped = new Set(releaseStamps.map((stamp) => stamp.file));
  const problems: ReleaseProblem[] = [];
  for (const { file, text } of files) {
    if (TEST_FILE.test(file) || stamped.has(file) || typedNameExemptions.some((exempt) => file === exempt.path || (exempt.path.endsWith("/") && file.startsWith(exempt.path)))) {
      continue;
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      for (const match of line.matchAll(TYPED_NAME)) {
        problems.push({
          file,
          message: `line ${String(index + 1)} types ${match[0]}, a clone's name, not the release's: read the image namespace and the CLI's package from the root package.json, which the release's stamp writes, or write a placeholder`,
        });
      }
    }
  }
  return problems;
};

/** The files the release's names are looked for in, with their text, by path from the root. */
const readNamedFiles = async (root: string): Promise<readonly { readonly file: string; readonly text: string }[]> => {
  const found: { file: string; text: string }[] = [];
  const visit = async (relative: string): Promise<void> => {
    const full = path.join(root, ...relative.split("/"));
    const entries = await readdir(full, { withFileTypes: true }).catch(() => null);
    if (entries === null) {
      const text = await readFile(full, "utf8").catch(() => null);
      if (text !== null) {
        found.push({ file: relative, text });
      }
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith(".") && !UNNAMED_DIRS.has(entry.name)) {
        await visit(child);
      } else if (entry.isFile() && NAMED_FILE.test(entry.name)) {
        found.push({ file: child, text: await readFile(path.join(full, entry.name), "utf8") });
      }
    }
  };
  for (const name of NAMED_ROOTS) {
    await visit(name);
  }
  return found;
};

/** Every release check over a checkout. Empty when it's ready to publish. */
export const releaseProblems = async (root: string): Promise<readonly ReleaseProblem[]> => {
  const workspace = await readWorkspace(root);
  const problems: ReleaseProblem[] = [];
  // One version line (ADR 0045): the CLI prints its package.json's, core tells runners its own and
  // the panel shows its own, so each must be the root's, which tags the images.
  const rootManifest = manifestSchema.parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
  const release = rootManifest.version ?? "";
  // The images' namespace, which the build tags them with and the compose file and charts name.
  if (!IMAGE_NAMESPACE.test(rootManifest.imageNamespace ?? "")) {
    problems.push({ file: "package.json", message: `its imageNamespace is ${rootManifest.imageNamespace ?? "missing"}, not an image namespace: where the images are published, which node scripts/version.ts sets ("ostra" in a clone)` });
  }
  // The CLI's npm name, which the pack publishes under and the panel's join command runs.
  if (!CLI_PACKAGE.test(rootManifest.cliPackage ?? "")) {
    problems.push({ file: "package.json", message: `its cliPackage is ${rootManifest.cliPackage ?? "missing"}, not an npm package name: the CLI's, which node scripts/version.ts sets ("ostra" in a clone)` });
  }
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
  problems.push(...typedNameProblems(await readNamedFiles(root)));
  // The releases the panel and the docs download from are this repository's.
  if (RELEASES_URL !== `${repositoryPages}/releases`) {
    problems.push({ file: "packages/protocol/src/release.ts", message: `RELEASES_URL is ${RELEASES_URL}, not the repository's releases, ${repositoryPages}/releases (scripts/licensor.ts, REPOSITORY_URL)` });
  }
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
 * registry and publishing nothing; its tree stamped with the version, the image namespace and the
 * CLI's package; the release's files made in every run and attached to the real run's release
 * only; and ci.yml never running it (the maintainer's CI scope).
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
  // The release job's own stamp: `runner-binaries` stamps the same tree (ticket 01), and a stamp
  // moved out of the release job alone would leave its images and packages unstamped.
  if (!/^ {6}- run: node scripts\/version\.ts "\$VERSION" "\$IMAGE_NAMESPACE" "\$CLI_PACKAGE"$/m.test(jobBlock(workflow, "release") ?? "")) {
    problems.push(`stamps its tree with the version, the image namespace the images are pushed to and the CLI's package: node scripts/version.ts "$VERSION" "$IMAGE_NAMESPACE" "$CLI_PACKAGE"`);
  }
  // The pack takes the CLI's name from the stamped root package.json, so nothing names it twice.
  if (workflow.includes("OSTRA_CLI_PACKAGE=")) {
    problems.push("packs the CLI under the stamped name: no OSTRA_CLI_PACKAGE beside pack:cli");
  }
  // The release's files are made in both runs, so the dry run lists them, and attached only by the
  // real run's release.
  const createRelease = /^ {6}- if: \$\{\{ !inputs\.dry-run \}\}\n {8}name: Create the GitHub release\n(?: {8,}.*\n)*/m.exec(workflow)?.[0] ?? "";
  if (!/^ {6}- name: Make the release's files\n {8}run: node scripts\/release-assets\.ts "\$OUT\/assets"$/m.test(workflow) || !/^\s+gh release create "v\$VERSION" .*"\$OUT"\/assets\/\*$/m.test(createRelease)) {
    problems.push(`makes the release's files in every run (node scripts/release-assets.ts "$OUT/assets") and attaches them to the real run's release only (gh release create ... "$OUT"/assets/*)`);
  }
  if (/release\.yml|npm publish|images:build/.test(ci)) {
    problems.push("ci.yml never runs the release, a publish or an image build (the maintainer's CI scope)");
  }
  return problems.map((message) => ({ file: WORKFLOW, message }));
};

/** The package.json files a version is set in: the root (the images' tags) and every workspace package. */
export const versionedFiles = async (root: string): Promise<readonly string[]> => ["package.json", ...(await readWorkspace(root)).map((item) => `${item.dir}/package.json`)];

/** What a release stamps on its tree: its version, the namespace its images are published under, and the CLI's npm name. */
export type Release = { readonly version: string; readonly imageNamespace: string; readonly cliPackage: string };

/**
 * A place in a file the stamp writes the release into: each match of `pattern` (global, by line)
 * becomes `to`, in which `{version}`, `{namespace}` and `{cliPackage}` are the release's and `$1`, `$2` the
 * pattern's groups. It must match `count` times, so a moved or added line fails the stamp instead
 * of shipping the old value.
 */
export type StampSpot = { readonly pattern: RegExp; readonly count: number; readonly to: string };

/** A file beside the package.json files that carries the release's version or namespace, and where. */
export type ReleaseStamp = { readonly file: string; readonly spots: readonly StampSpot[] };

/**
 * The files that carry the release as text, beside the package.json files, because Docker Compose
 * and Helm read them as they are: each names the release's images, `<namespace>/<name>:<version>`,
 * the images `release.yml` pushes. The CLI, core and the panel read their version from their own
 * package.json, so they can't drift from it. Each is checked where its rule lives: the compose
 * file by `pnpm check:images` (`compose-images`), each chart by `pnpm check:helm` (`chart-version`,
 * `chart-images`). Pinned to the release's tag, never `latest` (ADR 0046, ADR 0060).
 */
export const releaseStamps: readonly ReleaseStamp[] = [
  // The server, runner and base images, and the runner's two box images.
  {
    file: "deploy/compose.yaml",
    spots: [{ pattern: /^(\s+(?:image|OSTRA_BOX_BASE_IMAGE|OSTRA_BOX_RUNNER_IMAGE): )\S+\/(server|runner|base):\S+$/gm, count: 5, to: "$1{namespace}/$2:{version}" }],
  },
  // Each chart's version and its appVersion, the default tag of its images (values.yaml's empty `tag`).
  ...["ostra-server", "ostra-runner"].map((chart) => ({
    file: `deploy/helm/${chart}/Chart.yaml`,
    spots: [
      { pattern: /^(version: )\S+$/gm, count: 1, to: "$1{version}" },
      { pattern: /^(appVersion: ")[^"\r\n]*(")$/gm, count: 1, to: "$1{version}$2" },
    ],
  })),
  // Each chart's images' default repository, under the namespace: the server image, and the runner
  // image with the base image a box's agent runs in.
  { file: "deploy/helm/ostra-server/values.yaml", spots: [{ pattern: /^( {2}repository: )\S+\/(server)$/gm, count: 1, to: "$1{namespace}/$2" }] },
  { file: "deploy/helm/ostra-runner/values.yaml", spots: [{ pattern: /^( {2}repository: )\S+\/(runner|base)$/gm, count: 2, to: "$1{namespace}/$2" }] },
];

/** A stamped text, or an error naming the spot that didn't match as many times as it should. */
const stampText = (file: string, spots: readonly StampSpot[], text: string, release: Release): string =>
  spots.reduce((current, spot) => {
    const found = [...current.matchAll(spot.pattern)].length;
    if (found !== spot.count) {
      throw new Error(`${file}: the release stamp expects ${String(spot.count)} line(s) like ${String(spot.pattern)} and found ${String(found)}`);
    }
    // No value can hold a `$`, which a replacement would read, or a `{`: each is checked first.
    return current.replaceAll(spot.pattern, spot.to.replaceAll("{version}", release.version).replaceAll("{namespace}", release.imageNamespace).replaceAll("{cliPackage}", release.cliPackage));
  }, text);

/**
 * Every package.json's version line, and the root's `imageNamespace` and `cliPackage`: the image
 * checks and the build read the first, the pack the second, and the runner and the panel both.
 */
const manifestSpots = (file: string): readonly StampSpot[] => [
  { pattern: /^(\s*"version":\s*")[^"]*(")/gm, count: 1, to: "$1{version}$2" },
  ...(file === "package.json"
    ? [
        { pattern: /^(\s*"imageNamespace":\s*")[^"]*(")/gm, count: 1, to: "$1{namespace}$2" },
        { pattern: /^(\s*"cliPackage":\s*")[^"]*(")/gm, count: 1, to: "$1{cliPackage}$2" },
      ]
    : []),
];

/**
 * Stamps the release everywhere it's carried (ADR 0045's one version line, ADR 0064): its version
 * on every package.json, the root's (`releaseVersion`, the images' tags), the CLI's (`ostra
 * --version`) and core's (the version a runner pins to) among them; its image namespace on the
 * root's `imageNamespace` and the CLI's npm name on its `cliPackage`, which the runner and the panel
 * read (their box images and join commands) and the pack publishes under; and the version and the
 * namespace on each file of `stamps`. Only those values change; the rest of
 * each file is kept as it's written. Nothing is written unless every file can be stamped. `stamps`
 * is `releaseStamps` but in a test.
 */
export const stampRelease = async (root: string, release: Release, stamps: readonly ReleaseStamp[] = releaseStamps): Promise<readonly string[]> => {
  if (!RELEASE_VERSION.test(release.version)) {
    throw new Error(`"${release.version}" isn't a release version (1.0.0, or 1.0.0-rc.1)`);
  }
  if (!IMAGE_NAMESPACE.test(release.imageNamespace)) {
    throw new Error(`"${release.imageNamespace}" isn't an image namespace (a registry and a path, lowercase, such as ghcr.io/owner)`);
  }
  if (!CLI_PACKAGE.test(release.cliPackage)) {
    throw new Error(`"${release.cliPackage}" isn't an npm package name for the CLI (lowercase, scoped or not, such as @owner/ostra)`);
  }
  const read = (file: string): Promise<string> => readFile(path.join(root, ...file.split("/")), "utf8");
  const stamped: { readonly file: string; readonly text: string }[] = [];
  for (const file of await versionedFiles(root)) {
    stamped.push({ file, text: stampText(file, manifestSpots(file), await read(file), release) });
  }
  for (const stamp of stamps) {
    stamped.push({ file: stamp.file, text: stampText(stamp.file, stamp.spots, await read(stamp.file), release) });
  }
  for (const { file, text } of stamped) {
    await writeFile(path.join(root, ...file.split("/")), text, "utf8");
  }
  return stamped.map((item) => item.file);
};

/** Where a release's file comes from: a file of the stamped tree, or a chart Helm packages from it. */
export type AssetSource = { readonly kind: "file"; readonly path: string } | { readonly kind: "chart"; readonly chart: string };

/** A file the GitHub release carries, by the name it's downloaded as (`releaseFiles`, in `protocol`). */
export type ReleaseAsset = { readonly name: ReleaseFile; readonly from: AssetSource };

/**
 * The files the GitHub release carries beside its notes (ADR 0064, amended 2026-11-21), each as the
 * stamp leaves it, so each names the release's own images: the compose file the install guide
 * downloads, and both charts, which the Helm page installs. Each is reached at
 * `releases/latest/download/<name>`, or `releases/download/v<version>/<name>` for one release, so
 * no page types a version. `scripts/release-assets.ts` makes them, and `release.yml` attaches them.
 * Their names are `protocol`'s `releaseFiles`, which the panel's Helm join command downloads too.
 */
export const releaseAssets: readonly ReleaseAsset[] = [
  { name: releaseFiles.compose, from: { kind: "file", path: "deploy/compose.yaml" } },
  { name: releaseFiles.serverChart, from: { kind: "chart", chart: "ostra-server" } },
  { name: releaseFiles.runnerChart, from: { kind: "chart", chart: "ostra-runner" } },
];

/** The repository's own pages on GitHub (`https://github.com/<owner>/<repo>`), from REPOSITORY_URL. */
const repositoryPages = REPOSITORY_URL.replace(/^git\+/, "").replace(/\.git$/, "");

/** The release files a text names by their download link: `releases/latest/download/<name>`, or one release's. */
export const linkedAssets = (text: string): readonly string[] => {
  const base = RELEASES_URL.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = new RegExp(`${base}/(?:latest/download|download/[^/\\s]+)/([^\\s)"'\`<>\\\\]+)`, "g");
  return [...text.matchAll(link)].map((match) => (match[1] ?? "").replace(/[.,;:]+$/, ""));
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
