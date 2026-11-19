import type { CompareResult } from "@ostra/adapter-sdk";
import { z } from "zod";

import { lineAt, parseUnifiedDiff } from "./unified-diff.ts";
import type { DiffLine, DiffSide, ParsedPatch } from "./unified-diff.ts";

// A task repo's diff as `DiffCache.result` keeps it (F-027, ADR 0051): the code host's compare of
// the base and the pushed head, cut to the install's limits. A schema ostra owns, so it rejects
// unknown fields; a row it can't read is fetched again. Holds the repo's code: never logged.

export const STORED_DIFF_VERSION = 1;

const storedFileSchema = z.strictObject({
  path: z.string().min(1),
  previousPath: z.string().min(1).nullable(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** The unified diff, or `null`: a binary file, or one cut for its size (`tooLarge`). */
  patch: z.string().nullable(),
  /** Over the install's limits, or cut by the host: the panel says "Too large to show here" and links `hostUrl`. */
  tooLarge: z.boolean(),
});
export type StoredDiffFile = z.infer<typeof storedFileSchema>;

export const storedDiffSchema = z.strictObject({
  version: z.literal(STORED_DIFF_VERSION),
  /** The commit the head grew from, as the host reported it. */
  mergeBase: z.string().nullable(),
  headSha: z.string().min(1),
  aheadBy: z.number().int().nonnegative(),
  behindBy: z.number().int().nonnegative(),
  /** More files changed than the host listed, or than `OSTRA_DIFF_MAX_FILES`. */
  filesTruncated: z.boolean(),
  /** Where the code host shows the whole diff, for a file too large to show here. */
  hostUrl: z.string().nullable(),
  files: z.array(storedFileSchema),
});
export type StoredDiff = z.infer<typeof storedDiffSchema>;

export type DiffLimits = {
  /** `OSTRA_DIFF_MAX_FILES`: files past it are kept as too large, with no patch. */
  readonly maxFiles: number;
  /** `OSTRA_DIFF_MAX_PATCH_KIB`, in bytes: a larger patch is kept as too large. */
  readonly maxPatchBytes: number;
};

/** A compare cut to the limits, as it's stored. Pure. */
export const toStoredDiff = (compare: CompareResult, input: { readonly headSha: string; readonly hostUrl: string | null; readonly limits: DiffLimits }): StoredDiff => ({
  version: STORED_DIFF_VERSION,
  mergeBase: compare.mergeBase,
  headSha: input.headSha,
  aheadBy: compare.aheadBy,
  behindBy: compare.behindBy,
  filesTruncated: compare.filesTruncated || compare.files.length > input.limits.maxFiles,
  hostUrl: input.hostUrl,
  files: compare.files.map((file, index) => {
    const overFiles = index >= input.limits.maxFiles;
    const overPatch = file.patch !== null && new TextEncoder().encode(file.patch).length > input.limits.maxPatchBytes;
    const tooLarge = overFiles || overPatch || file.truncated;
    return {
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: tooLarge ? null : file.patch,
      tooLarge,
    };
  }),
});

/** Reads a stored diff (external data: storage). `null` for a row of another shape, which is fetched again. */
export const readStoredDiff = (value: unknown): StoredDiff | null => {
  const parsed = storedDiffSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** One file's patch, parsed, or `null` when the diff has no such file. */
export const parsedFile = (diff: StoredDiff, path: string): ParsedPatch | null => {
  const file = diff.files.find((candidate) => candidate.path === path);
  return file === undefined ? null : parseUnifiedDiff(file.patch);
};

/** The line a comment points at in a diff, or `null` when that diff doesn't show it. */
export const diffLineAt = (diff: StoredDiff, path: string, side: DiffSide, line: number): DiffLine | null => {
  const parsed = parsedFile(diff, path);
  return parsed === null ? null : lineAt(parsed, side, line);
};

/**
 * Whether a comment written on one head still points at the same code in a newer head's diff: the
 * line at its place shows the same text, with the same kind of change. A line that changed, moved
 * or left the diff makes the comment outdated (F-072).
 */
export const commentStillMatches = (
  comment: { readonly path: string; readonly side: DiffSide; readonly line: number },
  written: StoredDiff,
  latest: StoredDiff,
): boolean => {
  const before = diffLineAt(written, comment.path, comment.side, comment.line);
  const after = diffLineAt(latest, comment.path, comment.side, comment.line);
  if (after === null) {
    return false;
  }
  return before === null ? false : before.text === after.text && before.kind === after.kind;
};
