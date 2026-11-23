// What milestone 11's Trackers spec needs (ticket 12, `28-trackers.spec.ts`), in the throwaway e2e
// database only. Run as `node e2e/seed-trackers-world.ts '<json>'`; prints one JSON line.
//
// Scenario `world`: an organization of its own, new on every run, since every other spec's seed
// connects the first organization's trackers. Its admin (`username`, the e2e password) and four
// tracker connections of two kinds, as Organization › Trackers lists them: Acme's Linear (active,
// webhooks), Globex's Jira (active, webhooks, two boards on two projects), Acme Ops Jira (pending,
// no delivery yet) and Northwind's Linear (failed, polling). No tickets and no tasks.

import { randomBytes, randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.discriminatedUnion("scenario", [z.strictObject({ scenario: z.literal("world"), databaseUrl: z.string(), password: z.string() })]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));

const world = async (databaseUrl: string, password: string) => {
  const db = createDb(databaseUrl);
  const run = randomBytes(3).toString("hex");
  const organizationId = organizationIdSchema.parse(randomUUID());
  await db.organization.create({ data: { id: organizationId, name: `Trackers e2e ${run}`, slug: `trackers-e2e-${run}`, createdAt: new Date() } });
  const username = `trackers-${run}`;
  const admin = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password, role: "admin", organizationId });
  if (!admin.ok) throw new Error(`seeding ${username} failed: ${admin.error}`);

  const now = Date.now();
  const day = 86_400_000;
  // Two Linear workspaces and two Jira sites: the one-kind-per-organization rule is gone (ADR 0071),
  // and the app IDs differ the way two apps' or two sites' do.
  const acme = await db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      appId: `e2e-trackers-linear-acme-${run}`,
      name: "Acme Linear",
      state: "active",
      credentialKind: "api_key",
      webhookMode: "webhooks",
      externalWorkspaceId: `ws-acme-${run}`,
      externalWorkspaceKey: "acme",
      externalWorkspaceName: "Acme",
      activatedAt: new Date(now - 40 * day),
      lastEventAt: new Date(now - 2 * 60_000),
    },
  });
  const globex = await db.connection.create({
    data: {
      organizationId,
      kind: "jira",
      appId: `cloud-globex-${run}`,
      name: "Globex Jira",
      state: "active",
      credentialKind: "service_account_token",
      webhookMode: "webhooks",
      externalWorkspaceId: `cloud-globex-${run}`,
      externalWorkspaceKey: "globex.atlassian.net",
      externalWorkspaceName: "Globex",
      accountEmail: "ostra-bot@example.test",
      appUserId: `jira-account-${run}`,
      appUserName: "ostra-bot",
      accessTokenSecretRef: `builtin:e2e-jira-token-${run}`,
      tokenExpiresOn: new Date(Date.UTC(2028, 0, 14)),
      accessCheckedAt: new Date(now - 20 * day),
      accessCheck: {
        projects: [
          { id: "10001", key: "PROJ", name: "calculator", permissions: ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS"] },
          { id: "10002", key: "SHOP", name: "globex-shop", permissions: ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS"] },
        ],
        workflowsReadable: true,
      },
      activatedAt: new Date(now - 21 * day),
      lastEventAt: new Date(now - 6 * 60_000),
    },
  });
  const ops = await db.connection.create({
    data: {
      organizationId,
      kind: "jira",
      appId: `cloud-ops-${run}`,
      name: "Acme Ops Jira",
      state: "pending",
      webhookMode: "webhooks",
      // Step 1 is done (its cloud ID and host are known); step 3, the first delivery, isn't.
      externalWorkspaceId: `cloud-ops-${run}`,
      externalWorkspaceKey: "acme-ops.atlassian.net",
      externalWorkspaceName: "Acme Ops",
      createdByMemberId: admin.seeded.memberId,
    },
  });
  const northwind = await db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      appId: `e2e-trackers-linear-northwind-${run}`,
      name: "Northwind Linear",
      state: "failed",
      failedReason: "token-refused",
      credentialKind: "api_key",
      webhookMode: "polling",
      externalWorkspaceId: `ws-northwind-${run}`,
      externalWorkspaceKey: "northwind",
      externalWorkspaceName: "Northwind",
      activatedAt: new Date(now - 60 * day),
      lastEventAt: new Date(now - 3 * 3_600_000),
    },
  });

  // Globex's two boards, on two projects, as its panel lists "Boards on it".
  const mapping = { open: ["To Do"], started: "In Progress", inReview: "In Review", done: "Done", doneBy: "ostra", magicWord: "Closes" } as const;
  const board = async (name: string, slug: string, externalId: string, projectKey: string, boardName: string) => {
    const project = await db.project.create({ data: { organizationId, name, slug, access: "open" } });
    const row = await db.board.create({ data: { organizationId, projectId: project.id, connectionId: globex.id, externalId, name: boardName, key: projectKey, statusMap: { ...mapping } } });
    return { projectId: project.id, boardId: row.id, projectName: project.name };
  };
  const calculator = await board("calculator", `trackers-calculator-${run}`, `10001-${run}`, "PROJ", "Globex Calculator");
  const shop = await board("globex-shop", `trackers-shop-${run}`, `10002-${run}`, "SHOP", "Globex Shop");

  await db.$disconnect();
  return {
    username,
    organizationId,
    connections: { acme: acme.id, globex: globex.id, ops: ops.id, northwind: northwind.id },
    boards: { calculator, shop },
  };
};

process.stdout.write(`${JSON.stringify(await world(args.databaseUrl, args.password))}\n`);
