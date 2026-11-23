// What milestone 6's web specs need (tickets 31 to 33), in the throwaway e2e database only. Run as
// `node e2e/seed-m6.ts '<json>'`; prints one JSON line. Its names start `e2e-auto`.
//
// Scenarios:
// Every scenario uses the organization's Linear connection, on the stack's fake Linear with its
// admin's API key (as `seed-refine-world.ts` makes it; the first seed to run makes it).
//
// - `automations`: the project `e2e-auto` on the fake GitHub's `test1` with one board `AUTO` (a
//   team the fake doesn't have, so a poll changes none of its rows), and its cached open
//   tickets: three labelled `bug` (`AUTO-1` to `AUTO-3`, status Todo, unassigned), one `feature`
//   and one `docs`. The member `username` can open the project. Idempotent by the project's slug.
// - `paused`: a rule of `e2e-auto` that its hourly limit paused, for Home's row.
// - `inbox`: the project `e2e-bulk` on `test1` with the fake's team `OST` as its board, and tickets
//   made on the fake and cached: four to start, one holding an active task already, and a parent
//   with two open sub-issues. It prints each one's key. Idempotent by the project's slug.
// - `agent-mode`: the connection's token as the agent-mode consent leaves it (its scopes hold
//   `app:assignable` and `app:mentionable`, agent mode not yet turned on), the project `e2e-agent`
//   with a board for the fake's team `OST`, and three outside tasks waiting for approval as core's
//   `linear.agent-event` writes them: started in Linear by Casey Moore and Dana Ortiz, who match no
//   member, on the project's default profile and only on its pool `e2e-agent-pool`, each with its
//   agent session and its needs-you item for the project's members.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { hashPassword } from "better-auth/crypto";

import { silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import { LinearAdapter } from "@ostra/adapter-linear";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { externalTicketIdSchema, organizationIdSchema } from "@ostra/protocol";
import { z } from "zod";

const stackShape = {
  databaseUrl: z.string(),
  password: z.string(),
  dataDir: z.string(),
  linear: z.object({ apiUrl: z.string(), apiKey: z.string(), teamId: z.string(), teamKey: z.string() }),
};
const argsSchema = z.discriminatedUnion("scenario", [
  z.strictObject({ scenario: z.literal("automations"), ...stackShape, username: z.string() }),
  z.strictObject({ scenario: z.literal("paused"), ...stackShape, name: z.string() }),
  z.strictObject({ scenario: z.literal("inbox"), ...stackShape }),
  z.strictObject({ scenario: z.literal("agent-mode"), ...stackShape }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;
const SLUG = "e2e-auto";

const member = async (username: string, password: string) => {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password, role: "member" });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${username} failed: ${seeded.error}`);
  const user = await db.user.findUniqueOrThrow({ where: { username } });
  return db.member.findFirstOrThrow({ where: { userId: user.id } });
};

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

/** The organization's Linear: the stack's fake, with its admin's API key in the server's secret store. */
const linearConnection = async () =>
  (await db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } } })) ??
  (await (async () => {
    const key = parseSecretsKey((await readFile(path.join(args.dataDir, "secrets-key"), "utf8")).trim());
    if (!key.ok) throw new Error("the stack's secrets key didn't parse");
    const store = new BuiltinSecretStore({ rows: secretRows, key: key.value }, { logger: silentLogger, clock: adapterClock });
    const token = await store.put({ organizationId: organizationIdSchema.parse(organizationId), purpose: "linear-access-token" }, args.linear.apiKey);
    if (!token.ok) throw new Error("the secret store refused the token");
    return db.connection.create({
      data: {
        organizationId,
        kind: "linear",
        appId: "e2e-linear",
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

const githubRepo = async (projectId: string) => {
  const github = await db.connection.findFirst({ where: { organizationId, kind: "github" }, orderBy: { createdAt: "asc" } });
  const installation = github === null ? null : await db.codeHostInstallation.findFirst({ where: { organizationId, connectionId: github.id } });
  const connection = github ?? (await db.connection.create({ data: { organizationId, kind: "github", appId: "e2e-auto", slug: "e2e-auto" } }));
  const installationId = installation?.installationId ?? "7201";
  if (installation === null) {
    await db.codeHostInstallation.create({ data: { organizationId, connectionId: connection.id, installationId, accountLogin: "fake-org", accountKind: "organization" } });
  }
  await db.repo.create({
    data: { organizationId, projectId, connectionId: connection.id, installationId, hostRepoId: "4001", fullName: "fake-org/test1", defaultBranch: "main", checkoutDir: "test1" },
  });
};

const automations = async (username: string, password: string) => {
  const viewer = await member(username, password);
  const found = await db.project.findFirst({ where: { organizationId, slug: SLUG } });
  if (found !== null) {
    const board = await db.board.findFirstOrThrow({ where: { projectId: found.id } });
    return { projectId: found.id, boardId: board.id, memberId: viewer.id };
  }
  // The setup specs name the built-in profile's model; when they haven't, the stub's custom model, so a start starts.
  await db.agentProfile.updateMany({ where: { organizationId, builtIn: true, modelId: null, modelCatalogId: null, modelCustomName: null }, data: { modelCustomName: "local-coder-7b" } });
  const project = await db.project.create({ data: { organizationId, name: SLUG, slug: SLUG, access: "open" } });
  await githubRepo(project.id);
  const connection = await linearConnection();
  const board = await db.board.create({
    data: {
      organizationId,
      projectId: project.id,
      connectionId: connection.id,
      externalId: `e2e-team-${randomBytes(3).toString("hex")}`,
      name: "Calculator",
      key: "AUTO",
      statusMap: { open: ["s-backlog", "s-todo"], started: "s-progress", inReview: "s-review", done: "s-done", doneBy: "ostra", magicWord: "Closes" },
    },
  });
  const tickets: readonly { readonly key: string; readonly title: string; readonly labels: readonly string[] }[] = [
    { key: "AUTO-1", title: "Clear button forgets the memory", labels: ["bug"] },
    { key: "AUTO-2", title: "Rounding in percent mode", labels: ["bug"] },
    { key: "AUTO-3", title: "Division by zero shows NaN", labels: ["bug", "ui"] },
    { key: "AUTO-4", title: "Scientific mode", labels: ["feature"] },
    { key: "AUTO-5", title: "Document the build steps", labels: ["docs"] },
  ];
  let minutes = tickets.length;
  for (const ticket of tickets) {
    minutes -= 1;
    await db.ticket.create({
      data: {
        organizationId,
        projectId: project.id,
        boardId: board.id,
        connectionId: connection.id,
        externalId: `ext-${ticket.key}-${randomBytes(3).toString("hex")}`,
        key: ticket.key,
        title: ticket.title,
        description: "Seeded for the automations spec.",
        statusId: "s-todo",
        statusName: "Todo",
        statusCategory: "open",
        labels: [...ticket.labels],
        url: `https://linear.app/ostra-test/issue/${ticket.key}`,
        open: true,
        trackerUpdatedAt: new Date(Date.now() - minutes * 60_000),
      },
    });
  }
  return { projectId: project.id, boardId: board.id, memberId: viewer.id };
};

