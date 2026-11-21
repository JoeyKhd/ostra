import { createHash, randomBytes } from "node:crypto";

import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretRef, TrackerAdapter, TrackerCapabilities } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { connectionIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";
import { z } from "zod";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { linearAppIdPlaceholders } from "../tickets/contracts.ts";
import type { UseCaseResult } from "./common.ts";

// F-005: an organization connects its own Linear app (spec section 3, step 1; section 11, items 2
// and 3). Three steps, each a use case:
// 1. `startLinearConnection`: an admin presses "Connect Linear". A `pending` connection row is
//    made first, so the manifest link can name its webhook URL, and the link is returned.
// 2. `connectLinear`: the admin pastes the app's client ID, client secret and webhook signing
//    secret. They go to the secret store, and an `OAuthState` (state and PKCE verifier) is made,
//    bound to the admin's panel session; the answer is Linear's authorize URL (`actor=app`).
// 3. `authorizeLinear`: Linear's callback. The code is exchanged, the token checked to be the
//    app's own user, the tokens stored, and the connection goes `active`, in webhooks or polling.
// `disconnectLinear` revokes the token and ends the connection. Bodies: ticket 27 (these) and
// ticket 08 (the pure calls to Linear that `LinearAppKit` holds).
// Tokens and secrets go to the secret store and nowhere else: never a log line, never a column.

// ---------- Linear's side, as the use cases call it ----------

/** What Linear's token endpoint gave. Never logged. */
export type LinearTokens = {
  readonly accessToken: string;
  /** `null` when the grant gave none (it always does for the authorization code grant). */
  readonly refreshToken: string | null;
  /** When the access token expires, in ms since the epoch. */
  readonly expiresAt: number;
  /**
   * Milestone 6 (F-012): the scopes the token answer granted, when it says. Linear has no field that
   * reads a token's scopes back, so this is how ostra knows agent mode's were granted.
   */
  readonly scopes?: readonly string[];
};

/** Who a token belongs to, checked through `viewer`. */
export type LinearAppIdentity = {
  readonly appUserId: string;
  readonly appUserName: string;
  readonly workspaceId: string;
  readonly workspaceKey: string;
  readonly workspaceName: string;
};

export type LinearKitError = {
  /**
   * `refused`: Linear said no (a bad code, a bad client). `unavailable`: it did not answer.
   * `not-app-user`: the token works but belongs to a person, since Linear ignored `actor=app`.
   */
  readonly code: "refused" | "unavailable" | "not-app-user";
  /** For a person, never a token or Linear's body. */
  readonly message: string;
};

export type LinearKitResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: LinearKitError };

/**
 * Why Linear can't deliver webhooks to an address (adapter-linear's address pre-check): a code the
 * panel words (F-083), never a sentence.
 */
export const linearAddressProblems = ["invalid-url", "not-https", "loopback", "private-network", "single-label-host", "local-suffix", "linear-host"] as const;
export type LinearAddressProblem = (typeof linearAddressProblems)[number];

export type PublicUrlCheck = { readonly public: true } | { readonly public: false; readonly problem: LinearAddressProblem };

/**
 * The calls to Linear the connection flow makes, as pure functions and small requests (ticket 08
 * writes them in `adapter-linear`). Injected, so the use cases never touch Linear's addresses and a
 * test runs them against the fake Linear server.
 */
