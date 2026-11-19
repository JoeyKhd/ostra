import { spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { baseEnv, runProgram } from "@ostra/adapter-executor-host";
import { adapterError, ok, silentLogger } from "@ostra/adapter-sdk";
import type { AdapterResult, BuildSnapshotInput, KeptSnapshot, Logger, SnapshotBuildResult } from "@ostra/adapter-sdk";
import { imageDigestSchema } from "@ostra/protocol";
import type { SnapshotId } from "@ostra/protocol";
import { z } from "zod";
import { emptySchema } from "../engine.ts";
import type { Engine } from "../engine.ts";
import { planSnapshotBuild, SETUP_FAILED_MARKER, SNAPSHOT_LABEL, snapshotTag } from "./dockerfile.ts";
import { scanImageArchive } from "./image-scan.ts";

// A project's snapshot on a `docker` pool runner (F-051, ADR 0038 as amended, Q184), kept in this
// host's own Docker with no registry:
//
//   1. clone each repo at its default branch into the build context, with the repo's token in git's
//      environment for that one command (never in an argument, the context or `.git/config`)
//   2. write the Dockerfile and the context's files (`dockerfile.ts`), and each setup secret to a file
//      outside the context, mode 0600, for BuildKit's `--secret`
//   3. build with BuildKit (the `docker` CLI: the Engine API can't mount a build secret without
//      BuildKit's session protocol), tagged `ostra-snapshot/<projectId>:<snapshotId>`
//   4. export the image and scan every layer for each setup secret's value (`image-scan.ts`): a hit
//      deletes the image and fails the build with `secret-found`, naming the secret, never its value;
//      the previous ready snapshot stays in use, as core keeps it
//   5. answer the image's ID as its digest
//
// The staging folder and the secret files go whatever happens.

/** How a snapshot is built: BuildKit, given the context, the Dockerfile, the tag and the secret files. */
export type SnapshotBuilder = (input: {
  readonly contextDir: string;
  readonly dockerfile: string;
  readonly tag: string;
  readonly secrets: readonly { readonly id: string; readonly file: string }[];
  readonly onOutput: (stream: "stdout" | "stderr", text: string) => void;
  readonly signal?: AbortSignal;
}) => Promise<{ readonly exitCode: number | null }>;

/** git on the runner's host, for the clones into the build context. */
export type SnapshotGit = (
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly signal?: AbortSignal },
) => Promise<{ readonly code: number | null }>;

export type DockerSnapshotsOptions = {
  readonly engine: Engine;
  /** Where builds are staged: `<workDir>/snapshots/<snapshotId>/`. */
  readonly workDir: string;
  /** ostra's base image, for an environment that names none. */
  readonly defaultBaseImage: string;
  /** Default: the `docker` CLI with BuildKit. */
  readonly builder?: SnapshotBuilder;
  /** Default: `git` on this host. */
  readonly git?: SnapshotGit;
  readonly logger?: Logger;
  readonly now?: () => number;
};

export type DockerSnapshots = {
  readonly buildSnapshot: (input: BuildSnapshotInput) => Promise<AdapterResult<SnapshotBuildResult>>;
  readonly hasSnapshot: (snapshotId: SnapshotId) => Promise<AdapterResult<KeptSnapshot | null>>;
};

const imagesSchema = z.array(z.looseObject({ Id: z.string(), RepoTags: z.array(z.string()).nullish(), Labels: z.record(z.string(), z.string()).nullish() }));

/** Hides every secret value in the build's output: BuildKit prints what a setup script prints. */
const redactor = (values: readonly string[]): ((text: string) => string) => {
  const hidden = values.filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => hidden.reduce((out, value) => out.replaceAll(value, "[a setup secret]"), text);
};

