import type { DbOrTx } from "../client.ts";

// Milestone 4 (F-136, ADR 0065): a repo needs its linked installation row (`Repo`'s composite key
// to `CodeHostInstallation`). Tests that create a repo row directly, not through the project's use
// cases, give it one here first. Idempotent.

export const seedInstallation = async (
  db: DbOrTx,
  input: { readonly organizationId: string; readonly connectionId: string; readonly installationId: string; readonly accountLogin?: string },
): Promise<void> => {
  await db.codeHostInstallation.upsert({
    where: { connectionId_installationId: { connectionId: input.connectionId, installationId: input.installationId } },
    create: {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      installationId: input.installationId,
      accountLogin: input.accountLogin ?? "ostra-test",
      accountKind: "organization",
    },
    update: {},
  });
};
