import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InfoResponse, RunnerInstall } from "@ostra/protocol";
import type { Logger } from "@ostra/adapter-sdk";
import { z } from "zod";
import { userAgent } from "./version.ts";

// The pin (ADR 0034 as amended, Q243, spec section 4; milestone 5, ticket 19, F-061). At every
// start, a runner installed from npm whose version differs from its server's installs the server's
// version into `<dataDir>/versions/<version>` and runs that one instead, with the same arguments
// and environment, once:
//
//   1. the package's packument from the registry (`OSTRA_RUNNER_NPM_REGISTRY`, else the one the
//      server names in `/runner/v1/info`), and the version's `dist.integrity` (sha512 only)
//   2. the tarball, downloaded by the runner and checked against that integrity before npm sees it
//   3. `npm install --prefix <dir> --ignore-scripts <the checked tarball>`, then the integrity npm
//      recorded in the lockfile checked against the registry's again
//   4. the installed `ostra` bin, run by this Node with `OSTRA_PIN_REEXEC=<version>` set, so the
//      version it starts never pins again (the loop guard)
//
// A runner from the image or from source installs nothing: the image's tag is its pin, and the
// panel shows the difference. `OSTRA_RUNNER_PIN=false` turns it off. A failed pin is logged and the
// installed version starts: inside the window it works, outside it the server says what to do.

/** Set on the version the pin starts: it never pins again. */
export const PIN_REEXEC_ENV = "OSTRA_PIN_REEXEC";

export type NpmRun = (args: readonly string[], cwd: string) => Promise<{ readonly code: number; readonly stderr: string }>;

/** Runs the installed version; answers its exit code once it exits. */
export type Reexec = (program: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => Promise<number>;

export type PinInput = {
  readonly info: InfoResponse;
  readonly install: RunnerInstall;
  /** This runner's version. */
  readonly version: string;
  /** `OSTRA_RUNNER_PIN`. */
  readonly enabled: boolean;
  /** `OSTRA_RUNNER_NPM_REGISTRY` when it was set: it wins over the server's registry. */
  readonly registryOverride: string | null;
  readonly dataDir: string;
  /** The CLI's arguments, as given (without node and the program). */
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  /** For tests. */
  readonly npm?: NpmRun;
  readonly reexec?: Reexec;
  readonly fetch?: typeof fetch;
};

export type PinOutcome =
  /** The installed version starts: no pin to apply, or the pin failed (`reason`). */
  | { readonly kind: "continue"; readonly reason: PinSkip | PinFailure }
  /** The server's version ran, and exited with this code. */
  | { readonly kind: "ran"; readonly version: string; readonly exitCode: number };

export type PinSkip = "off" | "reexec" | "same-version" | "not-npm" | "no-package";
export type PinFailure = "registry" | "integrity" | "install";

const packumentSchema = z.looseObject({
  versions: z.record(
    z.string(),
    z.looseObject({ dist: z.looseObject({ tarball: z.url(), integrity: z.string().optional() }) }),
  ),
});

const lockSchema = z.looseObject({ packages: z.record(z.string(), z.looseObject({ version: z.string().optional(), integrity: z.string().optional() })) });
const manifestSchema = z.looseObject({ bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(), name: z.string() });

/** A package version npm accepts as a folder name: no path parts. */
const safeVersion = /^[0-9A-Za-z.+-]{1,64}$/;

/** `sha512-<base64>` of these bytes, as npm writes integrity. */
export const sha512Integrity = (bytes: Uint8Array): string => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/**
 * The integrity check: the bytes (or what npm recorded) are what the registry says. Only sha512:
 * a packument with a sha1 or no integrity at all is refused, since it would check nothing.
 */
export const integrityMatches = (expected: string | undefined, actual: string | undefined): boolean =>
  expected !== undefined && actual !== undefined && expected.startsWith("sha512-") && expected.split(/\s+/).includes(actual);

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

const runNpm: NpmRun = async (args, cwd) => {
  const [command = "npm", ...prefix] = await npmCli();
  return new Promise((resolve) => {
    execFile(command, [...prefix, ...args], { cwd, windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stderr });
    });
  });
};

/** Starts the installed version in this terminal and passes Ctrl-C on to it. */
const runInstalled: Reexec = (program, args, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [program, ...args], { env: { ...env }, stdio: "inherit", windowsHide: true });
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
    };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const done = (code: number): void => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(code);
    };
    child.on("error", () => {
      done(1);
    });
    child.on("exit", (code, signal) => {
      done(code ?? (signal === null ? 1 : 130));
    });
  });

/** The registry's URL of a package's packument: a scope's `/` is encoded, its `@` kept. */
const packumentUrl = (registry: string, name: string): string => `${registry.replace(/\/+$/, "")}/${encodeURIComponent(name).replace(/^%40/, "@")}`;

