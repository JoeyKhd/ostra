import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretRef, SecretStoreAdapter } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import type { Db, Tx } from "@ostra/db";
import { projectIdSchema, registryIdSchema, snapshotIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RegistryCredential, RegistryId, RunnerId } from "@ostra/protocol";
import { z } from "zod";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { registryCheckResultSchema, registryImageRef, registryRepository } from "../fleet/registry.ts";
import type { RegistryCheckResult, RegistryPlace } from "../fleet/registry.ts";
import type { Ports, ServerAdapters } from "../ports.ts";
import type { CheckRegistry, IssuePullCredential, IssuePushCredential, RegistryCredentialInput, SetRegistry } from "./m5-signatures.ts";

// The organization's snapshot registry (F-120, ADR 0060; milestone 5's ticket 17):
//
// - `setRegistry`: an admin's address, prefix, auth kind and credentials. The credentials go to the
//   secret store; the row holds their references. `registry.set` in the audit log, and a
//   `registry.check` job for the settings' version, in the same transaction.
// - `checkRegistry`: the job's work. Core's own calls to the registry's API, through a `RegistryProbe`
//   (core's `src/registry/`): nothing is pushed. The result is stored with the time.
// - `issuePushCredential`: for the one runner a build was given to, while it builds.
// - `issuePullCredential`: for the runner holding the task's current lease, when the lease's box
//   names a registry image. Each issuance is one `registry.credential-issued` audit entry.
//
// No credential's value is logged, stored in a row or put in an audit entry.

/** A credential as the secret store keeps it: one value, the username and the token together. */
const storedCredentialSchema = z.strictObject({ username: z.string().min(1).max(512), token: z.string().min(1).max(65_536) });

/** How long a runner may use an issued credential before it asks again. Working value. */
export const REGISTRY_CREDENTIAL_TTL_MS = 15 * 60_000;

