// What the Spend-per-key spec needs (F-135/c13, spend-keys.md): the target's four keys, each one
// client's (two on api.anthropic.com, one on openrouter.ai, one on api.openai.com that nothing uses),
// their models, five projects whose month in the rollup (`SpendDaily`) sums to the keys' $1,842.17,
// their budgets, and tasks whose sessions ran on each key this month. No endpoint is called, and the
// token refs name no stored secret. The throwaway e2e database only.
// With `demo`, the world is the target's own for the side-by-side shots: the organization is Acme
// Corp with a $2,500.00 budget, the clients' projects follow the default list where the target says
// so, and thirteen more projects spent nothing; without it, nothing outside its own rows changes.
// Run as `node e2e/seed-spend-keys-world.ts '<json>'`; prints one JSON line with the IDs the spec opens.

import { randomUUID } from "node:crypto";

import { createDb } from "@ostra/db";
import { z } from "zod";

const argsSchema = z.strictObject({
  databaseUrl: z.string(),
  demo: z.boolean().optional(),
  spent: z.boolean().optional(),
});
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const demo = args.demo === true;
/** `false`: nothing spent yet this month, the budgets set (spend-keys.md, "Nothing spent yet this month"). */
const spent = args.spent !== false;
const db = createDb(args.databaseUrl);

