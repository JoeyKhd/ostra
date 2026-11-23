// What milestone 11's Jira connect spec needs (ticket 13, `29-jira-connect.spec.ts`), in the
// throwaway e2e database only. Run as `node e2e/seed-jira-connect.ts '<json>'`; prints one JSON line.
//
// Four organizations, each fresh on every run (site uniqueness is per organization):
// - `webhook`: an admin and two pending Jira connections to the stack's fake site. The first is
//   connected through the three steps by webhook (its secret is in the secret store, so the spec's
//   signed delivery verifies at core); the second then tries the same site and is refused.
// - `polling`: an admin and one pending connection, connected by polling (the stack's address is
//   loopback), with a token 13 days from its date for F-008/c8's warning.
// - `shots`: one more, for the screenshot pass: step 2, the webhook and polling.

import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { hashPassword } from "better-auth/crypto";

import { silentLogger, systemClock } from "@ostra/adapter-sdk";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import { z } from "zod";

const jiraSchema = z.object({ cloudId: z.string(), siteHost: z.string(), token: z.string(), serviceAccountEmail: z.string(), projectKey: z.string() });

const argsSchema = z.strictObject({
  databaseUrl: z.string(),
  dataDir: z.string().nullable(),
  password: z.string(),
  jira: jiraSchema,
});
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

/** The `Secret` table as the built-in store's rows (as the panel's `deps.ts` keeps them). */
const secretRows: SecretRowStore = {
  insert: async (row) => {
    await db.secret.create({
      data: { id: row.id, organizationId: row.organizationId, purpose: row.purpose, ciphertext: Uint8Array.from(row.ciphertext), nonce: Uint8Array.from(row.nonce), keyVersion: row.keyVersion },
    });
  },
  get: async (id) => {
    const row = await db.secret.findUnique({ where: { id } });
    return row === null ? undefined : { id: row.id, organizationId: organizationIdSchema.parse(row.organizationId), purpose: row.purpose, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion };
  },
  delete: async (id) => (await db.secret.deleteMany({ where: { id } })).count > 0,
};

const secretStore = async (): Promise<BuiltinSecretStore> => {
  if (args.dataDir === null) throw new Error("the jira-connect seed needs the stack's data folder, for its secrets key");
  const key = parseSecretsKey((await readFile(path.join(args.dataDir, "secrets-key"), "utf8")).trim());
  if (!key.ok) throw new Error("the stack's secrets key didn't parse");
  return new BuiltinSecretStore({ rows: secretRows, key: key.value }, { logger: silentLogger, clock: systemClock });
};

const run = randomBytes(3).toString("hex");

const organization = async (label: string): Promise<{ organizationId: string; username: string; adminMemberId: string }> => {
  const organizationId = organizationIdSchema.parse(randomUUID());
  await db.organization.create({ data: { id: organizationId, name: `Jira connect ${label} ${run}`, slug: `jira-connect-${label}-${run}`, createdAt: new Date() } });
  const username = `jira-${label}-${run}`;
  const admin = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role: "admin", organizationId });
  if (!admin.ok) throw new Error(`seeding ${username} failed: ${admin.error}`);
  return { organizationId, username, adminMemberId: admin.seeded.memberId };
};

/** A pending Jira connection at step 1: no site, no token, the name the target's step 1 prefills over. */
const pendingConnection = async (organizationId: string, adminMemberId: string, name: string): Promise<string> => {
  const row = await db.connection.create({
    data: {
      organizationId,
      kind: "jira",
      appId: `pending:${randomUUID()}`,
      name,
      state: "pending",
      credentialKind: "service_account_token",
      webhookMode: "webhooks",
      createdByMemberId: adminMemberId,
    },
  });
  return row.id;
};

/** A webhook secret in the store and on the connection, as step 3's `trackers.jira.webhook` makes one. */
const withWebhookSecret = async (organizationId: string, connectionId: string, secret: string): Promise<void> => {
  const store = await secretStore();
  const put = await store.put({ organizationId: organizationIdSchema.parse(organizationId), purpose: "jira-webhook-secret" }, secret);
  if (!put.ok) throw new Error("the secret store refused the webhook secret");
  await db.connection.update({ where: { id: connectionId }, data: { webhookSecretSecretRef: put.value } });
};

const webhookOrg = await organization("webhook");
const webhookFirst = await pendingConnection(webhookOrg.organizationId, webhookOrg.adminMemberId, "Jira");
const webhookSecond = await pendingConnection(webhookOrg.organizationId, webhookOrg.adminMemberId, "Jira");
const webhookSecret = randomBytes(32).toString("base64url");
await withWebhookSecret(webhookOrg.organizationId, webhookFirst, webhookSecret);

const pollingOrg = await organization("polling");
const polling = await pendingConnection(pollingOrg.organizationId, pollingOrg.adminMemberId, "Jira");

const shotsOrg = await organization("shots");
const shotsWebhook = await pendingConnection(shotsOrg.organizationId, shotsOrg.adminMemberId, "Jira");
const shotsSecret = randomBytes(32).toString("base64url");
await withWebhookSecret(shotsOrg.organizationId, shotsWebhook, shotsSecret);

process.stdout.write(
  `${JSON.stringify({
    webhook: { username: webhookOrg.username, first: webhookFirst, second: webhookSecond, secret: webhookSecret },
    polling: { username: pollingOrg.username, connectionId: polling },
    shots: { username: shotsOrg.username, connectionId: shotsWebhook, secret: shotsSecret },
    jira: { siteName: args.jira.siteHost.replace(/\.atlassian\.net$/, ""), serviceAccountEmail: args.jira.serviceAccountEmail, token: args.jira.token, projectKey: args.jira.projectKey },
  })}\n`,
);
