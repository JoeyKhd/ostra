import type { Db, DbOrTx, Tx } from "@ostra/db";
import {
  acceptInvitation,
  activateVerifiedMemberships,
  ensureBuiltInAgentProfile,
  ensureDefaultPool,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  postgresAuditLog,
  postgresChangeNotices,
  systemClock,
} from "@ostra/domain";
import { invitationIdSchema, organizationIdSchema, userIdSchema } from "@ostra/protocol";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { admin, bearer, deviceAuthorization, organization, username } from "better-auth/plugins";
import { z } from "zod";

import {
  capturingTransactions,
  currentResetLinkSink,
  INVITATION_HEADER,
  recordResetLinkInTx,
  recordPasswordChangedInTx,
  recordResetUsedInTx,
  refusingJobQueue,
  transactionStorage,
} from "./account-hooks.ts";
import type { AccountPorts } from "./account-hooks.ts";
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
  /** How long an invitation works (`OSTRA_INVITATION_DAYS`). Default 7. */
  readonly invitationDays?: number;
  /** How long a reset link works (`OSTRA_RESET_LINK_HOURS`). Default 24. */
  readonly resetLinkHours?: number;
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
  /**
   * What the account hooks write through (milestone 4, ticket 22): the job queue for account mails,
   * the audit log, and whether the install's email is set up. Unset: no email, and no queue.
   */
  readonly accounts?: AccountPorts;
};

/** better-auth's routes ostra replaces with its own use cases, so their rules and audit entries hold (ADR 0053). */
const REPLACED_ORGANIZATION_PATHS: ReadonlyMap<string, string> = new Map([
  ["/organization/accept-invitation", "Accept an invitation from its link"],
  ["/organization/remove-member", "An organization admin removes members on the Members page"],
  ["/organization/leave", "Ask an organization admin to remove you"],
  ["/organization/update-member-role", "An organization admin changes roles on the Members page"],
]);

const ONE_DAY_SECONDS = 24 * 60 * 60;
const ONE_HOUR_SECONDS = 60 * 60;

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
/** The body of `/device/approve`; better-auth compares the code with the dashes and case ignored. */
const approvedDeviceSchema = z.looseObject({ userCode: z.string().min(1).transform((code) => code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()) });

/** The login session behind an approval: who it is and the organization it is signed into. */
const approverSchema = z.looseObject({
  user: z.looseObject({ id: z.string().min(1) }),
  session: z.looseObject({ activeOrganizationId: z.string().min(1).nullish() }),
});

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
const firstOrganizationOf = async (db: DbOrTx, userId: string): Promise<string | null> => {
  const member = await db.member.findFirst({
    // A removed membership, or one waiting on its address, makes no scope (ADR 0053).
    where: { userId, state: "active" },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });
  return member === null ? null : member.organizationId;
};

/** A refusal of a sign-up, with its code for the page. */
const signUpRefused = (code: string, message: string): APIError => new APIError("FORBIDDEN", { code, message });

/** What the sign-up page reads from each refusal of an invitation's acceptance. */
const invitationRefusalCode = {
  "not-found": "INVITATION_NOT_USABLE",
  expired: "INVITATION_NOT_USABLE",
  revoked: "INVITATION_NOT_USABLE",
  used: "INVITATION_NOT_USABLE",
  "address-mismatch": "ADDRESS_MISMATCH",
  "already-member": "ALREADY_MEMBER",
} as const;

const tokenOf = (body: unknown): string | null => {
  const token: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "token") : undefined;
  return typeof token === "string" && token !== "" ? token : null;
};

