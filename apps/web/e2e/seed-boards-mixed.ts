// What the boards-mixed spec needs (F-152/c4, F-008/c5, F-008/c7, F-152/c5; `31-boards-mixed.spec.ts`),
// in the throwaway e2e database only. Run as `node e2e/seed-boards-mixed.ts '<json>'`; prints one
// JSON line.
//
// Scenarios:
// - `world`: in the first organization, an organization admin (`boards-<tag>`, Alex Kim) and a
//   member (`boards-<tag>-member`), the fake Linear's connection and the fake Jira's (its service
//   account's scoped token in the secret store), and one project `calculator` with no boards: the
//   spec attaches a Linear team and a Jira project through the page.
// - `connection`: the Jira connection goes `failed` or back to `active`, as a refused token leaves it.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { hashPassword } from "better-auth/crypto";

import { silentLogger, systemClock } from "@ostra/adapter-sdk";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import { LinearAdapter } from "@ostra/adapter-linear";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import { z } from "zod";

const stackShape = z.object({
  databaseUrl: z.string(),
  dataDir: z.string().nullable(),
  linear: z.object({ apiUrl: z.string(), apiKey: z.string(), teamId: z.string(), teamKey: z.string() }),
  jira: z.object({ gatewayUrl: z.string(), siteUrl: z.string(), siteHost: z.string(), cloudId: z.string(), token: z.string(), serviceAccountId: z.string(), serviceAccountEmail: z.string(), projectId: z.string(), projectKey: z.string(), projectName: z.string() }),
});

const argsSchema = z.discriminatedUnion("scenario", [
  z.strictObject({ scenario: z.literal("world"), password: z.string(), tag: z.string(), stack: stackShape }),
  z.strictObject({ scenario: z.literal("connection"), stack: stackShape, state: z.enum(["active", "failed"]) }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.stack.databaseUrl);

const first = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = first.organizationId;

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
  if (args.stack.dataDir === null) throw new Error("the boards-mixed seed needs the stack's data folder, for its secrets key");
  const key = parseSecretsKey((await readFile(path.join(args.stack.dataDir, "secrets-key"), "utf8")).trim());
  if (!key.ok) throw new Error("the stack's secrets key didn't parse");
  return new BuiltinSecretStore({ rows: secretRows, key: key.value }, { logger: silentLogger, clock: systemClock });
};

/** The organization's Linear: the stack's fake, with its admin's API key in the server's secret store. */
const linearConnection = async () =>
  (await db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } } })) ??
  (await (async () => {
    const store = await secretStore();
    const token = await store.put({ organizationId: organizationIdSchema.parse(organizationId), purpose: "linear-access-token" }, args.stack.linear.apiKey);
    if (!token.ok) throw new Error("the secret store refused the token");
    return db.connection.create({
      data: {
        organizationId,
        kind: "linear",
        appId: "e2e-linear",
        name: "Acme Linear",
        state: "active",
        credentialKind: "api_key",
        accessTokenSecretRef: token.value,
        externalWorkspaceId: "e2e-workspace",
        externalWorkspaceKey: "ostra-test",
        externalWorkspaceName: "ostra-test",
        activatedAt: new Date(),
      },
    });
  })());

/** The organization's Jira: the stack's fake site, its service account's scoped token in the secret store. */
const jiraConnection = async () =>
  (await db.connection.findFirst({ where: { organizationId, kind: "jira", state: { not: "revoked" } } })) ??
  (await (async () => {
    const store = await secretStore();
    const token = await store.put({ organizationId: organizationIdSchema.parse(organizationId), purpose: "jira-api-token" }, args.stack.jira.token);
    if (!token.ok) throw new Error("the secret store refused the token");
    return db.connection.create({
      data: {
        organizationId,
        kind: "jira",
        appId: args.stack.jira.cloudId,
        name: "Globex Jira",
        state: "active",
        credentialKind: "api_key",
        accessTokenSecretRef: token.value,
        externalWorkspaceId: args.stack.jira.cloudId,
        externalWorkspaceKey: args.stack.jira.siteHost,
        externalWorkspaceName: "Globex",
        accountEmail: args.stack.jira.serviceAccountEmail,
        appUserId: args.stack.jira.serviceAccountId,
        appUserName: "ostra-bot",
        activatedAt: new Date(),
      },
    });
  })());

const memberOf = async (username: string, name: string, role: "admin" | "member", password: string) => {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password, role });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${username} failed: ${seeded.error}`);
  const user = await db.user.update({ where: { username }, data: { name } });
  return db.member.findFirstOrThrow({ where: { userId: user.id, organizationId } });
};

const world = async (input: Extract<z.infer<typeof argsSchema>, { readonly scenario: "world" }>) => {
  const admin = await memberOf(`boards-${input.tag}`, "Alex Kim", "admin", input.password);
  const member = await memberOf(`boards-${input.tag}-member`, "Sam Rivera", "member", input.password);

  const linear = await linearConnection();
  const jira = await jiraConnection();

  // The Linear team's name and key, as its own adapter lists them.
  const linearAdapter = new LinearAdapter({ apiUrl: input.stack.linear.apiUrl, auth: { kind: "api-key", token: input.stack.linear.apiKey } });
  const listed = await linearAdapter.listBoards();
  if (!listed.ok) throw new Error(`the fake Linear listed no teams: ${listed.error.message}`);
  const team = listed.value.find((one) => one.externalId === input.stack.linear.teamId) ?? listed.value[0];
  if (team === undefined) throw new Error("the fake Linear has no team");

  const project = await db.project.create({ data: { organizationId, name: "calculator", slug: `calculator-${input.tag}`, access: "open" } });
  return {
    username: `boards-${input.tag}`,
    memberUsername: `boards-${input.tag}-member`,
    adminId: admin.id,
    memberId: member.id,
    projectId: project.id,
    linearConnectionId: linear.id,
    jiraConnectionId: jira.id,
    linearTeam: { name: team.name, key: team.key, externalId: team.externalId },
    jiraProject: { name: input.stack.jira.projectName, key: input.stack.jira.projectKey, externalId: input.stack.jira.projectId },
  };
};

switch (args.scenario) {
  case "world":
    process.stdout.write(`${JSON.stringify(await world(args))}\n`);
    break;
  case "connection": {
    const jira = await jiraConnection();
    await db.connection.update({ where: { id: jira.id }, data: { state: args.state } });
    process.stdout.write(`${JSON.stringify({ state: args.state })}\n`);
    break;
  }
  default:
    args satisfies never;
}
await db.$disconnect();