const fail = (logger: Logger, reason: PinFailure, fields: Readonly<Record<string, string | number | boolean>>): PinOutcome => {
  logger.warn("the pin failed: this version starts instead", { reason, ...fields });
  return { kind: "continue", reason };
};

/** The bin `ostra` of an installed package, as a path inside its folder. */
const binOf = (manifest: z.infer<typeof manifestSchema>): string | null => {
  const bin = manifest.bin;
  if (bin === undefined) return null;
  return typeof bin === "string" ? bin : (bin["ostra"] ?? null);
};

export const applyPin = async (input: PinInput): Promise<PinOutcome> => {
  const { info, logger } = input;
  const target = info.serverVersion;
  const log = logger.child({ component: "pin", version: input.version, serverVersion: target });
  if (!input.enabled) {
    return { kind: "continue", reason: "off" };
  }
  if (input.env[PIN_REEXEC_ENV] !== undefined) {
    // The loop guard: this process is the one a pin started.
    return { kind: "continue", reason: "reexec" };
  }
  if (target === input.version) {
    return { kind: "continue", reason: "same-version" };
  }
  if (input.install !== "npm") {
    log.info("this runner's version differs from the server's; installed from the " + (input.install === "image" ? "image, whose tag is its pin" : "source") + ", it installs nothing", { install: input.install });
    return { kind: "continue", reason: "not-npm" };
  }
  const pkg = info.npm?.package ?? null;
  if (pkg === null || !safeVersion.test(target)) {
    log.info("the server names no npm package for the runner: no pin");
    return { kind: "continue", reason: "no-package" };
  }
  const registry = input.registryOverride ?? info.npm?.registry ?? null;
  if (registry === null) {
    return { kind: "continue", reason: "no-package" };
  }
  const doFetch = input.fetch ?? fetch;
  const headers = { "user-agent": userAgent(), accept: "application/json" };

  // 1. The version's integrity, as the registry has it.
  let tarballUrl: string;
  let expected: string | undefined;
  try {
    const answer = await doFetch(packumentUrl(registry, pkg), { headers, signal: AbortSignal.timeout(60_000) });
    if (!answer.ok) {
      return fail(log, "registry", { status: answer.status });
    }
    const packument = packumentSchema.safeParse(await answer.json());
    const entry = packument.success ? packument.data.versions[target] : undefined;
    if (entry === undefined) {
      return fail(log, "registry", { detail: "the registry has no such version" });
    }
    tarballUrl = entry.dist.tarball;
    expected = entry.dist.integrity;
  } catch {
    return fail(log, "registry", { detail: "the registry didn't answer" });
  }

  const dir = path.join(input.dataDir, "versions", target);
  const staging = `${dir}.download`;
  try {
    // 2. The tarball, checked before npm installs it.
    const download = await doFetch(tarballUrl, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(300_000) });
    if (!download.ok) {
      return fail(log, "registry", { status: download.status });
    }
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (!integrityMatches(expected, sha512Integrity(bytes))) {
      return fail(log, "integrity", { detail: "the tarball isn't what the registry's integrity says" });
    }
    // 3. The install, from the checked tarball, with no scripts.
    await rm(staging, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const file = path.join(staging, "package.tgz");
    await writeFile(file, bytes);
    const npm = input.npm ?? runNpm;
    const installed = await npm(
      ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", "--registry", registry, "--cache", path.join(input.dataDir, "versions", ".npm-cache"), file],
      staging,
    );
    if (installed.code !== 0) {
      await rm(dir, { recursive: true, force: true });
      return fail(log, "install", { code: installed.code });
    }
    const lock = lockSchema.safeParse(JSON.parse(await readFile(path.join(dir, "package-lock.json"), "utf8")));
    const recorded = lock.success ? lock.data.packages[`node_modules/${pkg}`]?.integrity : undefined;
    if (!integrityMatches(expected, recorded)) {
      await rm(dir, { recursive: true, force: true });
      return fail(log, "integrity", { detail: "the integrity npm recorded isn't the registry's" });
    }
    const manifest = manifestSchema.safeParse(JSON.parse(await readFile(path.join(dir, "node_modules", pkg, "package.json"), "utf8")));
    const bin = manifest.success ? binOf(manifest.data) : null;
    if (bin === null) {
      return fail(log, "install", { detail: "the package has no ostra bin" });
    }
    const program = path.resolve(dir, "node_modules", pkg, bin);
    if (!program.startsWith(path.resolve(dir, "node_modules", pkg) + path.sep)) {
      return fail(log, "install", { detail: "the package's bin is outside it" });
    }
    // 4. The server's version, with the same arguments and environment, once.
    log.info("starting the server's version");
    const exitCode = await (input.reexec ?? runInstalled)(program, input.args, { ...input.env, [PIN_REEXEC_ENV]: target });
    return { kind: "ran", version: target, exitCode };
  } catch {
    await rm(dir, { recursive: true, force: true });
    return fail(log, "install", { detail: "the install failed" });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};
