// What milestone 6's web specs need (tickets 31 to 33), in the throwaway e2e database only. Run as
// `node e2e/seed-m6.ts '<json>'`; prints one JSON line. Its names start `e2e-auto`.
//
// Scenarios:
// - `automations`: a Linear connection (seeded, as milestones 2 to 4 seed theirs: no app token),
//   the project `e2e-auto` on the fake GitHub's `test1` with one board `AUTO`, and its cached open
//   tickets: three labelled `bug` (`AUTO-1` to `AUTO-3`, status Todo, unassigned), one `feature`
//   and one `docs`. The member `username` can open the project. Idempotent by the project's slug.
// - `paused`: a rule of `e2e-auto` that its hourly limit paused, for Home's row.

import { randomBytes } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { z } from "zod";

const argsSchema = z.discriminatedUnion("scenario", [
  z.strictObject({ scenario: z.literal("automations"), databaseUrl: z.string(), password: z.string(), username: z.string() }),
  z.strictObject({ scenario: z.literal("paused"), databaseUrl: z.string(), password: z.string(), name: z.string() }),
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

const linearConnection = async () =>
  (await db.connection.findFirst({ where: { organizationId, kind: "linear" } })) ??
  db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      appId: "e2e-linear-client",
      state: "active",
      credentialKind: "api_key",
      externalWorkspaceId: "e2e-workspace",
      externalWorkspaceKey: "ostra-test",
      externalWorkspaceName: "ostra-test",
      webhookMode: "webhooks",
    },
  });

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

switch (args.scenario) {
  case "automations":
    process.stdout.write(`${JSON.stringify(await automations(args.username, args.password))}\n`);
    break;
  case "paused":
    process.stdout.write(`${JSON.stringify(await paused(args.name))}\n`);
    break;
  default:
    args satisfies never;
}
await db.$disconnect();
