import type { Db } from "@ostra/db";
import { ensureBuiltInAgentProfile, ensureDefaultPool } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, bearer, deviceAuthorization, organization, username } from "better-auth/plugins";

import { isOrganizationRole, organizationAccessControl, organizationRoles } from "./roles.ts";
import { usernamePluginOptions } from "./username.ts";

// Ported from spikes/auth-foundation/src/auth/create-auth.ts (spike 9, ADR 0003).
//
// better-auth, configured once here so `apps/web` serves it (`/api/auth/*`) and `apps/core` can
// check a device session with the same code. The pieces ostra adds are in this file and in
// `setup-token.ts` and `scope.ts`, each with its own test (`auth.contract.test.ts`).

/** The OAuth client ID a personal runner presents. Any other ID is refused (ADR 0029). */
export const RUNNER_CLIENT_ID = "ostra-runner";

export type AuthSettings = {
  /** Open sign-up for new organizations (Q102): off by default. */
  readonly openOrganizationSignup: boolean;
  /** Anyone may create an account, not only invitees (the hosted version). Off by default. */
  readonly openAccountSignup: boolean;
};

export const defaultAuthSettings: AuthSettings = {
  openOrganizationSignup: false,
  openAccountSignup: false,
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

/** The password length the first-admin form and sign-in both enforce (the domain's schema says 12). */
export const MIN_PASSWORD_LENGTH = 12;

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

  return betterAuth({
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
      // A link an admin copies into a chat has to outlive an hour.
      resetPasswordTokenExpiresIn: ONE_DAY_SECONDS,
      revokeSessionsOnPasswordReset: true,
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
      // Sign-up is closed to strangers. The first account is created by `setup.createFirstAdmin`
      // (the setup token, then one transaction: the account, its organization and the admin
      // role), never by this route, so it can't end up with no organization. This hook lets
      // through only what an install turned on: open sign-up. Invitees come in milestone 4
      // (F-002) with their own check, which refuses them for now with a clear message.
      before: createAuthMiddleware((ctx) => {
        if (ctx.path !== "/sign-up/email" || settings.openAccountSignup) {
          return Promise.resolve();
        }
        throw new APIError("FORBIDDEN", {
          code: "SIGN_UP_CLOSED",
          message: "Sign-up is closed: the first admin is created on the panel's first-run page, and invitations come in a later release",
        });
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
        allowUserToCreateOrganization: (user) => {
          const role: unknown = Reflect.get(user, "role");
          return settings.openOrganizationSignup || role === "admin";
        },
        // ADR 0026: exactly two roles, one per member. better-auth would also accept "owner".
        organizationHooks: {
          // Every organization has its built-in OpenCode profile and its default runner pool (F-086),
          // also one an instance admin makes later. The first organization gets its own in
          // `createFirstAdmin`.
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
};

export type OstraAuth = ReturnType<typeof createAuth>;
