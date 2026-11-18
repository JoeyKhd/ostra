import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { Db } from "@ostra/db";
import { memberIdSchema, organizationIdSchema, userIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, UserId } from "@ostra/protocol";
import { z } from "zod";

import type { AuditLog, ChangeNotices, Clock } from "../ports.ts";
import { ensureBuiltInAgentProfile } from "./agent-profiles.ts";
import { ensureDefaultPool } from "./pools.ts";
import type { UseCaseResult } from "./common.ts";

// F-001, F-002, Q117: the first account becomes the instance admin and the admin of the first
// organization, created with it, under a Postgres advisory lock so only one account ever gets it.
// It needs the setup token from the server's log; once an account exists, the token stops working
// and sign-up closes. Written by ticket 30.

export const createFirstAdminInputSchema = z.strictObject({
  /** The setup token. Never logged. */
  setupToken: z.string().min(16).max(512),
  username: z
    .string()
    .min(2)
    .max(39)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and inner hyphens"),
  email: z.email().max(320),
  /** Hashed by better-auth; never stored or logged as given. */
  password: z.string().min(12).max(256),
  organizationName: z.string().trim().min(1).max(128),
});
export type CreateFirstAdminInput = z.infer<typeof createFirstAdminInputSchema>;

export type CreateFirstAdminResult = UseCaseResult<
  { readonly userId: UserId; readonly memberId: MemberId; readonly organizationId: OrganizationId },
  "wrong-setup-token" | "already-set-up" | "username-taken" | "email-taken"
>;

export type CreateFirstAdminDeps = {
  /** The use case takes the advisory lock in its own transaction. */
  readonly db: Db;
  /** The token the server generated or read from OSTRA_SETUP_TOKEN. */
  readonly expectedSetupToken: string;
  /**
   * Hashes a password the way the sign-in side checks it (better-auth's `hashPassword`), so the
   * domain package doesn't depend on the auth library. The result is stored; the password never is.
   */
  readonly hashPassword: (password: string) => Promise<string>;
  readonly audit: AuditLog;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
};

export type CreateFirstAdmin = (deps: CreateFirstAdminDeps, input: CreateFirstAdminInput) => Promise<CreateFirstAdminResult>;

/** A fixed key for the advisory lock that serialises "who is the first account". */
export const FIRST_ACCOUNT_LOCK_KEY = 4_270_901;

/** Compares two secrets in constant time, whatever their lengths (it compares their digests). */
export const secretsMatch = (expected: string, given: string): boolean =>
  timingSafeEqual(createHash("sha256").update(expected).digest(), createHash("sha256").update(given).digest());

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

const refuse = (error: Exclude<CreateFirstAdminResult, { readonly ok: true }>["error"], message: string): CreateFirstAdminResult => ({
  ok: false,
  error,
  message,
});

export const createFirstAdmin: CreateFirstAdmin = async (deps, input) => {
  if (!secretsMatch(deps.expectedSetupToken, input.setupToken)) {
    return refuse("wrong-setup-token", "The setup token is wrong");
  }
  const passwordHash = await deps.hashPassword(input.password);
  const email = input.email.toLowerCase();
  const now = new Date(deps.clock.now());

  return deps.db.$transaction(async (tx): Promise<CreateFirstAdminResult> => {
    // $executeRaw, not $queryRaw: Prisma 7 with the pg driver adapter can't read the `void` column
    // this function returns (spike 9).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_LOCK_KEY})`;
    const setting = await tx.instanceSetting.findUnique({ where: { id: "instance" }, select: { firstAdminCreatedAt: true } });
    if ((setting !== null && setting.firstAdminCreatedAt !== null) || (await tx.user.count()) > 0) {
      return refuse("already-set-up", "This install already has its first account");
    }
    if ((await tx.user.count({ where: { username: input.username } })) > 0) {
      return refuse("username-taken", "That username is taken");
    }
    if ((await tx.user.count({ where: { email } })) > 0) {
      return refuse("email-taken", "That email is taken");
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
      actor: { kind: "member", id: memberId },
      action: "instance.first-admin-created",
      entity: "member",
      entityId: memberId,
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: memberId });
    return { ok: true, userId, memberId, organizationId };
  });
};