/** A registry's address: a host and an optional port, with `https://` (the default) or `http://` for a local one. */
const REGISTRY_URL = /^(?:https?:\/\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
/** A repository path, as the distribution spec allows its components. */
const REPOSITORY_PREFIX = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;

export type RegistryDeps = { readonly db: Db } & Pick<Ports, "audit" | "notices" | "clock" | "jobs"> & { readonly adapters: Pick<ServerAdapters, "secretStore"> };

const validCredential = (credential: RegistryCredentialInput | undefined): boolean =>
  credential === undefined || storedCredentialSchema.safeParse({ username: credential.username.trim(), token: credential.token }).success;

const storeCredential = async (secretStore: SecretStoreAdapter, organizationId: OrganizationId, purpose: string, credential: RegistryCredentialInput): Promise<SecretRef | null> => {
  const stored = await secretStore.put({ organizationId, purpose }, JSON.stringify({ username: credential.username.trim(), token: credential.token }));
  return stored.ok ? stored.value : null;
};

/** A stored credential, read back; `null` when there's none or it can't be read. */
export const readRegistryCredential = async (
  secretStore: SecretStoreAdapter,
  organizationId: OrganizationId,
  ref: string | null,
): Promise<{ readonly username: string; readonly token: string } | null> => {
  const parsedRef = secretRefSchema.safeParse(ref);
  if (!parsedRef.success) {
    return null;
  }
  const value = await secretStore.get(organizationId, parsedRef.data);
  if (!value.ok) {
    return null;
  }
  try {
    const parsed = storedCredentialSchema.safeParse(JSON.parse(value.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The registry's host and port, as an image reference and a credential name it. */
export const registryHostOf = (url: string): string => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");

/** The registry's API base: its own scheme, or `https://`. */
export const registryBaseUrl = (url: string): string => (/^https?:\/\//i.test(url) ? url.replace(/\/+$/, "") : `https://${registryHostOf(url)}`);

/** `setRegistry`'s body. The credentials are stored before the transaction; ones it replaced are deleted after it. */
export const setRegistry = (async (deps: RegistryDeps, scope: MemberScope, input) => {
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return { ok: false, error: "forbidden", message: "Only an admin sets the registry" } as const;
  }
  const url = input.url.trim().toLowerCase();
  const repositoryPrefix = input.repositoryPrefix.trim().replace(/^\/+|\/+$/g, "");
  if (!REGISTRY_URL.test(url) || !REPOSITORY_PREFIX.test(repositoryPrefix) || repositoryPrefix.length > 200 || !validCredential(input.push) || !validCredential(input.pull)) {
    return { ok: false, error: "invalid-input", message: "The registry's address, prefix or a credential isn't valid" } as const;
  }
  const organizationId = scope.organizationId;
  const existing = await deps.db.registry.findUnique({ where: { organizationId } });
  // A push credential is always needed: builds push with it, and the check uses it. A pull
  // credential only with `basic`: with `node` the cluster pulls with its own identity.
  if ((input.push === undefined && (existing?.pushSecretId ?? null) === null) || (input.auth === "basic" && input.pull === undefined && (existing?.pullSecretId ?? null) === null)) {
    return { ok: false, error: "invalid-input", message: "The registry needs a push credential, and a pull credential unless the cluster pulls with its own identity" } as const;
  }
  const { secretStore } = deps.adapters;
  const pushRef = input.push === undefined ? null : await storeCredential(secretStore, organizationId, "registry.push", input.push);
  const pullRef = input.auth === "node" || input.pull === undefined ? null : await storeCredential(secretStore, organizationId, "registry.pull", input.pull);
  if ((input.push !== undefined && pushRef === null) || (input.auth === "basic" && input.pull !== undefined && pullRef === null)) {
    throw new Error("the secret store refused a registry credential");
  }
  const pushSecretId = pushRef ?? existing?.pushSecretId ?? null;
  const pullSecretId = input.auth === "node" ? null : (pullRef ?? existing?.pullSecretId ?? null);
  const now = deps.clock.now();
  const registryId = await deps.db.$transaction(async (tx) => {
    const data = { url, repositoryPrefix, auth: input.auth, pushSecretId, pullSecretId, updatedByMemberId: scope.memberId, checkedAt: null, checkResult: Prisma.DbNull };
    const row = await tx.registry.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
      select: { id: true },
    });
    const id = registryIdSchema.parse(row.id);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "registry.set",
      entity: "registry",
      entityId: id,
      data: { url, repositoryPrefix, auth: input.auth, pushChanged: input.push !== undefined, pullChanged: pullRef !== null },
    });
    await deps.jobs.enqueueInTx(tx, "registry.check", { organizationId, registryId: id, version: now });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return id;
  });
  // The credentials this replaced, gone from the store once the row stopped naming them.
  for (const old of [existing?.pushSecretId ?? null, existing?.pullSecretId ?? null]) {
    const ref = secretRefSchema.safeParse(old);
    if (ref.success && ref.data !== pushSecretId && ref.data !== pullSecretId) {
      await secretStore.delete(organizationId, ref.data);
    }
  }
  return { ok: true, registryId } as const;
}) satisfies (deps: RegistryDeps, scope: MemberScope, input: Parameters<SetRegistry>[2]) => ReturnType<SetRegistry>;

/** What the probe gets: the registry's API base, the repository to try, and the two credentials. */
export type RegistryProbeInput = {
  readonly baseUrl: string;
  /** A repository under the prefix: an existing snapshot's, or one for the check that holds nothing. */
  readonly repository: string;
  /** An existing manifest to read with the pull credential, when the registry holds a snapshot. */
  readonly manifestDigest: string | null;
  readonly push: { readonly username: string; readonly token: string } | null;
  /** `null` with `node` auth: the cluster pulls with its own identity, which core can't check. */
  readonly pull: { readonly username: string; readonly token: string } | null;
};

/** Core's calls to the registry's API (`apps/core/src/registry/`): never pushes an image. */
export type RegistryProbe = (input: RegistryProbeInput) => Promise<RegistryCheckResult>;

/** The repository a check reads and writes nothing to, when the registry holds no snapshot yet. */
export const REGISTRY_CHECK_REPOSITORY = "ostra-registry-check";

/** `registry.check`'s body: the probe, then the result and the time on the row, for the panel. */
export const checkRegistry = (async (deps: { readonly db: Db } & Pick<Ports, "notices" | "clock"> & { readonly adapters: Pick<ServerAdapters, "secretStore">; readonly probe: RegistryProbe }, input) => {
  const row = await deps.db.registry.findFirst({ where: { id: input.registryId, organizationId: input.organizationId } });
  if (row === null) {
    return { ok: false, error: "not-found", message: "no such registry" } as const;
  }
  const { secretStore } = deps.adapters;
  const push = await readRegistryCredential(secretStore, input.organizationId, row.pushSecretId);
  const pull = row.auth === "node" ? null : await readRegistryCredential(secretStore, input.organizationId, row.pullSecretId);
  const place: RegistryPlace = { url: registryHostOf(row.url), repositoryPrefix: row.repositoryPrefix };
  // The pull is checked on a snapshot the registry holds, when there's one.
  const pushed = await deps.db.snapshot.findFirst({
    where: { organizationId: input.organizationId, registryId: row.id, pushedAt: { not: null }, digest: { not: null } },
    orderBy: { pushedAt: "desc" },
    select: { projectId: true, digest: true },
  });
  const prefix = row.repositoryPrefix.replace(/^\/+|\/+$/g, "");
  const repository =
    pushed === null
      ? [prefix, REGISTRY_CHECK_REPOSITORY].filter((part) => part !== "").join("/")
      : registryRepository(place, projectIdSchema.parse(pushed.projectId)).slice(place.url.length + 1);
  const result =
    push === null || (row.auth === "basic" && pull === null)
      ? ({ result: "refused", status: null, detail: "A stored credential couldn't be read from the secret store." } satisfies RegistryCheckResult)
      : registryCheckResultSchema.parse(await deps.probe({ baseUrl: registryBaseUrl(row.url), repository, manifestDigest: pushed?.digest ?? null, push, pull }));
  const checkedAt = deps.clock.now();
  await deps.db.$transaction(async (tx) => {
    await tx.registry.update({ where: { id: row.id }, data: { checkedAt: new Date(checkedAt), checkResult: result } });
    await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "organization", entityId: input.organizationId });
  });
  return { ok: true, result, checkedAt } as const;
}) satisfies (
  deps: { readonly db: Db } & Pick<Ports, "notices" | "clock"> & { readonly adapters: Pick<ServerAdapters, "secretStore">; readonly probe: RegistryProbe },
  input: Parameters<CheckRegistry>[1],
) => ReturnType<CheckRegistry>;

