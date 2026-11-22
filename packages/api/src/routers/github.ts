import { createHash, randomBytes } from "node:crypto";

import { appEvents, appPermissions, isPublicWebhookUrl } from "@ostra/adapter-github";
import {
  appOwnerInTx,
  connectExistingApp,
  connectGitHubApp,
  detectRepoEnvironment,
  linkOwnInstallationInTx,
  missingAppPermissions,
  seenInstallationOf,
  setGitHubClientSecret,
  setGitHubClientSecretInputSchema,
  setGitHubWebhookSecret,
} from "@ostra/domain";
import { secretRefSchema } from "@ostra/adapter-sdk";
import { connectionIdSchema, memberIdSchema, organizationIdSchema, repoFullNameSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { MemberScope } from "@ostra/domain";

import { loginSessionIdSchema } from "../auth/scope.ts";
import type { ApiDeps } from "../trpc/context.ts";
import { githubConnectionsOf, loadGitHubConnection } from "../services/github-connection.ts";
import { adapterErrorToTrpc } from "../trpc/errors.ts";
import { adminProcedure, router, unwrap } from "../trpc/init.ts";
import { detectionViewSchema } from "./environments.ts";
import { githubOrganizationProcedures, requireLinkedInstallation, webhookUrlOf } from "./github-organizations.ts";

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
  /**
   * Whether the App's OAuth client secret is stored (Q295): members link their GitHub accounts
   * through it (F-119), and until it is, the GitHub page says member linking is off.
   */
  clientSecretSet: z.boolean(),
});

const connectedSchema = z.object({
  connectionId: connectionIdSchema,
  slug: z.string(),
  permissions: z.record(z.string(), z.string()),
});

/**
 * Milestone 4 (F-136, ticket 51): `connectExisting` also answers the connection's own webhook
 * address, and the webhook secret ostra generated when the admin gave none, shown this once.
 */
