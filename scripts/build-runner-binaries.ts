// `node scripts/build-runner-binaries.ts <out-dir> [--target <name>] [--dry-run]`: compiles the
// runner's CLI for the three platforms a release ships, from the stamped tree, with the Bun
// `packages/deploy-checks/src/binaries.ts` pins (`run bun --target` cross-compiles all three from
// one Linux job, ADR 0075). Each binary is copied beside `LICENSE`, zipped as its versionless
// download (`releaseFiles`, so `releases/latest/download/<name>` is always the newest), and hashed:
// `unsigned-sha256.txt` lists the binaries a signing job will sign, and `SHA256SUMS` lists the zips.
// Nothing is signed here (tickets 02 and 03), and nothing is attached to a release until both
// signatures exist. `--minify` stays off, so a support log keeps a member's stack traces.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { binaryTargets, binaryZipName } from "@ostra/deploy-checks/binaries";
import type { BinaryTarget } from "@ostra/deploy-checks/binaries";
import { DEVELOPMENT_VERSION, releaseFiles } from "@ostra/protocol";
import { z } from "zod";

/** This checkout's root: the script lives in `scripts/`. */
export const checkoutRoot = path.resolve(import.meta.dirname, "..");

/** The binaries' hashes, `<sha256>  <target>/<executable>`: what a signing job verifies before it signs (tickets 02 and 03). */
export const UNSIGNED_SUMS = "unsigned-sha256.txt";

/** The zips' hashes, `<sha256>  <name>`, in `sha256sum` format: what the release attaches beside them (ticket 04). */
export const CHECKSUMS = "SHA256SUMS";

/** The entry Bun compiles: the CLI the npm pack bundles (`pack-cli.ts`). */
export const ENTRY = "apps/runner/src/main.ts";

/** The packages the npm bundle leaves external: `ws`'s optional native speed-ups, and it runs without them. */
export const EXTERNAL = ["bufferutil", "utf-8-validate"] as const;

/** One `bun build --compile` command: an argument array, never a shell string. */
export const compileCommand = (target: BinaryTarget, binary: string): readonly string[] => ["bun", "build", "--compile", `--target=${target.bunTarget}`, ENTRY, ...EXTERNAL.map((name) => `--external=${name}`), "--outfile", binary];

/** One zip: the binary and its LICENSE, at the archive's root, with no paths or extra attributes. */
export const zipOf = (zip: string, files: readonly string[]): readonly string[] => ["zip", "-X", "-j", zip, ...files];

