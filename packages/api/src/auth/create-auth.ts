import type { Db } from "@ostra/db";
import { ensureBuiltInAgentProfile, ensureDefaultPool, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { admin, bearer, deviceAuthorization, organization, username } from "better-auth/plugins";
import { z } from "zod";

import { isOrganizationRole, organizationAccessControl, organizationRoles } from "./roles.ts";
import { usernamePluginOptions } from "./username.ts";

// Ported from spikes/auth-foundation/src/auth/create-auth.ts (spike 9, ADR 0003).
//
// better-auth, configured once here so `apps/web` serves it (`/api/auth/*`) and `apps/core` can
// check a device session with the same code. The pieces ostra adds are in this file and in
// `scope.ts`, each with its own test (`auth.contract.test.ts`, `default-password.test.ts`).

/** The OAuth client ID a personal runner presents. Any other ID is refused (ADR 0029). */
export const RUNNER_CLIENT_ID = "ostra-runner";

// ostra is self-hosted only (ADR 0026, amended 2026-11-19): sign-up is never open, and only the
// instance admin creates organizations. No setting changes either; the two that once did,
// OSTRA_OPEN_SIGNUP_*, are retired and ignored (`retiredSettingFields` in @ostra/domain).
export type AuthSettings = {
  /**
   * The seeded admin may keep the default password (`OSTRA_ALLOW_DEFAULT_PASSWORD`, for demos). Off:
   * an account flagged `mustChangePassword` can do nothing but change it (F-001).
   */
  readonly allowDefaultPassword: boolean;
};

export const defaultAuthSettings: AuthSettings = {
  allowDefaultPassword: false,
};

export type CreateAuthInput = {
  readonly db: Db;
  /** The panel's address as browsers reach it (`OSTRA_PUBLIC_URL`). */
  readonly baseUrl: string;
  /** Signs sessions and tokens (`BETTER_AUTH_SECRET`). Never logged. */
  readonly secret: string;
  readonly settings?: AuthSettings;
  /** How often a runner may poll for its device token. */
  readonly deviceInterval?: "1s" | "5s";
  /** better-auth logs refused sign-ins as warnings; a test that provokes dozens asks for errors only. */
  readonly logLevel?: "warn" | "error";
};

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const ONE_DAY_SECONDS = 24 * 60 * 60;

/**
 * What an account that must change its default password may still reach (F-001): reading and ending
 * its session, signing in, and changing the password. Everything else better-auth serves (the
 * organization, admin and device-approval routes) is refused until it has.
 */
const PATHS_BEFORE_PASSWORD_CHANGE: ReadonlySet<string> = new Set([
  "/get-session",
  "/sign-out",
  "/sign-in/email",
  "/sign-in/username",
  "/change-password",
  "/ok",
  "/error",
]);

const changedPasswordSchema = z.looseObject({ user: z.looseObject({ id: z.string().min(1) }) });

/** Whether better-auth's user (or session user) still has to change its default password. */
export const mustChangePasswordOf = (user: object): boolean => Reflect.get(user, "mustChangePassword") === true;

const assertOrganizationRole = (role: string): void => {
  if (!isOrganizationRole(role)) {
    throw new APIError("BAD_REQUEST", {
      code: "ROLE_NOT_FOUND",
      message: "An organization role is admin or member",
    });
  }
};

/**
 * The organization a new session starts in: the oldest organization the account belongs to. (A
 * second organization is a later milestone: the panel then switches it with better-auth's
 * `setActive`.) `null` when the account belongs to none.
 */
const firstOrganizationOf = async (db: Db, userId: string): Promise<string | null> => {
  const member = await db.member.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });
  return member === null ? null : member.organizationId;
};

