import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { scanImageArchive } from "@ostra/adapter-executor-docker";
import { z } from "zod";

import { extractTar, parseImageRef, pushOciLayout, registryUrlOf } from "./oci.ts";

// The runner image's steps in a snapshot build's pod (ticket 08, `snapshots.ts`): `ostra internal
// build-step context|scan|push` runs `runBuildStep`. Each reads only its own file of the build's
// secret, at a path its environment names, and prints words and counts, never a value. The last
// line the push step prints is its result, as JSON, which the executor reads from the pod's log.

export const BUILD_STEPS = ["context", "scan", "push"] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

/** The scan step's exit code when it finds a secret: the executor tells it from a failure. */
export const SCAN_HIT_EXIT = 3;
/** What the scan step prints before the names it found. */
export const SCAN_HIT_PREFIX = "ostra-scan: found ";
/** What the push step prints before its result. */
export const PUSH_RESULT_PREFIX = "ostra-push: ";

const planSchema = z.strictObject({
  repos: z.array(
    z.strictObject({
      cloneUrl: z.string().min(1),
      defaultBranch: z.string().min(1),
      checkoutDir: z.string().regex(/^[A-Za-z0-9._-]+$/),
      token: z.string().nullable(),
      files: z.array(z.strictObject({ path: z.string().min(1), content: z.string() })),
    }),
  ),
  dockerfile: z.string(),
  contextFiles: z.array(z.strictObject({ path: z.string().min(1), content: z.string() })),
});
const scanSchema = z.strictObject({ targets: z.array(z.strictObject({ name: z.string(), value: z.string() })) });
const pushSchema = z.strictObject({ ref: z.string().min(1), username: z.string(), token: z.string() });
export const pushResultSchema = z.strictObject({ digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), blobs: z.number().int().nonnegative() });

const envSchema = z.looseObject({
  OSTRA_BUILD_PLAN: z.string().optional(),
  OSTRA_BUILD_CONTEXT: z.string().optional(),
  OSTRA_BUILD_SCAN: z.string().optional(),
  OSTRA_BUILD_IMAGE: z.string().optional(),
  OSTRA_BUILD_PUSH: z.string().optional(),
  OSTRA_BUILD_LAYOUT: z.string().optional(),
});

/** A path under a folder, or `null` when it would leave it. */
const inside = (root: string, relative: string): string | null => {
  const target = path.resolve(root, ...relative.split("/"));
  return target.startsWith(`${path.resolve(root)}${path.sep}`) ? target : null;
};

