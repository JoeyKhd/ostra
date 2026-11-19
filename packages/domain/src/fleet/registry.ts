import { imageDigestSchema } from "@ostra/protocol";
import type { ProjectId, SnapshotId } from "@ostra/protocol";
import { z } from "zod";

// The organization's snapshot registry (F-120, ADR 0060): where a snapshot's image is pushed and
// pulled from, and what the panel's check found. The credentials are secret store references,
// never here.

/** A registry's address and path, as its row holds them. */
export type RegistryPlace = {
  /** The registry's host (and port), such as `registry.example.com`; a scheme or a trailing slash is dropped. */
  readonly url: string;
  /** The path images go under, such as `ostra`; slashes at either end are dropped. */
  readonly repositoryPrefix: string;
};

/** The registry's host, without a scheme or a trailing slash. */
const registryHost = (url: string): string => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");

/** The repository a project's snapshots go to: `<url>/<prefix>/<projectId>`. */
export const registryRepository = (registry: RegistryPlace, projectId: ProjectId): string => {
  const prefix = registry.repositoryPrefix.replace(/^\/+|\/+$/g, "");
  return [registryHost(registry.url), ...(prefix === "" ? [] : [prefix]), projectId].join("/");
};

/** A snapshot's image name, as it's pushed: `<url>/<prefix>/<projectId>:<snapshotId>`. */
export const registryImageRef = (registry: RegistryPlace, projectId: ProjectId, snapshotId: SnapshotId): string =>
  `${registryRepository(registry, projectId)}:${snapshotId}`;

/** The image as a box pulls it: by digest, never by tag, so a moved tag can't change what runs. */
export const registryImageByDigest = (registry: RegistryPlace, projectId: ProjectId, digest: string): string =>
  `${registryRepository(registry, projectId)}@${imageDigestSchema.parse(digest)}`;

/**
 * What the panel's check found (ticket 17): push and pull both allowed for the prefix, pull only,
 * or refused. `detail` is words and status codes, never a credential or a token.
 */
export const registryCheckResultSchema = z.strictObject({
  result: z.enum(["push-and-pull", "pull-only", "refused"]),
  /** The HTTP status the refusing step answered, when one did. */
  status: z.number().int().min(100).max(599).nullable(),
  /** Why, in words: never a credential's value. */
  detail: z.string().max(500),
});
export type RegistryCheckResult = z.infer<typeof registryCheckResultSchema>;

/** A stored check result, or `null` when there is none or it doesn't parse. */
export const registryCheckFromDb = (value: unknown): RegistryCheckResult | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = registryCheckResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