const admin = await db.member.findFirstOrThrow({
  where: { role: "admin" },
  orderBy: { createdAt: "asc" },
});
const organizationId = admin.organizationId;
const now = new Date();
const month = `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
const day = (n: number): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(n, now.getUTCDate()), 9));
const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 100)) * 10_000n;

type ModelSeed = {
  readonly endpointModelId: string;
  readonly catalogId: string | null;
  readonly displayName: string | null;
  readonly priced: boolean;
};
const opus: ModelSeed = {
  endpointModelId: "claude-opus-5-5",
  catalogId: "anthropic/claude-opus-5-5",
  displayName: "Claude Opus 5.5",
  priced: true,
};
const sonnet: ModelSeed = {
  endpointModelId: "claude-sonnet-5-5",
  catalogId: "anthropic/claude-sonnet-5-5",
  displayName: "Claude Sonnet 5.5",
  priced: true,
};
const gpt: ModelSeed = {
  endpointModelId: "openai/gpt-6.2-sol",
  catalogId: "openai/gpt-6.2-sol",
  displayName: "GPT-6.2 Sol",
  priced: true,
};
const deepseek: ModelSeed = {
  endpointModelId: "deepseek/deepseek-v4-flash",
  catalogId: "deepseek/deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
  priced: true,
};
const sqlCoder: ModelSeed = {
  endpointModelId: "acme/sql-coder-ft",
  catalogId: null,
  displayName: null,
  priced: false,
};

// In the demo, acme-anthropic and globex-openrouter are older than last month, and the other two
// were added this month: a past month lists only the keys held then.
const longAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
const provider = async (
  name: string,
  baseUrl: string,
  apiFormat: "anthropic_messages" | "openai_compatible",
  models: readonly ModelSeed[],
  old: boolean,
) => {
  const createdAt = demo ? { createdAt: old ? longAgo : day(3) } : {};
  const row = await db.modelProvider.upsert({
    where: { organizationId_name: { organizationId, name } },
    create: {
      organizationId,
      name,
      baseUrl,
      apiFormat,
      authScheme: apiFormat === "anthropic_messages" ? "x_api_key" : "bearer",
      tokenSecretRef: `builtin:${name}`,
      ...createdAt,
    },
    update: { baseUrl, apiFormat, ...createdAt },
  });
  const ids = new Map<string, string>();
  for (const model of models) {
    const prices = model.priced
      ? { inputPricePerMTok: 3, outputPricePerMTok: 15, priceSource: "catalog" as const }
      : {};
    const saved = await db.model.upsert({
      where: {
        providerId_endpointModelId: { providerId: row.id, endpointModelId: model.endpointModelId },
      },
      create: {
        organizationId,
        providerId: row.id,
        endpointModelId: model.endpointModelId,
        catalogId: model.catalogId,
        displayName: model.displayName,
        ...prices,
      },
      update: {},
    });
    ids.set(model.endpointModelId, saved.id);
  }
  const id = (model: ModelSeed): string => {
    const found = ids.get(model.endpointModelId);
    if (found === undefined) throw new Error(`no ${model.endpointModelId} on ${name}`);
    return found;
  };
  return { providerId: row.id, id };
};

const acme = await provider(
  "acme-anthropic",
  "https://api.anthropic.com",
  "anthropic_messages",
  [opus, sonnet],
  true,
);
const northwind = await provider(
  "northwind-anthropic",
  "https://api.anthropic.com",
  "anthropic_messages",
  [opus, sonnet],
  false,
);
const globex = await provider(
  "globex-openrouter",
  "https://openrouter.ai/api/v1",
  "openai_compatible",
  [gpt, deepseek, sqlCoder],
  true,
);
const spare = await provider(
  "spare-openai",
  "https://api.openai.com/v1",
  "openai_compatible",
  [gpt],
  false,
);

// The clients' projects, fresh each run (a cascade takes their spend, budgets and tasks).
const project = async (name: string, own: readonly string[] | "default") => {
  const old = await db.project.findFirst({ where: { organizationId, slug: name } });
  if (old !== null) await db.project.delete({ where: { id: old.id } });
  const row = await db.project.create({
    data: { organizationId, name, slug: name, access: "open", ownProviders: own !== "default" },
  });
  for (const providerId of own === "default" ? [] : own) {
    await db.providerListEntry.create({ data: { organizationId, projectId: row.id, providerId } });
  }
  return row.id;
};
// The target's default list serves acme-anthropic's three projects; the spec, which shares the stack
// with other specs, gives them their own lists and leaves the default list as it is.
const acmeList = demo ? ("default" as const) : [acme.providerId];
if (demo) {
  await db.providerListEntry.deleteMany({ where: { organizationId, projectId: null } });
  await db.providerListEntry.create({
    data: { organizationId, projectId: null, providerId: acme.providerId },
  });
  await db.organization.update({ where: { id: organizationId }, data: { name: "Acme Corp" } });
}
const billing = await project("billing-platform", acmeList);
const calculator = await project("calculator", acmeList);
const portal = await project("northwind-portal", [northwind.providerId]);
const shop = await project("globex-shop", [globex.providerId]);
const pipeline = await project("data-pipeline", acmeList);
if (demo) {
  for (let i = 1; i <= 13; i += 1)
    await project(`sandbox-${String(i).padStart(2, "0")}`, "default");
}

// The month in the rollup: each project's spend on its key's models, with each key's four token kinds
// split over its rows by spend. The keys sum to $1,842.17 and 186.7M tokens, as the projects do.
type Kinds = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};
const split = (total: number, weights: readonly number[]): number[] => {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((weight) => Math.floor((total * weight) / sum));
  out[out.length - 1] = total - out.slice(0, -1).reduce((a, b) => a + b, 0);
  return out;
};
const rowsFor = async (
  rows: readonly { readonly projectId: string; readonly modelId: string; readonly spent: number }[],
  kinds: Kinds,
  monthsBack = 0,
) => {
  const weights = rows.map((row) => row.spent);
  const [input, output, cacheRead, cacheWrite] = [
    split(kinds.input, weights),
    split(kinds.output, weights),
    split(kinds.cacheRead, weights),
    split(kinds.cacheWrite, weights),
  ];
  await db.spendDaily.createMany({
    data: rows.map((row, i) => ({
      organizationId,
      projectId: row.projectId,
      modelId: row.modelId,
      day: new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() - monthsBack,
          Math.min(i + 1, now.getUTCDate()),
        ),
      ),
      inputTokens: BigInt(input[i] ?? 0),
      outputTokens: BigInt(output[i] ?? 0),
      cacheReadTokens: BigInt(cacheRead[i] ?? 0),
      cacheWriteTokens: BigInt(cacheWrite[i] ?? 0),
      spentMicroUsd: usd(row.spent),
    })),
  });
};
if (spent) {
  await rowsFor(
    [
      { projectId: billing, modelId: acme.id(opus), spent: 400 },
      { projectId: billing, modelId: acme.id(sonnet), spent: 212.4 },
      { projectId: calculator, modelId: acme.id(opus), spent: 250 },
      { projectId: calculator, modelId: acme.id(sonnet), spent: 238.1 },
      { projectId: pipeline, modelId: acme.id(opus), spent: 52.15 },
      { projectId: pipeline, modelId: acme.id(sonnet), spent: 18.2 },
    ],
    { input: 52_100_000, output: 4_800_000, cacheRead: 65_300_000, cacheWrite: 6_200_000 },
  );
  await rowsFor(
    [
      { projectId: portal, modelId: northwind.id(opus), spent: 270.25 },
      { projectId: portal, modelId: northwind.id(sonnet), spent: 142.55 },
    ],
    { input: 18_700_000, output: 1_700_000, cacheRead: 24_200_000, cacheWrite: 2_300_000 },
  );
  await db.spendDaily.createMany({
    data: [
      {
        organizationId,
        projectId: shop,
        modelId: globex.id(gpt),
        day: day(2),
        inputTokens: 1_800_000n,
        outputTokens: 500_000n,
        cacheReadTokens: 3_000_000n,
        spentMicroUsd: usd(188.6),
      },
      {
        organizationId,
        projectId: shop,
        modelId: globex.id(deepseek),
        day: day(3),
        inputTokens: 1_000_000n,
        outputTokens: 300_000n,
        cacheReadTokens: 1_400_000n,
        spentMicroUsd: usd(69.92),
      },
      // The fine-tuned model has no price: its 3.4M tokens are counted, not priced.
      {
        organizationId,
        projectId: shop,
        modelId: globex.id(sqlCoder),
        day: day(4),
        inputTokens: 3_000_000n,
        outputTokens: 400_000n,
        unpricedTokens: 3_400_000n,
      },
    ],
  });
}

// In the demo, last month too: what acme-anthropic and globex-openrouter spent then.
if (demo) {
  await rowsFor(
    [
      { projectId: billing, modelId: acme.id(opus), spent: 700 },
      { projectId: calculator, modelId: acme.id(sonnet), spent: 688.2 },
    ],
    { input: 61_400_000, output: 5_200_000, cacheRead: 80_100_000, cacheWrite: 7_000_000 },
    1,
  );
  await rowsFor(
    [{ projectId: shop, modelId: globex.id(gpt), spent: 241.06 }],
    { input: 6_100_000, output: 1_300_000, cacheRead: 3_900_000, cacheWrite: 0 },
    1,
  );
}

// The budgets: per project only (a key has none), and in the demo the organization's.
const budget = async (projectId: string | null, dollars: number) => {
  if (projectId === null)
    await db.budget.deleteMany({ where: { organizationId, projectId: null } });
  return db.budget.create({
    data: { organizationId, projectId, monthlyMicroUsd: usd(dollars), updatedByMemberId: admin.id },
  });
};
const billingBudget = await budget(billing, 600);
const calculatorBudget = await budget(calculator, 600);
await budget(portal, 800);
await budget(pipeline, 300);
if (spent)
  await db.budgetNotice.createMany({
    data: [
      { organizationId, budgetId: calculatorBudget.id, month, threshold: "warn", sentAt: day(16) },
      { organizationId, budgetId: billingBudget.id, month, threshold: "warn", sentAt: day(12) },
      { organizationId, budgetId: billingBudget.id, month, threshold: "reached", sentAt: day(19) },
    ],
  });
if (demo) await budget(null, 2500);

// This month's tasks on each key: each with a session that ran on it.
const tasks = async (
  projectIds: readonly string[],
  providerId: string,
  modelId: string,
  count: number,
) => {
  for (let i = 0; i < count; i += 1) {
    const projectId = projectIds[i % projectIds.length] ?? "";
    const task = await db.task.create({
      data: {
        organizationId,
        projectId,
        kind: "code",
        source: "prompt",
        title: `Keys task ${String(i + 1)}`,
        prompt: "A prompt",
        branchName: `ostra/${randomUUID().slice(0, 8)}-keys`,
        state: "stopped",
        stoppedReason: "requested",
        driverMemberId: admin.id,
        creatorMemberId: admin.id,
      },
      select: { id: true },
    });
    await db.session.create({
      data: {
        organizationId,
        projectId,
        taskId: task.id,
        origin: "new",
        state: "ended",
        outcome: "with_changes",
        startedAt: day((i % 20) + 1),
        endedAt: day((i % 20) + 1),
        providerId,
        modelId,
      },
    });
  }
};
if (spent) {
  await tasks([billing, calculator, pipeline], acme.providerId, acme.id(opus), demo ? 64 : 4);
  await tasks([portal], northwind.providerId, northwind.id(opus), demo ? 38 : 3);
  await tasks([shop], globex.providerId, globex.id(gpt), demo ? 21 : 2);
}

process.stdout.write(
  `${JSON.stringify({
    keys: {
      acme: acme.providerId,
      northwind: northwind.providerId,
      globex: globex.providerId,
      spare: spare.providerId,
    },
    projects: { billing, calculator, portal, shop, pipeline },
    sqlCoder: globex.id(sqlCoder),
  })}\n`,
);
await db.$disconnect();
