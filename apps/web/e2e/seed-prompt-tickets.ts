// What the prompt-tickets spec needs (F-097/c2, `27-prompt-tickets.spec.ts`), in the throwaway e2e
// database only. Run as `node e2e/seed-prompt-tickets.ts '<json>'`; prints one JSON line.
//
// Scenarios:
// - `world`: in the first organization, an organization admin (`prompt-<tag>`, Alex Kim) and an
//   organization member (`prompt-<tag>-member`), a model key with DeepSeek V4.1 Flash and the
//   profile `Fast fixes` on it, and three projects on that key: `calculator` with two boards
//   (`Calculator` on the fake Linear's team, its mapping drafted from the team's statuses, and
//   `Web platform`), `calculator-one` with that one board, and `calculator-none` with none. The
//   organization's Linear is the stack's fake, through its admin's API key, as the other seeds
//   connect it. Nothing turns the setting on: the spec does, through the panel.
// - `connection`: the organization's Linear connection goes `failed` or back to `active`, as a
//   token Linear stopped taking leaves it.
// - `writes`: the ticket writes a task has (their kind and board), never their text.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { hashPassword } from "better-auth/crypto";

import { silentLogger, systemClock } from "@ostra/adapter-sdk";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import { LinearAdapter } from "@ostra/adapter-linear";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createDb } from "@ostra/db";
import { draftBoardMapping, seedMember } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import { z } from "zod";

