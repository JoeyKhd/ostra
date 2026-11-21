import { z } from "zod";

import { repoIdSchema, snapshotIdSchema, taskIdSchema } from "../ids.ts";
import { apiFormatSchema, authSchemeSchema, envNameSchema, epochMsSchema, leaseEpochSchema, serviceNameSchema } from "../common.ts";
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

/**
 * An HTTP header value: visible ASCII, space, tab and obs-text, never CR, LF or another control
 * character. Node refuses such a value when a request is made, so the profile editor, the stored
 * value and the credentials all hold to it.
 */
export const HTTP_HEADER_VALUE = /^[\t\u0020-\u007e\u0080-\u00ff]+$/;
export const mcpHeaderValueSchema = secretValue.regex(HTTP_HEADER_VALUE, "a header value can't hold a line break or another control character");

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

const headerNameSchema = z.string().min(1).max(256);

/**
 * An HTTP MCP server's address and headers (minor 2, ADR 0049, Q170), for the sidecar's MCP proxy,
 * which forwards the agent's calls on the spec's `proxyPath` and adds the headers. Never logged;
 * the agent never sees them.
 */
export const mcpServerCredentialsSchema = z
  .strictObject({
    name: agentItemNameSchema,
    url: z.url({ protocol: /^https?$/ }),
    /** Every header the proxy adds. Each is a secret unless `plainHeaders` names it. */
    headers: z.record(headerNameSchema, mcpHeaderValueSchema),
    /**
     * Minor 7 (F-145, ADR 0069): the headers among `headers` that hold no secret, by name: a
     * library server's fixed header, or an input its registry entry doesn't mark secret and the
     * admin gave as plain text. The proxy sends them like the others; the runner's environment
     * check doesn't search for their values (ADR 0030), so a plain value that also sits in the
     * agent's environment doesn't stop the session. Missing means every header is a secret: a
     * profile's own server, and every server a runner below minor 7 is sent.
     */
    plainHeaders: z.array(headerNameSchema).max(100).optional(),
  })
  .refine(
    (server) => (server.plainHeaders ?? []).every((name, index, names) => Object.hasOwn(server.headers, name) && names.indexOf(name) === index),
    "each plain header is one of the server's headers, named once",
  );
export type McpServerCredentials = z.infer<typeof mcpServerCredentialsSchema>;

/** The values of the server's secret headers: every header `plainHeaders` doesn't name. */
export const secretHeaderValues = (server: McpServerCredentials): readonly string[] => {
  const plain = new Set(server.plainHeaders ?? []);
  return Object.entries(server.headers).flatMap(([name, value]) => (plain.has(name) ? [] : [value]));
};

/**
 * A service's secret variables (minor 2, F-094, ADR 0038): the spec names the service and carries
 * its plain variables; these are the ones kept in the secret store, for the `docker` executor to
 * set on the service's container only. Never logged; the agent's container never gets them.
 */
export const serviceSecretsSchema = z.strictObject({
  name: serviceNameSchema,
  variables: z.array(z.strictObject({ name: envNameSchema, value: z.string().max(65_536) })).max(200),
});
export type ServiceSecrets = z.infer<typeof serviceSecretsSchema>;

/** Minor 1's credentials, kept for the endpoint's answer to a minor-1 runner. */
export const taskCredentialsSchemaV1 = z
  .strictObject(taskCredentialsShapeV1)
  .describe(NEVER_LOGGED)
  .brand<"TaskCredentials">();

/** The credentials at the current minor (7): minor 2's, with a server's `plainHeaders` from minor 7. */
export const taskCredentialsSchema = z
  .strictObject({
    ...taskCredentialsShapeV1,
    /** Minor 2: the profile's HTTP MCP servers; minor 7 adds their `plainHeaders`. Never logged. */
    mcpServers: z.array(mcpServerCredentialsSchema).max(runnerLimits.mcpServersMax).optional(),
    /** Minor 2: the environment's services' secret variables, by service. Never logged. */
    services: z.array(serviceSecretsSchema).max(runnerLimits.servicesMax).optional(),
  })
  .describe(NEVER_LOGGED)
  .brand<"TaskCredentials">();
export type TaskCredentials = z.infer<typeof taskCredentialsSchema>;

/**
 * The credentials as a runner at `minor` reads them: below minor 7, each server without its
 * `plainHeaders` (every header still sent, and searched for as a secret, as before); below minor 2,
 * without the MCP servers and the services' secrets.
 */
export const encodeTaskCredentialsForMinor = (credentials: TaskCredentials, minor: number): TaskCredentials => {
  if (minor >= 7) {
    return credentials;
  }
  if (minor >= 2) {
    if (credentials.mcpServers === undefined) {
      return credentials;
    }
    const mcpServers = credentials.mcpServers.map((server) => {
      const down: Record<string, unknown> = { ...server };
      Reflect.deleteProperty(down, "plainHeaders");
      return down;
    });
    return taskCredentialsSchema.parse({ ...credentials, mcpServers });
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
