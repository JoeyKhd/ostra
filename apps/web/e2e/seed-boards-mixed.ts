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

import { randomBytes, randomUUID } from "node:crypto";

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
  /** Ticket chips (F-152/c4, `32-ticket-chips.spec.ts`): two boards, their cached tickets, and a Jira task. */
  z.strictObject({ scenario: z.literal("chips"), password: z.string(), tag: z.string(), stack: stackShape }),
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

/**
 * Ticket chips: a project with a Linear team and a Jira project attached, their cached tickets, and a
 * running task on the Jira one, with the three writes the task page's "On Jira" group draws. The
 * tracker never answers for these: the Inbox reads the cache, as its own rows do.
 */
const chips = async (input: Extract<z.infer<typeof argsSchema>, { readonly scenario: "chips" }>) => {
  const admin = await memberOf(`chips-${input.tag}`, "Alex Kim", "admin", input.password);
  const linear = await linearConnection();
  const jira = await jiraConnection();
  const listed = await new LinearAdapter({ apiUrl: input.stack.linear.apiUrl, auth: { kind: "api-key", token: input.stack.linear.apiKey } }).listBoards();
  if (!listed.ok) throw new Error(`the fake Linear listed no teams: ${listed.error.message}`);
  const team = listed.value.find((one) => one.externalId === input.stack.linear.teamId) ?? listed.value[0];
  if (team === undefined) throw new Error("the fake Linear has no team");

  const project = await db.project.create({ data: { organizationId, name: "calculator", slug: `chips-${input.tag}`, access: "open" } });
  // The Inbox lists the tickets by the statuses a mapping calls open: both boards' one, `In Progress`.
  const statusMap = { open: ["in-progress"], started: "in-progress", inReview: "in-review", done: "done", doneBy: "ostra", magicWord: "Closes" };
  const linearBoard = await db.board.create({
    data: { organizationId, projectId: project.id, connectionId: linear.id, externalId: team.externalId, name: team.name, key: team.key, statusMap },
  });
  const jiraBoard = await db.board.create({
    data: { organizationId, projectId: project.id, connectionId: jira.id, externalId: input.stack.jira.projectId, name: "Globex Calculator", key: input.stack.jira.projectKey, statusMap, ticketsForPromptTasks: true },
  });

  const now = new Date();
  const ticketOf = (over: { readonly boardId: string; readonly connectionId: string; readonly externalId: string; readonly key: string; readonly title: string; readonly labels?: string[]; readonly url?: string; readonly parentExternalId?: string; readonly open?: boolean }) =>
    db.ticket.create({ data: { organizationId, projectId: project.id, statusId: "in-progress", statusName: "In Progress", statusCategory: "started", priority: 3, url: "https://example.test", trackerUpdatedAt: now, ...over } });
  await ticketOf({ boardId: linearBoard.id, connectionId: linear.id, externalId: "lin-170", key: "CALC-170", title: "Fix rounding in percent mode", labels: ["bug"], url: "https://linear.app/acme/issue/CALC-170" });
  const parent = await ticketOf({ boardId: jiraBoard.id, connectionId: jira.id, externalId: "10012", key: "PROJ-12", title: "Checkout total ignores the coupon", labels: ["bug"], url: "https://globex.atlassian.net/browse/PROJ-12" });
  await ticketOf({ boardId: jiraBoard.id, connectionId: jira.id, externalId: "10013", key: "PROJ-13", title: "Split the payment form", parentExternalId: "10012", open: false });
  await ticketOf({ boardId: jiraBoard.id, connectionId: jira.id, externalId: "10015", key: "PROJ-15", title: "Round the coupon", parentExternalId: "10012" });

  const task = await db.task.create({
    data: {
      organizationId,
      projectId: project.id,
      kind: "code",
      source: "ticket",
      title: parent.title,
      ticketKey: "PROJ-12",
      branchName: "ostra/PROJ-12",
      state: "running",
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
      ticketId: parent.id,
      boardId: jiraBoard.id,
      queuedAt: now,
    },
  });
  const writeOf = (write: {
    readonly kind: "move" | "comment" | "link_task";
    readonly payload: { readonly status?: string; readonly body?: string; readonly taskId?: string };
    readonly via?: readonly { readonly id: string; readonly name: string }[];
  }) =>
    db.ticketWrite.create({
      data: {
        organizationId,
        projectId: project.id,
        taskId: task.id,
        boardId: jiraBoard.id,
        ticketId: parent.id,
        kind: write.kind,
        payload: write.payload,
        ...(write.via === undefined ? {} : { via: write.via.map((one) => ({ id: one.id, name: one.name })) }),
        idempotencyKey: `${task.id}-${write.kind}`,
        state: "done",
        attempts: 1,
        doneAt: now,
      },
    });
  await writeOf({ kind: "move", payload: { status: "in-progress" }, via: [{ id: "31", name: "Start progress" }] });
  await writeOf({ kind: "comment", payload: { body: "Looking at the coupon path now." } });
  await writeOf({ kind: "link_task", payload: { taskId: task.id } });
  // Search's index (ADR 0054) is written when a task starts; a row made here has none, so the
  // search page would find nothing. Its title and ticket entries, as core writes them.
  await db.searchEntry.createMany({
    data: [
      { organizationId, projectId: project.id, taskId: task.id, kind: "title", text: parent.title },
      { organizationId, projectId: project.id, taskId: task.id, kind: "ticket", text: parent.key },
    ],
  });

  // A second organization with no tracker: Home's step 4 open, and the next step (setup-checklist.md's
  // picture: three done, `Connect a tracker` current). Its model key and GitHub row are rows only.
  const freshId = organizationIdSchema.parse(randomUUID());
  const run = randomBytes(3).toString("hex");
  await db.organization.create({ data: { id: freshId, name: `Chips e2e ${run}`, slug: `chips-e2e-${run}`, createdAt: new Date() } });
  const freshUsername = `chips-fresh-${run}`;
  const fresh = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: freshUsername, email: `${freshUsername}@example.com`, password: input.password, role: "admin", organizationId: freshId });
  if (!fresh.ok) throw new Error(`seeding ${freshUsername} failed: ${fresh.error}`);
  await db.modelProvider.create({ data: { organizationId: freshId, name: `chips-fresh-${run}`, baseUrl: "https://chips-fresh.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: `builtin:chips-fresh-${run}` } });
  await db.connection.create({ data: { organizationId: freshId, kind: "github", appId: `e2e-chips-${run}`, slug: `e2e-chips-${run}`, state: "active" } });

  return {
    username: `chips-${input.tag}`,
    freshUsername,
    projectId: project.id,
    taskId: task.id,
    linearConnection: linear.name,
    jiraConnection: jira.name,
    jiraProjectName: jiraBoard.name,
  };
};

switch (args.scenario) {
  case "world":
    process.stdout.write(`${JSON.stringify(await world(args))}\n`);
    break;
  case "chips":
    process.stdout.write(`${JSON.stringify(await chips(args))}\n`);
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
