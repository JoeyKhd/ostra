// What milestone 2's Linear spec needs (tickets 33 and 35, `22-linear-inbox.spec.ts`), in the
// throwaway e2e database only. Run as `node e2e/seed-linear-world.ts '<json>'`; prints one JSON line.
//
// Scenarios:
// - `world`: an organization of its own, new on every run, since every other spec's seed connects
//   the first organization's Linear with an API key, and one organization has one connection. Its
//   admin (`username`, the e2e password), the fake GitHub's `test1` as its repo, a model key that
//   lists one model (a row only: nothing calls it), the built-in profiles on that model, and a
//   project on that key whose default code profile is its own, `Ticket builder`. No Linear
//   connection, no board: the spec makes both through the panel.
// - `ticket`: a person makes an issue on the fake Linear's team, through the shipped adapter with
//   the fake admin's API key, as a ticket made in Linear. It prints the issue's key.

import { randomBytes, randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { LinearAdapter } from "@ostra/adapter-linear";
import { createDb } from "@ostra/db";
import { ensureBuiltInKindProfilesInTx, seedMember } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import { z } from "zod";

const linearShape = z.object({ apiUrl: z.string(), apiKey: z.string(), teamId: z.string(), teamKey: z.string() });
const argsSchema = z.discriminatedUnion("scenario", [
  z.strictObject({ scenario: z.literal("world"), databaseUrl: z.string(), password: z.string() }),
  z.strictObject({ scenario: z.literal("ticket"), linear: linearShape, title: z.string() }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));

const CATALOG_ID = "anthropic/claude-sonnet-4-5";
const PROFILE = "Ticket builder";

const world = async (databaseUrl: string, password: string) => {
  const db = createDb(databaseUrl);
  const run = randomBytes(3).toString("hex");
  const organizationId = organizationIdSchema.parse(randomUUID());
  await db.organization.create({ data: { id: organizationId, name: `Linear e2e ${run}`, slug: `linear-e2e-${run}`, createdAt: new Date() } });
  const username = `linear-${run}`;
  const admin = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password, role: "admin", organizationId });
  if (!admin.ok) throw new Error(`seeding ${username} failed: ${admin.error}`);

  // The fake GitHub's `test1`: a start needs a repo (the App has no key here, so nothing asks GitHub).
  const github = await db.connection.create({ data: { organizationId, kind: "github", appId: `e2e-linear-${run}`, slug: `e2e-linear-${run}` } });
  const installationId = String(7300 + Number.parseInt(run.slice(0, 2), 16));
  await db.codeHostInstallation.create({ data: { organizationId, connectionId: github.id, installationId, accountLogin: "fake-org", accountKind: "organization" } });

  // A key that lists one model, and the built-in profiles on it, so Start task has what it needs.
  const provider = await db.modelProvider.create({
    data: { organizationId, name: "e2e-linear", baseUrl: "https://e2e-linear.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:e2e-linear" },
  });
  const model = await db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-4-5", catalogId: CATALOG_ID, displayName: "Claude Sonnet 4.5" } });
  await db.$transaction((tx) => ensureBuiltInKindProfilesInTx(tx, organizationId));
  await db.agentProfile.updateMany({ where: { organizationId }, data: { modelId: model.id, modelCatalogId: CATALOG_ID } });
  // The project's own default for code tasks, which Start task must offer first (F-010).
  const builder = await db.agentProfile.create({ data: { organizationId, name: PROFILE, adapter: "opencode", modelId: model.id, modelCatalogId: CATALOG_ID } });

  const name = `tickets-${run}`;
  const project = await db.project.create({ data: { organizationId, name, slug: name, access: "open", ownProviders: true, defaultCodeProfileId: builder.id } });
  await db.providerListEntry.create({ data: { organizationId, projectId: project.id, providerId: provider.id } });
  await db.repo.create({
    data: { organizationId, projectId: project.id, connectionId: github.id, installationId, hostRepoId: "4001", fullName: "fake-org/test1", defaultBranch: "main", checkoutDir: "test1" },
  });
  await db.$disconnect();
  return { username, organizationId, projectId: project.id, projectName: name };
};

const ticket = async (linear: z.infer<typeof linearShape>, title: string) => {
  const adapter = new LinearAdapter({ apiUrl: linear.apiUrl, auth: { kind: "api-key", token: linear.apiKey } });
  const made = await adapter.createTicket({ externalId: linear.teamId }, { title, description: "Made in Linear while the Inbox was open." });
  if (!made.ok) throw new Error(`the fake Linear made no ticket: ${made.error.message}`);
  return { key: made.value.key, externalId: made.value.externalId };
};

switch (args.scenario) {
  case "world":
    process.stdout.write(`${JSON.stringify(await world(args.databaseUrl, args.password))}\n`);
    break;
  case "ticket":
    process.stdout.write(`${JSON.stringify(await ticket(args.linear, args.title))}\n`);
    break;
  default:
    args satisfies never;
}
