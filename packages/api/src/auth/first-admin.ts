import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { defaultFirstAdmin, seedFirstAdmin } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, SeededFirstAdmin, ServerSettings } from "@ostra/domain";

// F-001 (the maintainer, 2026-11-19): a server that starts with no account creates the first admin
// and the first organization from its settings, so a fresh install is signed into, not claimed.
// demo@demo.com / demo unless `OSTRA_ADMIN_*` says otherwise. The default password is flagged: the
// first sign-in must choose a new one (`create-auth.ts` refuses everything else until then).

export type EnsureFirstAdminInput = {
  readonly db: Db;
  readonly settings: Pick<ServerSettings, "firstAdmin">;
  /** better-auth's `hashPassword`: the seed stores the hash directly, so "demo" needs no length rule. */
  readonly hashPassword: (password: string) => Promise<string>;
  readonly ports: { readonly audit: AuditLog; readonly notices: ChangeNotices; readonly clock: Clock };
  readonly logger: Logger;
};

/** Seeds the first admin when the install has no account. The seeded IDs, or `null` when one existed. */
export const ensureFirstAdmin = async (input: EnsureFirstAdminInput): Promise<SeededFirstAdmin | null> => {
  const { firstAdmin } = input.settings;
  const usesDefault = firstAdmin.password === null;
  const result = await seedFirstAdmin(
    { db: input.db, hashPassword: input.hashPassword, ...input.ports },
    {
      email: firstAdmin.email,
      username: firstAdmin.username,
      password: firstAdmin.password ?? defaultFirstAdmin.password,
      organizationName: firstAdmin.organizationName,
      mustChangePassword: usesDefault,
    },
  );
  if (!result.ok) {
    // The settings schema refuses a short OSTRA_ADMIN_PASSWORD first: this is a bug if it happens.
    throw new Error(`the first admin could not be seeded: ${result.message}`);
  }
  if (result.seeded !== null) {
    // IDs only: never the email, the username or the password.
    input.logger.info("setup.first_admin_seeded", {
      userId: result.seeded.userId,
      memberId: result.seeded.memberId,
      organizationId: result.seeded.organizationId,
      defaultPassword: usesDefault,
    });
  }
  return result.seeded;
};