export const createAuth = (input: CreateAuthInput) => {
  const settings = input.settings ?? defaultAuthSettings;
  const { db } = input;
  const accounts: AccountPorts = input.accounts ?? {
    emailOn: () => Promise.resolve(false),
    jobs: refusingJobQueue,
    audit: postgresAuditLog,
    notices: postgresChangeNotices,
    clock: systemClock,
  };
  const invitationDays = settings.invitationDays ?? 7;
  const resetLinkSeconds = (settings.resetLinkHours ?? 24) * ONE_HOUR_SECONDS;
  // The transaction better-auth is running now, if any: a hook inside it writes ostra's rows there.
  const transactions = transactionStorage();
  const inTransaction = (): Tx => {
    const tx = transactions.getStore();
    if (tx === undefined) {
      throw new APIError("INTERNAL_SERVER_ERROR", { code: "NO_TRANSACTION", message: "That didn't work. Try again." });
    }
    return tx;
  };
  // The before hook reads the caller's session through the finished instance, set just below.
  const finished: { sessionOf?: (headers: Headers) => Promise<{ readonly user: object; readonly session: object } | null> } = {};

  const auth = betterAuth({
    baseURL: input.baseUrl,
    secret: input.secret,
    trustedOrigins: [input.baseUrl],
    // ADR 0021: no telemetry.
    telemetry: { enabled: false },
    logger: { level: input.logLevel ?? "warn" },
    database: prismaAdapter(capturingTransactions(db, transactions), {
      provider: "postgresql",
      // A multi-row write (an organization and its first member) is one transaction.
      transaction: true,
    }),
    // ostra's own table for a login session, so "Session" stays the agent's (schema.prisma).
    session: { modelName: "authSession" },

    // Q54: a username or an email, plus a password. No mail server is assumed: with none, nothing
    // is verified by mail, and a reset link is handed to the instance admin (ADR 0053).
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // A link an admin copies into a chat has to outlive an hour (`OSTRA_RESET_LINK_HOURS`).
      resetPasswordTokenExpiresIn: resetLinkSeconds,
      revokeSessionsOnPasswordReset: true,
      // A link better-auth made: into the asking instance admin's sink, or, with email set up and the
      // address verified, an account mail. Anything else is dropped, and the answer stays the same.
      sendResetPassword: async ({ user, url, token }) => {
        const userId = userIdSchema.parse(user.id);
        const expiresAt = accounts.clock.now() + resetLinkSeconds * 1000;
        const sink = currentResetLinkSink();
        if (sink !== undefined) {
          await db.$transaction((tx) => recordResetLinkInTx(accounts, tx, { userId, token, kind: "admin_link", createdByUserId: sink.createdBy, expiresAt }));
          sink.link = { url, token };
          return;
        }
        if (!user.emailVerified || !(await accounts.emailOn())) {
          return;
        }
        await db.$transaction((tx) => recordResetLinkInTx(accounts, tx, { userId, token, kind: "self_service", createdByUserId: null, expiresAt }));
      },
    },

    // With email set up, an invitee's address is proven by a link (ADR 0053): 24 hours, the reset
    // link's value. ostra enqueues the mail itself, in the sign-up's transaction (the job carries the
    // membership's ID, never the link), so better-auth sends none on sign-up.
    emailVerification: {
      sendOnSignUp: false,
      expiresIn: ONE_DAY_SECONDS,
      autoSignInAfterVerification: true,
      // "Send it again": one account mail per membership still waiting on this address.
      sendVerificationEmail: async ({ user }) => {
        if (!(await accounts.emailOn())) {
          return;
        }
        await db.$transaction(async (tx) => {
          const waiting = await tx.member.findMany({ where: { userId: user.id, state: "pending_verification" }, select: { id: true, organizationId: true } });
          for (const member of waiting) {
            // The first mail's delivery is done (sent, or given up on): asked again, it goes again.
            // The job sends only a pending delivery, so a replay still sends nothing twice.
            await tx.accountMailDelivery.updateMany({
              where: { purpose: "email_verification", recordId: member.id, state: { not: "pending" } },
              data: { state: "pending", error: null },
            });
            await accounts.jobs.enqueueInTx(tx, "account-mail.send", {
              organizationId: organizationIdSchema.parse(member.organizationId),
              purpose: "email_verification",
              recordId: member.id,
            });
          }
        });
      },
      // The address is proven: the memberships waiting on it become active, each with `member.verified`.
      afterEmailVerification: async (user) => {
        await db.$transaction((tx) => activateVerifiedMemberships(accounts, tx, userIdSchema.parse(user.id)));
      },
    },

    user: {
      additionalFields: {
        // F-001: set only by the seed, for the default password; cleared by a password change.
        // `input: false`: no sign-up or profile update can set it.
        mustChangePassword: { type: "boolean", required: false, defaultValue: false, input: false },
        // F-082 (milestone 7): the member's theme, in the session's payload. `input: false`: only
        // `account.setTheme` writes it.
        theme: { type: "string", required: false, defaultValue: "dark", input: false },
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
      account: {
        create: {
          // F-002: a sign-up through an invitation's link joins its organization in the sign-up's own
          // transaction: the account, the membership, its project grants and the acceptance commit
          // together, or none does. The before hook below has checked the invitation already.
          before: async (account, context) => {
            if (context?.path !== "/sign-up/email") {
              return;
            }
            const invitationId = invitationIdSchema.safeParse(context.headers?.get(INVITATION_HEADER));
            if (!invitationId.success) {
              throw signUpRefused("SIGN_UP_CLOSED", "Sign-up needs an invitation");
            }
            const tx = inTransaction();
            const userId = userIdSchema.parse(account.userId);
            const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
            const accepted = await acceptInvitation(
              { jobs: accounts.jobs, audit: accounts.audit, notices: accounts.notices, clock: accounts.clock },
              tx,
              { invitationId: invitationId.data, userId, email: user.email, emailOn: await accounts.emailOn() },
            );
            if (!accepted.ok) {
              throw signUpRefused(invitationRefusalCode[accepted.error], accepted.message);
            }
          },
        },
        update: {
          // A reset link used: its grant, the account's CLI sessions and the audit entries, in the
          // reset's transaction (better-auth ends the login sessions in it).
          before: async (_account, context) => {
            const token = context?.path === "/reset-password" ? tokenOf(context.body) : null;
            if (token !== null) {
              await recordResetUsedInTx(accounts, inTransaction(), token);
            }
          },
        },
      },
      session: {
        create: {
          // A new session starts in the member's organization, so the panel, and a personal
          // runner's device session, know where they are (ticket 30: the device approval). Inside a
          // sign-up, the membership it just made is read in its transaction.
          before: async (session) => {
            const activeOrganizationId = await firstOrganizationOf(transactions.getStore() ?? db, session.userId);
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
        //
        // F-002 (ADR 0053): an invitee signs up with the invitation's ID, which is the secret in its
        // link, sent on `x-ostra-invitation`. Knowing the invited address is not enough. With email
        // set up the address must be the invitation's; without, it's taken as written. The account
        // hook above accepts it in the sign-up's transaction.
        if (ctx.path === "/sign-up/email") {
          const invitationId = invitationIdSchema.safeParse(ctx.headers?.get(INVITATION_HEADER));
          if (!invitationId.success) {
            throw signUpRefused("SIGN_UP_CLOSED", "Sign-up needs an invitation");
          }
          const now = new Date(accounts.clock.now());
          const invitation = await db.invitation.findFirst({
            where: { id: invitationId.data, status: "pending", acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
            select: { email: true },
          });
          if (invitation === null) {
            throw signUpRefused("INVITATION_NOT_USABLE", "This invitation can't be used: it expired, was revoked or was used");
          }
          const email: unknown = Reflect.get(ctx.body ?? {}, "email");
          if ((await accounts.emailOn()) && (typeof email !== "string" || email.trim().toLowerCase() !== invitation.email.toLowerCase())) {
            throw signUpRefused("ADDRESS_MISMATCH", "Sign up with the address the invitation was sent to");
          }
          return;
        }
        const replaced = REPLACED_ORGANIZATION_PATHS.get(ctx.path);
        if (replaced !== undefined) {
          throw new APIError("FORBIDDEN", { code: "USE_OSTRA", message: replaced });
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
        // F-103: a device code approved for the CLI remembers the organization the approver was signed
        // into, so the CLI session binds to that organization's member (and its audit entry lands there).
        if (ctx.path === "/device/approve" && !isAPIError(ctx.context.returned)) {
          const approved = approvedDeviceSchema.safeParse(ctx.body);
          const { sessionOf } = finished;
          if (approved.success && ctx.headers !== undefined && sessionOf !== undefined) {
            const found = approverSchema.safeParse(await sessionOf(ctx.headers));
            const active = found.success ? found.data.session.activeOrganizationId : null;
            if (found.success && typeof active === "string") {
              const { user } = found.data;
              const member = await db.member.findFirst({ where: { userId: user.id, organizationId: active }, select: { id: true } });
              if (member !== null) {
                await db.deviceCode.updateMany({
                  where: { userCode: approved.data.userCode, userId: user.id, purpose: "cli", organizationId: null },
                  data: { organizationId: active },
                });
              }
            }
          }
          return;
        }
        // A changed password ends the default one: the flag goes, and with it the forced step and
        // the panel's warning (F-001). The change is an audit entry, which setup's timeline reads
        // (F-076, ticket 24).
        if (ctx.path !== "/change-password" || isAPIError(ctx.context.returned)) {
          return;
        }
        const changed = changedPasswordSchema.safeParse(ctx.context.returned);
        if (changed.success) {
          const userId = userIdSchema.parse(changed.data.user.id);
          await db.$transaction(async (tx) => {
            const ended = await tx.user.updateMany({ where: { id: userId, mustChangePassword: true }, data: { mustChangePassword: false } });
            await recordPasswordChangedInTx(accounts, tx, userId, ended.count > 0);
          });
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
        invitationExpiresIn: invitationDays * ONE_DAY_SECONDS,
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
