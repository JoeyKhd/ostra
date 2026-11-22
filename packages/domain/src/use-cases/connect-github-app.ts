import type { Tx } from "@ostra/db";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId } from "@ostra/protocol";
import { z } from "zod";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretRef } from "@ostra/adapter-sdk";

// F-006, ADR 0040: the organization's own GitHub App, either created by the manifest flow (the code
// the host hands back) or an existing App connected by its ID, private key and webhook secret.
// ostra reads the App, stores its secrets through the secret store, and keeps its slug, bot identity
// and permissions. Written by ticket 31.
//
// Q295 (2026-11-21): an existing App also takes its OAuth client secret, which the verified link
// (F-119) signs members in with; the manifest flow is handed it by GitHub. Its client ID needs no
// field: GitHub's `GET /app` answers it. An admin adds or replaces the secret later with
// `setGitHubClientSecret`; until then members can't link.

export const connectGitHubAppInputSchema = z.discriminatedUnion("via", [
  z.strictObject({
    via: z.literal("manifest"),
    /** The code the manifest flow's redirect carried. */
    code: z.string().min(1).max(256),
  }),
  z.strictObject({
    via: z.literal("existing"),
    appId: z.string().regex(/^\d+$/, "a numeric App ID"),
    /** PEM. Never logged; stored through the secret store. */
    privateKey: z.string().min(1).max(16_384),
    /** Never logged; stored through the secret store. */
    webhookSecret: z.string().min(1).max(512),
    /** The App's OAuth client secret, for the verified link (F-119). Never logged; stored through the secret store. */
    clientSecret: z.string().min(1).max(512).optional(),
  }),
]);
export type ConnectGitHubAppInput = z.infer<typeof connectGitHubAppInputSchema>;

export type ConnectGitHubAppResult = UseCaseResult<
  { readonly connectionId: ConnectionId; readonly slug: string; readonly permissions: Readonly<Record<string, string>> },
  "forbidden" | "app-refused" | "missing-permissions" | "already-connected"
>;

export type ConnectGitHubAppDeps = Pick<Ports, "notices" | "audit" | "clock" | "adapters"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type ConnectGitHubApp = (deps: ConnectGitHubAppDeps, input: ConnectGitHubAppInput) => Promise<ConnectGitHubAppResult>;

/** What ostra needs of the App: its checks are written, and its CI runs are read (F-006, F-054). */
export const requiredAppPermissions = { checks: "write", actions: "read" } as const;

const LEVELS: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

/** The required permissions the App lacks, as `checks: write`. Empty: the App is fit. */
export const missingAppPermissions = (granted: Readonly<Record<string, string>>): readonly string[] =>
  Object.entries(requiredAppPermissions)
    .filter(([name, level]) => (LEVELS[granted[name] ?? ""] ?? 0) < (LEVELS[level] ?? 0))
    .map(([name, level]) => `${name}: ${level}`);

const refuse = (
  error: Exclude<ConnectGitHubAppResult, { readonly ok: true }>["error"],
  message: string,
): ConnectGitHubAppResult => ({ ok: false, error, message });

