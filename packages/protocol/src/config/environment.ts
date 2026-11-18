import { z } from "zod";

import { repoIdSchema } from "../ids.ts";
import { envNameSchema } from "../common.ts";
import { repoRelativePathSchema } from "../task/spec.ts";

// A project's environment (ADR 0038, F-050): the recipe for every box. One per project. Each
// variable, secret and file names one repo. ostra owns this format: strict.

const entryBase = {
  repoId: repoIdSchema,
  /** Set while the setup script runs (a secret then is mounted for the build only, Q39). */
  availableDuringSetup: z.boolean().default(false),
};

export const environmentEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...entryBase, kind: z.literal("variable"), name: envNameSchema, value: z.string().max(65_536) }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("secret"),
    name: envNameSchema,
    /** Only on input: the server stores it through the secret store and keeps a reference. */
    value: z.string().min(1).max(65_536).optional(),
  }),
  z.strictObject({ ...entryBase, kind: z.literal("file"), path: repoRelativePathSchema, content: z.string().max(1_048_576) }),
]);
export type EnvironmentEntry = z.infer<typeof environmentEntrySchema>;
export type EnvironmentEntryKind = EnvironmentEntry["kind"];

export const environmentConfigSchema = z.strictObject({
  /** The `docker` executor's base image, or `null` for ostra's own. The `host` executor ignores it. */
  baseImage: z.string().min(1).max(512).nullable(),
  /** Run with `bash` in the workspace before the agent starts, or `null` for none. */
  setupScript: z.string().max(262_144).nullable(),
  /** Where each repo's variables and secrets are written in its checkout. */
  envFiles: z.array(z.strictObject({ repoId: repoIdSchema, path: repoRelativePathSchema })).default([]),
  entries: z.array(environmentEntrySchema).max(1000),
});
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;

/** The env file a repo gets when its environment names none (spec section 11, item 7). */
export const DEFAULT_ENV_FILE = ".env";