const git = (args: readonly string[], cwd: string, env: Record<string, string>): Promise<number | null> =>
  new Promise((resolve) => {
    const child = spawn("git", [...args], { cwd, env, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    child.once("error", () => {
      resolve(null);
    });
    child.once("close", (code) => {
      resolve(code);
    });
  });

const required = (value: string | undefined, name: string): string => {
  if (value === undefined || value === "") throw new Error(`${name} isn't set`);
  return value;
};

const writeInside = async (root: string, relative: string, content: string): Promise<void> => {
  const target = inside(root, relative);
  if (target === null) throw new Error("a context file's path leaves the context");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};

/** The build context: each repo cloned with its token for that one clone, then the Dockerfile and the context's files. */
const contextStep = async (env: z.infer<typeof envSchema>, say: (line: string) => void): Promise<number> => {
  const plan = planSchema.parse(JSON.parse(await readFile(required(env.OSTRA_BUILD_PLAN, "OSTRA_BUILD_PLAN"), "utf8")));
  const context = required(env.OSTRA_BUILD_CONTEXT, "OSTRA_BUILD_CONTEXT");
  const gitConfig = path.join(context, ".ostra-gitconfig");
  await mkdir(path.join(context, "repos"), { recursive: true });
  await writeFile(gitConfig, "");
  const basics: Record<string, string> = {};
  for (const name of ["PATH", "Path", "SystemRoot", "HOME", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) basics[name] = value;
  }
  for (const repo of plan.repos) {
    const basic = repo.token === null ? null : Buffer.from(`x-access-token:${repo.token}`).toString("base64");
    const code = await git(
      ["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "clone", "--quiet", "--no-tags", "--single-branch", "--branch", repo.defaultBranch, repo.cloneUrl, path.join(context, "repos", repo.checkoutDir)],
      context,
      {
        ...basics,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: gitConfig,
        ...(basic === null ? {} : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` }),
      },
    );
    if (code !== 0) {
      say(`ostra-context: cloning ${repo.checkoutDir} failed (exit ${String(code)})`);
      return 1;
    }
    for (const file of repo.files) await writeInside(path.join(context, "repos", repo.checkoutDir), file.path, file.content);
  }
  await rm(gitConfig, { force: true });
  await writeInside(context, "Dockerfile", plan.dockerfile);
  for (const file of plan.contextFiles) await writeInside(context, file.path, file.content);
  say(`ostra-context: ${String(plan.repos.length)} repos and ${String(plan.contextFiles.length)} files staged`);
  return 0;
};

/** Milestone 3's scan of every layer, before any push: a hit ends the build here, naming what it found, never a value. */
const scanStep = async (env: z.infer<typeof envSchema>, say: (line: string) => void): Promise<number> => {
  const scan = scanSchema.parse(JSON.parse(await readFile(required(env.OSTRA_BUILD_SCAN, "OSTRA_BUILD_SCAN"), "utf8")));
  const result = await scanImageArchive(required(env.OSTRA_BUILD_IMAGE, "OSTRA_BUILD_IMAGE"), scan.targets);
  if (result.found.length > 0) {
    say(`${SCAN_HIT_PREFIX}${result.found.join(", ")}`);
    return SCAN_HIT_EXIT;
  }
  say(`ostra-scan: clean (${String(result.entries)} entries, ${String(result.bytesScanned)} bytes)`);
  return 0;
};

/** The push, with the push credential only this step mounts: the digest comes back on its last line. */
const pushStep = async (env: z.infer<typeof envSchema>, say: (line: string) => void): Promise<number> => {
  const push = pushSchema.parse(JSON.parse(await readFile(required(env.OSTRA_BUILD_PUSH, "OSTRA_BUILD_PUSH"), "utf8")));
  const ref = parseImageRef(push.ref);
  if (ref === null) {
    say("ostra-push: the push reference doesn't parse");
    return 1;
  }
  const layout = required(env.OSTRA_BUILD_LAYOUT, "OSTRA_BUILD_LAYOUT");
  await rm(layout, { recursive: true, force: true });
  await extractTar(required(env.OSTRA_BUILD_IMAGE, "OSTRA_BUILD_IMAGE"), layout);
  const pushed = await pushOciLayout(layout, ref, { username: push.username, token: push.token }, registryUrlOf(ref.host));
  if (!pushed.ok) {
    say(`ostra-push: ${pushed.message}`);
    return 1;
  }
  say(`${PUSH_RESULT_PREFIX}${JSON.stringify({ digest: pushed.digest, blobs: pushed.blobs })}`);
  return 0;
};

/** Runs one step; answers its exit code. */
export const runBuildStep = async (step: string, env: NodeJS.ProcessEnv = process.env, say: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> => {
  const parsed = envSchema.parse(env);
  try {
    switch (step) {
      case "context":
        return await contextStep(parsed, say);
      case "scan":
        return await scanStep(parsed, say);
      case "push":
        return await pushStep(parsed, say);
      default:
        say(`ostra-build: no step ${step}`);
        return 2;
    }
  } catch (error) {
    // The error's kind only: its message could carry a path or a value.
    say(`ostra-build: the ${step} step failed (${error instanceof Error ? error.name : "unknown"})`);
    return 1;
  }
};
