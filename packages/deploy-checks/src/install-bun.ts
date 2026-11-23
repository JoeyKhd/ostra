// `node packages/deploy-checks/src/install-bun.ts --out <dir> [--dry-run]`: downloads exactly the Bun
// archive `binaries.ts` pins, checks its SHA-256 against the repository's pin (never against the
// download's own claim, ADR 0046's rule for OpenCode), unpacks the `bun` executable into `<dir>`,
// and prints what it runs. Every command is an argument array, and a hash mismatch, an unreachable
// archive or a version other than the pin fails with what was expected.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { bunPin, bunPinSchema, BUN_VERSION_PATTERN } from "./binaries.ts";
import type { BunPin } from "./binaries.ts";

/** The executable's path inside Bun's archive: `unzip -j` drops the folder and leaves `bun`. */
export const BUN_ARCHIVE_ENTRY = "bun-linux-x64/bun";

/** Downloads a URL's bytes. */
export type Download = (url: string) => Promise<Uint8Array>;

/** Unpacks a zip's `BUN_ARCHIVE_ENTRY` into a folder, as `bun`. */
export type Unzip = (archive: string, out: string) => Promise<void>;

/** Runs a binary and returns its stdout. */
export type RunBinary = (binary: string) => Promise<string>;

/** What the installer leaves: the `bun` it unpacked, and the version that binary printed. */
export type InstalledBun = { readonly binary: string; readonly version: string };

export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The archive's bytes against the pin: a mismatch names both hashes and the URL it came from. */
export const verifyBunArchive = (bytes: Uint8Array, pin: BunPin = bunPin): void => {
  const actual = sha256Of(bytes);
  if (actual !== pin.sha256) {
    throw new Error(`${pin.url} has SHA-256 ${actual}, not the pinned ${pin.sha256}: the archive isn't the one the repository pinned`);
  }
};

const fetchArchive: Download = async (url) => {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (error) {
    throw new Error(`cannot download ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`cannot download ${url}: HTTP ${String(response.status)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

const exec = (command: string, args: readonly string[]): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(command, [...args], { windowsHide: true, timeout: 300_000 }, (error, stdout, stderr) => {
    if (error === null) {
      resolve(stdout);
    } else {
      reject(new Error(`${[command, ...args].join(" ")} failed: ${(stderr.trim() === "" ? error.message : stderr).slice(-2000)}`));
    }
  });
  return promise;
};

const unzipBun: Unzip = async (archive, out) => {
  await exec("unzip", ["-o", "-j", archive, BUN_ARCHIVE_ENTRY, "-d", out]);
};

const bunVersion: RunBinary = async (binary) => (await exec(binary, ["--version"])).trim();

export type InstallOptions = { readonly out: string; readonly pin?: BunPin; readonly download?: Download; readonly unzip?: Unzip; readonly version?: RunBinary };

/**
 * The pinned Bun in `out`: the archive downloaded, hashed and unpacked, and the version the unpacked
 * `bun` prints, which must be the pin's. The hooks are the test's; the job uses the real ones.
 */
export const installBun = async (options: InstallOptions): Promise<InstalledBun> => {
  const pin = bunPinSchema.parse(options.pin ?? bunPin);
  const out = path.resolve(options.out);
  const bytes = await (options.download ?? fetchArchive)(pin.url);
  verifyBunArchive(bytes, pin);
  await mkdir(out, { recursive: true });
  const scratch = await mkdtemp(path.join(tmpdir(), "ostra-bun-"));
  try {
    const archive = path.join(scratch, "bun-linux-x64.zip");
    await writeFile(archive, bytes);
    await (options.unzip ?? unzipBun)(archive, out);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const binary = path.join(out, "bun");
  await chmod(binary, 0o755);
  const version = await (options.version ?? bunVersion)(binary);
  if (!BUN_VERSION_PATTERN.test(version) || version !== pin.version) {
    throw new Error(`${binary} is bun ${JSON.stringify(version)}, not the pinned ${pin.version}: the archive didn't hold the pinned Bun`);
  }
  return { binary, version };
};

/** The commands `installBun` would run, for `--dry-run`: nothing is downloaded or written. */
export const installPlan = (out: string, pin: BunPin = bunPin): readonly string[] => [
  `fetch ${pin.url}`,
  `sha256 ${pin.sha256}`,
  `unzip -o -j bun-linux-x64.zip ${BUN_ARCHIVE_ENTRY} -d ${path.resolve(out)}`,
  `${path.join(path.resolve(out), "bun")} --version`,
];

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt === -1 ? "" : (args[outAt + 1] ?? "");
  if (out === "") {
    process.stderr.write("install-bun: give the folder to unpack Bun into: node packages/deploy-checks/src/install-bun.ts --out <dir>\n");
    return 1;
  }
  if (args.includes("--dry-run")) {
    for (const line of installPlan(out)) {
      process.stdout.write(`${line}\n`);
    }
    return 0;
  }
  const installed = await installBun({ out });
  process.stdout.write(`${installed.binary} is bun ${installed.version}\n`);
  return 0;
};

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`install-bun: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