export const connectGitHubApp: ConnectGitHubApp = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin connects GitHub");
  }
  // One GitHub App per organization (Q102, F-006).
  const present = await tx.connection.findFirst({ where: { organizationId, kind: "github" }, select: { id: true } });
  if (present !== null) {
    return refuse("already-connected", "This organization already has a GitHub App");
  }

  const host = deps.adapters.codeHost;
  let credentials: { readonly appId: string; readonly privateKey: string };
  let webhookSecret: string;
  let clientSecret: string | null = null;
  if (input.via === "manifest") {
    const created = await host.convertManifestCode(input.code);
    if (!created.ok) {
      return refuse("app-refused", `GitHub did not hand over the App: ${created.error.message}`);
    }
    credentials = { appId: created.value.appId, privateKey: created.value.privateKey };
    webhookSecret = created.value.webhookSecret;
    clientSecret = created.value.clientSecret;
  } else {
    credentials = { appId: input.appId, privateKey: input.privateKey };
    webhookSecret = input.webhookSecret;
    clientSecret = input.clientSecret ?? null;
  }

  const app = await host.readApp(credentials);
  if (!app.ok) {
    return refuse("app-refused", `GitHub did not accept the App's credentials: ${app.error.message}`);
  }
  const missing = missingAppPermissions(app.value.permissions);
  if (missing.length > 0) {
    return refuse("missing-permissions", `The App lacks permissions ostra needs: ${missing.join(", ")}`);
  }
  const bot = await host.getBotIdentity(credentials);
  if (!bot.ok) {
    return refuse("app-refused", `GitHub did not give the App's bot identity: ${bot.error.message}`);
  }

  // Secrets go to the secret store, and the row keeps their references. If anything after this
  // fails, the secrets are deleted again: nothing is left that no row points at.
  const stored: SecretRef[] = [];
  const keep = async (purpose: string, value: string): Promise<SecretRef> => {
    const put = await deps.adapters.secretStore.put({ organizationId, purpose }, value);
    if (!put.ok) {
      throw new Error(`the secret store did not keep a GitHub App secret: ${put.error.code}`);
    }
    stored.push(put.value);
    return put.value;
  };
  try {
    const privateKeySecretRef = await keep("github-app.private-key", credentials.privateKey);
    // A manifest without a webhook (a private address) has no secret to keep.
    const webhookSecretSecretRef = webhookSecret === "" ? null : await keep("github-app.webhook-secret", webhookSecret);
    const clientSecretSecretRef = clientSecret === null || clientSecret === "" ? null : await keep("github-app.client-secret", clientSecret);
    const created = await tx.connection.create({
      data: {
        organizationId,
        kind: "github",
        appId: credentials.appId,
        slug: app.value.slug,
        botName: bot.value.name,
        botEmail: bot.value.email,
        privateKeySecretRef,
        webhookSecretSecretRef,
        clientSecretSecretRef,
        permissions: app.value.permissions,
      },
      select: { id: true },
    });
    const connectionId = connectionIdSchema.parse(created.id);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "github.connected",
      entity: "connection",
      entityId: connectionId,
      data: { via: input.via, appId: credentials.appId, slug: app.value.slug },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: connectionId });
    return { ok: true, connectionId, slug: app.value.slug, permissions: app.value.permissions };
  } catch (error) {
    await Promise.allSettled(stored.map((ref) => deps.adapters.secretStore.delete(organizationId, ref)));
    throw error;
  }
};

// ---- Q295: the App's OAuth client secret, added or replaced on the GitHub page ----

export const setGitHubClientSecretInputSchema = z.strictObject({
  /** From the App's settings on GitHub ("Generate a new client secret"). Never logged; stored through the secret store. */
  clientSecret: z.string().trim().min(1).max(512),
});
export type SetGitHubClientSecretInput = z.infer<typeof setGitHubClientSecretInputSchema>;

export type SetGitHubClientSecretResult = UseCaseResult<
  {
    readonly connectionId: ConnectionId;
    /** The secret it replaced, for the caller to delete once the transaction commits; `null` for a first one. */
    readonly replaced: SecretRef | null;
  },
  "forbidden" | "not-connected"
>;

export type SetGitHubClientSecretDeps = Pick<Ports, "notices" | "audit" | "adapters"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

const refuseSecret = (
  error: Exclude<SetGitHubClientSecretResult, { readonly ok: true }>["error"],
  message: string,
): SetGitHubClientSecretResult => ({ ok: false, error, message });

/**
 * Keeps the organization's own App's OAuth client secret (the first App it connected, which the
 * verified link signs members in with), replacing one it had. The new secret is in the secret store
 * before the row points at it, and is deleted again if the row's write fails. The old one is the
 * caller's to delete after the commit, so a rolled-back write still has the secret it pointed at.
 */
