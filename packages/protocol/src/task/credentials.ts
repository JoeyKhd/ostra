import { z } from "zod";

import { repoIdSchema, taskIdSchema } from "../ids.ts";
import { apiFormatSchema, authSchemeSchema, envNameSchema, epochMsSchema, leaseEpochSchema } from "../common.ts";
import { repoRelativePathSchema } from "./spec.ts";

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

export const taskCredentialsSchema = z
  .strictObject({
    taskId: taskIdSchema,
    leaseEpoch: leaseEpochSchema,
    model: modelEndpointCredentialsSchema,
    repos: z.array(repoCredentialsSchema),
    /** The environment's secrets, per repo (F-050). */
    secrets: z.array(z.strictObject({ repoId: repoIdSchema, entries: z.array(repoSecretSchema) })),
    /** The token the runner sends with this task's calls to ostra's MCP endpoint. */
    mcpToken: secretValue,
  })
  .describe(NEVER_LOGGED)
  .brand<"TaskCredentials">();
export type TaskCredentials = z.infer<typeof taskCredentialsSchema>;
