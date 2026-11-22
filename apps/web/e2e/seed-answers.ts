// What the task page's answers spec needs (milestone 3's ticket 43; F-026, F-063, F-024, F-084):
// a second member, and tasks the admin drives, each with the rows core writes when the scripted
// fake agent reaches that point: an open approval (its row, its needs-you item and its
// `approval.requested` event), a proposed plan, a running turn, and two counted turns. The
// throwaway e2e database only. Run as `node e2e/seed-answers.ts '<json>'`; prints one JSON line.

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb, notifyChannels } from "@ostra/db";
import { modelTokenPrices, priceTokens, seedMember } from "@ostra/domain";
import type { TaskEvent } from "@ostra/protocol";
import { taskEventSchema } from "@ostra/protocol";
import { z } from "zod";

const args = z.strictObject({ databaseUrl: z.string(), password: z.string(), member: z.string() }).parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: args.member, email: `${args.member}@example.com`, password: args.password, role: "member" });
if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${args.member} failed: ${seeded.error}`);

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;
const project =
  (await db.project.findFirst({ where: { organizationId, slug: "answers" } })) ??
  (await db.project.create({ data: { organizationId, name: "answers", slug: "answers", access: "open" } }));
const projectId = project.id;

type Seeded = { readonly taskId: string; readonly sessionId: string };

/** A code task the admin drives, with one session, in the state given. */
const createTask = async (title: string, task: { readonly state: "running" | "needs_you"; readonly needsYouReason?: "approval" | "plan"; readonly planState?: "proposed" }): Promise<Seeded> => {
  const row = await db.task.create({
    data: {
      organizationId,
      projectId,
      kind: "code",
      source: "prompt",
      title,
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-answers`,
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
      ...task,
    },
  });
  const session = await db.session.create({ data: { organizationId, projectId, taskId: row.id, origin: "new", state: task.state === "running" ? "running" : "waiting" } });
  const seededTask = { taskId: row.id, sessionId: session.id };
  await appendEvents(seededTask, [{ kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: title, delivery: "immediate" }]);
  return seededTask;
};