/** BuildKit through the `docker` CLI: argument arrays only, and an environment of what the CLI needs. */
export const dockerCliBuilder =
  (options: { readonly command?: string; readonly env?: NodeJS.ProcessEnv } = {}): SnapshotBuilder =>
  (input) =>
    new Promise((resolve) => {
      const source = options.env ?? process.env;
      const env: Record<string, string> = { ...baseEnv(source), DOCKER_BUILDKIT: "1" };
      for (const name of ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "BUILDKIT_PROGRESS"] as const) {
        const value = source[name];
        if (value !== undefined) {
          env[name] = value;
        }
      }
      const args = [
        "build",
        "--progress",
        "plain",
        "--file",
        input.dockerfile,
        "--tag",
        input.tag,
        ...input.secrets.flatMap((secret) => ["--secret", `id=${secret.id},src=${secret.file}`]),
        input.contextDir,
      ];
      const child = spawn(options.command ?? "docker", args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(input.signal === undefined ? {} : { signal: input.signal }) });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text: string) => {
        input.onOutput("stdout", text);
      });
      child.stderr.on("data", (text: string) => {
        input.onOutput("stderr", text);
      });
      child.once("error", () => {
        resolve({ exitCode: null });
      });
      child.once("close", (code) => {
        resolve({ exitCode: code });
      });
    });

const localGit: SnapshotGit = (args, options) =>
  runProgram("git", args, { cwd: options.cwd, env: options.env, ...(options.signal === undefined ? {} : { signal: options.signal }) });

