import type { RepoAccess, SecretStoreAdapter } from "@ostra/adapter-sdk";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { repoFullNameSchema } from "@ostra/protocol";
import type { OrganizationId, RepoId } from "@ostra/protocol";
import { INSTALLATION_NOT_LINKED, installationStateSelect, installationUsable } from "../code-host/installations.ts";

// How core reaches one repo through its organization's App (ADR 0030): the App's key from the
// secret store, the repo's installation. Milestone 3's compares, drafts and reactions share it.
// The key is passed per call and never logged.

export type RepoAccessResult = { readonly ok: true; readonly access: RepoAccess } | { readonly ok: false; readonly reason: string };

/** The App's access to a repo of the organization, or why there's none, in words. */
export const repoAccessFor = async (
  db: Db | Tx,
  secretStore: SecretStoreAdapter,
  organizationId: OrganizationId,
  repoId: RepoId,
): Promise<RepoAccessResult> => {
  const repo = await db.repo.findFirst({
    where: { id: repoId, organizationId },
    select: { fullName: true, installationId: true, connection: { select: { appId: true, privateKeySecretRef: true } }, ...installationStateSelect },
  });
  if (repo === null) {
    return { ok: false, reason: "no such repo" };
  }
  // Milestone 4 (F-136, ADR 0065): nothing is minted through an installation that isn't linked.
  if (!installationUsable(repo.installation)) {
    return { ok: false, reason: INSTALLATION_NOT_LINKED };
  }
  const ref = secretRefSchema.safeParse(repo.connection.privateKeySecretRef);
  const fullName = repoFullNameSchema.safeParse(repo.fullName);
  if (!ref.success || !fullName.success) {
    return { ok: false, reason: "the repo's App has no private key" };
  }
  const key = await secretStore.get(organizationId, ref.data);
  if (!key.ok) {
    return { ok: false, reason: "the App's private key couldn't be read" };
  }
  return { ok: true, access: { app: { appId: repo.connection.appId, privateKey: key.value }, installationId: repo.installationId, repo: fullName.data } };
};