/** Appends events as core's ingest writes them: numbered per task, a turn row per `turn.started`, one NOTIFY. */
const appendEvents = async (task: Seeded, raw: readonly unknown[]): Promise<readonly number[]> => {
  const events: TaskEvent[] = raw.map((event) => taskEventSchema.parse(event));
  const row = await db.task.findUniqueOrThrow({ where: { id: task.taskId }, select: { eventSeq: true } });
  const session = await db.session.findUniqueOrThrow({ where: { id: task.sessionId }, select: { ingestedSeq: true } });
  const seqs = events.map((_, i) => row.eventSeq + i + 1);
  await db.event.createMany({
    data: events.map((event, i) => ({
      organizationId,
      projectId,
      taskId: task.taskId,
      seq: row.eventSeq + i + 1,
      sessionId: task.sessionId,
      sessionSeq: session.ingestedSeq + i + 1,
      leaseEpoch: null,
      kind: event.kind,
      payload: event,
      occurredAt: new Date(Date.now() - (events.length - i) * 50),
    })),
  });
  const turnsBefore = await db.turn.count({ where: { sessionId: task.sessionId } });
  const starts = events.flatMap((event, i) => (event.kind === "turn.started" ? [row.eventSeq + i + 1] : []));
  for (const [i, startSeq] of starts.entries()) {
    const started = events[startSeq - row.eventSeq - 1];
    if (started?.kind !== "turn.started") continue;
    await db.turn.create({ data: { id: started.turnId, organizationId, projectId, taskId: task.taskId, sessionId: task.sessionId, startSeq, ordinal: turnsBefore + i + 1 } });
  }
  await db.task.update({ where: { id: task.taskId }, data: { eventSeq: row.eventSeq + events.length } });
  await db.session.update({ where: { id: task.sessionId }, data: { ingestedSeq: session.ingestedSeq + events.length } });
  await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId: task.taskId, seq: row.eventSeq + events.length })})`;
  return seqs;
};

const OPTIONS = [
  { optionId: "o-once", label: "Approve once", kind: "allow-once", decision: "allow_once" },
  { optionId: "o-task", label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
  { optionId: "o-deny", label: "Deny", kind: "reject-once", decision: "deny" },
] as const;

/** A turn whose tool call a rule held: the approval's row, its open item, the tool call and `approval.requested`. */
const requestApproval = async (
  task: Seeded,
  call: { readonly toolKind: "edit" | "execute"; readonly title: string; readonly input: Record<string, unknown> },
  subject: { readonly kind: "path" | "command"; readonly value: string },
  rule: { readonly ruleId: string; readonly name: string } | null,
): Promise<string> => {
  const turnId = randomUUID();
  const toolCallId = `toolu_${randomUUID().slice(0, 8)}`;
  const approval = await db.approval.create({
    data: {
      organizationId,
      projectId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      toolCallId,
      options: [...OPTIONS],
      subjectKind: subject.kind,
      subjectValue: subject.value,
      ...(rule === null ? {} : { ruleId: rule.ruleId, ruleSource: "profile" as const }),
    },
  });
  await db.needsYouItem.create({ data: { organizationId, projectId, taskId: task.taskId, reason: "approval", audience: "driver", approvalId: approval.id } });
  await appendEvents(task, [
    { kind: "turn.started", turnId },
    { kind: "agent.message", turnId, segmentId: `seg-${toolCallId}`, text: "Next I need one change the project's rules hold for a person." },
    { kind: "tool.called", turnId, toolCallId, toolKind: call.toolKind, title: call.title, input: call.input },
    {
      kind: "approval.requested",
      turnId,
      approvalId: approval.id,
      toolCallId,
      options: [...OPTIONS],
      subject,
      ...(rule === null ? {} : { rule: { source: "profile", ruleId: rule.ruleId, name: rule.name } }),
    },
  ]);
  return approval.id;
};

// ---- two members answer one approval ----
const race = await createTask("Migrate the saved state", { state: "needs_you", needsYouReason: "approval" });
await requestApproval(race, { toolKind: "execute", title: "pnpm db:migrate", input: { command: "pnpm db:migrate" } }, { kind: "command", value: "pnpm db:migrate" }, null);

// ---- "Approve for this task", on a profile rule's path ----
const rule = await createTask("Set the release name", { state: "needs_you", needsYouReason: "approval" });
await requestApproval(rule, { toolKind: "edit", title: "edit", input: { paths: ["config/settings.json"] } }, { kind: "path", value: "config/settings.json" }, { ruleId: "rule-settings", name: "Settings files" });

// ---- a deny with a reason ----
const deny = await createTask("Add a date library", { state: "needs_you", needsYouReason: "approval" });
await requestApproval(deny, { toolKind: "execute", title: "pnpm add moment", input: { command: "pnpm add moment" } }, { kind: "command", value: "pnpm add moment" }, { ruleId: "rule-deps", name: "Adds a dependency" });

// ---- a proposed plan, waiting for the driver ----
const plan = await createTask("Show the version in Settings", { state: "needs_you", needsYouReason: "plan", planState: "proposed" });
const planTurn = randomUUID();
await appendEvents(plan, [
  { kind: "turn.started", turnId: planTurn, mode: "plan" },
  { kind: "agent.message", turnId: planTurn, segmentId: "seg-plan", text: "Here is how I would do it." },
  {
    kind: "plan.proposed",
    turnId: planTurn,
    message: "Three steps, no new dependency.",
    entries: [
      { content: "Read the version from package.json at build time", priority: "high", status: "pending" },
      { content: "Show it in Settings › About", priority: "medium", status: "pending" },
      { content: "Run the tests", priority: "low", status: "pending" },
    ],
  },
  { kind: "turn.ended", turnId: planTurn, stopReason: "end_turn" },
]);
await db.needsYouItem.create({ data: { organizationId, projectId, taskId: plan.taskId, reason: "plan", audience: "driver", summary: "A plan to approve" } });

// ---- a running turn the admin drives, for a watcher ----
const watched = await createTask("Tidy the README", { state: "running" });
const watchedTurn = randomUUID();
await appendEvents(watched, [
  { kind: "turn.started", turnId: watchedTurn },
  { kind: "agent.message", turnId: watchedTurn, segmentId: "seg-watched", text: "Reading the README before I tidy it." },
]);

// ---- two counted turns (F-084): the second's second call estimated by the key proxy ----
const counted = await createTask("Count the tokens of two turns", { state: "running" });
// Its profile's model has prices, so the Spend row reads dollars against the cap (F-068). A provider
// row only: no endpoint is called, and the token ref names no stored secret.
const provider = await db.modelProvider.upsert({
  where: { organizationId_name: { organizationId, name: "e2e-answers" } },
  create: { organizationId, name: "e2e-answers", baseUrl: "http://127.0.0.1:9/v1", apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: "builtin:e2e-answers" },
  update: {},
});
/** Micro-USD per million tokens ($3, $15, $0.30, $3.75): fresh input, output, cache read, cache write. */
const PRICES = { input: 3_000_000, output: 15_000_000, read: 300_000, write: 3_750_000 } as const;
const pricedModel = await db.model.upsert({
  where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId: "answers-model" } },
  create: {
    organizationId,
    providerId: provider.id,
    endpointModelId: "answers-model",
    displayName: "Answers model",
    inputPricePerMTok: PRICES.input / 1_000_000,
    outputPricePerMTok: PRICES.output / 1_000_000,
    cacheReadPricePerMTok: PRICES.read / 1_000_000,
    cacheWritePricePerMTok: PRICES.write / 1_000_000,
  },
  update: {},
});
const counter = await db.agentProfile.create({ data: { organizationId, name: `Counter ${randomUUID().slice(0, 6)}`, adapter: "opencode", modelId: pricedModel.id, providerId: provider.id } });
const call = (inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, estimated: boolean) => ({
  kind: "usage.recorded",
  providerId: provider.id,
  modelId: pricedModel.id,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  estimated,
});
/** A call's cost as ingest prices it (F-089): each kind at its own price, in micro-USD. */
const prices = modelTokenPrices(pricedModel);
if (prices === null) throw new Error("the counted task's model has no price");
const cost = (c: ReturnType<typeof call>): number => priceTokens(prices, c);
const countedTurns = [
  { turnId: randomUUID(), calls: [call(12_000, 3_100, 40_000, 2_000, false), call(8_000, 900, 41_000, 0, false)], agentMs: 74_000 },
  { turnId: randomUUID(), calls: [call(5_400, 1_200, 52_000, 1_500, false), call(2_600, 400, 0, 0, true)], agentMs: 38_000 },
] as const;
const turns = countedTurns.map((turn) => ({ ...turn, spentMicroUsd: turn.calls.reduce((sum, c) => sum + cost(c), 0) }));
for (const turn of turns) {
  await appendEvents(counted, [
    { kind: "turn.started", turnId: turn.turnId },
    ...turn.calls,
    { kind: "agent.message", turnId: turn.turnId, segmentId: `seg-${turn.turnId}`, text: "Counted." },
    { kind: "turn.ended", turnId: turn.turnId, stopReason: "end_turn" },
  ]);
  // Core keeps the figures on the turn as the usage arrives (ticket 28).
  const sum = (pick: (c: (typeof turn.calls)[number]) => number): number => turn.calls.reduce((total, c) => total + pick(c), 0);
  await db.turn.update({
    where: { id: turn.turnId },
    data: {
      inputTokens: sum((c) => c.inputTokens),
      outputTokens: sum((c) => c.outputTokens),
      cacheReadTokens: sum((c) => c.cacheReadTokens),
      cacheWriteTokens: sum((c) => c.cacheWriteTokens),
      estimated: turn.calls.some((c) => c.estimated),
      agentMs: turn.agentMs,
      spentMicroUsd: turn.spentMicroUsd,
      endedAt: new Date(),
    },
  });
}
const all = turns.flatMap((turn) => turn.calls);
const total = (pick: (c: (typeof all)[number]) => number): number => all.reduce((sum, c) => sum + pick(c), 0);
const countedSpent = turns.reduce((sum, turn) => sum + turn.spentMicroUsd, 0);
await db.session.update({
  where: { id: counted.sessionId },
  data: {
    agentProfileId: counter.id,
    providerId: provider.id,
    modelId: pricedModel.id,
    inputTokens: total((c) => c.inputTokens),
    outputTokens: total((c) => c.outputTokens),
    cacheReadTokens: total((c) => c.cacheReadTokens),
    cacheWriteTokens: total((c) => c.cacheWriteTokens),
    spentMicroUsd: countedSpent,
  },
});
await db.task.update({ where: { id: counted.taskId }, data: { agentProfileId: counter.id, spentMicroUsd: countedSpent } });

process.stdout.write(
  `${JSON.stringify({ race: race.taskId, rule: rule.taskId, deny: deny.taskId, plan: plan.taskId, watched: watched.taskId, counted: counted.taskId })}\n`,
);
await db.$disconnect();
