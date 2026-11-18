import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import {
  admin,
  bearer,
  deviceAuthorization,
  organization,
  username,
} from "better-auth/plugins";
import { promoteFirstAccount } from "../db/bootstrap.ts";
import type { PrismaClient } from "../db/prisma-client.ts";
import { InvitationId, UserId } from "../ids.ts";
import { currentLinkSink } from "./link-sink.ts";
import { isOrganizationRole, organizationAccessControl, organizationRoles } from "./roles.ts";

/** The OAuth client ID a personal runner presents. Any other ID is refused. */
export const RUNNER_CLIENT_ID = "ostra-runner";

/**
 * The request header on which the panel's sign-up page sends the invitation ID
 * it read from the `/accept-invitation/<id>` link. A header, not a body field,
 * so the better-auth schema has no column for it.
 */
export const INVITATION_HEADER = "x-ostra-invitation";

export type AuthSettings = {
  /** Open sign-up for new organizations (Q102): off by default. */
  readonly openOrganizationSignup: boolean;
  /** Anyone may create an account, not only invitees (hosted version). Off by default. */
  readonly openAccountSignup: boolean;
};

export const defaultAuthSettings: AuthSettings = {
  openOrganizationSignup: false,
  openAccountSignup: false,
};

export type CreateAuthInput = {
  readonly prisma: PrismaClient;
  readonly baseURL: string;
  readonly secret: string;
  readonly settings?: AuthSettings;
  /** How often a runner may poll for its device token. */
  readonly deviceInterval?: "1s" | "5s";
  /** better-auth logs refused sign-ins as warnings; the harness provokes dozens, so it asks for errors only. */
  readonly logLevel?: "warn" | "error";
};

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const ONE_DAY_SECONDS = 24 * 60 * 60;

const assertOrganizationRole = (role: string): void => {
  if (!isOrganizationRole(role)) {
    throw new APIError("BAD_REQUEST", {
      code: "ROLE_NOT_FOUND",
      message: "An organization role is admin or member",
    });
  }
};

export const createAuth = (input: CreateAuthInput) => {
  const settings = input.settings ?? defaultAuthSettings;
  const { prisma } = input;

  return betterAuth({
    baseURL: input.baseURL,
    secret: input.secret,
    // ADR 0021: no telemetry.
    telemetry: { enabled: false },
    logger: { level: input.logLevel ?? "warn" },
    database: prismaAdapter(prisma, {
      provider: "postgresql",
      // A multi-row write (an organization and its first member) is one transaction.
      transaction: true,
    }),

    // Q54: a username or an email, plus a password. No mail server is assumed:
    // nothing is verified by mail, and a reset link is handed to the admin.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
      minPasswordLength: 10,
      // A link an admin copies into a chat has to outlive an hour.
      resetPasswordTokenExpiresIn: ONE_DAY_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) => {
        const sink = currentLinkSink();
        if (sink !== undefined) {
          sink.reset = { userId: UserId.parse(user.id), url };
        }
        return Promise.resolve();
      },
    },

    databaseHooks: {
      user: {
        create: {
          // Q54: every account has a unique username. The username plugin makes
          // it optional, so ostra refuses an account without one, whichever
          // path creates it (sign-up, an admin creating a user).
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
          // Q102: the first account on an install is the instance admin.
          after: async (user) => {
            await promoteFirstAccount(prisma, UserId.parse(user.id));
          },
        },
      },
    },

    hooks: {
      // Sign-up is closed to strangers: the first account, an invitee, or
      // anyone when the install turns open sign-up on.
      //
      // An invitee proves the invitation with its ID, which is the secret in
      // the invite link the admin handed over. Knowing the invited email
      // address is not enough: with no mail server there is no proof of the
      // mailbox, so an address alone would let a stranger sign up as the invitee.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") {
          return;
        }
        if (settings.openAccountSignup) {
          return;
        }
        const accounts = await prisma.user.count();
        if (accounts === 0) {
          return;
        }
        const email: unknown = Reflect.get(ctx.body ?? {}, "email");
        const invitationId = InvitationId.safeParse(ctx.headers?.get(INVITATION_HEADER));
        if (typeof email === "string" && invitationId.success) {
          const invitation = await prisma.invitation.findFirst({
            where: {
              id: invitationId.data,
              email: email.toLowerCase(),
              status: "pending",
              expiresAt: { gt: new Date() },
            },
            select: { id: true },
          });
          if (invitation !== null) {
            return;
          }
        }
        throw new APIError("FORBIDDEN", {
          code: "SIGN_UP_CLOSED",
          message: "Sign-up needs an invitation",
        });
      }),
    },

    plugins: [
      // Q54: a second name to sign in with. Letters, digits, underscore and dot,
      // so a username can never be mistaken for an email address.
      username({
        minUsernameLength: 3,
        maxUsernameLength: 32,
      }),
      // Q102: the instance admin. Its role lives on `user.role`, apart from the
      // organization roles on `member.role`.
      admin({
        adminRoles: ["admin"],
        defaultRole: "user",
      }),
      // ADR 0026: organizations, members and invitations, with two roles.
      // No `sendInvitationEmail`: with no mail server the admin copies the link.
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
      // A runner presents the session token it got from the device flow as a
      // bearer token. The plugin is not on ADR 0003's list; see README.
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