const stackShape = {
  databaseUrl: z.string(),
  dataDir: z.string(),
  linear: z.object({ apiUrl: z.string(), apiKey: z.string(), teamId: z.string(), teamKey: z.string() }),
};
const argsSchema = z.discriminatedUnion("scenario", [
  z.strictObject({ scenario: z.literal("world"), ...stackShape, password: z.string(), tag: z.string().regex(/^[a-z0-9-]{1,24}$/) }),
  z.strictObject({ scenario: z.literal("connection"), ...stackShape, state: z.enum(["failed", "active"]) }),
  z.strictObject({ scenario: z.literal("writes"), ...stackShape, taskId: z.string() }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

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

/** The organization's Linear: the stack's fake, with its admin's API key in the server's secret store. */
const linearConnection = async () =>
  (await db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } } })) ??
  (await (async () => {
    const key = parseSecretsKey((await readFile(path.join(args.dataDir, "secrets-key"), "utf8")).trim());
    if (!key.ok) throw new Error("the stack's secrets key didn't parse");
    const store = new BuiltinSecretStore({ rows: secretRows, key: key.value }, { logger: silentLogger, clock: systemClock });
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

const memberOf = async (username: string, name: string, role: "admin" | "member", password: string) => {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password, role });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${username} failed: ${seeded.error}`);
  const user = await db.user.update({ where: { username }, data: { name } });
  return db.member.findFirstOrThrow({ where: { userId: user.id, organizationId } });
};

const world = async (input: Extract<z.infer<typeof argsSchema>, { readonly scenario: "world" }>) => {
  const admin = await memberOf(`prompt-${input.tag}`, "Alex Kim", "admin", input.password);
  const member = await memberOf(`prompt-${input.tag}-member`, "Sam Rivera", "member", input.password);

  // A key with one model, and `Fast fixes` on it: New task's check finds a key, so it says what happens next.
  const provider = await db.modelProvider.create({
    data: { organizationId, name: `prompt-key-${input.tag}`, baseUrl: "https://prompt-key.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: `builtin:prompt-${input.tag}`, allowOnPersonalRunners: true },
  });
  const model = await db.model.create({
    data: { organizationId, providerId: provider.id, endpointModelId: "deepseek-v4-1-flash", catalogId: "deepseek/deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", adminImageInput: false, inputPricePerMTok: 0.3, outputPricePerMTok: 1.2, priceSource: "catalog" },
  });
  const profile = await db.agentProfile.create({ data: { organizationId, name: `Fast fixes ${input.tag}`, adapter: "opencode", modelId: model.id, modelCatalogId: "deepseek/deepseek-v4.1-flash", providerId: provider.id } });

  // The repos' GitHub, as rows: the spec reads nothing from it.
  const github =
    (await db.connection.findFirst({ where: { organizationId, kind: "github" }, orderBy: { createdAt: "asc" } })) ??
    (await db.connection.create({ data: { organizationId, kind: "github", appId: `e2e-prompt-${input.tag}`, slug: `e2e-prompt-${input.tag}`, state: "active" } }));
  const installation =
    (await db.codeHostInstallation.findFirst({ where: { organizationId, connectionId: github.id }, orderBy: { createdAt: "asc" } })) ??
    (await db.codeHostInstallation.create({ data: { organizationId, connectionId: github.id, installationId: `inst-prompt-${input.tag}`, accountLogin: "acme", accountKind: "organization" } }));

  const linear = await linearConnection();
  const statuses = await new LinearAdapter({ apiUrl: input.linear.apiUrl, auth: { kind: "api-key", token: input.linear.apiKey } }).listStatuses({ externalId: input.linear.teamId });
  if (!statuses.ok) throw new Error(`the fake Linear listed no statuses: ${statuses.error.message}`);
  const drafted = draftBoardMapping(statuses.value, { installed: false });
  if (!drafted.ok) throw new Error(`no mapping drafted: ${drafted.reason}`);

  const projectOf = async (name: string, slug: string, boards: readonly { readonly name: string; readonly key: string; readonly externalId: string }[]) => {
    const project = await db.project.create({ data: { organizationId, name, slug: `${slug}-${input.tag}`, access: "open", ownProviders: true, defaultCodeProfileId: profile.id } });
    await db.providerListEntry.create({ data: { organizationId, projectId: project.id, providerId: provider.id } });
    await db.repo.create({
      data: { organizationId, projectId: project.id, connectionId: github.id, installationId: installation.installationId, hostRepoId: `e2e-prompt-${slug}-${input.tag}`, fullName: "acme/calculator-web", defaultBranch: "main", checkoutDir: "calculator-web" },
    });
    const ids: string[] = [];
    for (const board of boards) {
      const row = await db.board.create({
        data: { organizationId, projectId: project.id, connectionId: linear.id, externalId: board.externalId, name: board.name, key: board.key, statusMap: drafted.mapping, lastPolledAt: new Date(Date.now() - 40_000) },
      });
      ids.push(row.id);
    }
    return { projectId: project.id, boardIds: ids };
  };
  // `Calculator` is the fake's own team, so its statuses are real; `Web platform` is a team of its own.
  const calculator = { name: "Calculator", key: "CALC", externalId: input.linear.teamId };
  const two = await projectOf("calculator", "calculator", [calculator, { name: "Web platform", key: "WEB", externalId: `${input.linear.teamId}-web-${randomBytes(3).toString("hex")}` }]);
  const one = await projectOf("calculator-one", "calculator-one", [calculator]);
  const none = await projectOf("calculator-none", "calculator-none", []);
  const [calculatorBoard, webBoard] = two.boardIds;
  return {
    username: `prompt-${input.tag}`,
    memberUsername: `prompt-${input.tag}-member`,
    adminId: admin.id,
    memberId: member.id,
    projectId: two.projectId,
    calculatorBoardId: calculatorBoard ?? "",
    webBoardId: webBoard ?? "",
    oneProjectId: one.projectId,
    noneProjectId: none.projectId,
  };
};

switch (args.scenario) {
  case "world":
    process.stdout.write(`${JSON.stringify(await world(args))}\n`);
    break;
  case "connection": {
    const linear = await linearConnection();
    await db.connection.update({ where: { id: linear.id }, data: { state: args.state } });
    process.stdout.write(`${JSON.stringify({ state: args.state })}\n`);
    break;
  }
  case "writes": {
    const writes = await db.ticketWrite.findMany({ where: { taskId: args.taskId }, select: { kind: true, boardId: true }, orderBy: { createdAt: "asc" } });
    process.stdout.write(`${JSON.stringify({ writes })}\n`);
    break;
  }
  default:
    args satisfies never;
}
await db.$disconnect();