export type LinearAppKit = {
  /** What ostra asks for at authorize time: `read`, `write`, `issues:create`, `comments:create`. */
  readonly scopes: readonly string[];
  /** The webhook resource types the manifest subscribes to. */
  readonly webhookEvents: readonly string[];
  /** Whether Linear could reach this address: https, not loopback, not private, not a local name. */
  readonly checkPublicUrl: (url: string) => PublicUrlCheck;
  /** The "create an app from this manifest" link, pre-filled. `webhookUrl` is `null` in polling mode. */
  readonly manifestUrl: (input: { readonly name: string; readonly callbackUrl: string; readonly webhookUrl: string | null }) => string;
  /** Linear's authorize URL, with `actor=app` and S256 PKCE. */
  readonly authorizeUrl: (input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
    readonly state: string;
    readonly codeChallenge: string;
    /**
     * Milestone 6 ("Turn on agent mode"): re-authorizes the existing install with the whole set
     * (`update_scopes_on_existing_token=true`), so its token gains the new scopes.
     */
    readonly updateExistingToken?: boolean;
  }) => string;
  readonly exchangeCode: (input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly codeVerifier: string;
  }) => Promise<LinearKitResult<LinearTokens>>;
  /** Asks `viewer` who the token is, and refuses a token that is not the app's own user. */
  readonly checkAppToken: (accessToken: string) => Promise<LinearKitResult<LinearAppIdentity>>;
  /** Revokes an access or refresh token at Linear. */
  readonly revokeToken: (token: string) => Promise<LinearKitResult<null>>;
  /** What Linear's adapter declares about agent mode (its `agentSessions` and `agentScopes`). */
  readonly capabilities: AgentModeCapabilities;
};

// ---------- the addresses ----------

/** The tracker's declarations agent mode reads (F-012, ADR 0013, ADR 0025): whether it has agent sessions, and the scopes they need. */
export type AgentModeCapabilities = Pick<TrackerCapabilities, "agentSessions" | "agentScopes">;

/**
 * The agent-mode scopes a granted set lacks, by the tracker's own `agentScopes`, or `null` when the
 * tracker declares no agent sessions, so agent mode can't be turned on whatever was granted.
 */
export const missingAgentModeScopes = (capabilities: AgentModeCapabilities, granted: readonly string[]): readonly string[] | null =>
  capabilities.agentSessions ? capabilities.agentScopes.filter((wanted) => !granted.includes(wanted)) : null;

/** The `state` prefix of a consent for agent mode: the callback knows it by the state it stored. */
export const AGENT_MODE_STATE_PREFIX = "agent-mode.";

/** Where Linear delivers this connection's webhooks (spec section 11, item 2). */
export const linearWebhookUrl = (corePublicUrl: string, connectionId: ConnectionId): string =>
  `${corePublicUrl.replace(/\/+$/, "")}/webhooks/linear/${connectionId}`;

/** Where Linear sends the admin back after consent: the panel's route. */
export const linearCallbackUrl = (publicUrl: string): string => `${publicUrl.replace(/\/+$/, "")}/api/linear/callback`;

/** The app's name on Linear: ostra and the panel's host, which the kit shortens when it holds "linear". */
export const linearAppName = (publicUrl: string): string => {
  const host = URL.canParse(publicUrl) ? new URL(publicUrl).host : "";
  return host === "" ? "ostra" : `ostra (${host})`;
};

/** How long the OAuth `state` lives: the admin is on Linear's consent page for a minute or two. */
export const LINEAR_OAUTH_STATE_TTL_MS = 10 * 60_000;

/** The access token is refreshed this long before it expires. */
export const LINEAR_REFRESH_MARGIN_MS = 60 * 60_000;

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

// ---------- the deps ----------

export type LinearConnectionDeps = Pick<Ports, "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
  /** Core's public address, or `null` when it fails the pre-check: the connection polls. */
  readonly corePublicUrl: string | null;
  /** Why `corePublicUrl` failed the pre-check, as its code; `null` when it passed. */
  readonly corePublicUrlProblem?: LinearAddressProblem | null;
  /** The panel's address, for the OAuth callback. */
  readonly publicUrl: string;
  readonly linear: LinearAppKit;
};

const adminOnly = <E extends string>(scope: MemberScope, error: E): { readonly ok: false; readonly error: E; readonly message: string } | null =>
  requireOrganizationAdmin(scope, scope.organizationId).ok ? null : { ok: false, error, message: "Only an organization admin connects Linear" };

// ---------- 1. start ----------