export const createDockerSnapshots = (options: DockerSnapshotsOptions): DockerSnapshots => {
  const log = (options.logger ?? silentLogger).child({ component: "snapshots" });
  const builder = options.builder ?? dockerCliBuilder();
  const git = options.git ?? localGit;
  const now = options.now ?? Date.now;

  /** The images that carry the snapshot's label: one, once it's built. */
  const imagesOf = async (snapshotId: SnapshotId): Promise<AdapterResult<z.infer<typeof imagesSchema>>> => {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${SNAPSHOT_LABEL}=${snapshotId}`] }));
    const listed = await options.engine.call("GET", `/images/json?filters=${filters}`, imagesSchema);
    return listed.ok ? ok(listed.value.filter((image) => image.Labels?.[SNAPSHOT_LABEL] === snapshotId)) : adapterError("unavailable", `listing the images failed: ${listed.error.message}`);
  };

  const removeImage = async (imageId: string): Promise<void> => {
    const removed = await options.engine.call("DELETE", `/images/${encodeURIComponent(imageId)}?force=true&noprune=false`, emptySchema);
    if (!removed.ok && removed.error.status !== 404) {
      log.warn("removing a snapshot image failed", { status: removed.error.status });
    }
  };

  const failed = (reason: "setup-failed" | "secret-found" | "build-failed", detail: string): AdapterResult<SnapshotBuildResult> =>
    ok({ outcome: "failed", reason, detail: detail.slice(0, 2000) });

  return {
    hasSnapshot: async (snapshotId) => {
      const images = await imagesOf(snapshotId);
      if (!images.ok) {
        return images;
      }
      const [image] = images.value;
      const digest = imageDigestSchema.safeParse(image?.Id);
      if (image === undefined || !digest.success) {
        return ok(null);
      }
      const tag = image.RepoTags?.find((each) => each.startsWith("ostra-snapshot/")) ?? image.RepoTags?.[0] ?? digest.data;
      return ok({ imageRef: tag, imageDigest: digest.data });
    },

    buildSnapshot: async (input) => {
      const started = now();
      const staging = path.join(options.workDir, "snapshots", input.snapshotId.replaceAll(/[^A-Za-z0-9._-]/g, "_"));
      const contextDir = path.join(staging, "context");
      const secretDir = path.join(staging, "secrets");
      const tag = snapshotTag(input.projectId, input.snapshotId);
      const planned = planSnapshotBuild({
        snapshotId: input.snapshotId,
        projectId: input.projectId,
        environment: input.environment,
        credentials: input.credentials,
        defaultBaseImage: options.defaultBaseImage,
      });
      if (!planned.ok) {
        return failed("build-failed", planned.detail);
      }
      const plan = planned.plan;
      const redact = redactor([...plan.secrets.map((secret) => secret.value), ...input.credentials.repos.map((repo) => repo.gitToken)]);
      const blog = log.child({ snapshotId: input.snapshotId, projectId: input.projectId });
      try {
        await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await mkdir(path.join(contextDir, "repos"), { recursive: true });
        await mkdir(secretDir, { recursive: true, mode: 0o700 });
        // 1. The checkouts, each with its token for its one clone.
        const emptyConfig = path.join(staging, "gitconfig");
        await writeFile(emptyConfig, "");
        for (const repo of input.environment.repos) {
          const token = input.credentials.repos.find((entry) => entry.repoId === repo.repoId)?.gitToken;
          const basic = token === undefined ? null : Buffer.from(`x-access-token:${token}`).toString("base64");
          const cloned = await git(
            ["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "clone", "--quiet", "--no-tags", "--single-branch", "--branch", repo.defaultBranch, repo.cloneUrl, path.join(contextDir, "repos", repo.checkoutDir)],
            {
              cwd: staging,
              env: {
                ...baseEnv(),
                GIT_TERMINAL_PROMPT: "0",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: emptyConfig,
                GIT_CEILING_DIRECTORIES: staging,
                ...(basic === null ? {} : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` }),
              },
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            },
          );
          if (cloned.code !== 0) {
            blog.warn("cloning a repo for the snapshot failed", { repoId: repo.repoId, code: cloned.code });
            return failed("build-failed", `cloning ${repo.fullName} failed`);
          }
          for (const file of repo.files) {
            const target = path.join(contextDir, "repos", repo.checkoutDir, ...file.path.split("/"));
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, file.content);
          }
        }
        // 2. The Dockerfile, the context's files and the secrets' files.
        const dockerfile = path.join(staging, "Dockerfile");
        await writeFile(dockerfile, plan.dockerfile);
        for (const file of plan.contextFiles) {
          const target = path.join(contextDir, ...file.path.split("/"));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, file.content);
        }
        const secretFiles: { id: string; file: string }[] = [];
        for (const secret of plan.secrets) {
          const file = path.join(secretDir, secret.id);
          await writeFile(file, secret.value, { mode: 0o600 });
          await chmod(file, 0o600);
          secretFiles.push({ id: secret.id, file });
        }
        // 3. The build.
        let output = "";
        const built = await builder({
          contextDir,
          dockerfile,
          tag,
          secrets: secretFiles,
          onOutput: (stream, text) => {
            const shown = redact(text);
            output = (output + shown).slice(-64 * 1024);
            input.onOutput(stream, shown);
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        // The secret files go as soon as the build is over: nothing after needs them.
        await rm(secretDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        if (built.exitCode !== 0) {
          const setupFailed = output.includes(SETUP_FAILED_MARKER);
          blog.info("snapshot build failed", { exitCode: built.exitCode, setupFailed });
          return failed(setupFailed ? "setup-failed" : "build-failed", setupFailed ? "the setup script failed in the snapshot build" : `the image build failed (exit ${String(built.exitCode)})`);
        }
        const images = await imagesOf(input.snapshotId);
        const image = images.ok ? images.value[0] : undefined;
        const digest = imageDigestSchema.safeParse(image?.Id);
        if (image === undefined || !digest.success) {
          return failed("build-failed", "the build left no image with the snapshot's label");
        }
        // 4. The scan, before anything uses the image.
        const archive = path.join(staging, "image.tar");
        const exported = await options.engine.download(`/images/${encodeURIComponent(image.Id)}/get`, archive);
        if (!exported.ok) {
          await removeImage(image.Id);
          return failed("build-failed", `exporting the image for its scan failed: ${exported.error.message}`);
        }
        let scan;
        try {
          scan = await scanImageArchive(archive, plan.scanFor);
        } catch (error) {
          await removeImage(image.Id);
          return failed("build-failed", `the image couldn't be scanned (${error instanceof Error ? error.name : "unknown"})`);
        }
        if (scan.found.length > 0) {
          await removeImage(image.Id);
          // Names only: a secret's value is never in an event, a log line or the panel.
          blog.warn("a setup secret was found in the snapshot image: deleted", { found: scan.found.length });
          return failed("secret-found", `The setup secret${scan.found.length === 1 ? "" : "s"} ${scan.found.join(", ")} ${scan.found.length === 1 ? "was" : "were"} found in the image, so the image was deleted. A setup script must not write a secret's value into a file.`);
        }
        blog.info("snapshot built", { entries: scan.entries, bytesScanned: scan.bytesScanned, durationMs: now() - started });
        return ok({ outcome: "built", imageRef: tag, imageDigest: digest.data, durationMs: Math.max(0, now() - started) });
      } catch (error) {
        return failed("build-failed", `the build couldn't be staged (${error instanceof Error ? error.name : "unknown"})`);
      } finally {
        await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      }
    },
  };
};
