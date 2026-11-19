import type { ProjectId, SnapshotBuildEnvironment, SnapshotCredentials, SnapshotId } from "@ostra/protocol";

// A project's snapshot on `docker` (F-051, ADR 0038 as amended, Q153, Q184): the environment's base
// image, every repo's checkout and the setup script's result, built from a Dockerfile this module
// writes, ported from spike 3 (`spikes/what-is-inside-a-box/src/snapshot/dockerfile.ts`).
//
// - The runner stages each repo's checkout in the build context (`repos/<checkoutDir>`), cloned with
//   the repo's token outside the build, so the build needs no network and no git token.
// - The setup script runs once per repo in the repo's checkout, as on `host`, as the agent's user,
//   with the repo's variables marked "available during setup". Each setup secret is a BuildKit
//   secret mount on that step only: never a build argument, an `ENV` or a copied file. A secret file
//   is copied into place for the step and removed before the step ends, so no layer keeps it.
// - The checkouts live in the image at `/task/snapshot/workspace`, and nothing is mounted over them
//   (Q153): a box's task volume, mounted at `/task`, starts empty and Docker fills it from the
//   image, so the box sees the checkouts; the sidecar moves them into the task's own workspace.
//
// Every name in the generated text comes from a validated schema (env names, checkout folders,
// repo-relative paths) and every value is quoted for the shell it lands in, so nothing in an
// environment can run as code at build time beyond the admin's own setup script.

/** The task volume's mount point in both containers (`boxes.ts`). */
const TASK_ROOT = "/task";
/** The agent's uid and gid in a box (`boxes.ts`). */
const AGENT = "1000:1000";

/** Where a snapshot's checkouts are in the image: the task volume's own folder for them. */
export const SNAPSHOT_DIR = `${TASK_ROOT}/snapshot`;
export const SNAPSHOT_WORKSPACE = `${SNAPSHOT_DIR}/workspace`;
/** The file that names the snapshot a box's volume was filled from. */
export const SNAPSHOT_MARKER_FILE = "snapshot-id";

/** The labels every snapshot image carries: `hasSnapshot` finds it by them. */
export const SNAPSHOT_LABEL = "ostra.snapshot";
export const PROJECT_LABEL = "ostra.project";

/** The line a failed setup script leaves in the build's output: `setup-failed`, not `build-failed`. */
export const SETUP_FAILED_MARKER = "ostra: the setup script failed in the snapshot build";

/** A Docker repository name: lower-case, and only what a reference allows. */
const referencePart = (value: string, max: number): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, max) || "x";

/** The snapshot's tag in this host's own Docker: `ostra-snapshot/<projectId>:<snapshotId>`. Never pushed (F-120 is milestone 5). */
export const snapshotTag = (projectId: ProjectId, snapshotId: SnapshotId): string =>
  `ostra-snapshot/${referencePart(projectId, 128)}:${snapshotId.replaceAll(/[^A-Za-z0-9_.-]/g, "_").replace(/^[.-]+/, "").slice(0, 128) || "x"}`;

/** A value as one single-quoted shell word. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** An image name the `FROM` line can carry: no whitespace, no quote, nothing a Dockerfile would read as more. */
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,511}$/;

export type SnapshotBuildSecret = {
  /** Its BuildKit secret ID: `s<repo>_<n>`. */
  readonly id: string;
  /** Never logged, never in the context, never in a layer. */
  readonly value: string;
};

export type SnapshotBuildPlan = {
  readonly dockerfile: string;
  /** The context's files besides the staged checkouts, by path from the context's root. None holds a secret. */
  readonly contextFiles: readonly { readonly path: string; readonly content: string }[];
  /** Each setup secret as BuildKit mounts it, for its repo's step only. */
  readonly secrets: readonly SnapshotBuildSecret[];
  /** Every value the image must not hold, by the name ostra shows: the scan looks for each. */
  readonly scanFor: readonly { readonly name: string; readonly value: string }[];
};

export type PlanInput = {
  readonly snapshotId: SnapshotId;
  readonly projectId: ProjectId;
  readonly environment: SnapshotBuildEnvironment;
  readonly credentials: SnapshotCredentials;
  /** ostra's own base image, for an environment that names none. */
  readonly defaultBaseImage: string;
};

export type PlanResult = { readonly ok: true; readonly plan: SnapshotBuildPlan } | { readonly ok: false; readonly detail: string };

