import type { RepoTree, TreeFile, TreeFileMode, TreeLimits, TreeNote, TreeNoteReason } from "./base.ts";

// Milestone 8 (F-145, ADR 0069, ADR 0025 amended): the rules every code host applies in
// `readTree`, written once so GitHub, the fake code host and a later GitLab read a repo alike:
// - the folder: repo-relative, with no `..`, and `""` for the whole repo;
// - the caps, applied while reading: a file over the bytes left is left out and reading goes on;
//   the first file past `maxFiles` stops it;
// - a symlink, followed only when its target, and every hop to it, stays inside the folder, as the
//   `skills` CLI follows "symlinks that stay inside the skill" (research §2.5). A link to a file
//   carries that file's bytes and mode; a link to a folder carries its files, under the link's path.
//
// Nothing here logs: a tree's paths and bytes are the repo's content.

/** The most notes a tree carries. Past it notes are dropped, and `truncated` or the files say the rest. */
export const TREE_NOTES_MAX = 100;
/** The most hops a chain of symlinks takes before it counts as a loop. */
const SYMLINK_HOPS_MAX = 8;
const PATH_MAX_CHARS = 1024;

const isSafeSegment = (part: string): boolean => part !== "" && part !== "." && part !== "..";

/**
 * A folder to read, normalized: `""` for the whole repo (`""`, `"."`), else `a/b` with no slash at
 * either end. `null` when it isn't repo-relative: absolute, with `..`, a backslash or a control character.
 */
export const treeFolderOf = (path: string): string | null => {
  const folder = path === "." ? "" : path.endsWith("/") ? path.slice(0, -1) : path;
  if (folder === "") {
    return "";
  }
  if (folder.length > PATH_MAX_CHARS || folder.startsWith("/") || folder.includes("\\") || /[\u0000-\u001f\u007f]/.test(folder)) {
    return null;
  }
  return folder.split("/").every(isSafeSegment) ? folder : null;
};

/** Why the caps can't be used, or `null`: each is a whole number, `maxFiles` at least 1. */
export const treeLimitsProblem = (limits: TreeLimits): string | null =>
  Number.isSafeInteger(limits.maxFiles) && limits.maxFiles >= 1 && Number.isSafeInteger(limits.maxBytes) && limits.maxBytes >= 0
    ? null
    : "a tree's caps are whole numbers: at least one file, and no fewer than zero bytes";

/** A link's target from where the link sits, as a repo-relative path; `null` when it leaves the repo. */
const joinTarget = (linkPath: string, target: string): string | null => {
  if (target.startsWith("/") || target.includes("\\") || target === "") {
    return null;
  }
  const parts = linkPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
};

/** Whether `path` is `ancestor` or under it; `""` is the repo's root, above everything. */
const isUnder = (path: string, ancestor: string): boolean => ancestor === "" || path === ancestor || path.startsWith(`${ancestor}/`);

const byPath = <T extends { readonly path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * What an adapter feeds as it reads a commit's entries, in any order, and what it gets back. It
 * asks `wants` before reading a file's bytes, so a file the caps leave out is never held.
 */
export type TreeCollector = {
  /**
   * Whether to read the file at `path` (repo-relative) of `size` bytes: it's inside the folder and
   * fits the caps. When it is, the caller reads its bytes and gives them to `file`. A file outside
   * the folder is simply not wanted; one the caps leave out is noted.
   */
  readonly wants: (path: string, size: number) => boolean;
  readonly file: (path: string, mode: TreeFileMode, bytes: Uint8Array) => void;
  /** A symlink and its target as git stores it; resolved when the tree is finished. */
  readonly symlink: (path: string, target: string) => void;
  /** True once a file past `maxFiles` was offered: the caller stops reading. */
  readonly full: () => boolean;
  readonly finish: () => RepoTree;
};

/** Where a link's chain ends: a path inside the folder, or outside it (a loop counts as outside). */
type LinkTarget = { readonly kind: "path"; readonly path: string } | { readonly kind: "outside" };

/** Collects one `readTree`'s files under `folder` (from `treeFolderOf`) within `limits`. */
export const createTreeCollector = (folder: string, limits: TreeLimits): TreeCollector => {
  const files = new Map<string, TreeFile>();
  const links = new Map<string, string>();
  const notes: TreeNote[] = [];
  /** Files a cap left out, so a link to one says why it's missing. */
  const leftOut = new Map<string, TreeNoteReason>();
  let taken = 0;
  let bytes = 0;
  let truncated = false;
  let stopped = false;

  const note = (path: string, reason: TreeNoteReason): void => {
    if (notes.length < TREE_NOTES_MAX) {
      notes.push({ path, reason });
    }
  };
  /** Counts a file against the caps, or says which cap leaves it out (and notes it). */
  const admit = (path: string, size: number): TreeNoteReason | null => {
    if (stopped || taken >= limits.maxFiles) {
      truncated = true;
      if (!stopped) {
        stopped = true;
        note(path, "over-max-files");
      }
      return "over-max-files";
    }
    if (bytes + size > limits.maxBytes) {
      truncated = true;
      note(path, "over-max-bytes");
      return "over-max-bytes";
    }
    taken += 1;
    bytes += size;
    return null;
  };
  /** Follows a link's chain to a path that isn't a link, every hop inside the folder. */
  const follow = (linkPath: string, target: string): LinkTarget => {
    let from = linkPath;
    let to = target;
    for (let hop = 0; hop < SYMLINK_HOPS_MAX; hop += 1) {
      const next = joinTarget(from, to);
      if (next === null || !isUnder(next, folder)) {
        return { kind: "outside" };
      }
      // A link to itself, or to a folder holding it, would read itself forever: never followed.
      if (isUnder(linkPath, next)) {
        return { kind: "outside" };
      }
      const again = links.get(next);
      if (again === undefined) {
        return { kind: "path", path: next };
      }
      from = next;
      to = again;
    }
    return { kind: "outside" };
  };
  const copy = (file: TreeFile, path: string): void => {
    if (files.has(path)) {
      return;
    }
    const reason = admit(path, file.size);
    if (reason === null) {
      files.set(path, { ...file, path });
    } else {
      leftOut.set(path, reason);
    }
  };

  return {
    wants: (path, size) => {
      if (!isUnder(path, folder)) {
        return false;
      }
      const reason = admit(path, size);
      if (reason !== null) {
        leftOut.set(path, reason);
        return false;
      }
      return true;
    },
    file: (path, mode, content) => {
      files.set(path, { path, size: content.length, mode, bytes: content });
    },
    symlink: (path, target) => {
      if (isUnder(path, folder)) {
        links.set(path, target);
      }
    },
    full: () => stopped,
    finish: () => {
      for (const [path, target] of [...links].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const resolved = follow(path, target);
        if (resolved.kind === "outside") {
          note(path, "symlink-outside");
          continue;
        }
        const file = files.get(resolved.path);
        if (file !== undefined) {
          copy(file, path);
          continue;
        }
        const under = [...files.values()].filter((candidate) => candidate.path.startsWith(`${resolved.path}/`)).sort(byPath);
        if (under.length > 0) {
          for (const inner of under) {
            copy(inner, `${path}${inner.path.slice(resolved.path.length)}`);
          }
          continue;
        }
        note(path, leftOut.get(resolved.path) ?? (stopped ? "over-max-files" : "symlink-dangling"));
      }
      return { files: [...files.values()].sort(byPath), truncated, notes: [...notes].sort(byPath) };
    },
  };
};