export type StartLinearConnectionResult = UseCaseResult<
  {
    readonly connectionId: ConnectionId;
    /** Linear's "create an app from this manifest" link, pre-filled. */
    readonly manifestUrl: string;
    readonly callbackUrl: string;
    /** `null` in polling mode. */
    readonly webhookUrl: string | null;
    readonly mode: "webhooks" | "polling";
    /** Why polling, as the pre-check's code, when it is and the pre-check said; otherwise `null`. */
    readonly modeReason: LinearAddressProblem | null;
  },
  "forbidden" | "already-connected"
>;

export type StartLinearConnection = (deps: LinearConnectionDeps) => Promise<StartLinearConnectionResult>;

/**
 * Makes the `pending` connection row (or finds the one this organization started and left), and
 * the manifest link for it. One Linear connection per organization: a second start while one is
 * active or failed is refused, and a pending one is picked up where it was left.
 */
export const startLinearConnection: StartLinearConnection = async (deps) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const denied = adminOnly(scope, "forbidden" as const);
  if (denied !== null) return denied;

  const mode = deps.corePublicUrl === null ? ("polling" as const) : ("webhooks" as const);
  const modeReason = mode === "polling" ? (deps.corePublicUrlProblem ?? null) : null;
  const existing = await tx.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } } });
  if (existing !== null && existing.state !== "pending") {
    return { ok: false, error: "already-connected", message: "This organization is already connected to Linear. Disconnect it first to connect another workspace" };
  }
  const row =
    existing !== null
      ? await tx.connection.update({ where: { id: existing.id }, data: { webhookMode: mode } })
      : await tx.connection.create({
          data: {
            organizationId,
            kind: "linear",
            appId: linearAppIdPlaceholders.pending,
            state: "pending",
            webhookMode: mode,
            credentialKind: "app_oauth",
            createdByMemberId: scope.memberId,
          },
        });
  const connectionId = connectionIdSchema.parse(row.id);
  const callbackUrl = linearCallbackUrl(deps.publicUrl);
  const webhookUrl = deps.corePublicUrl === null ? null : linearWebhookUrl(deps.corePublicUrl, connectionId);
  const manifestUrl = deps.linear.manifestUrl({ name: linearAppName(deps.publicUrl), callbackUrl, webhookUrl });

  if (existing === null) {
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "linear.started",
      entity: "connection",
      entityId: connectionId,
      data: { mode },
    });
  }
  await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: connectionId });
  return { ok: true, connectionId, manifestUrl, callbackUrl, webhookUrl, mode, modeReason };
};

// ---------- 2. the three values ----------

export const connectLinearInputSchema = z.strictObject({
  connectionId: connectionIdSchema,
  /** Linear's OAuth client ID: not a secret, kept as the connection's `appId`. */
  clientId: z.string().trim().min(8).max(256),
  /** Never logged; to the secret store. */
  clientSecret: z.string().trim().min(8).max(512),
  /** The webhook signing secret; absent in polling mode. Never logged; to the secret store. */
  webhookSecret: z.string().trim().min(8).max(512).optional(),
});
export type ConnectLinearInput = z.infer<typeof connectLinearInputSchema>;

export type ConnectLinearResult = UseCaseResult<
  { readonly authorizeUrl: string },
  "not-found" | "forbidden" | "not-pending" | "webhook-secret-required"
>;

export type ConnectLinearDeps = LinearConnectionDeps & {
  /** The better-auth session the OAuth state is bound to. */
  readonly authSessionId: string;
  readonly adapters: Pick<Ports["adapters"], "secretStore">;
};

export type ConnectLinear = (deps: ConnectLinearDeps, input: ConnectLinearInput) => Promise<ConnectLinearResult>;