const paused = async (name: string) => {
  const project = await db.project.findFirstOrThrow({ where: { organizationId, slug: SLUG } });
  const row =
    (await db.automation.findFirst({ where: { organizationId, projectId: project.id, name } })) ??
    (await db.automation.create({
      data: { organizationId, projectId: project.id, kind: "intake_rule", name, taskKind: "code", poolLabels: [], filter: { labels: { mode: "any", names: ["docs"] } }, createdByMemberId: admin.id },
    }));
  await db.automation.update({ where: { id: row.id }, data: { pausedAt: new Date(), pausedReason: "hourly_limit" } });
  // Home shows needs-you only once setup is done (F-076): run alone, finish what the setup specs would have.
  if ((await db.runner.count({ where: { organizationId, state: "online" } })) === 0) {
    await db.runner.create({
      data: { organizationId, kind: "personal", ownerMemberId: admin.id, name: "e2e-auto-runner", publicKey: `e2e-auto-${randomBytes(8).toString("hex")}`, executor: "host", capacity: 1, version: "0.0.0", state: "online", lastSeenAt: new Date("2099-01-01T00:00:00Z") },
    });
  }
  return { automationId: row.id, projectId: project.id };
};

const inbox = async () => {
  const slug = "e2e-bulk";
  const keysOf = async (projectId: string) => {
    const rows = await db.ticket.findMany({ where: { projectId, description: { startsWith: "e2e-bulk:" } }, select: { id: true, key: true, description: true } });
    const keys = Object.fromEntries(rows.map((row) => [(row.description ?? "").slice("e2e-bulk:".length), row.key] as const));
    const parent = rows.find((row) => row.description === "e2e-bulk:parent");
    return { projectId, parentTicketId: parent?.id ?? "", keys };
  };
  const found = await db.project.findFirst({ where: { organizationId, slug } });
  if (found !== null) return keysOf(found.id);
  await db.agentProfile.updateMany({ where: { organizationId, builtIn: true, modelId: null, modelCatalogId: null, modelCustomName: null }, data: { modelCustomName: "local-coder-7b" } });
  const project = await db.project.create({ data: { organizationId, name: slug, slug, access: "open" } });
  await githubRepo(project.id);
  const connection = await linearConnection();
  const linear = new LinearAdapter({ apiUrl: args.linear.apiUrl, auth: { kind: "api-key", token: args.linear.apiKey } });
  const team = { externalId: args.linear.teamId };
  const statuses = await linear.listStatuses(team);
  if (!statuses.ok) throw new Error(`the fake Linear listed no statuses: ${statuses.error.message}`);
  const status = (name: string): string => {
    const one = statuses.value.find((candidate) => candidate.name === name);
    if (one === undefined) throw new Error(`the fake Linear has no ${name} status`);
    return one.id;
  };
  const board = await db.board.create({
    data: {
      organizationId,
      projectId: project.id,
      connectionId: connection.id,
      externalId: args.linear.teamId,
      name: "Bulk",
      key: args.linear.teamKey,
      statusMap: { open: [status("Backlog"), status("Todo")], started: status("In Progress"), inReview: status("In Review"), done: status("Done"), doneBy: "ostra", magicWord: "Closes" },
    },
  });
  // Made on the fake Linear, then cached as the ingest caches them; the description names its role.
  const made = async (role: string, title: string, minutes: number, parent: { readonly externalId: string } | null = null) => {
    const ticket = await linear.createTicket(team, { title, description: `e2e-bulk:${role}`, ...(parent === null ? {} : { parent: { externalId: externalTicketIdSchema.parse(parent.externalId) } }) });
    if (!ticket.ok) throw new Error(`the fake Linear made no ticket: ${ticket.error.message}`);
    // A new issue lands in Triage; the Inbox lists the open ones, so it moves to Todo, as a person triaging does.
    const moved = await linear.updateStatus(team, ticket.value.key, status("Todo"));
    if (!moved.ok) throw new Error(`the fake Linear didn't move the ticket: ${moved.error.message}`);
    return db.ticket.create({
      data: {
        organizationId,
        projectId: project.id,
        boardId: board.id,
        connectionId: connection.id,
        externalId: ticket.value.externalId,
        key: ticket.value.key,
        title,
        description: `e2e-bulk:${role}`,
        statusId: status("Todo"),
        statusName: "Todo",
        statusCategory: "open",
        labels: ["bulk"],
        url: ticket.value.url,
        open: true,
        trackerUpdatedAt: new Date(Date.now() - minutes * 60_000),
        parentExternalId: parent?.externalId ?? null,
      },
    });
  };
  await made("one", "Add the line bulk-1 to NOTES.md", 1);
  await made("two", "Add the line bulk-2 to NOTES.md", 2);
  await made("three", "Add the line bulk-3 to NOTES.md", 3);
  await made("four", "Add the line bulk-4 to NOTES.md", 4);
  const held = await made("held", "Add the line bulk-5 to NOTES.md", 5);
  const parent = await made("parent", "Show the app's version", 6);
  await made("childA", "Show the version in the footer", 7, parent);
  await made("childB", "Add a version endpoint", 8, parent);
  // The held ticket already has its task: a bulk start skips it, with its reason.
  await db.task.create({
    data: {
      organizationId,
      projectId: project.id,
      kind: "code",
      source: "ticket",
      ticketId: held.id,
      ticketKey: held.key,
      boardId: board.id,
      title: held.title,
      prompt: held.title,
      branchName: `ostra/${randomBytes(4).toString("hex")}-held`,
      state: "queued",
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
    },
  });
  return keysOf(project.id);
};

