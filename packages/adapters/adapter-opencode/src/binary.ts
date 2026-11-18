import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { adapterError, ok } from "@ostra/adapter-sdk";
import type { AdapterResult } from "@ostra/adapter-sdk";
import { z } from "zod";

// The OpenCode binary: the V2 line's `@opencode/cli`, pinned to one version and checked against a
// SHA-256 per platform before it runs (ADR 0032, ticket 11). Ported from
// spikes/how-should-the-runner-drive-opencode/src/lib/opencode.ts (`resolveOpenCodeBinary`).
//
// The install runs no script (`allowBuilds` says false for `@opencode/cli`): this module finds the
// real executable in its per-platform package itself. A binary that doesn't match its pinned hash
// is never started.

/** The version this adapter is written and tested against. A bump re-runs the steer probe (ADR 0032). */
export const OPENCODE_VERSION = "2.3.2";

/**
 * SHA-256 of each platform package's executable, at `OPENCODE_VERSION`, computed from the packages
 * the npm registry serves. A package missing here has no pin, and its binary is refused.
 * Regenerate them with a bump: they're the supply-chain check.
 */
export const pinnedChecksums: Readonly<Record<string, string>> = {
  "@opencode/cli-linux-x64": "e6543f6e5c39c40971ba38afd1819ac852c29ac735b5a89065d3d148d47f27ad",
  "@opencode/cli-linux-x64-baseline": "e6543f6e5c39c40971ba38afd1819ac852c29ac735b5a89065d3d148d47f27ad",
  "@opencode/cli-linux-x64-musl": "338bad40b5b5f602af50ebb995036bb6965d25deffc9d88df3f69ddc04524a17",
  "@opencode/cli-linux-x64-baseline-musl": "338bad40b5b5f602af50ebb995036bb6965d25deffc9d88df3f69ddc04524a17",
  "@opencode/cli-linux-arm64": "fc1ad8f2dffed8494e31265837f78d1e6ce5200f5c1c50e953cd9b63e607efdb",
  "@opencode/cli-linux-arm64-musl": "0e214ccebc6f0dd8775be65104b8a9de0585427b8911ad838c9fd83d1c812e2d",
  "@opencode/cli-darwin-arm64": "635c523002b6eaf897597facba703729794cb07bdb59044d5e173b07b77ff934",
  "@opencode/cli-darwin-x64": "0731128b9fd40bc827977a5898a0d045800a6e1c63c96b770ce9ec6ec9e653f8",
  "@opencode/cli-darwin-x64-baseline": "5d188d68f808570aa1f8826c9d6bd7d9ade18e9bac8961aa3c0079f41e2850e8",
  "@opencode/cli-windows-x64": "5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3",
  "@opencode/cli-windows-x64-baseline": "ba343b5c0fd8d7daabc0501bd1c1866c0fd91e8ff7b4404f5524fbc0cc233882",
  "@opencode/cli-windows-arm64": "cde2ef5e052143ecca725af3ab330e00b7b7ab6bab1b971bb1a9467fc2c15063",
};

export type OpenCodeBinary = {
  readonly path: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sha256: string;
};

const packageJsonSchema = z.looseObject({ name: z.string(), version: z.string() });

const isMusl = (): boolean => {
  const report: unknown = process.report.getReport();
  const header: unknown = Reflect.get(Object(report), "header");
  return process.platform === "linux" && Reflect.get(Object(header), "glibcVersionRuntime") === undefined;
};

/** The per-platform packages that could hold this machine's binary, in the order to try them. */
export const platformPackages = (): readonly string[] => {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch;
  const suffix = platform === "linux" && isMusl() ? "-musl" : "";
  const base = `@opencode/cli-${platform}-${arch}`;
  return arch === "x64" ? [`${base}${suffix}`, `${base}-baseline${suffix}`] : [`${base}${suffix}`];
};

const hashes = new Map<string, string>();

/** SHA-256 of a file, streamed. Remembered per path, size and modification time. */
export const sha256File = async (file: string): Promise<string> => {
  const info = await stat(file);
  const key = `${file}:${String(info.size)}:${String(info.mtimeMs)}`;
  const known = hashes.get(key);
  if (known !== undefined) {
    return known;
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const digest = hash.digest("hex");
  hashes.set(key, digest);
  return digest;
};

export type ResolveOptions = {
  /** Where to look for `@opencode/cli`. Default: this package's own install. */
  readonly from?: string;
  /** Checksums by platform package. Default: the pins in this file. */
  readonly checksums?: Readonly<Record<string, string>>;
};

/**
 * Finds the pinned OpenCode executable and checks its SHA-256. A missing binary, a package at
 * another version, a platform with no pin and a binary that doesn't match its pin are all refused,
 * each with its own words, before anything starts.
 */
export const resolveOpenCodeBinary = async (options: ResolveOptions = {}): Promise<AdapterResult<OpenCodeBinary>> => {
  const checksums = options.checksums ?? pinnedChecksums;
  const require = createRequire(options.from ?? import.meta.url);
  let wrapperJson: string;
  try {
    wrapperJson = require.resolve("@opencode/cli/package.json");
  } catch {
    return adapterError("unavailable", "OpenCode is not installed: @opencode/cli is missing");
  }
  const fromWrapper = createRequire(wrapperJson);
  for (const packageName of platformPackages()) {
    let platformJson: string;
    try {
      platformJson = fromWrapper.resolve(`${packageName}/package.json`);
    } catch {
      continue;
    }
    const meta = packageJsonSchema.safeParse(JSON.parse(await readFile(platformJson, "utf8")));
    if (!meta.success || meta.data.name !== packageName) {
      return adapterError("invalid-response", "OpenCode's platform package could not be read");
    }
    if (meta.data.version !== OPENCODE_VERSION) {
      return adapterError("conflict", `OpenCode ${meta.data.version} is installed, but this ostra is pinned to ${OPENCODE_VERSION}`);
    }
    const binary = path.join(path.dirname(platformJson), "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
    try {
      await access(binary);
    } catch {
      return adapterError("unavailable", "OpenCode's binary is missing from its platform package");
    }
    const pinned = checksums[packageName];
    if (pinned === undefined) {
      return adapterError("conflict", `no checksum is pinned for ${packageName}: its binary is not started`);
    }
    const actual = await sha256File(binary);
    if (actual !== pinned) {
      return adapterError("conflict", `the OpenCode binary does not match its pinned SHA-256 (${packageName}): it is not started`);
    }
    return ok({ path: binary, packageName, packageVersion: meta.data.version, sha256: actual });
  }
  return adapterError("unavailable", `OpenCode has no build for this platform (${process.platform} ${process.arch})`);
};