type CredentialDeps = { readonly tx: Tx } & Pick<Ports, "audit" | "clock"> & { readonly adapters: Pick<ServerAdapters, "secretStore"> };

const issued = async (
  deps: CredentialDeps,
  entry: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly runnerId: RunnerId; readonly registryId: RegistryId; readonly kind: "push" | "pull" },
  data: Readonly<Record<string, string | number>>,
  credential: { readonly username: string; readonly token: string },
  url: string,
): Promise<RegistryCredential> => {
  // Milestone 4's rule for credentials: each issuance is one audit entry, naming who got which.
  await deps.audit.recordInTx(deps.tx, {
    organizationId: entry.organizationId,
    projectId: entry.projectId,
    actor: { kind: "runner", id: entry.runnerId },
    action: "registry.credential-issued",
    entity: "registry",
    entityId: entry.registryId,
    data: { kind: entry.kind, ...data },
  });
  return { registry: registryHostOf(url), username: credential.username, token: credential.token, expiresAt: deps.clock.now() + REGISTRY_CREDENTIAL_TTL_MS };
};

/**
 * `POST /runner/v1/snapshots/:snapshotId/push-credential`: for the runner the build was given to,
 * while the snapshot is `building` and its build pushes to the registry.
 */
export const issuePushCredential = (async (deps: CredentialDeps, input) => {
  const row = await deps.tx.snapshot.findFirst({
    where: { id: input.snapshotId, organizationId: input.organizationId },
    select: { id: true, state: true, runnerId: true, projectId: true, registry: { select: { id: true, url: true, pushSecretId: true } } },
  });
  if (row === null) {
    return { ok: false, error: "not-found", message: "no such snapshot" } as const;
  }
  if (row.state !== "building" || row.runnerId !== input.runnerId || row.registry === null) {
    return { ok: false, error: "not-the-builder", message: "this runner isn't building that snapshot for the registry" } as const;
  }
  const credential = await readRegistryCredential(deps.adapters.secretStore, input.organizationId, row.registry.pushSecretId);
  if (credential === null) {
    return { ok: false, error: "not-found", message: "the registry's push credential couldn't be read" } as const;
  }
  const registryId = registryIdSchema.parse(row.registry.id);
  return {
    ok: true,
    credential: await issued(
      deps,
      { organizationId: input.organizationId, projectId: projectIdSchema.parse(row.projectId), runnerId: input.runnerId, registryId, kind: "push" },
      { snapshotId: snapshotIdSchema.parse(row.id) },
      credential,
      row.registry.url,
    ),
  } as const;
}) satisfies (deps: CredentialDeps, input: Parameters<IssuePushCredential>[1]) => ReturnType<IssuePushCredential>;

