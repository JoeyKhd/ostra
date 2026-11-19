import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { connectionIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

import { createWebhook, deleteWebhook, listWebhooks, readWorkspace } from "./linear.ts";
import type { LinearTool } from "./linear.ts";

// The development seed of the organization's Linear connection (spec section 3, "Until the
// maintainer authorizes the Linear app"; ticket 39). Linear's consent-free grant is off on the test
// app, so the overnight run connects with the maintainer's personal API key instead:
// `credentialKind: api_key`, state `active`, the workspace from `viewer` and `organization`, and
// `appUserId` null. The key goes into the secret store and nowhere else. No panel action makes an
// `api_key` connection; the panel labels it "Personal API key (development)".
//
// With a public address for core (the tunnel), it registers a workspace webhook on the team, with a
// secret it generates and keeps only in the secret store, and `removeSeedWebhook` deletes it after
// the run. Without one, the connection polls (F-042).

/** The label of the demo's webhook on Linear: an earlier run's is found by it and deleted. */
export const SEED_WEBHOOK_LABEL = "ostra e2e m2 (dev seed)";

/** The `Secret` table as the built-in store's rows: the same rows core and the panel read. */
const secretRows = (db: Db): SecretRowStore => ({
  insert: async (row) => {
    await db.secret.create({
      data: { id: row.id, organizationId: row.organizationId, purpose: row.purpose, ciphertext: Uint8Array.from(row.ciphertext), nonce: Uint8Array.from(row.nonce), keyVersion: row.keyVersion },
    });
  },
  get: async (id) => {
    const row = await db.secret.findUnique({ where: { id } });
    if (row === null) return undefined;
    return { id: row.id, organizationId: organizationIdSchema.parse(row.organizationId), purpose: row.purpose, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion };
  },
  delete: async (id) => (await db.secret.deleteMany({ where: { id } })).count > 0,
});

/** The stack's secrets key: OSTRA_SECRETS_KEY, or the file the server made in its data folder. Never printed. */
const secretsKey = async (env: Readonly<Record<string, string | undefined>>, serverDataDir: string): Promise<string> => {
  const named = env["OSTRA_SECRETS_KEY"];
  if (named !== undefined && named !== "") return named;
  return (await readFile(path.join(env["OSTRA_DATA_DIR"] ?? serverDataDir, "secrets-key"), "utf8")).trim();
};

export type SeedInput = {
  readonly db: Db;
  readonly tool: LinearTool;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `.ostra-dev/server`: where the dev stack keeps its secrets key. */
  readonly serverDataDir: string;
  /** The personal API key: stored in the secret store only. */
  readonly apiKey: string;
  readonly teamId: string;
  /** Core's public address (the tunnel), or `null` to poll. */
  readonly publicUrl: string | null;
  /**
   * The webhook's label on Linear: an earlier run's webhook with it is deleted first. The demo's by
   * default; the failure suite (ticket 38) has its own, so neither deletes the other's.
   */
  readonly webhookLabel?: string;
};

export type SeededConnection = {
  readonly organizationId: OrganizationId;
  readonly connectionId: ConnectionId;
  readonly workspaceKey: string;
  /** The webhook made on Linear, or `null` when the connection polls. */
  readonly webhookId: string | null;
  /** Whether this run made the connection (`false`: an earlier run's, reused). */
  readonly created: boolean;
};

export const seedLinear = async (input: SeedInput): Promise<SeededConnection> => {
  const { db } = input;
  const organization = await db.organization.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (organization === null) throw new Error("the stack has no organization yet: sign in first");
  const organizationId = organizationIdSchema.parse(organization.id);
  const key = parseSecretsKey(await secretsKey(input.env, input.serverDataDir));
  if (!key.ok) throw new Error(`the stack's secrets key: ${key.error.message}`);
  const store = new BuiltinSecretStore({ rows: secretRows(db), key: key.value });
  const workspace = await readWorkspace(input.tool);

  const existing = await db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } }, select: { id: true } });
  let connectionId: ConnectionId;
  let created = false;
  if (existing === null) {
    const token = await store.put({ organizationId, purpose: "linear-access-token" }, input.apiKey);
    if (!token.ok) throw new Error(`the secret store refused the key: ${token.error.message}`);
    const row = await db.connection.create({
      data: {
        organizationId,
        kind: "linear",
        appId: "api-key",
        state: "active",
        credentialKind: "api_key",
        webhookMode: input.publicUrl === null ? "polling" : "webhooks",
        externalWorkspaceId: workspace.organization.id,
        externalWorkspaceKey: workspace.organization.urlKey,
        externalWorkspaceName: workspace.organization.name,
        appUserId: null,
        appUserName: null,
        accessTokenSecretRef: token.value,
        activatedAt: new Date(),
      },
      select: { id: true },
    });
    connectionId = connectionIdSchema.parse(row.id);
    created = true;
  } else {
    connectionId = connectionIdSchema.parse(existing.id);
  }

  // An earlier run's webhook points at an old tunnel, or at this one twice: delete it first.
  const label = input.webhookLabel ?? SEED_WEBHOOK_LABEL;
  for (const hook of await listWebhooks(input.tool)) {
    if (hook.label === label) await deleteWebhook(input.tool, hook.id);
  }
  if (input.publicUrl === null) {
    await db.connection.update({ where: { id: connectionId }, data: { webhookMode: "polling" } });
    return { organizationId, connectionId, workspaceKey: workspace.organization.urlKey, webhookId: null, created };
  }
  const signingSecret = randomBytes(32).toString("hex");
  const stored = await store.put({ organizationId, purpose: "linear-webhook-secret" }, signingSecret);
  if (!stored.ok) throw new Error(`the secret store refused the webhook secret: ${stored.error.message}`);
  await db.connection.update({ where: { id: connectionId }, data: { webhookMode: "webhooks", webhookSecretSecretRef: stored.value } });
  const webhookId = await createWebhook(input.tool, {
    url: `${input.publicUrl}/webhooks/linear/${connectionId}`,
    teamId: input.teamId,
    secret: signingSecret,
    label,
  });
  return { organizationId, connectionId, workspaceKey: workspace.organization.urlKey, webhookId, created };
};

/** Deletes the seed's webhook on Linear: the run is over. */
export const removeSeedWebhook = async (tool: LinearTool, webhookId: string | null): Promise<void> => {
  if (webhookId !== null) await deleteWebhook(tool, webhookId);
};
