import { secretRefSchema } from "@ostra/adapter-sdk";
import { blobIdSchema, runnerLimits, sha256HexSchema } from "@ostra/protocol";
import { z } from "zod";

import type { ServerDiff, ServerSnapshot, SkillDiff } from "./diffs.ts";

// F-145 (ADR 0069, ticket 27): what a library version's JSON columns hold, in ostra's own format,
// so strict. A skill's files as blobs with their digests; a server's remote as the registry asked
// for it (its URL template and the inputs it asks for, never a value); and the admin's inputs, a
// plain value kept as it is and a secret one only as its secret store reference. Read back through
// these schemas wherever a version is used: the install, the test call, delivery and the update
// check (ticket 28). Nothing here is logged.

/** One file of a skill's version: its blob, which delivery copies into a task's blobs with its digest. */
export const libraryVersionFileSchema = z.strictObject({
  /** Relative to the skill's folder, `/`-separated. */
  path: z.string().min(1).max(1024),
  blobId: blobIdSchema,
  size: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
  executable: z.boolean(),
});
export type LibraryVersionFile = z.infer<typeof libraryVersionFileSchema>;

/** `LibraryItemVersion.files`: `SKILL.md` and at most 20 more. */
export const libraryVersionFilesSchema = z.array(libraryVersionFileSchema).max(runnerLimits.skillFilesMax + 1);

/** An input a server's remote asks for, as the version keeps it: its name, whether it's a secret, and the entry's words. */
export const storedServerInputSpecSchema = z.strictObject({
  name: z.string().min(1).max(256),
  isSecret: z.boolean(),
  isRequired: z.boolean(),
  /** Untrusted text from the registry, shown as data. */
  description: z.string().max(4096).nullable(),
});
export type StoredServerInputSpec = z.infer<typeof storedServerInputSpecSchema>;

/** `LibraryItemVersion.serverEntry`: the registry entry's remote, as asked. Never a secret's value. */
export const storedServerEntrySchema = z.strictObject({
  /** `streamable-http`, the only transport ostra installs (Q320). */
  transport: z.literal("streamable-http"),
  /** The remote's URL, `{name}` where a URL variable goes. */
  remoteUrl: z.string().min(1).max(2048),
  description: z.string().max(4096).nullable(),
  variables: z.array(storedServerInputSpecSchema).max(50),
  headers: z.array(storedServerInputSpecSchema).max(50),
  /** Headers the entry fixes itself, never a secret: sent as they are. */
  fixedHeaders: z.record(z.string().min(1).max(256), z.string().max(8192)),
});
export type StoredServerEntry = z.infer<typeof storedServerEntrySchema>;

/** One input's value as kept: a plain one as it is, a secret one as its reference only. */
export const storedServerInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plain"), value: z.string().max(8192) }),
  z.strictObject({ kind: z.literal("secret"), ref: secretRefSchema }),
]);
export type StoredServerInput = z.infer<typeof storedServerInputSchema>;

/** `LibraryItemVersion.serverInputs`: the admin's values by input name. Never a secret's value; never logged. */
export const storedServerInputsSchema = z.strictObject({
  variables: z.record(z.string().min(1).max(256), storedServerInputSchema),
  headers: z.record(z.string().min(1).max(256), storedServerInputSchema),
});
export type StoredServerInputs = z.infer<typeof storedServerInputsSchema>;

/** `LibraryItemVersion.toolNames`. */
export const storedToolNamesSchema = z.array(z.string().min(1).max(128)).max(500);

/** A server version as `serverDiff` compares it (ticket 28's update check). */
export const serverSnapshotOf = (input: {
  readonly registryVersion: string;
  readonly entry: StoredServerEntry;
  readonly toolNames: readonly string[];
}): ServerSnapshot => ({
  version: input.registryVersion,
  description: input.entry.description,
  remoteUrl: input.entry.remoteUrl,
  headers: input.entry.headers.map((header) => ({ name: header.name, isSecret: header.isSecret })),
  toolNames: input.toolNames,
});

// ---------- an update's diff (ticket 28), as `LibraryItemVersion.diff` keeps it ----------

const lineNumber = z.number().int().positive();

const skillDiffLineSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("context"), oldLine: lineNumber, newLine: lineNumber, text: z.string() }),
  z.strictObject({ kind: z.literal("add"), oldLine: z.null(), newLine: lineNumber, text: z.string() }),
  z.strictObject({ kind: z.literal("del"), oldLine: lineNumber, newLine: z.null(), text: z.string() }),
]);

/** `skillDiff`'s result, strict. Its text is the skill's: shown as data, never logged. */
export const skillDiffSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      path: z.string().min(1).max(1024),
      change: z.enum(["added", "removed", "changed"]),
      binary: z.boolean(),
      lines: z.array(skillDiffLineSchema),
      truncated: z.boolean(),
    }),
  ),
  truncated: z.boolean(),
}) satisfies z.ZodType<SkillDiff>;

const fieldChangeOf = <T extends z.ZodType>(value: T) => z.strictObject({ from: value, to: value }).nullable();
const names = z.array(z.string().max(256)).max(500);

/** `serverDiff`'s result, strict. */
export const serverDiffSchema = z.strictObject({
  version: fieldChangeOf(z.string()),
  description: fieldChangeOf(z.string().nullable()),
  remoteUrl: fieldChangeOf(z.string()),
  headers: z.strictObject({ added: names, removed: names, secretChanged: z.array(z.strictObject({ name: z.string().max(256), isSecret: z.boolean() })).max(50) }),
  tools: z.strictObject({ added: names, removed: names }),
  changed: z.boolean(),
}) satisfies z.ZodType<ServerDiff>;

/**
 * How a server update's fresh test call went: its tools `listed`, an OAuth challenge, no answer,
 * or not made because the new version asks for an input the item doesn't have.
 */
export const serverUpdateTestSchema = z.enum(["listed", "needs-oauth", "unavailable", "needs-input"]);
export type ServerUpdateTest = z.infer<typeof serverUpdateTestSchema>;

/**
 * `LibraryItemVersion.diff` of an update, against the version that was current when it was found:
 * a skill's files, or a server's fields with its test call's outcome and the inputs it lacks
 * (names only). Absent on an install's first version.
 */
export const storedVersionDiffSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("skill"), diff: skillDiffSchema }),
  z.strictObject({ kind: z.literal("server"), diff: serverDiffSchema, test: serverUpdateTestSchema, missingInputs: z.array(z.string().min(1).max(256)).max(100) }),
]);
export type StoredVersionDiff = z.infer<typeof storedVersionDiffSchema>;