/** Reads a secret reference column; `null` when there is none. */
const refOf = (value: string | null): SecretRef | null => {
  const parsed = secretRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Deletes secrets that are gone from the connection row. A value already gone is not an error. */
const dropSecrets = async (deps: Pick<ConnectLinearDeps, "adapters">, organizationId: OrganizationId, refs: readonly (string | null)[]): Promise<void> => {
  for (const value of refs) {
    const ref = refOf(value);
    if (ref !== null) {
      await deps.adapters.secretStore.delete(organizationId, ref);
    }
  }
};

/**
 * Keeps the app's three values: the client ID on the row, the client secret and the webhook secret
 * in the secret store (replacing earlier ones). Nothing here is returned or logged.
 */
export const saveLinearApp = async (deps: ConnectLinearDeps, input: ConnectLinearInput): Promise<UseCaseResult<{ readonly connectionId: ConnectionId }, "not-found" | "forbidden" | "not-pending" | "webhook-secret-required">> => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const denied = adminOnly(scope, "forbidden" as const);
  if (denied !== null) return denied;
  const connection = await tx.connection.findFirst({ where: { id: input.connectionId, organizationId, kind: "linear" } });
  if (connection === null) {
    return { ok: false, error: "not-found", message: "No such Linear connection" };
  }
  if (connection.state !== "pending") {
    return { ok: false, error: "not-pending", message: "This connection is already set up. Disconnect it to start again" };
  }
  if (connection.webhookMode === "webhooks" && input.webhookSecret === undefined) {
    return { ok: false, error: "webhook-secret-required", message: "Paste the app's webhook signing secret: this connection receives webhooks" };
  }

  const clientSecret = await deps.adapters.secretStore.put({ organizationId, purpose: "linear-client-secret" }, input.clientSecret);
  if (!clientSecret.ok) {
    throw new Error(`the secret store refused the Linear client secret: ${clientSecret.error.code}`);
  }
  let webhookRef: SecretRef | null = null;
  if (input.webhookSecret !== undefined && connection.webhookMode === "webhooks") {
    const stored = await deps.adapters.secretStore.put({ organizationId, purpose: "linear-webhook-secret" }, input.webhookSecret);
    if (!stored.ok) {
      throw new Error(`the secret store refused the Linear webhook secret: ${stored.error.code}`);
    }
    webhookRef = stored.value;
  }
  await dropSecrets(deps, organizationId, [connection.clientSecretSecretRef, connection.webhookSecretSecretRef]);
  await tx.connection.update({
    where: { id: connection.id },
    data: { appId: input.clientId, clientSecretSecretRef: clientSecret.value, webhookSecretSecretRef: webhookRef },
  });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: null,
    actor: { kind: "member", id: scope.memberId },
    action: "linear.app-saved",
    entity: "connection",
    entityId: input.connectionId,
    data: { mode: connection.webhookMode },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: input.connectionId });
  return { ok: true, connectionId: input.connectionId };
};

export const authorizeUrlInputSchema = z.strictObject({ connectionId: connectionIdSchema });
export type AuthorizeUrlInput = z.infer<typeof authorizeUrlInputSchema>;

/**
 * Makes an `OAuthState` bound to the admin's panel session (the state, hashed; the PKCE verifier in
 * the secret store; 10 minutes) and answers Linear's authorize URL. For a pending connection whose
 * values are saved, and to authorize a failed one again.
 */