const connectedExistingSchema = connectedSchema.extend({
  webhookUrl: z.string(),
  /** Set in the App's webhook settings with `webhookUrl`; `null` when the admin gave their own. */
  webhookSecret: z.string().nullable(),
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

/** What the manifest flow takes: the account to create the App on, and whether it's public (F-136). */
const manifestInputSchema = z.strictObject({
  ownerLogin: z.string().min(1).max(100).nullable().default(null),
  /** Whether accounts other than the owner may install it. Off by default: a host may not let it go back. */
  public: z.boolean().default(false),
});

/** The manifest flow's first step: the manifest, and a `state` bound to the admin's session. */
const startManifestFor = async (
  ctx: { readonly deps: ApiDeps; readonly scope: MemberScope; readonly user: { readonly sessionId: z.infer<typeof boundSchema>["sessionId"] } },
  input: z.infer<typeof manifestInputSchema>,
): Promise<z.infer<typeof manifestOutputSchema>> => {
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
      // F-136 (ticket 51): a public App other accounts may install; private unless the admin says.
      public: input.public,
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
};

const manifestOutputSchema = z.object({
  /** Where the panel posts the manifest (a form field named `manifest`). */
  createUrl: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  /** Sent along as the form's `state` query parameter and returned on GitHub's redirect. */
  state: z.string(),
  webhookEnabled: z.boolean(),
  note: z.string().nullable(),
});

export const githubRouter = router({
  // F-136 (ticket 51): every App, its installations, and an admin's link, unlink and remove.
  ...githubOrganizationProcedures,

  /** The connection, without a secret in it; `null` until GitHub is connected. */
  connection: adminProcedure.output(connectionViewSchema.nullable()).query(async ({ ctx }) => {
    const [row] = await githubConnectionsOf(ctx.deps, ctx.scope);
    if (row === undefined) {
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
      clientSecretSet: row.clientSecretSecretRef !== null,
    };
  }),

  /**
   * Q295: adds or replaces the organization's own App's OAuth client secret, which the verified link
   * (F-119) signs members in with. An App connected as an existing one has none until an admin adds
   * it here. The secret goes to the secret store and no output returns it; the one it replaces is
   * deleted once the new one is in place.
   */
  setClientSecret: adminProcedure
    .input(setGitHubClientSecretInputSchema)
    .output(z.object({ connectionId: connectionIdSchema, replaced: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const result = await db.$transaction((tx) => setGitHubClientSecret({ tx, scope: ctx.scope, ...ports }, input));
      const set = unwrap(result, { forbidden: "FORBIDDEN", "not-connected": "PRECONDITION_FAILED" });
      if (set.replaced !== null) {
        // Nothing points at it any more; a failed delete leaves an orphan, never a broken link.
        await ports.adapters.secretStore.delete(ctx.scope.organizationId, set.replaced);
      }
      return { connectionId: set.connectionId, replaced: set.replaced !== null };
    }),

  /**
   * F-006/c4: finishes the webhook of an App made while the server had no public address, once it
   * has one. GitHub has no call that gives such an App a webhook or subscribes it to events (its
   * `GET /app/hook/config` answers 404 for one), so ostra generates the webhook secret, keeps it in
   * the secret store, and answers what an admin sets in the App's settings on GitHub: the App's own
   * webhook address, the secret, shown this once, and the events to subscribe to. Until then the
   * inbox takes no delivery for the App. Called again, it replaces the secret, for one that was lost.
   */
  turnOnWebhook: adminProcedure
    .input(z.strictObject({ connectionId: connectionIdSchema }))
    .output(
      z.object({
        connectionId: connectionIdSchema,
        webhookUrl: z.string(),
        /** Set in the App's webhook settings with `webhookUrl`; no other output returns it. */
        webhookSecret: z.string(),
        /** What a manifest App made with a webhook subscribes to (`appEvents`), in its order. */
        events: z.array(z.string()),
        replaced: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      const webhookUrl = webhookUrlOf(settings.corePublicUrl, input.connectionId);
      if (!isPublicWebhookUrl(webhookUrl)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This server's address isn't public, so GitHub can't deliver to it. Set OSTRA_CORE_PUBLIC_URL to a public address first.",
        });
      }
      const webhookSecret = randomBytes(32).toString("hex");
      const result = await db.$transaction((tx) => setGitHubWebhookSecret({ tx, scope: ctx.scope, ...ports }, { connectionId: input.connectionId, webhookSecret }));
      const set = unwrap(result, { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" });
      if (set.replaced !== null) {
        // Nothing points at it any more; a failed delete leaves an orphan, never a broken webhook.
        await ports.adapters.secretStore.delete(ctx.scope.organizationId, set.replaced);
      }
      return { connectionId: set.connectionId, webhookUrl, webhookSecret, events: [...appEvents], replaced: set.replaced !== null };
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
   *
   * Milestone 4 (F-136, ticket 51): it works beside another App, a client's own, with its owner
   * read from GitHub. It answers the connection's own webhook address; without a webhook secret
   * from the admin, ostra generates one and answers it this once, for the App's settings.
   *
   * Q295: the organization's own App also takes its OAuth client secret, so members can link their
   * GitHub accounts (F-119); without one they can't, until an admin adds it (`setClientSecret`). A
   * client's App beside it takes none: members link through the organization's own.
   */
  connectExisting: adminProcedure
    .input(
      z.strictObject({
        appId: z.string().regex(/^\d+$/, "a numeric App ID"),
        privateKey: z.string().min(1).max(16_384),
        webhookSecret: z.string().min(1).max(512).optional(),
        clientSecret: z.string().trim().min(1).max(512).optional(),
      }),
    )
    .output(connectedExistingSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      const generated = input.webhookSecret === undefined ? randomBytes(32).toString("hex") : null;
      const webhookSecret = input.webhookSecret ?? generated ?? "";
      const present = await githubConnectionsOf(ctx.deps, ctx.scope);
      if (present.length === 0) {
        const result = await db.$transaction(
          (tx) =>
            connectGitHubApp(
              { tx, scope: ctx.scope, ...ports },
              { via: "existing", appId: input.appId, privateKey: input.privateKey, webhookSecret, ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }) },
            ),
          { timeout: 30_000, maxWait: 10_000 },
        );
        const connected = unwrap(result, connectErrors);
        return { connectionId: connected.connectionId, slug: connected.slug, permissions: connected.permissions, webhookUrl: webhookUrlOf(settings.corePublicUrl, connected.connectionId), webhookSecret: generated };
      }
      if (present.some((row) => row.appId === input.appId)) {
        throw new TRPCError({ code: "CONFLICT", message: "That App is connected already" });
      }
      if (input.clientSecret !== undefined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Members link their GitHub accounts through the organization's own App: a client's App takes no client secret" });
      }
      // Beside the organization's own App: a client's App, read with its own credentials.
      const host = ports.adapters.codeHost;
      const credentials = { appId: input.appId, privateKey: input.privateKey };
      const app = await host.readApp(credentials);
      if (!app.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `GitHub did not accept the App's credentials: ${app.error.message}` });
      }
      const missing = missingAppPermissions(app.value.permissions);
      if (missing.length > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `The App lacks permissions ostra needs: ${missing.join(", ")}` });
      }
      if (app.value.owner === undefined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "GitHub didn't say which account owns the App" });
      }
      const bot = await host.getBotIdentity(credentials);
      if (!bot.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `GitHub did not give the App's bot identity: ${bot.error.message}` });
      }
      const organizationId = ctx.scope.organizationId;
      const stored: string[] = [];
      const keep = async (purpose: string, value: string): Promise<string> => {
        const put = await ports.adapters.secretStore.put({ organizationId, purpose }, value);
        if (!put.ok) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The secret store did not keep the App's secret" });
        }
        stored.push(put.value);
        return put.value;
      };
      const forget = async (): Promise<void> => {
        for (const ref of stored) {
          const parsed = secretRefSchema.safeParse(ref);
          if (parsed.success) {
            await ports.adapters.secretStore.delete(organizationId, parsed.data);
          }
        }
      };
      try {
        const privateKeySecretRef = await keep("github-app.private-key", input.privateKey);
        const webhookSecretSecretRef = await keep("github-app.webhook-secret", webhookSecret);
        const result = await connectExistingApp({ db, audit: ports.audit, clock: ports.clock }, ctx.scope, {
          appId: input.appId,
          slug: app.value.slug,
          ownerLogin: app.value.owner.login,
          ownerAccountId: app.value.owner.accountId,
          botName: bot.value.name,
          botEmail: bot.value.email,
          privateKeySecretRef,
          webhookSecretSecretRef,
        });
        const connected = unwrap(result, { forbidden: "FORBIDDEN", "already-connected": "CONFLICT" });
        await db.connection.updateMany({ where: { id: connected.connectionId, organizationId }, data: { permissions: app.value.permissions } });
        return { connectionId: connected.connectionId, slug: app.value.slug, permissions: { ...app.value.permissions }, webhookUrl: webhookUrlOf(settings.corePublicUrl, connected.connectionId), webhookSecret: generated };
      } catch (error) {
        await forget();
        throw error;
      }
    }),

  /** "Create a new App", the manifest flow's first step under its own name (F-136): `public` says who may install it. */
  createApp: adminProcedure
    .input(manifestInputSchema)
    .output(manifestOutputSchema)
    .mutation(async ({ ctx, input }) => startManifestFor(ctx, input)),

  /**
   * "Create a new App" (the manifest flow): the manifest to post to GitHub, and a `state` bound to
   * this admin's session. The webhook is in the manifest only when the server's address is public:
   * GitHub refuses a private one, and the App is then made without events (`webhookEnabled`).
   */
  startManifest: adminProcedure
    .input(manifestInputSchema)
    .output(manifestOutputSchema)
    .mutation(async ({ ctx, input }) => startManifestFor(ctx, input)),

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
    .input(z.strictObject({ connectionId: connectionIdSchema.optional() }).optional())
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
    .query(async ({ ctx, input }) => {
      const github = await loadGitHubConnection(ctx.deps, ctx.scope, input?.connectionId ?? null);
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
    .input(z.strictObject({ installationId: z.string().min(1).max(64), connectionId: connectionIdSchema.optional() }))
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
      const github = await loadGitHubConnection(ctx.deps, ctx.scope, input.connectionId ?? null);
      // F-136 (ticket 51): repos come only from a linked installation.
      await requireLinkedInstallation(ctx, github, input.installationId);
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
    .input(z.strictObject({ installationId: z.string().min(1).max(64), fullName: repoFullNameSchema, ref: z.string().min(1).max(255), connectionId: connectionIdSchema.optional() }))
    .output(detectionViewSchema)
    .query(async ({ ctx, input }) => {
      const github = await loadGitHubConnection(ctx.deps, ctx.scope, input.connectionId ?? null);
      await requireLinkedInstallation(ctx, github, input.installationId);
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
