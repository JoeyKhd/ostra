import { randomUUID } from "node:crypto";

import type { Db } from "@ostra/db";
import { memberIdSchema, organizationIdSchema, userIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, UserId } from "@ostra/protocol";
import { z } from "zod";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, organizationNameSchema, usernameSchema } from "../accounts.ts";
import type { AuditLog, ChangeNotices, Clock } from "../ports.ts";
import { ensureBuiltInAgentProfile } from "./agent-profiles.ts";
import { ensureDefaultPool } from "./pools.ts";
import type { UseCaseResult } from "./common.ts";

// F-001, F-002 (the maintainer, 2026-11-19, which supersedes Q117's setup token): a server that
// starts with no account seeds the first one from its settings (`OSTRA_ADMIN_*`, default
// demo@demo.com / demo), the instance admin and the admin of the first organization, created with
// it. Every replica calls this at start; a Postgres advisory lock makes exactly one of them create
// anything, and the others find the account there.

export const seedFirstAdminInputSchema = z.strictObject({
  username: usernameSchema,
  email: z.email().max(320),
  /**
   * Hashed here; never stored or logged as given. Only the seed may store one under the policy's
   * length, and only flagged `mustChangePassword` (the default password).
   */
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  organizationName: organizationNameSchema,
  /** The account must choose a new password at its first sign-in: it was seeded with the default. */
  mustChangePassword: z.boolean(),
});
export type SeedFirstAdminInput = z.infer<typeof seedFirstAdminInputSchema>;

export type SeededFirstAdmin = {
  readonly userId: UserId;
  readonly memberId: MemberId;
  readonly organizationId: OrganizationId;
};

export type SeedFirstAdminResult = UseCaseResult<
  /** `seeded` is `null` when the install already had an account: nothing was created. */
  { readonly seeded: SeededFirstAdmin | null },
  "password-too-short"
>;

export type SeedFirstAdminDeps = {
  /** The use case takes the advisory lock in its own transaction. */
  readonly db: Db;
  /**
   * Hashes a password the way the sign-in side checks it (better-auth's `hashPassword`), so the
   * domain package doesn't depend on the auth library. The result is stored; the password never is.
   */
  readonly hashPassword: (password: string) => Promise<string>;
  readonly audit: AuditLog;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
};

export type SeedFirstAdmin = (deps: SeedFirstAdminDeps, input: SeedFirstAdminInput) => Promise<SeedFirstAdminResult>;

/** A fixed key for the advisory lock that serialises "who is the first account". */
export const FIRST_ACCOUNT_LOCK_KEY = 4_270_901;

/** A URL-safe slug of an organization's name, never empty. */
export const slugify = (name: string, fallback: string): string => {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug === "" ? fallback : slug;
};

const hasAccount = async (db: Pick<Db, "user" | "instanceSetting">): Promise<boolean> => {
  const setting = await db.instanceSetting.findUnique({ where: { id: "instance" }, select: { firstAdminCreatedAt: true } });
  return (setting !== null && setting.firstAdminCreatedAt !== null) || (await db.user.count()) > 0;
};

export const seedFirstAdmin: SeedFirstAdmin = async (deps, input) => {
  if (input.password.length < MIN_PASSWORD_LENGTH && !input.mustChangePassword) {
    return { ok: false, error: "password-too-short", message: `A password has ${String(MIN_PASSWORD_LENGTH)} characters or more` };
  }
  // A restart of a set-up install is the common case: it hashes nothing and takes no lock.
  if (await hasAccount(deps.db)) {
    return { ok: true, seeded: null };
  }
  const passwordHash = await deps.hashPassword(input.password);
  const email = input.email.toLowerCase();
  const now = new Date(deps.clock.now());

  return deps.db.$transaction(async (tx): Promise<SeedFirstAdminResult> => {
    // $executeRaw, not $queryRaw: Prisma 7 with the pg driver adapter can't read the `void` column
    // this function returns (spike 9). Replicas starting together wait here, one at a time.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_LOCK_KEY})`;
    if (await hasAccount(tx)) {
      return { ok: true, seeded: null };
    }

    const userId = userIdSchema.parse(randomUUID());
    // The instance admin's role lives on `user.role`, apart from the organization roles (ADR 0003).
    await tx.user.create({
      data: {
        id: userId,
        name: input.username,
        email,
        emailVerified: false,
        username: input.username,
        displayUsername: input.username,
        role: "admin",
        mustChangePassword: input.mustChangePassword,
        createdAt: now,
        updatedAt: now,
        accounts: {
          create: { id: randomUUID(), accountId: userId, providerId: "credential", password: passwordHash, createdAt: now, updatedAt: now },
        },
      },
    });

    const organizationId = organizationIdSchema.parse(randomUUID());
    await tx.organization.create({
      data: {
        id: organizationId,
        name: input.organizationName,
        slug: slugify(input.organizationName, `org-${organizationId.slice(0, 8)}`),
        createdAt: now,
      },
    });
    // Every organization has its built-in OpenCode profile (F-086); the admin picks its model later.
    await ensureBuiltInAgentProfile(tx, organizationId);
    // And its default runner pool, which a new project links to.
    await ensureDefaultPool(tx, organizationId);
    const memberId = memberIdSchema.parse(randomUUID());
    await tx.member.create({ data: { id: memberId, organizationId, userId, role: "admin", createdAt: now } });
    await tx.instanceSetting.upsert({
      where: { id: "instance" },
      create: { id: "instance", firstAdminCreatedAt: now },
      update: { firstAdminCreatedAt: now },
    });

    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "system", id: null },
      action: "instance.first-admin-created",
      entity: "member",
      entityId: memberId,
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: memberId });
    return { ok: true, seeded: { userId, memberId, organizationId } };
  });
};
