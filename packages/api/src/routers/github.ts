import { createHash, randomBytes } from "node:crypto";

import { appPermissions, isPublicWebhookUrl } from "@ostra/adapter-github";
import { appOwnerInTx, connectGitHubApp, detectRepoEnvironment, linkOwnInstallationInTx, seenInstallationOf } from "@ostra/domain";
import { connectionIdSchema, memberIdSchema, organizationIdSchema, repoFullNameSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { loginSessionIdSchema } from "../auth/scope.ts";
import { loadGitHubConnection } from "../services/github-connection.ts";
import { adapterErrorToTrpc } from "../trpc/errors.ts";
import { adminProcedure, router, unwrap } from "../trpc/init.ts";
import { detectionViewSchema } from "./environments.ts";

// F-006, ticket 31: the organization's GitHub App. Admin only, organization scoped. The App's
// private key, webhook secret and client secret go to the secret store at once and no procedure
// returns them: every output below is built field by field.

const connectionViewSchema = z.object({
  connectionId: connectionIdSchema,
  appId: z.string(),
  slug: z.string().nullable(),
  /** The bot identity every commit is authored by (F-078). */
  botName: z.string().nullable(),
  botEmail: z.string().nullable(),
  /** Permission name to level, as GitHub reports them. */
  permissions: z.record(z.string(), z.string()),
});

const connectedSchema = z.object({
  connectionId: connectionIdSchema,
  slug: z.string(),
  permissions: z.record(z.string(), z.string()),
});

const connectErrors = {
  forbidden: "FORBIDDEN",
  "app-refused": "BAD_REQUEST",
  "missing-permissions": "BAD_REQUEST",
  "already-connected": "CONFLICT",
} as const;

/** How long the manifest flow's `state` lives: the admin is on GitHub's page for a minute or two. */
const MANIFEST_STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PREFIX = "ostra.github-manifest:";

const stateKey = (state: string): string => `${STATE_PREFIX}${createHash("sha256").update(state).digest("hex")}`;

/** What the state is bound to: the admin's session, so another session can't complete the flow. */
const boundSchema = z.strictObject({
  sessionId: loginSessionIdSchema,
  memberId: memberIdSchema,
  organizationId: organizationIdSchema,
});

export const githubRouter = router({
  /** The connection, without a secret in it; `null` until GitHub is connected. */
  connection: adminProcedure.output(connectionViewSchema.nullable()).query(async ({ ctx }) => {
    const row = await ctx.deps.db.connection.findFirst({ where: { organizationId: ctx.scope.organizationId, kind: "github" } });
    if (row === null) {
      return null;
    }
    const permissions = z.record(z.string(), z.string()).safeParse(row.permissions);
    return {
      connectionId: connectionIdSchema.parse(row.id),
      appId: row.appId,
      slug: row.slug,
      botName: row.botName,
      botEmail: row.botEmail,
      permissions: permissions.success ? permissions.data : {},
    };
  }),

  /**
   * What a new App asks GitHub for, in the manifest's order, and whether it can get events: the
   * not-connected page shows both before the admin starts (F-006). Read from the manifest itself,
   * never typed again in the panel.
   */
  appRequest: adminProcedure
    .output(
      z.object({
        permissions: z.array(z.object({ name: z.string(), level: z.enum(["read", "write"]) })),
        /** Permissions left out on purpose: a push that touches `.github/workflows/` fails. */
        notAsked: z.array(z.string()),
        /** Whether GitHub can reach the server's webhook address (OSTRA_CORE_PUBLIC_URL). */
        webhookPossible: z.boolean(),
      }),
    )
    .query(({ ctx }) => ({
      permissions: Object.entries(appPermissions).map(([name, level]) => ({ name, level })),
      notAsked: ["workflows"],
      webhookPossible: isPublicWebhookUrl(`${ctx.deps.settings.corePublicUrl}/webhooks/github`),
    })),

  /**
   * "Use an existing App": reads the App with the credentials given, checks its permissions include
   * `checks: write` and `actions: read` (naming the missing ones if not), stores the key and the
   * secret through the secret store, and keeps the slug and the bot identity.
   */
  connectExisting: adminProcedure
    .input(
      z.strictObject({
        appId: z.string().regex(/^\d+$/, "a numeric App ID"),
        privateKey: z.string().min(1).max(16_384),
        webhookSecret: z.string().min(1).max(512),
      }),
    )
    .output(connectedSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const result = await db.$transaction(
        (tx) => connectGitHubApp({ tx, scope: ctx.scope, ...ports }, { via: "existing", ...input }),
        { timeout: 30_000, maxWait: 10_000 },
      );
      const connected = unwrap(result, connectErrors);
      return { connectionId: connected.connectionId, slug: connected.slug, permissions: connected.permissions };
    }),

  /**
   * "Create a new App" (the manifest flow): the manifest to post to GitHub, and a `state` bound to
   * this admin's session. The webhook is in the manifest only when the server's address is public:
   * GitHub refuses a private one, and the App is then made without events (`webhookEnabled`).
   */
  startManifest: adminProcedure
    .input(z.strictObject({ ownerLogin: z.string().min(1).max(100).nullable().default(null) }))
    .output(
      z.object({
        /** Where the panel posts the manifest (a form field named `manifest`). */
        createUrl: z.string(),
        manifest: z.record(z.string(), z.unknown()),
        /** Sent along as the form's `state` query parameter and returned on GitHub's redirect. */
        state: z.string(),
        webhookEnabled: z.boolean(),
        note: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { db, settings, ports } = ctx.deps;
      const organization = await db.organization.findUniqueOrThrow({
        where: { id: ctx.scope.organizationId },
        select: { slug: true },
      });
      const prepared = ports.adapters.codeHost.appManifest({
        name: `ostra-${organization.slug}`.slice(0, 34).replace(/-+$/, ""),
        homepageUrl: settings.publicUrl,
        webhookUrl: `${settings.corePublicUrl}/webhooks/github`,
        redirectUrl: `${settings.publicUrl}/api/github/manifest/callback`,
        ownerLogin: input.ownerLogin,
      });
      const webhookEnabled = "hook_attributes" in prepared.manifest;

      const state = randomBytes(32).toString("base64url");
      const bound: z.infer<typeof boundSchema> = {
        sessionId: ctx.user.sessionId,
        memberId: ctx.scope.memberId,
        organizationId: ctx.scope.organizationId,
      };
      // Better-auth's `verification` table is the store for short-lived keyed values: the state is
      // kept by its hash, bound to the session, and used once.
      await db.verification.create({
        data: {
          id: randomBytes(16).toString("hex"),
          identifier: stateKey(state),
          value: JSON.stringify(bound),
          expiresAt: new Date(ports.clock.now() + MANIFEST_STATE_TTL_MS),
        },
      });
      return {
        createUrl: prepared.createUrl,
        manifest: { ...prepared.manifest },
        state,
        webhookEnabled,
        note: webhookEnabled
          ? null
          : "The server's address is not public, so the App is created without a webhook and receives no events. Set OSTRA_CORE_PUBLIC_URL to a public address to turn them on.",
      };
    }),

  /**
   * The manifest flow's return: the code GitHub redirected back with, and the `state` it carried.
   * The state must be unexpired, unused and bound to this admin's own session; it is used up here.
   */
  completeManifest: adminProcedure
    .input(z.strictObject({ code: z.string().min(1).max(256), state: z.string().min(16).max(200) }))
    .output(connectedSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const key = stateKey(input.state);
      const stored = await db.verification.findFirst({ where: { identifier: key, expiresAt: { gt: new Date(ports.clock.now()) } } });
      const invalid = new TRPCError({ code: "BAD_REQUEST", message: "This sign-in with GitHub is not valid any more: start again" });
      if (stored === null) {
        throw invalid;
      }
      const bound = boundSchema.safeParse(safeJson(stored.value));
      if (!bound.success) {
        throw invalid;
      }
      // Bound to the session that started it: another session, even this admin's, can't finish it.
      if (
        bound.data.sessionId !== ctx.user.sessionId ||
        bound.data.memberId !== ctx.scope.memberId ||
        bound.data.organizationId !== ctx.scope.organizationId
      ) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This sign-in with GitHub was started in another session" });
      }
      // Used once: of two requests at the same moment, one deletes the row and goes on.
      const used = await db.verification.deleteMany({ where: { id: stored.id } });
      if (used.count !== 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This sign-in with GitHub was already used: start again" });
      }
      const result = await db.$transaction(
        (tx) => connectGitHubApp({ tx, scope: ctx.scope, ...ports }, { via: "manifest", code: input.code }),
        { timeout: 30_000, maxWait: 10_000 },
      );
      const connected = unwrap(result, connectErrors);
      return { connectionId: connected.connectionId, slug: connected.slug, permissions: connected.permissions };
    }),

  /** The installations of the App: `ostra-test` for the test App. */
  installations: adminProcedure
    .output(
      z.array(
        z.object({
          installationId: z.string(),
          accountLogin: z.string(),
          accountKind: z.enum(["organization", "user"]),
          repositorySelection: z.enum(["all", "selected"]),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      const github = await loadGitHubConnection(ctx.deps, ctx.scope);
      const listed = await ctx.deps.ports.adapters.codeHost.listInstallations(github.credentials);
      if (!listed.ok) {
        throw adapterErrorToTrpc(listed.error, "GitHub did not list the App's installations");
      }
      // Milestone 4 (F-136, ADR 0065): the App owner's own installation is linked when a listing shows it.
      const { ports } = ctx.deps;
      await ctx.deps.db.$transaction(async (tx) => {
        const connection = await tx.connection.findFirstOrThrow({ where: { id: github.connectionId, organizationId: ctx.scope.organizationId } });
        const owner = await appOwnerInTx(tx, ports.adapters.codeHost, github.credentials, connection);
        for (const installation of listed.value) {
          await linkOwnInstallationInTx(ports, tx, { organizationId: ctx.scope.organizationId, connectionId: github.connectionId, owner, installation: seenInstallationOf(installation) });
        }
      });
      return listed.value.map((installation) => ({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountKind: installation.accountKind,
        repositorySelection: installation.repositorySelection,
      }));
    }),

  /** The repos an installation grants the App. */
  repos: adminProcedure
    .input(z.strictObject({ installationId: z.string().min(1).max(64) }))
    .output(
      z.array(
        z.object({
          hostRepoId: z.string(),
          fullName: z.string(),
          defaultBranch: z.string(),
          private: z.boolean(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const github = await loadGitHubConnection(ctx.deps, ctx.scope);
      const listed = await ctx.deps.ports.adapters.codeHost.listRepos(github.credentials, input.installationId);
      if (!listed.ok) {
        throw adapterErrorToTrpc(listed.error, "GitHub did not list the installation's repos");
      }
      return listed.value.map((repo) => ({
        hostRepoId: repo.hostRepoId,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        private: repo.private,
      }));
    }),

  /**
   * What detection finds in a repo of an installation, before any project exists (F-112, "Create a
   * project"): the same draft `projects.create` makes, from the repo's files at `ref`. Nothing is
   * stored. No agent, no model.
   */
  detect: adminProcedure
    .input(z.strictObject({ installationId: z.string().min(1).max(64), fullName: repoFullNameSchema, ref: z.string().min(1).max(255) }))
    .output(detectionViewSchema)
    .query(async ({ ctx, input }) => {
      const github = await loadGitHubConnection(ctx.deps, ctx.scope);
      return detectRepoEnvironment(
        ctx.deps.ports.adapters.codeHost,
        { app: github.credentials, installationId: input.installationId, repo: input.fullName },
        input.ref,
      );
    }),
});

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