const agentMode = async () => {
  const slug = "e2e-agent";
  const connection = await linearConnection();
  // The consent's token: agent mode's scopes granted; turning it on is the panel's press.
  await db.connection.update({
    where: { id: connection.id },
    data: { scopes: ["read", "write", "issues:create", "comments:create", "app:assignable", "app:mentionable"], appUserName: connection.appUserName ?? "ostra", webhookMode: "webhooks" },
  });
  const found = await db.project.findFirst({ where: { organizationId, slug } });
  const keysOf = async (projectId: string) => {
    const tasks = await db.task.findMany({ where: { projectId, state: "awaiting_approval" }, orderBy: { createdAt: "asc" }, select: { id: true, ticketKey: true } });
    const board = await db.board.findFirstOrThrow({ where: { projectId } });
    return { projectId, boardName: board.name, tasks: tasks.map((task) => ({ id: task.id, key: task.ticketKey ?? "" })) };
  };
  if (found !== null) return keysOf(found.id);
  await db.agentProfile.updateMany({ where: { organizationId, builtIn: true, modelId: null, modelCatalogId: null, modelCustomName: null }, data: { modelCustomName: "local-coder-7b" } });
  const project = await db.project.create({ data: { organizationId, name: slug, slug, access: "open" } });
  await githubRepo(project.id);
  const pool = (await db.runnerPool.findFirst({ where: { organizationId, name: "e2e-agent-pool" } })) ?? (await db.runnerPool.create({ data: { organizationId, name: "e2e-agent-pool" } }));
  await db.projectPool.create({ data: { organizationId, projectId: project.id, poolId: pool.id, position: 0 } });
  const profile = await db.agentProfile.findFirstOrThrow({ where: { organizationId, builtIn: true }, orderBy: { createdAt: "asc" } });
  const linear = new LinearAdapter({ apiUrl: args.linear.apiUrl, auth: { kind: "api-key", token: args.linear.apiKey } });
  const team = { externalId: args.linear.teamId };
  const board = await db.board.create({
    data: {
      organizationId,
      projectId: project.id,
      connectionId: connection.id,
      // Its own team ID, so this board's switch never meets another project's board of `OST`.
      externalId: `${args.linear.teamId}-agent`,
      name: "Agent",
      key: "AGT",
      statusMap: { open: ["s-backlog", "s-todo"], started: "s-progress", inReview: "s-review", done: "s-done", doneBy: "ostra", magicWord: "Closes" },
    },
  });
  const outside = async (title: string, by: string, minutes: number) => {
    const made = await linear.createTicket(team, { title, description: "Delegated to ostra in Linear." });
    if (!made.ok) throw new Error(`the fake Linear made no ticket: ${made.error.message}`);
    const ticket = await db.ticket.create({
      data: {
        organizationId,
        projectId: project.id,
        boardId: board.id,
        connectionId: connection.id,
        externalId: made.value.externalId,
        key: made.value.key,
        title,
        description: "Delegated to ostra in Linear.",
        statusId: "s-todo",
        statusName: "Todo",
        statusCategory: "open",
        labels: [],
        url: made.value.url,
        open: true,
        trackerUpdatedAt: new Date(),
      },
    });
    const task = await db.task.create({
      data: {
        organizationId,
        projectId: project.id,
        kind: "code",
        source: "ticket",
        ticketId: ticket.id,
        ticketKey: ticket.key,
        boardId: board.id,
        title,
        prompt: title,
        branchName: `ostra/${randomBytes(4).toString("hex")}-outside`,
        state: "awaiting_approval",
        agentProfileId: profile.id,
        trackerActorId: `linear-user-${by.toLowerCase().replace(" ", "-")}`,
        trackerActorName: by,
        poolOnly: true,
        createdAt: new Date(Date.now() - minutes * 60_000),
      },
    });
    await db.agentSession.create({
      data: {
        organizationId,
        connectionId: connection.id,
        externalSessionId: `session-${randomBytes(6).toString("hex")}`,
        projectId: project.id,
        ticketId: ticket.id,
        taskId: task.id,
        boardId: board.id,
        state: "awaiting_approval",
        creatorExternalId: `linear-user-${by.toLowerCase().replace(" ", "-")}`,
        creatorName: by,
        createdAt: new Date(Date.now() - minutes * 60_000),
      },
    });
    await db.needsYouItem.create({ data: { organizationId, projectId: project.id, taskId: task.id, reason: "awaiting_approval", audience: "project_members" } });
  };
  await outside("Retry failed invoice exports", "Casey Moore", 30);
  await outside("Invoice PDF shows the wrong locale", "Dana Ortiz", 20);
  await outside("Add VAT to the CSV export", "Casey Moore", 10);
  // Home shows needs-you only once setup is done (F-076): run alone, finish what the setup specs
  // would have. The model provider is the one step this world didn't seed; the runner stays online
  // (its last contact is far ahead of core's presence sweep).
  if ((await db.modelProvider.count({ where: { organizationId } })) === 0) {
    await db.modelProvider.create({
      data: { organizationId, name: "Agent mode seed", baseUrl: "https://agent-mode-seed.invalid/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "seed:none" },
    });
  }
  if ((await db.runner.count({ where: { organizationId, state: "online" } })) === 0) {
    await db.runner.create({
      data: { organizationId, kind: "personal", ownerMemberId: admin.id, name: "e2e-agent-runner", publicKey: `e2e-agent-${randomBytes(8).toString("hex")}`, executor: "host", capacity: 1, version: "0.0.0", state: "online", lastSeenAt: new Date("2099-01-01T00:00:00Z") },
    });
  }
  return keysOf(project.id);
};

switch (args.scenario) {
  case "automations":
    process.stdout.write(`${JSON.stringify(await automations(args.username, args.password))}\n`);
    break;
  case "paused":
    process.stdout.write(`${JSON.stringify(await paused(args.name))}\n`);
    break;
  case "inbox":
    process.stdout.write(`${JSON.stringify(await inbox())}\n`);
    break;
  case "agent-mode":
    process.stdout.write(`${JSON.stringify(await agentMode())}\n`);
    break;
  default:
    args satisfies never;
}
await db.$disconnect();
