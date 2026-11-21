import { secretRefSchema } from "@ostra/adapter-sdk";
import { blobIdSchema, runnerLimits, sha256HexSchema } from "@ostra/protocol";
import { z } from "zod";

import type { ServerSnapshot } from "./diffs.ts";

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