export const createLinearAuthorizeUrl = async (
  deps: ConnectLinearDeps,
  input: AuthorizeUrlInput,
  /** Milestone 6 (F-012): "Turn on agent mode" asks for agent mode's scopes too, on the existing install. */
  options: { readonly agentMode?: boolean } = {},
): Promise<UseCaseResult<{ readonly authorizeUrl: string }, "not-found" | "forbidden" | "not-ready">> => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const denied = adminOnly(scope, "forbidden" as const);
  if (denied !== null) return denied;
  if (options.agentMode === true && !deps.linear.capabilities.agentSessions) {
    return { ok: false, error: "not-ready", message: "This tracker has no agent sessions" };
  }
  const connection = await tx.connection.findFirst({ where: { id: input.connectionId, organizationId, kind: "linear" } });
  if (connection === null || connection.state === "revoked") {
    return { ok: false, error: "not-found", message: "No such Linear connection" };
  }
  if (connection.clientSecretSecretRef === null || connection.appId === linearAppIdPlaceholders.pending || connection.appId === linearAppIdPlaceholders.apiKey) {
    return { ok: false, error: "not-ready", message: "Save the app's client ID and secret first" };
  }

  // The state's prefix says what the consent was for; the callback trusts it only by the stored hash.
  const state = `${options.agentMode === true ? AGENT_MODE_STATE_PREFIX : ""}${randomBytes(32).toString("base64url")}`;
  const verifier = randomBytes(48).toString("base64url");
  const stored = await deps.adapters.secretStore.put({ organizationId, purpose: "linear-pkce-verifier" }, verifier);
  if (!stored.ok) {
    throw new Error(`the secret store refused the PKCE verifier: ${stored.error.code}`);
  }
  await tx.oAuthState.create({
    data: {
      organizationId,
      connectionId: connection.id,
      stateHash: sha256Hex(state),
      codeVerifierSecretRef: stored.value,
      memberId: scope.memberId,
      authSessionId: deps.authSessionId,
      expiresAt: new Date(deps.clock.now() + LINEAR_OAUTH_STATE_TTL_MS),
    },
  });
  const authorizeUrl = deps.linear.authorizeUrl({
    clientId: connection.appId,
    redirectUri: linearCallbackUrl(deps.publicUrl),
    scopes: options.agentMode === true ? [...new Set([...deps.linear.scopes, ...deps.linear.capabilities.agentScopes])] : deps.linear.scopes,
    state,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    ...(options.agentMode === true ? { updateExistingToken: true } : {}),
  });
  return { ok: true, authorizeUrl };
};

/** Saves the app's values, then makes the authorize URL: the contract of the second step. */
export const connectLinear: ConnectLinear = async (deps, input) => {
  const saved = await saveLinearApp(deps, input);
  if (!saved.ok) return saved;
  const made = await createLinearAuthorizeUrl(deps, { connectionId: input.connectionId });
  if (!made.ok) {
    // Saved a moment ago, so this can only be a row that changed under us.
    return { ok: false, error: "not-found", message: made.message };
  }
  return { ok: true, authorizeUrl: made.authorizeUrl };
};

// ---------- 3. the callback ----------

export const authorizeLinearInputSchema = z.strictObject({
  /** Linear's `code`, exchanged once. Never logged. */
  code: z.string().min(1).max(2048),
  /** The `state` from the authorize URL; found by its hash. */
  state: z.string().min(16).max(512),
});
export type AuthorizeLinearInput = z.infer<typeof authorizeLinearInputSchema>;

export type AuthorizeLinearResult = UseCaseResult<
  {
    readonly connectionId: ConnectionId;
    readonly workspaceName: string;
    readonly appUserName: string;
    readonly mode: "webhooks" | "polling";
  },
  /** The state is unknown, expired, used, or from another panel session. */
  | "bad-state"
  /** Linear refused the code or the client. */
  | "exchange-failed"
  /** The token isn't the app's own user: Linear ignored `actor=app`. */
  | "not-app-user"
  | "forbidden"
  /** Milestone 6 (F-012): "Turn on agent mode" came back without agent mode's scopes. */
  | "missing-scopes"
>;

export type AuthorizeLinearDeps = Pick<Ports, "notices" | "audit" | "clock" | "jobs"> & {
  readonly db: Db;
  readonly scope: MemberScope;
  readonly authSessionId: string;
  /** The panel's address: the redirect URI the code is exchanged against. */
  readonly publicUrl: string;
  readonly linear: LinearAppKit;
  readonly adapters: Pick<Ports["adapters"], "secretStore">;
};

export type AuthorizeLinear = (deps: AuthorizeLinearDeps, input: AuthorizeLinearInput) => Promise<AuthorizeLinearResult>;