/** A path as a command line prints it: quoted when it holds a space. */
export const formatCommand = (command: readonly string[]): string => command.map((argument) => (/[\s"']/.test(argument) ? JSON.stringify(argument) : argument)).join(" ");

/** One target of the build: where its binary, LICENSE and zip go, and the two commands that make them. */
export type BuildTarget = {
  readonly target: BinaryTarget;
  /** `<out>/<folder>/ostra[.exe]`. */
  readonly binary: string;
  /** `<out>/<folder>/LICENSE`. */
  readonly license: string;
  /** `<out>/ostra-<target>.zip`, the name `releaseFiles` gives it. */
  readonly zip: string;
  /** `<folder>/ostra[.exe]`, as `unsigned-sha256.txt` lists it. */
  readonly relativeBinary: string;
  readonly command: readonly string[];
  readonly zipCommand: readonly string[];
};

/** What the build makes, as data: the targets, their paths and their commands. */
export type BuildPlan = { readonly root: string; readonly out: string; readonly targets: readonly BuildTarget[] };

/** The build's plan: three targets' binaries, licenses and zips, and the commands that make them. */
export const buildPlan = (root: string, out: string, targets: readonly BinaryTarget[] = binaryTargets): BuildPlan => ({
  root,
  out,
  targets: targets.map((target) => {
    const binary = path.join(out, target.folder, target.executable);
    const license = path.join(out, target.folder, "LICENSE");
    const zip = path.join(out, binaryZipName(target));
    if (releaseFiles[target.asset] !== binaryZipName(target)) {
      throw new Error(`the release names ${target.asset} ${releaseFiles[target.asset]}, not ${binaryZipName(target)}: the build makes the name the release attaches`);
    }
    return { target, binary, license, zip, relativeBinary: `${target.folder}/${target.executable}`, command: compileCommand(target, binary), zipCommand: zipOf(zip, [binary, license]) };
  }),
});

const rootManifestSchema = z.looseObject({ version: z.string().min(1) });

/** The targets a `--target` names: all three, or the one named, or an error listing the ones that exist. */
export const selectTargets = (only: string | null): readonly BinaryTarget[] => {
  if (only === null) {
    return binaryTargets;
  }
  const selected = binaryTargets.filter((target) => target.name === only);
  if (selected.length === 0) {
    throw new Error(`unknown target ${only}: the targets are ${binaryTargets.map((target) => target.name).join(", ")}`);
  }
  return selected;
};

/** The stamped version, or an error: a clone's `0.0.0` has no release and its `ostra --version` would prove nothing. */
export const stampedVersion = async (root: string): Promise<string> => {
  const { version } = rootManifestSchema.parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
  if (version === DEVELOPMENT_VERSION) {
    throw new Error(`this checkout's version is ${DEVELOPMENT_VERSION}: run node scripts/version.ts <version> <image-namespace> <cli-package> before building`);
  }
  return version;
};

/** Runs a command, as an argument array; a failure names the command and its last lines. */
export type RunCommand = (command: readonly string[]) => Promise<void>;

/** Zips files, as `zip -X -j` does: the archive's root holds them, in order. */
export type ZipFiles = (zip: string, files: readonly string[]) => Promise<void>;

const exec = (command: readonly string[], root: string): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const [file = "", ...args] = command;
  execFile(file, args, { cwd: root, windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error === null) {
      resolve(undefined);
    } else {
      const tail = (stderr.trim() === "" ? stdout : stderr).split(/\r?\n/).slice(-12).join("\n");
      reject(new Error(`${formatCommand(command)} failed: ${tail}`));
    }
  });
  return promise;
};

export type BuildOptions = {
  /** Print each command and stop; nothing is written and no command runs. */
  readonly dryRun?: boolean;
  /** Runs a command; the job's is `bun` and `zip`, the test's records it. */
  readonly run?: RunCommand;
  readonly zip?: ZipFiles;
};

/**
 * A plan's binaries, then their zips and both checksum files. `out` must be empty or new, as
 * `release-assets.ts` requires, so a stale binary can't be shipped under the release's name.
 */
export const buildBinaries = async (plan: BuildPlan, options: BuildOptions = {}): Promise<readonly string[]> => {
  if (options.dryRun === true) {
    return plan.targets.flatMap((target) => [formatCommand(target.command), formatCommand(target.zipCommand)]);
  }
  await mkdir(plan.out, { recursive: true });
  const held = await readdir(plan.out);
  if (held.length > 0) {
    throw new Error(`${plan.out} already holds ${held.join(", ")}: the binaries go in an empty folder`);
  }
  const run: RunCommand = options.run ?? (async (command) => {
    await exec(command, plan.root);
  });
  const zip: ZipFiles = options.zip ?? (async (archive, files) => {
    await exec(["zip", "-X", "-j", archive, ...files], plan.root);
  });
  for (const target of plan.targets) {
    await mkdir(path.dirname(target.binary), { recursive: true });
    await run(target.command);
    await copyFile(path.join(plan.root, "LICENSE"), target.license);
  }
  const unsigned = await Promise.all(plan.targets.map(async (target) => `${createHash("sha256").update(await readFile(target.binary)).digest("hex")}  ${target.relativeBinary}`));
  await writeFile(path.join(plan.out, UNSIGNED_SUMS), `${unsigned.join("\n")}\n`);
  for (const target of plan.targets) {
    await zip(target.zip, [target.binary, target.license]);
  }
  const made = await Promise.all(
    plan.targets.map(async (target) => {
      const bytes = await readFile(target.zip);
      return { name: path.basename(target.zip), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    }),
  );
  made.sort((left, right) => left.name.localeCompare(right.name));
  await writeFile(path.join(plan.out, CHECKSUMS), `${made.map((file) => `${file.sha256}  ${file.name}`).join("\n")}\n`);
  return made.map((file) => `${file.sha256}  ${file.name}  (${String(file.bytes)} bytes)`);
};

const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  let out: string | null = null;
  let only: string | null = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--target") {
      only = argv[index + 1] ?? "";
      index += 1;
    } else if (argument.startsWith("--target=")) {
      only = argument.slice("--target=".length);
    } else if (argument.startsWith("--")) {
      process.stderr.write(`build-runner-binaries: unknown option ${argument}\n`);
      return 1;
    } else if (out === null) {
      out = argument;
    } else {
      process.stderr.write(`build-runner-binaries: unexpected ${argument}: give one folder to build in\n`);
      return 1;
    }
  }
  if (out === null || out === "") {
    process.stderr.write("build-runner-binaries: give the folder to build in: node scripts/build-runner-binaries.ts <out-dir>\n");
    return 1;
  }
  const targets = selectTargets(only);
  const version = await stampedVersion(checkoutRoot);
  const plan = buildPlan(checkoutRoot, path.resolve(out), targets);
  const lines = await buildBinaries(plan, { dryRun });
  if (dryRun) {
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
    }
    return 0;
  }
  process.stdout.write(`build-runner-binaries: ostra ${version} for ${targets.map((target) => target.name).join(", ")} in ${plan.out}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
};

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`build-runner-binaries: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
