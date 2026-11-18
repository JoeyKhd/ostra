import type { Tx } from "@ostra/db";
import type { ConnectionId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-006, ADR 0040: the organization's own GitHub App, either created by the manifest flow (the code
// the host hands back) or an existing App connected by its ID, private key and webhook secret.
// ostra reads the App, stores its secrets through the secret store, and keeps its slug, bot identity
// and permissions. Written by ticket 31.

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

export const connectGitHubApp: ConnectGitHubApp = () => notImplemented("31");