const refuseAuthorize = (error: Exclude<AuthorizeLinearResult, { readonly ok: true }>["error"], message: string): AuthorizeLinearResult => ({ ok: false, error, message });

const BAD_STATE = "This sign-in with Linear is not valid any more: start again";

export const authorizeLinear: AuthorizeLinear = async (deps, input) => {
  const { db, scope } = deps;
  const organizationId = scope.organizationId;
  const denied = adminOnly(scope, "forbidden" as const);
  if (denied !== null) return denied;

  // The state: known, unexpired, unused, and made by this admin on this panel session. It is used
  // up first, so a callback replayed (or raced) goes no further, whatever Linear answers.
  const stored = await db.oAuthState.findFirst({ where: { stateHash: sha256Hex(input.state), organizationId } });
  if (stored?.usedAt !== null || stored.expiresAt.getTime() <= deps.clock.now()) {
    return refuseAuthorize("bad-state", BAD_STATE);
  }
  if (stored.memberId !== scope.memberId || stored.authSessionId !== deps.authSessionId) {
    return refuseAuthorize("bad-state", "This sign-in with Linear was started in another session: start again");
  }
  const used = await db.oAuthState.updateMany({ where: { id: stored.id, usedAt: null }, data: { usedAt: new Date(deps.clock.now()) } });
  if (used.count !== 1) {
    return refuseAuthorize("bad-state", BAD_STATE);
  }

  const connection = await db.connection.findFirst({ where: { id: stored.connectionId, organizationId, kind: "linear" } });
  const clientSecretRef = refOf(connection?.clientSecretSecretRef ?? null);
  const verifierRef = refOf(stored.codeVerifierSecretRef);
  if (connection === null || connection.state === "revoked" || clientSecretRef === null || verifierRef === null) {
    return refuseAuthorize("bad-state", BAD_STATE);
  }
  const [clientSecret, verifier] = await Promise.all([
    deps.adapters.secretStore.get(organizationId, clientSecretRef),
    deps.adapters.secretStore.get(organizationId, verifierRef),
  ]);
  await deps.adapters.secretStore.delete(organizationId, verifierRef);
  if (!clientSecret.ok || !verifier.ok) {
    return refuseAuthorize("exchange-failed", "The app's saved values could not be read: save them again");
  }

  const exchanged = await deps.linear.exchangeCode({
    clientId: connection.appId,
    clientSecret: clientSecret.value,
    redirectUri: linearCallbackUrl(deps.publicUrl),
    code: input.code,
    codeVerifier: verifier.value,
  });
  if (!exchanged.ok) {
    return refuseAuthorize("exchange-failed", `Linear did not accept the sign-in: ${exchanged.error.message}`);
  }
  const identity = await deps.linear.checkAppToken(exchanged.value.accessToken);
  if (!identity.ok) {
    // A token that isn't the app's own user is thrown away at Linear too, so nothing of it lingers.
    await deps.linear.revokeToken(exchanged.value.accessToken);
    return identity.error.code === "not-app-user"
      ? refuseAuthorize("not-app-user", "Linear gave a token for a person, not for the app's own user. Authorize again as the app")
      : refuseAuthorize("exchange-failed", `Linear did not confirm the token: ${identity.error.message}`);
  }

  // Milestone 6 (F-012): a consent for agent mode must grant its scopes; without them the new token
  // isn't kept, and the connection stays as it was.
  const agentMode = input.state.startsWith(AGENT_MODE_STATE_PREFIX);
  const granted = exchanged.value.scopes ?? null;
  const missing = granted === null ? null : missingAgentModeScopes(deps.linear.capabilities, granted);
  if (agentMode && (missing === null || missing.length > 0)) {
    return refuseAuthorize("missing-scopes", "Linear didn't grant the scopes agent mode needs. Authorize again and accept them");
  }
  const access = await deps.adapters.secretStore.put({ organizationId, purpose: "linear-access-token" }, exchanged.value.accessToken);
  if (!access.ok) {
    throw new Error(`the secret store refused the Linear access token: ${access.error.code}`);
  }
  let refreshRef: SecretRef | null = null;
  if (exchanged.value.refreshToken !== null) {
    const refresh = await deps.adapters.secretStore.put({ organizationId, purpose: "linear-refresh-token" }, exchanged.value.refreshToken);
    if (!refresh.ok) {
      throw new Error(`the secret store refused the Linear refresh token: ${refresh.error.code}`);
    }
    refreshRef = refresh.value;
  }
  const now = deps.clock.now();
  const expiresAt = exchanged.value.expiresAt;
  const connectionId = connectionIdSchema.parse(connection.id);

  await db.$transaction(async (tx) => {
    await tx.connection.update({
      where: { id: connection.id },
      data: {
        state: "active",
        failedReason: null,
        credentialKind: "app_oauth",
        accessTokenSecretRef: access.value,
        refreshTokenSecretRef: refreshRef,
        accessTokenExpiresAt: new Date(expiresAt),
        externalWorkspaceId: identity.value.workspaceId,
        externalWorkspaceKey: identity.value.workspaceKey,
        externalWorkspaceName: identity.value.workspaceName,
        appUserId: identity.value.appUserId,
        appUserName: identity.value.appUserName,
        activatedAt: new Date(now),
        ...(granted === null ? {} : { scopes: [...granted] }),
        ...(agentMode ? { agentModeAt: new Date(now) } : {}),
      },
    });
    if (agentMode) {
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: null,
        actor: { kind: "member", id: scope.memberId },
        action: "linear.agent-mode-enabled",
        entity: "connection",
        entityId: connectionIdSchema.parse(connection.id),
      });
    }
    // The token is refreshed before it expires: one delayed job per connection (ADR 0037).
    await deps.jobs.enqueueInTx(
      tx,
      "linear.refresh-token",
      { organizationId: organizationIdSchema.parse(organizationId), connectionId },
      { startAfterMs: Math.max(60_000, expiresAt - now - LINEAR_REFRESH_MARGIN_MS) },
    );
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "linear.connected",
      entity: "connection",
      entityId: connectionId,
      data: { workspace: identity.value.workspaceKey, mode: connection.webhookMode },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: connectionId });
  });
  // The previous token's secrets (a re-authorized connection) are dropped once the new ones stand.
  await dropSecrets(deps, organizationId, [connection.accessTokenSecretRef, connection.refreshTokenSecretRef]);
  return { ok: true, connectionId, workspaceName: identity.value.workspaceName, appUserName: identity.value.appUserName, mode: connection.webhookMode };
};

