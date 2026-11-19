// Seeds what `insights.compute` and the spend rollup write (F-108, ticket 37), for the Insights page's
// browser checks: the throwaway e2e database, or the dev database for a look at the page. Run as
// `node e2e/seed-insights.ts '{"databaseUrl":"…"}'`; prints `{ "seeded": true }`.
//
// It makes two open projects of its own (`insights-a`, `insights-b`) and a model provider with two
// models, and writes 95 days of daily rows for the organization and each project, a `TaskMetric` per
// seeded task, `SpendDaily` rows, and the job's last run three minutes ago. Run again, it replaces
// its own rows, so the numbers stay the same.

import { randomBytes } from "node:crypto";

import { createDb } from "@ostra/db";
import { z } from "zod";

const argsSchema = z.strictObject({ databaseUrl: z.string() });
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const DAY = 86_400_000;
const now = Date.now();
const today = now - (now % DAY);

/** A small fixed generator, so every run writes the same numbers. */
const numbers = (seed: number) => {
  let state = seed;
  return (max: number): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % (max + 1);
  };
};

const main = async (): Promise<void> => {
  const organization = await db.organization.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const organizationId = organization.id;

  const ensureProject = async (slug: string) =>
    (await db.project.findFirst({ where: { organizationId, slug } })) ??
    db.project.create({ data: { organizationId, name: slug, slug, access: "open" } });
  const projects = [await ensureProject("insights-a"), await ensureProject("insights-b")];

  const provider =
    (await db.modelProvider.findFirst({ where: { organizationId, name: "Insights seed" } })) ??
    (await db.modelProvider.create({
      data: { organizationId, name: "Insights seed", baseUrl: "https://insights-seed.invalid/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "seed:none" },
    }));
  const ensureModel = async (name: string) =>
    (await db.model.findFirst({ where: { organizationId, providerId: provider.id, endpointModelId: name } })) ??
    db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: name, listed: false } });
  const models = [await ensureModel("claude-sonnet-5-5"), await ensureModel("qwen3-coder-480b")];

  // The seed's own rows go first, so a second run writes the same numbers.
  const projectIds = projects.map((project) => project.id);
  await db.spendDaily.deleteMany({ where: { organizationId, projectId: { in: projectIds } } });
  await db.task.deleteMany({ where: { organizationId, projectId: { in: projectIds }, title: { startsWith: "Insights seed" } } });
  await db.insightDaily.deleteMany({ where: { organizationId, OR: [{ projectId: null }, { projectId: { in: projectIds } }] } });

  const reasons = ["approval", "plan", "question", "draft_ready"] as const;
  const organizationDays = new Map<number, { opened: number; merged: number; closed: number; waits: Record<string, number[]> }>();
  for (const [index, project] of projects.entries()) {
    const next = numbers(17 + index * 101);
    for (let back = 0; back < 95; back += 1) {
      const day = today - back * DAY;
      const opened = next(6) + (index === 0 ? 2 : 0);
      const merged = Math.min(opened, next(5));
      const closed = next(9) < 3 ? 1 : 0;
      const waits: Record<string, number[]> = {};
      for (const reason of reasons) {
        const items = next(2);
        if (items > 0) waits[reason] = Array.from({ length: items }, () => (next(40) + 2) * 60_000);
      }
      const waitingMs = Object.values(waits).flat().reduce((sum, ms) => sum + ms, 0);
      await db.insightDaily.create({
        data: {
          organizationId,
          projectId: project.id,
          day: new Date(day),
          prsOpened: opened,
          prsMerged: merged,
          prsClosedUnmerged: closed,
          waitingMs: BigInt(waitingMs),
          waitingItems: Object.values(waits).flat().length,
          waitingByReason: waits,
          computedAt: new Date(now - 3 * 60_000),
        },
      });
      const sum = organizationDays.get(day) ?? { opened: 0, merged: 0, closed: 0, waits: {} };
      for (const [reason, list] of Object.entries(waits)) sum.waits[reason] = [...(sum.waits[reason] ?? []), ...list];
      organizationDays.set(day, { opened: sum.opened + opened, merged: sum.merged + merged, closed: sum.closed + closed, waits: sum.waits });
      for (const [modelIndex, model] of models.entries()) {
        const input = BigInt(next(90_000) + 10_000);
        await db.spendDaily.create({
          data: {
            organizationId,
            projectId: project.id,
            modelId: model.id,
            day: new Date(day),
            inputTokens: input,
            outputTokens: input / 8n,
            cacheReadTokens: input * 2n,
            cacheWriteTokens: input / 10n,
            spentMicroUsd: BigInt((next(9_000) + 500) * 1_000) / BigInt(modelIndex + 1),
            unpricedTokens: modelIndex === 1 && back % 9 === 0 ? 1_200n : 0n,
          },
        });
      }
    }
    // A task a few days apart, each with its first PR some minutes after its creation.
    for (let back = 2; back < 95; back += 4) {
      const createdAt = today - back * DAY + 9 * 3_600_000;
      const task = await db.task.create({
        data: {
          organizationId,
          projectId: project.id,
          kind: "code",
          source: "prompt",
          title: `Insights seed ${String(back)}`,
          prompt: "Seeded for Insights",
          branchName: `ostra/${randomBytes(4).toString("hex")}-insights-seed`,
          state: "merged",
        },
        select: { id: true },
      });
      await db.taskMetric.create({
        data: { organizationId, projectId: project.id, taskId: task.id, createdAt: new Date(createdAt), firstPrAt: new Date(createdAt + (next(80) + 5) * 60_000), prsOpened: 1 },
      });
    }
  }
  for (const [day, sum] of organizationDays) {
    const all = Object.values(sum.waits).flat();
    await db.insightDaily.create({
      data: {
        organizationId,
        projectId: null,
        day: new Date(day),
        prsOpened: sum.opened,
        prsMerged: sum.merged,
        prsClosedUnmerged: sum.closed,
        waitingMs: BigInt(all.reduce((total, ms) => total + ms, 0)),
        waitingItems: all.length,
        waitingByReason: sum.waits,
        computedAt: new Date(now - 3 * 60_000),
      },
    });
  }
  await db.insightRun.upsert({
    where: { organizationId },
    create: { organizationId, lastRunAt: new Date(now - 3 * 60_000), lastSourceChangeAt: new Date(now - 3 * 60_000) },
    update: { lastRunAt: new Date(now - 3 * 60_000) },
  });
  process.stdout.write(`${JSON.stringify({ seeded: true })}\n`);
};

try {
  await main();
} finally {
  await db.$disconnect();
}