export const createAuth = (input: CreateAuthInput) => {
  const settings = input.settings ?? defaultAuthSettings;
  const { db } = input;
  // The before hook reads the caller's session through the finished instance, set just below.
  const finished: { sessionOf?: (headers: Headers) => Promise<{ readonly user: object } | null> } = {};

  const auth = betterAuth({
    baseURL: input.baseUrl,
    secret: input.secret,
    trustedOrigins: [input.baseUrl],
    // ADR 0021: no telemetry.
    telemetry: { enabled: false },
    logger: { level: input.logLevel ?? "warn" },
    database: prismaAdapter(db, {
      provider: "postgresql",
      // A multi-row write (an organization and its first member) is one transaction.
      transaction: true,
    }),
    // ostra's own table for a login session, so "Session" stays the agent's (schema.prisma).
    session: { modelName: "authSession" },

    // Q54: a username or an email, plus a password. No mail server is assumed: nothing is
    // verified by mail, and a reset link is handed to the admin.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // A link an admin copies into a chat has to outlive an hour.
      resetPasswordTokenExpiresIn: ONE_DAY_SECONDS,
      revokeSessionsOnPasswordReset: true,
    },

    user: {
      additionalFields: {
        // F-001: set only by the seed, for the default password; cleared by a password change.
        // `input: false`: no sign-up or profile update can set it.
        mustChangePassword: { type: "boolean", required: false, defaultValue: false, input: false },
      },
    },

    databaseHooks: {
      user: {
        create: {
          // Q54: every account has a unique username. The username plugin makes it optional, so
          // ostra refuses an account without one, whichever path creates it.
          before: (user) => {
            const name: unknown = Reflect.get(user, "username");
            if (typeof name !== "string" || name.trim() === "") {
              throw new APIError("BAD_REQUEST", {
                code: "USERNAME_REQUIRED",
                message: "Every account needs a username",
              });
            }
            return Promise.resolve();
          },
        },
      },
      session: {
        create: {
          // A new session starts in the member's organization, so the panel, and a personal
          // runner's device session, know where they are (ticket 30: the device approval).
          before: async (session) => {
            const activeOrganizationId = await firstOrganizationOf(db, session.userId);
            return activeOrganizationId === null ? undefined : { data: { ...session, activeOrganizationId } };
          },
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Sign-up is closed, on every install. The first account is seeded by the server at start
        // (`seedFirstAdmin`: one transaction, the account, its organization and the admin role),
        // never by this route, so it can't end up with no organization. Invitees come in
        // milestone 4 (F-002) with their own check, which refuses them for now with a clear message.
        if (ctx.path === "/sign-up/email") {
          throw new APIError("FORBIDDEN", {
            code: "SIGN_UP_CLOSED",
            message: "Sign-up is closed: the server creates the first admin, and invitations come in a later release",
          });
        }
        // F-001: the seeded admin with the default password changes it before anything else.
        const { sessionOf } = finished;
        if (settings.allowDefaultPassword || PATHS_BEFORE_PASSWORD_CHANGE.has(ctx.path) || ctx.headers === undefined || sessionOf === undefined) {
          return;
        }
        const found = await sessionOf(ctx.headers);
        if (found !== null && mustChangePasswordOf(found.user)) {
          throw new APIError("FORBIDDEN", {
            code: "PASSWORD_CHANGE_REQUIRED",
            message: "Choose a new password first: this account still has the default one",
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // A changed password ends the default one: the flag goes, and with it the forced step and
        // the panel's warning (F-001).
        if (ctx.path !== "/change-password" || isAPIError(ctx.context.returned)) {
          return;
        }
        const changed = changedPasswordSchema.safeParse(ctx.context.returned);
        if (changed.success) {
          await db.user.updateMany({ where: { id: changed.data.user.id, mustChangePassword: true }, data: { mustChangePassword: false } });
        }
      }),
    },

    plugins: [
      // Q54: a second name to sign in with.
      username(usernamePluginOptions),
      // Q102: the instance admin. Its role lives on `user.role`, apart from the organization
      // roles on `member.role`.
      admin({ adminRoles: ["admin"], defaultRole: "user" }),
      // ADR 0026: organizations, members and invitations, with two roles. No
      // `sendInvitationEmail`: with no mail server the admin copies the link.
      organization({
        ac: organizationAccessControl,
        roles: organizationRoles,
        creatorRole: "admin",
        invitationExpiresIn: SEVEN_DAYS_SECONDS,
        cancelPendingInvitationsOnReInvite: true,
        requireEmailVerificationOnInvitation: false,
        // Only the instance admin creates organizations (ADR 0026); an organization's own admin can't.
        allowUserToCreateOrganization: (user) => Reflect.get(user, "role") === "admin",
        // ADR 0026: exactly two roles, one per member. better-auth would also accept "owner".
        organizationHooks: {
          // Every organization has its built-in OpenCode profile and its default runner pool (F-086),
          // also one an instance admin makes later. The first organization gets its own in
          // `seedFirstAdmin`.
          afterCreateOrganization: async ({ organization: created }) => {
            const organizationId = organizationIdSchema.parse(created.id);
            await db.$transaction(async (tx) => {
              await ensureBuiltInAgentProfile(tx, organizationId);
              await ensureDefaultPool(tx, organizationId);
            });
          },
          beforeCreateInvitation: ({ invitation }) => {
            assertOrganizationRole(invitation.role);
            return Promise.resolve();
          },
          beforeAddMember: ({ member }) => {
            assertOrganizationRole(member.role);
            return Promise.resolve();
          },
          beforeUpdateMemberRole: ({ newRole }) => {
            assertOrganizationRole(newRole);
            return Promise.resolve();
          },
        },
      }),
      // A runner presents the session token it got from the device flow as a bearer token
      // (ADR 0003, as amended).
      bearer(),
      // A member's personal runner signs in from a terminal (RFC 8628).
      deviceAuthorization({
        validateClient: (clientId) => clientId === RUNNER_CLIENT_ID,
        expiresIn: "10m",
        interval: input.deviceInterval ?? "5s",
        userCodeLength: 8,
        verificationUri: "/device",
      }),
    ],
  });
  finished.sessionOf = (headers) => auth.api.getSession({ headers, query: { disableRefresh: true } });
  return auth;
};

export type OstraAuth = ReturnType<typeof createAuth>;