/**
 * `POST /runner/v1/tasks/:taskId/pull-credential`: for the runner holding the task's current lease
 * at this epoch, when the lease's box names a registry image. With `node` auth there's none: the
 * cluster pulls with its own identity.
 */
export const issuePullCredential = (async (deps: CredentialDeps, input) => {
  const task = await deps.tx.task.findFirst({ where: { id: input.taskId, organizationId: input.organizationId }, select: { id: true, projectId: true, leaseEpoch: true } });
  if (task === null) {
    return { ok: false, error: "not-found", message: "no such task" } as const;
  }
  const lease = await deps.tx.lease.findFirst({
    where: { taskId: task.id, organizationId: input.organizationId, epoch: input.leaseEpoch, runnerId: input.runnerId, state: "active" },
    select: { box: { select: { imageRef: true, imageDigest: true } } },
  });
  if (task.leaseEpoch !== input.leaseEpoch || lease === null) {
    return { ok: false, error: "stale-lease", message: "this runner doesn't hold the task's current lease at that epoch" } as const;
  }
  const registry = await deps.tx.registry.findUnique({ where: { organizationId: input.organizationId }, select: { id: true, url: true, auth: true, pullSecretId: true } });
  if (lease.box.imageDigest === null || lease.box.imageRef === null || registry === null) {
    return { ok: false, error: "no-image", message: "the lease's box names no registry image" } as const;
  }
  if (registry.auth === "node") {
    return { ok: false, error: "no-image", message: "the registry is pulled with the cluster's own identity: there's no pull credential" } as const;
  }
  const credential = await readRegistryCredential(deps.adapters.secretStore, input.organizationId, registry.pullSecretId);
  if (credential === null) {
    return { ok: false, error: "not-found", message: "the registry's pull credential couldn't be read" } as const;
  }
  return {
    ok: true,
    credential: await issued(
      deps,
      { organizationId: input.organizationId, projectId: projectIdSchema.parse(task.projectId), runnerId: input.runnerId, registryId: registryIdSchema.parse(registry.id), kind: "pull" },
      { taskId: input.taskId, leaseEpoch: input.leaseEpoch },
      credential,
      registry.url,
    ),
  } as const;
}) satisfies (deps: CredentialDeps, input: Parameters<IssuePullCredential>[1]) => ReturnType<IssuePullCredential>;

/** The image a box of the project starts from, when the chosen runner pulls from the registry: its ready snapshot, pushed. */
export const registryImageForProject = async (
  tx: Tx,
  scope: { readonly organizationId: OrganizationId; readonly projectId: ProjectId },
): Promise<{ readonly ref: string; readonly digest: string } | null> => {
  const ready = await tx.snapshot.findFirst({
    where: { ...scope, state: "ready", registryId: { not: null }, pushedAt: { not: null }, digest: { not: null } },
    orderBy: { readyAt: "desc" },
    select: { id: true, digest: true, registry: { select: { url: true, repositoryPrefix: true } } },
  });
  if (ready === null) {
    return null;
  }
  const { digest, registry } = ready;
  if (digest === null || registry === null) {
    return null;
  }
  const place: RegistryPlace = { url: registryHostOf(registry.url), repositoryPrefix: registry.repositoryPrefix };
  return { ref: registryImageRef(place, scope.projectId, snapshotIdSchema.parse(ready.id)), digest };
};