// ---------- disconnect ----------

export const disconnectLinearInputSchema = z.strictObject({ connectionId: connectionIdSchema });
export type DisconnectLinearInput = z.infer<typeof disconnectLinearInputSchema>;

export type DisconnectLinearResult = UseCaseResult<{ readonly connectionId: ConnectionId; readonly revokedAtLinear: boolean }, "not-found" | "forbidden">;

export type DisconnectLinearDeps = Pick<Ports, "notices" | "audit" | "clock"> & {
  readonly db: Db;
  readonly scope: MemberScope;
  readonly linear: LinearAppKit;
  readonly adapters: Pick<Ports["adapters"], "secretStore">;
};

/**
 * Revokes the token at Linear (best effort: a Linear that does not answer does not keep the admin
 * connected), deletes every secret of the connection, and sets it `revoked`. Its boards and
 * tickets stay, read-only; core stops polling boards whose connection is not active.
 */
export const disconnectLinear = async (deps: DisconnectLinearDeps, input: DisconnectLinearInput): Promise<DisconnectLinearResult> => {
  const { db, scope } = deps;
  const organizationId = scope.organizationId;
  const denied = adminOnly(scope, "forbidden" as const);
  if (denied !== null) return denied;
  const connection = await db.connection.findFirst({ where: { id: input.connectionId, organizationId, kind: "linear", state: { not: "revoked" } } });
  if (connection === null) {
    return { ok: false, error: "not-found", message: "No such Linear connection" };
  }

  let revoked = false;
  const accessRef = refOf(connection.accessTokenSecretRef);
  if (accessRef !== null && connection.credentialKind !== "api_key") {
    const token = await deps.adapters.secretStore.get(organizationId, accessRef);
    if (token.ok) {
      revoked = (await deps.linear.revokeToken(token.value)).ok;
      const refreshRef = refOf(connection.refreshTokenSecretRef);
      const refresh = refreshRef === null ? null : await deps.adapters.secretStore.get(organizationId, refreshRef);
      if (refresh?.ok === true) {
        await deps.linear.revokeToken(refresh.value);
      }
    }
  }
  await dropSecrets(deps, organizationId, [
    connection.accessTokenSecretRef,
    connection.refreshTokenSecretRef,
    connection.clientSecretSecretRef,
    connection.webhookSecretSecretRef,
  ]);
  const pending = await db.oAuthState.findMany({ where: { connectionId: connection.id, usedAt: null }, select: { codeVerifierSecretRef: true } });
  await dropSecrets(deps, organizationId, pending.map((state) => state.codeVerifierSecretRef));

  const connectionId = connectionIdSchema.parse(connection.id);
  await db.$transaction(async (tx) => {
    await tx.oAuthState.deleteMany({ where: { connectionId: connection.id } });
    await tx.connection.update({
      where: { id: connection.id },
      data: {
        state: "revoked",
        // The (organization, kind, app) triple is unique; a revoked row gives its app ID back, so a new
        // connection can start with the placeholder again, or with the same app.
        appId: `revoked:${connectionId}`,
        accessTokenSecretRef: null,
        refreshTokenSecretRef: null,
        clientSecretSecretRef: null,
        webhookSecretSecretRef: null,
        accessTokenExpiresAt: null,
      },
    });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "linear.disconnected",
      entity: "connection",
      entityId: connectionId,
      data: { revokedAtLinear: revoked },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: connectionId });
  });
  return { ok: true, connectionId, revokedAtLinear: revoked };
};

