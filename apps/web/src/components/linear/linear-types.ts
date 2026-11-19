// What the Linear page reads from `linear.status` (ticket 27, "Decided 2026-11-19"): one union,
// with `none` carrying the mode before the click. Times are epoch milliseconds, as every router
// sends them.

export type LinearMode = "webhooks" | "polling";
export type LinearCredentialKind = "app_oauth" | "app_client_credentials" | "api_key";

/** What every state carries: the mode the connection runs (or would run) in, and what the app asks for. */
type LinearCommon = {
  readonly mode: LinearMode;
  /** The address pre-check's words when the mode is polling (ticket 08); null for webhooks. */
  readonly modeReason: string | null;
  readonly scopes: readonly string[];
  readonly webhookEvents: readonly string[];
  readonly pollSeconds: number;
  readonly reconcileMinutes: number;
};

export type LinearNone = LinearCommon & {
  readonly state: "none";
  /** The revoked connection this one replaces, for "Disconnected from … on …". */
  readonly lastRevoked: { readonly workspaceKey: string | null; readonly at: number } | null;
};

export type LinearConnection = LinearCommon & {
  readonly state: "pending" | "active" | "failed";
  readonly connectionId: string;
  readonly credentialKind: LinearCredentialKind;
  readonly workspaceKey: string | null;
  readonly workspaceName: string | null;
  readonly appUserName: string | null;
  readonly activatedAt: number | null;
  /** When the state last changed: the time the connection failed, for `since 14:02`. */
  readonly stateSince: number;
  /** The webhook's URL in webhooks mode. */
  readonly webhookUrl: string | null;
  /** Whether the app's values are saved (step 2 of a pending connection). */
  readonly appSaved: boolean;
  readonly manifestUrl: string | null;
  /** The newest delivery: its time, and its type and ticket key when a `WebhookDelivery` names them. */
  readonly lastEvent: { readonly at: number; readonly type: string | null; readonly ticketKey: string | null } | null;
  readonly lastPoll: { readonly at: number; readonly changed: number } | null;
  readonly accessTokenExpiresAt: number | null;
  readonly silentSince: number | null;
  readonly startedAt: number;
  readonly startedByName: string | null;
};

export type LinearStatus = LinearNone | LinearConnection;
