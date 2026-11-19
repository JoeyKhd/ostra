import { z } from "zod";

import { repoIdSchema, snapshotIdSchema, taskIdSchema } from "../ids.ts";
import { apiFormatSchema, authSchemeSchema, envNameSchema, epochMsSchema, leaseEpochSchema } from "../common.ts";
import { runnerLimits } from "../runner/limits.ts";
import { agentItemNameSchema, repoRelativePathSchema } from "./spec.ts";

// The task credentials (ADR 0030): the secrets a task needs, returned by
// `POST /runner/v1/tasks/:taskId/credentials` only after the server checks the lease epoch. They
// stay in the runner's process (the sidecar's work): the agent's process never gets them, only the
// fake key and the proxy URLs.
//
// The type is branded `TaskCredentials`, so the adapter SDK's logger refuses one by type.

const NEVER_LOGGED =
  "The task's credentials. The payload is never logged, never written to an event, and never passed to the agent's process.";

const secretValue = z.string().min(1).max(65_536);

export const modelEndpointCredentialsSchema = z.strictObject({
  baseUrl: z.url({ protocol: /^https?$/ }),
  apiFormat: apiFormatSchema,
  authScheme: authSchemeSchema,
  /** The provider's real token. The key proxy swaps it in for the task's fake key. */
  token: secretValue,
});

export const repoCredentialsSchema = z.strictObject({
  repoId: repoIdSchema,
  /** A code host token for this one repo only, with the named permissions (ADR 0030). */
  gitToken: secretValue,
  expiresAt: epochMsSchema,
});

export const repoSecretSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("variable"),
    name: envNameSchema,
    value: z.string().max(65_536),
    availableDuringSetup: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("file"),
    path: repoRelativePathSchema,
    content: z.string().max(1_048_576),
    availableDuringSetup: z.boolean(),
  }),
]);
export type RepoSecret = z.infer<typeof repoSecretSchema>;

const taskCredentialsShapeV1 = {
  taskId: taskIdSchema,
  leaseEpoch: leaseEpochSchema,
  model: modelEndpointCredentialsSchema,
  repos: z.array(repoCredentialsSchema),
  /** The environment's secrets, per repo (F-050). */
  secrets: z.array(z.strictObject({ repoId: repoIdSchema, entries: z.array(repoSecretSchema) })),
  /** The token the runner sends with this task's calls to ostra's MCP endpoint. */
  mcpToken: secretValue,
};

/**
 * An HTTP MCP server's address and secret headers (minor 2, ADR 0049, Q170), for the sidecar's MCP
 * proxy, which forwards the agent's calls on the spec's `proxyPath` and adds the headers. Never
 * logged; the agent never sees them.
 */
export const mcpServerCredentialsSchema = z.strictObject({
  name: agentItemNameSchema,
  url: z.url({ protocol: /^https?$/ }),
  headers: z.record(z.string().min(1).max(256), secretValue),
});
export type McpServerCredentials = z.infer<typeof mcpServerCredentialsSchema>;

/** Minor 1's credentials, kept for the endpoint's answer to a minor-1 runner. */
export const taskCredentialsSchemaV1 = z
  .strictObject(taskCredentialsShapeV1)
  .describe(NEVER_LOGGED)
  .brand<"TaskCredentials">();

/** The credentials at the current minor (2). */
export const taskCredentialsSchema = z
  .strictObject({
    ...taskCredentialsShapeV1,
    /** Minor 2: the profile's HTTP MCP servers. Never logged. */
    mcpServers: z.array(mcpServerCredentialsSchema).max(runnerLimits.mcpServersMax).optional(),
  })
  .describe(NEVER_LOGGED)
  .brand<"TaskCredentials">();
export type TaskCredentials = z.infer<typeof taskCredentialsSchema>;

/** The credentials as a runner at `minor` reads them: below minor 2, without the MCP servers. */
export const encodeTaskCredentialsForMinor = (credentials: TaskCredentials, minor: number): TaskCredentials => {
  if (minor >= 2) {
    return credentials;
  }
  return taskCredentialsSchema.parse(z.object(taskCredentialsShapeV1).parse(credentials));
};

/** The credentials endpoint's answer schema for a runner at `minor`. */
export const taskCredentialsResponseSchemaFor = (
  minor: number,
): typeof taskCredentialsSchema | typeof taskCredentialsSchemaV1 =>
  minor >= 2 ? taskCredentialsSchema : taskCredentialsSchemaV1;

// ---------- a snapshot build's credentials (minor 2, F-051) ----------

/**
 * A snapshot build's secrets: a git token per repo and the setup secrets, returned by
 * `POST /runner/v1/snapshots/:snapshotId/credentials` only to the runner the build was sent to,
 * while the build is open. The build mounts them for the build only, then scans the image for
 * each value (ADR 0038). Never logged.
 */
export const snapshotCredentialsSchema = z
  .strictObject({
    snapshotId: snapshotIdSchema,
    repos: z.array(repoCredentialsSchema),
    /** Only the secrets available during setup. */
    secrets: z.array(z.strictObject({ repoId: repoIdSchema, entries: z.array(repoSecretSchema) })),
  })
  .describe(NEVER_LOGGED)
  .brand<"SnapshotCredentials">();
export type SnapshotCredentials = z.infer<typeof snapshotCredentialsSchema>;
