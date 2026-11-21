// What the follow-up checks need (2026-11-21; F-100, F-147, ADR 0059 amended), in a project the
// spec made through New project on the fake GitHub's `test1`: a code task in its AI review, whose
// PR is open, and the review task `review.start` made for it, queued with the round's prompt as its
// first message. With `personal`, the code task ran on the admin's personal runner, which is
// offline, so the review waits for it or a pool runner; without it, the code task ran on a pool,
// and the review waits for the pools only, as every review did before. The project's review
// profile is on a key of its own, so core's dispatch reads the same reason when it tries again.
// The throwaway e2e database only. Run as `node e2e/seed-follow-up-world.ts '<json>'`; prints one
// JSON line.

import { createHash, randomUUID } from "node:crypto";

import { createDb } from "@ostra/db";
import { appendServerEvent, dispatchWaitColumns } from "@ostra/domain";
import { clientMessageIdSchema, memberIdSchema, organizationIdSchema, projectIdSchema, runnerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

const args = z
  .strictObject({
    databaseUrl: z.string(),
    projectId: z.string(),
    personal: z.boolean(),
    title: z.string(),
    /**
     * For a check that mustn't race core's sweep (the walk over every route): the review's session
     * isn't waiting to start, so core never tries it again and its reason stays as seeded; the
     * project's keys are left alone, and no branch is pushed.
     */
    steady: z.boolean().default(false),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const sha = (seed: string): string => createHash("sha1").update(`${seed}-${randomUUID()}`).digest("hex");
const CATALOG_ID = "anthropic/claude-sonnet-4-5";

const project = await db.project.findUniqueOrThrow({ where: { id: args.projectId }, include: { repos: { orderBy: { position: "asc" } } } });
const organizationId = organizationIdSchema.parse(project.organizationId);
const projectId = projectIdSchema.parse(project.id);
const repo = project.repos[0];
if (repo === undefined) throw new Error("the project has no repo");
const admin = await db.member.findFirstOrThrow({ where: { organizationId, role: "admin" }, orderBy: { createdAt: "asc" } });

/** The review profile, on a key of the project's own list that personal runners may use. */
const reviewProfile = async (): Promise<{ readonly id: string }> => {
  const provider = await db.modelProvider.upsert({
    where: { organizationId_name: { organizationId, name: "review-key" } },
    create: { organizationId, name: "review-key", baseUrl: "https://review-key.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:review-key", allowOnPersonalRunners: true },
    update: { allowOnPersonalRunners: true },
  });
  const model = await db.model.upsert({
    where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId: "claude-sonnet-4-5" } },
    create: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-4-5", catalogId: CATALOG_ID, displayName: "Claude Sonnet 4.5", inputPricePerMTok: 3, outputPricePerMTok: 15, priceSource: "catalog" },
    update: {},
  });
  const made =
    (await db.agentProfile.findFirst({ where: { organizationId, name: "Reviewer" } })) ??
    (await db.agentProfile.create({ data: { organizationId, name: "Reviewer", adapter: "opencode", modelId: model.id, modelCatalogId: CATALOG_ID } }));
  await db.project.update({ where: { id: projectId }, data: { ownProviders: true, defaultReviewProfileId: made.id } });
  await db.providerListEntry.deleteMany({ where: { organizationId, projectId } });
  await db.providerListEntry.create({ data: { organizationId, projectId, providerId: provider.id } });
  return made;
};
const steadyProfile = project.defaultReviewProfileId ?? project.defaultCodeProfileId;
const profile = args.steady ? (steadyProfile === null ? null : { id: steadyProfile }) : await reviewProfile();

// The admin's laptop, offline: the runner the code task ran on.
const laptop = args.personal
  ? ((await db.runner.findFirst({ where: { organizationId, kind: "personal", ownerMemberId: admin.id, name: "santi-laptop" } })) ??
    (await db.runner.create({
      data: { organizationId, kind: "personal", ownerMemberId: admin.id, name: "santi-laptop", publicKey: `e2e-follow-up-${randomUUID()}`, executor: "host", capacity: 2, version: "0.0.0", state: "offline" },
    })))
  : null;

// The code task, in its AI review, with its PR open.
const code = await db.task.create({
  data: {
    organizationId,
    projectId,
    kind: "code",
    source: "prompt",
    title: args.title,
    prompt: args.title,
    branchName: `ostra/${randomUUID().slice(0, 8)}-index-html`,
    state: "in_review",
    subState: "ai_review",
    driverMemberId: admin.id,
    creatorMemberId: admin.id,
    runnerId: laptop?.id ?? null,
  },
});
await db.session.create({ data: { organizationId, projectId, taskId: code.id, origin: "new", state: "ended", outcome: "with_changes", endedAt: new Date(), agentProfileId: profile?.id ?? null } });
if (laptop !== null) {
  await db.box.create({ data: { organizationId, projectId, taskId: code.id, runnerId: laptop.id, executor: "host", state: "stopped" } });
}
const head = sha("head");
// The walk's world has no branch on the code host, as its other tasks, so "Take it local" stays shut.
const pushedHead = args.steady ? null : head;
const prNumber = 14;
const prUrl = `https://github.com/${repo.fullName}/pull/${String(prNumber)}`;
const codeRepo = await db.taskRepo.create({
  data: { organizationId, projectId, taskId: code.id, repoId: repo.id, branchName: code.branchName, baseBranch: "main", state: "pr_open", headSha: pushedHead, prNumber, prUrl, prTitle: args.title },
});
await db.taskPullRequest.create({ data: { organizationId, projectId, taskRepoId: codeRepo.id, number: prNumber, url: prUrl, branchName: code.branchName } });

// Its review task, as `review.start` makes it: queued, the round's prompt its first message.
const prompt = `Review pull request #${String(prNumber)} on ${repo.fullName} against what was asked: "${args.title}". Hand in your findings with submit_review.`;
const review = await db.task.create({
  data: {
    organizationId,
    projectId,
    kind: "review",
    source: "prompt",
    title: `Review: ${args.title}`.slice(0, 200),
    prompt,
    branchName: `${code.branchName}--review`,
    state: "queued",
    reviewOfTaskId: code.id,
    origin: "pr_review",
    driverMemberId: admin.id,
    creatorMemberId: admin.id,
    agentProfileId: profile?.id ?? null,
    queuedAt: new Date(Date.now() - 46 * 60_000),
    createdAt: new Date(Date.now() - 46 * 60_000),
    ...dispatchWaitColumns(laptop === null ? { code: "no-runner-online" } : { code: "follow-up-waits", runner: { id: runnerIdSchema.parse(laptop.id), name: laptop.name }, personal: "offline" }),
  },
});
await db.taskRepo.create({ data: { organizationId, projectId, taskId: review.id, repoId: repo.id, branchName: review.branchName, baseBranch: "main", headSha: pushedHead } });
const session = await db.session.create({ data: { organizationId, projectId, taskId: review.id, agentProfileId: profile?.id ?? null, origin: "new", state: args.steady ? "waiting" : "starting" } });
await db.reviewRun.create({ data: { organizationId, projectId, codeTaskId: code.id, reviewTaskId: review.id, round: 1, state: "running", heads: [{ repoId: repo.id, prNumber, baseSha: "e".repeat(40), headSha: head }] } });
await db.$transaction((tx) =>
  appendServerEvent(tx, {
    organizationId,
    projectId,
    taskId: taskIdSchema.parse(review.id),
    sessionId: sessionIdSchema.parse(session.id),
    at: Date.now() - 46 * 60_000,
    event: { kind: "user.message", memberId: memberIdSchema.parse(admin.id), clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: prompt, delivery: "immediate" },
  }),
);

process.stdout.write(`${JSON.stringify({ codeTaskId: code.id, reviewTaskId: review.id, runner: laptop?.name ?? null, prNumber })}\n`);
await db.$disconnect();
