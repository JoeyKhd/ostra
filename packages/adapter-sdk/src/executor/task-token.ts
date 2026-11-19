import { chmod, chown, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult } from "../common/result.ts";

// The task token's handoff to a box's sidecar (ADR 0034, Q129), the same on `docker` and
// `kubernetes`: a file in a folder of its own, readable by the sidecar's user only, which the
// sidecar's container mounts and no other container does. Never an environment variable or an
// argument, where `docker inspect`, a process list or a crash report would show it. The token names
// one lease and lasts as long as it, so it's written once and never rewritten.
// Ported from `apps/runner/src/box-dispatcher.ts` (milestone 1's ticket 41), which writes it the same way.

/** Who, besides the runner that writes it, reads the token folder. */
export type TaskTokenOwner =
  /** The runner is root: the folder and its files are handed to the sidecar's uid, and nobody else reads them. */
  | { readonly kind: "owner"; readonly uid: number; readonly gid: number }
  /** The runner isn't root: its own group reads them, and the sidecar's container joins that group. */
  | { readonly kind: "group"; readonly gid: number }
  /** No way to restrict a file here (no POSIX ids): no token is written, and no box is made. */
  | { readonly kind: "none" };

/** The token's file name in its folder, as the sidecar reads it. */
export const TASK_TOKEN_FILE = "token";

export type TaskTokenFileOptions = {
  /** Hands a path to another uid, for `owner`. Defaults to `fs.chown`. */
  readonly chown?: (target: string, uid: number, gid: number) => Promise<void>;
};

/** The folder's and its files' modes for each owner: closed to everyone but the sidecar's user (and the runner). */
export const taskTokenModes = (owner: Exclude<TaskTokenOwner, { readonly kind: "none" }>): { readonly dir: number; readonly file: number } => {
  switch (owner.kind) {
    case "owner":
      return { dir: 0o500, file: 0o400 };
    case "group":
      return { dir: 0o750, file: 0o440 };
    default:
      return owner satisfies never;
  }
};

const refuseNone = (): AdapterResult<never> =>
  adapterError("unsupported", "this host can't restrict a file to the sidecar's user, so it holds no task token");

/**
 * Makes `dir` afresh for a box's sidecar: a folder left by an earlier try may hold an old token, so
 * it's removed first. Owned by the sidecar's uid (`owner`) or readable by the runner's group (`group`).
 */
export const makeTaskTokenDir = async (dir: string, owner: TaskTokenOwner, options: TaskTokenFileOptions = {}): Promise<AdapterResult<void>> => {
  if (owner.kind === "none") {
    return refuseNone();
  }
  const handOver = options.chown ?? chown;
  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  const modes = taskTokenModes(owner);
  if (owner.kind === "owner") {
    await handOver(dir, owner.uid, owner.gid);
  }
  await chmod(dir, modes.dir);
  return ok(undefined);
};

/**
 * Writes one file of a token folder made by `makeTaskTokenDir` (the token, the services' health)
 * with its final mode from the first byte, then moves it into place, so the sidecar never reads
 * half of it. Answers the file's path.
 */
export const writeTaskTokenDirFile = async (
  dir: string,
  owner: TaskTokenOwner,
  name: string,
  content: string,
  options: TaskTokenFileOptions = {},
): Promise<AdapterResult<string>> => {
  if (owner.kind === "none") {
    return refuseNone();
  }
  const handOver = options.chown ?? chown;
  const file = path.join(dir, name);
  const staging = `${file}.next`;
  await rm(staging, { force: true });
  await writeFile(staging, content, { mode: taskTokenModes(owner).file, flag: "wx" });
  if (owner.kind === "owner") {
    await handOver(staging, owner.uid, owner.gid);
  }
  await rename(staging, file);
  return ok(file);
};

/**
 * The task token's handoff (ADR 0034): `dir` made afresh for the sidecar's user, and the token
 * written into it as `token`. Answers the file's path, which only the sidecar's container mounts.
 * `owner: none` writes nothing and answers `unsupported`.
 */
export const writeTaskTokenFile = async (
  dir: string,
  owner: TaskTokenOwner,
  token: string,
  options: TaskTokenFileOptions = {},
): Promise<AdapterResult<string>> => {
  const made = await makeTaskTokenDir(dir, owner, options);
  if (!made.ok) {
    return made;
  }
  return writeTaskTokenDirFile(dir, owner, TASK_TOKEN_FILE, token, options);
};
