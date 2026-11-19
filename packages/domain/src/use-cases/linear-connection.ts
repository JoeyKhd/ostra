import type { TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { notYet } from "./common.ts";
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
// Bodies: ticket 08 (the OAuth and the app-user check) and ticket 27 (the routers that call them).
// Tokens and secrets go to the secret store and nowhere else: never a log line, never a column.

export type LinearConnectionDeps = Pick<Ports, "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
  /** Core's public address, or `null` when it fails the pre-check: the connection polls. */
  readonly corePublicUrl: string | null;
  /** The panel's address, for the OAuth callback. */
  readonly publicUrl: string;
};

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
    /** Why polling, in words, when it is. */
    readonly modeReason: string | null;
  },
  "forbidden" | "already-connected"
>;

export type StartLinearConnection = (deps: LinearConnectionDeps) => Promise<StartLinearConnectionResult>;

export const startLinearConnection: StartLinearConnection = () => notYet("08");

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
};

export type ConnectLinear = (deps: ConnectLinearDeps, input: ConnectLinearInput) => Promise<ConnectLinearResult>;

export const connectLinear: ConnectLinear = () => notYet("08");

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
>;

export type AuthorizeLinearDeps = Pick<Ports, "notices" | "audit" | "clock" | "jobs"> & {
  readonly db: Db;
  readonly scope: MemberScope;
  readonly authSessionId: string;
};

export type AuthorizeLinear = (deps: AuthorizeLinearDeps, input: AuthorizeLinearInput) => Promise<AuthorizeLinearResult>;

export const authorizeLinear: AuthorizeLinear = () => notYet("08");

// ---------- "Skip for now" (ticket 27) ----------

export const skipSetupStepInputSchema = z.strictObject({ step: z.enum(["linear"]) });
export type SkipSetupStepInput = z.infer<typeof skipSetupStepInputSchema>;

export type SkipSetupStepResult = UseCaseResult<{ readonly skippedAt: number }, "forbidden">;

export type SkipSetupStep = (
  deps: Pick<Ports, "audit" | "clock" | "notices"> & { readonly tx: Tx; readonly scope: MemberScope },
  input: SkipSetupStepInput,
) => Promise<SkipSetupStepResult>;

export const skipSetupStep: SkipSetupStep = () => notYet("27");

// ---------- the connection's tracker ----------

/** What core needs to act for a connection: its tracker adapter, built with its token. */
export type ConnectionTracker = {
  readonly connectionId: ConnectionId;
  readonly tracker: TrackerAdapter;
  /** The connection's own user, for the echo check; `null` with an API key. */
  readonly ownUserId: string | null;
};
