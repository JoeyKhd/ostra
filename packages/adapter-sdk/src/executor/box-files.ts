import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { FILES_ROOT_DIR, fileBoxPathSchema, fileTextPathSchema } from "@ostra/protocol";

// Files for the agent in the box (milestone 9, ADR 0070, F-148, F-149, F-150): a message's files
// and a ticket's, and a document's text beside each, under the workspace root's `.ostra/`, outside
// every repo. The runner writes them with these, the same way on every executor (`docker`,
// `kubernetes`, `host`): the workspace root is the box's own folder as the runner's process and the
// agent's both read it. The executor suite checks the place on each executor.
//
// A file's place is core's (`attachments/<n>/<name>` or `ticket/<name>`), checked again here with
// the protocol's schemas, and the folder it lands in must resolve inside the root's `.ostra/`: a
// link, a junction or `..` that leaves it is refused. A file is written beside its place under a
// fresh name, then moved onto it, so a link put at the place is replaced, never followed. Every
// file is `0644` and every folder `0755`: readable by the agent's user, never executable. Nothing
// here runs a file, and nothing here logs: a path holds the member's or the ticket's file name.

/** The folder under a box's workspace root that holds every file for the agent: `<root>/.ostra/`. */
export const boxFilesDir = (workspaceDir: string): string => path.join(workspaceDir, FILES_ROOT_DIR);

/** A file's or a text's place under `.ostra/`, as the protocol's schemas read it: its parts, or `null`. */
const placeParts = (place: string): readonly string[] | null =>
  fileBoxPathSchema.safeParse(place).success || fileTextPathSchema.safeParse(place).success ? place.split("/") : null;

/** Where a file under the root's `.ostra/` is on this file system, for a place the schemas accept; `null` for one they refuse. */
export const boxFilePath = (workspaceDir: string, place: string): string | null =>
  placeParts(place) === null ? null : path.join(boxFilesDir(workspaceDir), ...place.split("/"));

/**
 * How placing a file went: `written`; `present`, already there with the same bytes, so not written
 * again; `path-refused`, its place isn't one or leaves the root's `.ostra/`; `write-failed`, the
 * file system refused.
 */
export type BoxFilePlacement = "written" | "present" | "path-refused" | "write-failed";

const FILE_MODE = 0o644;
const FOLDER_MODE = 0o755;

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const codeOf = (error: unknown): string | undefined => {
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
};

/** `target` is `dir` or somewhere below it. */
const isInside = (dir: string, target: string): boolean => {
  const relative = path.relative(dir, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** The entry at a path, without following a link, or `null` when there's none. */
const entryAt = async (target: string): Promise<Stats | null> => {
  try {
    return await lstat(target);
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/**
 * The folder `parts` names under `root`, each part made when it's missing and checked when it's
 * there: a real folder, never a link or a junction. Then the folder as the file system resolves it
 * must sit inside the root's `.ostra/`. `null` when it doesn't.
 */
const folderInside = async (root: string, parts: readonly string[]): Promise<string | null> => {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let found = await entryAt(current);
    if (found === null) {
      try {
        await mkdir(current, { mode: FOLDER_MODE });
        // The mode as given, whatever the process's umask: the agent's user reads the folder.
        await chmod(current, FOLDER_MODE);
      } catch (error) {
        if (codeOf(error) !== "EEXIST") {
          throw error;
        }
      }
      found = await entryAt(current);
    }
    if (found === null || found.isSymbolicLink() || !found.isDirectory()) {
      return null;
    }
  }
  return isInside(path.join(root, FILES_ROOT_DIR), await realpath(current)) ? current : null;
};

/**
 * Writes one file under the workspace root's `.ostra/`, at its place (`attachments/<n>/<name>`,
 * `ticket/<name>`, or either with `.md` for a document's text). A file already there with the same
 * bytes isn't written again (`present`). The bytes are the caller's, checked against their size and
 * digest before they come here.
 */
export const placeBoxFile = async (input: { readonly workspaceDir: string; readonly place: string; readonly bytes: Uint8Array }): Promise<BoxFilePlacement> => {
  const parts = placeParts(input.place);
  const name = parts?.at(-1);
  if (parts === null || name === undefined) {
    return "path-refused";
  }
  const folderParts = [FILES_ROOT_DIR, ...parts.slice(0, -1)];
  let root: string;
  let folder: string | null;
  try {
    root = await realpath(input.workspaceDir);
    folder = await folderInside(root, folderParts);
  } catch {
    return "write-failed";
  }
  if (folder === null) {
    return "path-refused";
  }
  const target = path.join(folder, name);
  const temp = path.join(folder, `.ostra-write-${randomBytes(8).toString("hex")}`);
  try {
    const there = await entryAt(target);
    if (there !== null) {
      if (there.isSymbolicLink() || !there.isFile()) {
        return "path-refused";
      }
      if (there.size === input.bytes.length && sha256Of(await readFile(target)) === sha256Of(input.bytes)) {
        return "present";
      }
    }
    // A new file of its own (`wx` makes it, and never opens one that's there or a link), then moved
    // onto the place: a move replaces whatever is at the place, and never follows it.
    const handle = await open(temp, "wx", FILE_MODE);
    try {
      await handle.writeFile(input.bytes);
      await handle.chmod(FILE_MODE);
    } finally {
      await handle.close();
    }
    // The folder is checked again just before the file takes its place: a link swapped in since is refused.
    if ((await folderInside(root, folderParts)) === null) {
      await rm(temp, { force: true });
      return "path-refused";
    }
    await rename(temp, target);
    return "written";
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    return "write-failed";
  }
};

/**
 * A file under the workspace root's `.ostra/` when it's there with exactly these bytes (its size and
 * SHA-256), a real file in a real folder inside `.ostra/`; else `null`. What the runner reads back to
 * send an image, and to skip a download of a file a kept box still holds.
 */
export const readBoxFile = async (input: {
  readonly workspaceDir: string;
  readonly place: string;
  readonly size: number;
  readonly sha256: string;
}): Promise<Uint8Array | null> => {
  const parts = placeParts(input.place);
  const name = parts?.at(-1);
  if (parts === null || name === undefined) {
    return null;
  }
  try {
    const root = await realpath(input.workspaceDir);
    const base = path.join(root, FILES_ROOT_DIR);
    let current = root;
    for (const part of [FILES_ROOT_DIR, ...parts.slice(0, -1)]) {
      current = path.join(current, part);
      const found = await entryAt(current);
      if (found === null || found.isSymbolicLink() || !found.isDirectory()) {
        return null;
      }
    }
    if (!isInside(base, await realpath(current))) {
      return null;
    }
    const target = path.join(current, name);
    const there = await entryAt(target);
    if (there === null || there.isSymbolicLink() || !there.isFile() || there.size !== input.size) {
      return null;
    }
    const bytes = await readFile(target);
    return bytes.length === input.size && sha256Of(bytes) === input.sha256 ? bytes : null;
  } catch {
    return null;
  }
};