/** One repo's setup step: its folder, its variables, its secrets copied in and out, then the script. */
const repoSetupScript = (
  repo: SnapshotBuildEnvironment["repos"][number],
  mounted: readonly { readonly id: string; readonly kind: "variable" | "file"; readonly target: string }[],
): string => {
  const checkout = `${SNAPSHOT_WORKSPACE}/${repo.checkoutDir}`;
  const files = mounted.filter((entry) => entry.kind === "file");
  const lines = [
    "#!/bin/bash",
    `# Written by ostra: ${repo.fullName}'s setup in the snapshot build (F-051). No secret value is in this file.`,
    "set -u",
    `cd ${shellQuote(checkout)} || exit 1`,
    `export OSTRA_REPO=${shellQuote(repo.fullName)}`,
    ...repo.variables.filter((variable) => variable.availableDuringSetup).map((variable) => `export ${variable.name}=${shellQuote(variable.value)}`),
    ...mounted.filter((entry) => entry.kind === "variable").map((entry) => `export ${entry.target}="$(cat /run/secrets/${entry.id})"`),
  ];
  if (files.length > 0) {
    // Copied in for the step, and gone before it ends: the step's layer never holds them.
    lines.push(`ostra_secret_files=(${files.map((entry) => shellQuote(entry.target)).join(" ")})`);
    lines.push('ostra_clean() { rm -f -- "${ostra_secret_files[@]}"; }', "trap ostra_clean EXIT");
    for (const entry of files) {
      lines.push(`mkdir -p -- "$(dirname -- ${shellQuote(entry.target)})" && cp /run/secrets/${entry.id} ${shellQuote(entry.target)}`);
    }
  }
  lines.push(
    "bash /tmp/ostra/setup.sh",
    "code=$?",
    `if [ "$code" -ne 0 ]; then echo ${shellQuote(SETUP_FAILED_MARKER)} >&2; fi`,
    'exit "$code"',
    "",
  );
  return lines.join("\n");
};

/**
 * The snapshot's Dockerfile, its context files and its secrets (F-051). Pure: the unit tests read
 * the generated text. Refuses a base image name a `FROM` line can't carry as one word.
 */
export const planSnapshotBuild = (input: PlanInput): PlanResult => {
  const baseImage = input.environment.baseImage ?? input.defaultBaseImage;
  if (!IMAGE_NAME.test(baseImage)) {
    return { ok: false, detail: "the environment's base image isn't an image name" };
  }
  const script = input.environment.setupScript;
  const hasSetup = script !== null && script.trim().length > 0;
  const secrets: SnapshotBuildSecret[] = [];
  const scanFor: { name: string; value: string }[] = [];
  const contextFiles: { path: string; content: string }[] = [{ path: `ostra/${SNAPSHOT_MARKER_FILE}`, content: `${input.snapshotId}\n` }];
  if (hasSetup) {
    contextFiles.push({ path: "ostra/setup.sh", content: script.replaceAll("\r\n", "\n") });
  }
  const lines: string[] = [
    "# syntax=docker/dockerfile:1.7",
    `# Written by ostra: snapshot ${input.snapshotId} (F-051, ADR 0038). No layer holds a secret.`,
    `FROM ${baseImage}`,
    `LABEL ${JSON.stringify(SNAPSHOT_LABEL)}=${JSON.stringify(input.snapshotId)} ${JSON.stringify(PROJECT_LABEL)}=${JSON.stringify(input.projectId)}`,
    "USER 0:0",
    `RUN mkdir -p ${SNAPSHOT_WORKSPACE} && chown -R ${AGENT} ${TASK_ROOT}`,
    `USER ${AGENT}`,
    `WORKDIR ${SNAPSHOT_WORKSPACE}`,
  ];
  for (const repo of input.environment.repos) {
    lines.push(`COPY --chown=${AGENT} repos/${repo.checkoutDir} ${SNAPSHOT_WORKSPACE}/${repo.checkoutDir}`);
  }
  lines.push(`COPY --chown=${AGENT} ostra/ /tmp/ostra/`);
  for (const [index, repo] of input.environment.repos.entries()) {
    const entries = (input.credentials.secrets.find((entry) => entry.repoId === repo.repoId)?.entries ?? []).filter((entry) => entry.availableDuringSetup);
    const mounted = entries.map((entry, n) => {
      const id = `s${String(index)}_${String(n)}`;
      if (entry.kind === "variable") {
        secrets.push({ id, value: entry.value });
        scanFor.push({ name: entry.name, value: entry.value });
        return { id, kind: "variable" as const, target: entry.name };
      }
      secrets.push({ id, value: entry.content });
      scanFor.push({ name: entry.path, value: entry.content });
      return { id, kind: "file" as const, target: `${SNAPSHOT_WORKSPACE}/${repo.checkoutDir}/${entry.path}` };
    });
    if (!hasSetup) {
      continue;
    }
    contextFiles.push({ path: `ostra/setup-${String(index)}.sh`, content: repoSetupScript(repo, mounted) });
    const mounts = mounted.map((entry) => `--mount=type=secret,id=${entry.id},uid=1000,mode=0400,required=true`).join(" ");
    lines.push(`RUN ${mounts === "" ? "" : `${mounts} `}${JSON.stringify(["bash", `/tmp/ostra/setup-${String(index)}.sh`])}`);
  }
  for (const repo of input.credentials.repos) {
    scanFor.push({ name: `the git token of ${repo.repoId}`, value: repo.gitToken });
  }
  lines.push(
    // The box's sidecar knows its volume came from this snapshot by this file.
    `COPY --chown=${AGENT} ostra/${SNAPSHOT_MARKER_FILE} ${SNAPSHOT_DIR}/${SNAPSHOT_MARKER_FILE}`,
    "USER 0:0",
    "RUN rm -rf /tmp/ostra",
    `USER ${AGENT}`,
    "",
  );
  return { ok: true, plan: { dockerfile: lines.join("\n"), contextFiles, secrets, scanFor } };
};