export const setGitHubClientSecret = async (deps: SetGitHubClientSecretDeps, input: SetGitHubClientSecretInput): Promise<SetGitHubClientSecretResult> => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuseSecret("forbidden", "Only an organization admin sets the GitHub App's client secret");
  }
  const own = await tx.connection.findFirst({
    where: { organizationId, kind: "github" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, clientSecretSecretRef: true },
  });
  if (own === null) {
    return refuseSecret("not-connected", "Connect GitHub first");
  }
  const put = await deps.adapters.secretStore.put({ organizationId, purpose: "github-app.client-secret" }, input.clientSecret);
  if (!put.ok) {
    throw new Error(`the secret store did not keep the GitHub App's client secret: ${put.error.code}`);
  }
  try {
    await tx.connection.update({ where: { id: own.id }, data: { clientSecretSecretRef: put.value } });
    const connectionId = connectionIdSchema.parse(own.id);
    const previous = secretRefSchema.safeParse(own.clientSecretSecretRef);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "github.client-secret-set",
      entity: "connection",
      entityId: connectionId,
      data: { replaced: own.clientSecretSecretRef !== null },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: connectionId });
    return { ok: true, connectionId, replaced: previous.success ? previous.data : null };
  } catch (error) {
    await deps.adapters.secretStore.delete(organizationId, put.value);
    throw error;
  }
};

// ---- F-006/c4: the webhook of an App made without one, finished later ----

export const setGitHubWebhookSecretInputSchema = z.strictObject({
  connectionId: connectionIdSchema,
  /** The secret ostra generated, for the App's webhook settings on GitHub. Never logged; stored through the secret store. */
  webhookSecret: z.string().min(1).max(512),
});
export type SetGitHubWebhookSecretInput = z.infer<typeof setGitHubWebhookSecretInputSchema>;

export type SetGitHubWebhookSecretResult = UseCaseResult<
  {
    readonly connectionId: ConnectionId;
    /** The secret it replaced, for the caller to delete once the transaction commits; `null` for a first one. */
    readonly replaced: SecretRef | null;
  },
  "forbidden" | "not-found"
>;

const refuseWebhook = (
  error: Exclude<SetGitHubWebhookSecretResult, { readonly ok: true }>["error"],
  message: string,
): SetGitHubWebhookSecretResult => ({ ok: false, error, message });

/**
 * Keeps a webhook secret for one of the organization's GitHub Apps, replacing one it had. An App made
 * while the server had no public address has none, and takes no webhooks until it has (F-006/c4).
 * The new secret is in the secret store before the row points at it, and is deleted again if the
 * row's write fails; the old one is the caller's to delete after the commit.
 */
export const setGitHubWebhookSecret = async (deps: SetGitHubClientSecretDeps, input: SetGitHubWebhookSecretInput): Promise<SetGitHubWebhookSecretResult> => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuseWebhook("forbidden", "Only an organization admin sets a GitHub App's webhook");
  }
  const connection = await tx.connection.findFirst({
    where: { id: input.connectionId, organizationId, kind: "github" },
    select: { id: true, webhookSecretSecretRef: true },
  });
  if (connection === null) {
    return refuseWebhook("not-found", "No such GitHub App in this organization");
  }
  const put = await deps.adapters.secretStore.put({ organizationId, purpose: "github-app.webhook-secret" }, input.webhookSecret);
  if (!put.ok) {
    throw new Error(`the secret store did not keep the GitHub App's webhook secret: ${put.error.code}`);
  }
  try {
    await tx.connection.update({ where: { id: connection.id }, data: { webhookSecretSecretRef: put.value } });
    const connectionId = connectionIdSchema.parse(connection.id);
    const previous = secretRefSchema.safeParse(connection.webhookSecretSecretRef);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "github.webhook-secret-set",
      entity: "connection",
      entityId: connectionId,
      data: { replaced: connection.webhookSecretSecretRef !== null },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: connectionId });
    return { ok: true, connectionId, replaced: previous.success ? previous.data : null };
  } catch (error) {
    await deps.adapters.secretStore.delete(organizationId, put.value);
    throw error;
  }
};