// ---------- "Skip for now" (ticket 27) ----------

export const skipSetupStepInputSchema = z.strictObject({ step: z.enum(["linear"]) });
export type SkipSetupStepInput = z.infer<typeof skipSetupStepInputSchema>;

export type SkipSetupStepResult = UseCaseResult<{ readonly skippedAt: number }, "forbidden">;

export type SkipSetupStep = (
  deps: Pick<Ports, "audit" | "clock" | "notices"> & { readonly tx: Tx; readonly scope: MemberScope },
  input: SkipSetupStepInput,
) => Promise<SkipSetupStepResult>;

/** Home's checklist: the admin sets the Linear step aside. An active connection still makes it done. */
export const skipSetupStep: SkipSetupStep = async (deps) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const denied = adminOnly(scope, "forbidden" as const);
  if (denied !== null) return denied;
  const skippedAt = deps.clock.now();
  await tx.organizationSetting.upsert({
    where: { organizationId },
    create: { organizationId, linearSkippedAt: new Date(skippedAt), linearSkippedByMemberId: scope.memberId },
    update: { linearSkippedAt: new Date(skippedAt), linearSkippedByMemberId: scope.memberId },
  });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: null,
    actor: { kind: "member", id: scope.memberId },
    action: "setup.step-skipped",
    entity: "organization",
    entityId: organizationId,
    data: { step: "linear" },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
  return { ok: true, skippedAt };
};

// ---------- the connection's tracker ----------

/** What core needs to act for a connection: its tracker adapter, built with its token. */
export type ConnectionTracker = {
  readonly connectionId: ConnectionId;
  readonly tracker: TrackerAdapter;
  /** The connection's own user, for the echo check; `null` with an API key. */
  readonly ownUserId: string | null;
};
