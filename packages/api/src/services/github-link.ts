import { createHash, randomBytes } from "node:crypto";

import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostOAuthClient } from "@ostra/adapter-sdk";
import { linkGitHubUser } from "@ostra/domain";
import type { OrganizationId } from "@ostra/protocol";

import type { Context } from "../trpc/context.ts";

// The verified GitHub link (F-119, ADR 0040, ADR 0052; ticket 39). A member signs in to GitHub with
// the App's own OAuth, and ostra keeps their GitHub user ID and login and no token: the adapter
// revokes the token before `exchangeUserCode` returns, and a revocation that fails links nothing.
// The `state` binds the round trip to the member's panel session for ten minutes and to one use
// (`OAuthState`, as the Linear connection's). A code, a state and a token are in no log line.

const STATE_TTL_MS = 10 * 60_000;

/** Where the callback sends the member back, as `?github=<outcome>` on their Account page. */
export type GitHubLinkOutcome = "linked" | "taken" | "revoke-failed" | "failed";

export type GitHubLinkStart =
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "sign-in" }
  /** GitHub is not connected to the install, or its App was made without an OAuth client. */
  | { readonly kind: "not-connected" }
  | { readonly kind: "unavailable" };

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const githubLinkCallbackUrl = (publicUrl: string): string => `${publicUrl.replace(/\/+$/, "")}/api/github/link/callback`;

/** The organization's GitHub App as an OAuth client, or why it is none. */
const oauthClientOf = async (ctx: Context, organizationId: OrganizationId) => {
  const { db, ports } = ctx.deps;
  const connection = await db.connection.findFirst({
    where: { organizationId, kind: "github", state: "active" },
    select: { id: true, appId: true, privateKeySecretRef: true, clientSecretSecretRef: true },
  });
  if (connection === null) {
    return { kind: "not-connected" } as const;
  }
  const keyRef = secretRefSchema.safeParse(connection.privateKeySecretRef);
  const secretRef = secretRefSchema.safeParse(connection.clientSecretSecretRef);
  if (!keyRef.success || !secretRef.success || !ports.adapters.codeHost.capabilities.userLink) {
    return { kind: "not-connected" } as const;
  }
  const [key, secret] = await Promise.all([ports.adapters.secretStore.get(organizationId, keyRef.data), ports.adapters.secretStore.get(organizationId, secretRef.data)]);
  if (!key.ok || !secret.ok) {
    return { kind: "unavailable" } as const;
  }
  const app = await ports.adapters.codeHost.readApp({ appId: connection.appId, privateKey: key.value });
  if (!app.ok || app.value.clientId === undefined) {
    return { kind: "unavailable" } as const;
  }
  const client: CodeHostOAuthClient = { clientId: app.value.clientId, clientSecret: secret.value };
  return { kind: "ready", connectionId: connection.id, client } as const;
};

/** Whether GitHub can be linked on this install (a connection with an OAuth client), for the Account page. */
export const githubLinkAvailable = async (ctx: Context, organizationId: OrganizationId): Promise<boolean> => {
  const connection = await ctx.deps.db.connection.findFirst({
    where: { organizationId, kind: "github", state: "active", clientSecretSecretRef: { not: null } },
    select: { id: true },
  });
  return connection !== null && ctx.deps.ports.adapters.codeHost.capabilities.userLink;
};

/** `/api/github/link/start`: a `state` bound to the member's session, and GitHub's sign-in URL. */
export const startGitHubLink = async (ctx: Context): Promise<GitHubLinkStart> => {
  if (ctx.user === null || ctx.member === null) {
    return { kind: "sign-in" };
  }
  const { db, ports, settings } = ctx.deps;
  const organizationId = ctx.member.scope.organizationId;
  const found = await oauthClientOf(ctx, organizationId);
  if (found.kind !== "ready") {
    return { kind: found.kind };
  }
  const state = randomBytes(32).toString("base64url");
  const url = ports.adapters.codeHost.userAuthorizeUrl(found.client, state, githubLinkCallbackUrl(settings.publicUrl));
  if (!url.ok) {
    return { kind: "unavailable" };
  }
  await db.oAuthState.create({
    data: {
      organizationId,
      connectionId: found.connectionId,
      stateHash: sha256(state),
      // The App's sign-in has no PKCE verifier to keep.
      codeVerifierSecretRef: "",
      memberId: ctx.member.scope.memberId,
      authSessionId: ctx.user.sessionId,
      expiresAt: new Date(ports.clock.now() + STATE_TTL_MS),
    },
  });
  return { kind: "redirect", url: url.value };
};

export type GitHubLinkResult = { readonly outcome: GitHubLinkOutcome; readonly login: string | null };

/**
 * `/api/github/link/callback`: checks the `state` is this member's own, from this session, unexpired
 * and unused; trades the code (the adapter revokes the token); and stores the verified ID and login.
 * A denied consent (`error` instead of a `code`) uses the state up and links nothing.
 */
export const completeGitHubLink = async (ctx: Context, input: { readonly code: string | null; readonly state: string | null }): Promise<GitHubLinkResult> => {
  const failed: GitHubLinkResult = { outcome: "failed", login: null };
  if (ctx.user === null || ctx.member === null) {
    return failed;
  }
  if (input.state === null) {
    return failed;
  }
  const { db, ports, settings, logger } = ctx.deps;
  const scope = ctx.member.scope;
  const stored = await db.oAuthState.findFirst({ where: { stateHash: sha256(input.state), organizationId: scope.organizationId, memberId: scope.memberId } });
  if (stored === null) {
    return failed;
  }
  if (stored.authSessionId !== ctx.user.sessionId || stored.usedAt !== null || stored.expiresAt.getTime() <= ports.clock.now()) {
    return failed;
  }
  // One use: a second callback with the same state finds it used.
  const used = await db.oAuthState.updateMany({ where: { id: stored.id, usedAt: null }, data: { usedAt: new Date(ports.clock.now()) } });
  if (used.count !== 1 || input.code === null) {
    return failed;
  }
  const found = await oauthClientOf(ctx, scope.organizationId);
  if (found.kind !== "ready") {
    return failed;
  }
  const exchanged = await ports.adapters.codeHost.exchangeUserCode(found.client, input.code, githubLinkCallbackUrl(settings.publicUrl));
  if (!exchanged.ok) {
    logger.warn("github.link.refused", { organizationId: scope.organizationId, memberId: scope.memberId, code: exchanged.error.code });
    // The adapter links nothing when it could not revoke the token it got.
    return { outcome: exchanged.error.message.includes("revoking") ? "revoke-failed" : "failed", login: null };
  }
  const linked = await linkGitHubUser({ db, ...ports }, { userId: ctx.user.userId, githubUserId: exchanged.value.userId, githubLogin: exchanged.value.login });
  if (!linked.ok) {
    return { outcome: "taken", login: null };
  }
  return { outcome: "linked", login: linked.githubLogin };
};
