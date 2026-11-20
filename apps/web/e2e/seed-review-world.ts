// What the review spec needs (F-102, F-100, F-101, F-035, F-111; milestone 6's ticket 34's sibling,
// ticket 35), in a project the spec made through New project on the fake GitHub's `test1`: the rows
// core's review loop leaves once a task went through a CI round and a findings round to "waiting
// for a reviewer", written as core writes them. The PR's head diff is milestone 3's stored compare;
// CI round 1 failed `test` (its log tail a blob), the AI review's round 1 found a blocking finding
// the agent fixed, its round 2 the reviewing fake's nit, still open; the admin is a requested
// reviewer and a team owns the code. A second task waits at the CI round limit. The throwaway e2e
// database only. Run as `node e2e/seed-review-world.ts '<json>'`; prints one JSON line.

import { createHash, randomUUID } from "node:crypto";

import { sampleReview } from "@ostra/adapter-sdk/testing";
import { createDb } from "@ostra/db";
import { appendServerEvent, toStoredDiff } from "@ostra/domain";
import { repoFullNameSchema, sessionIdSchema, organizationIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

const args = z.strictObject({ databaseUrl: z.string(), projectId: z.string() }).parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const sha = (seed: string): string => createHash("sha1").update(`${seed}-${randomUUID()}`).digest("hex");
const limits = { maxFiles: 300, maxPatchBytes: 1024 * 1024 };

const project = await db.project.findUniqueOrThrow({ where: { id: args.projectId }, include: { repos: { orderBy: { position: "asc" } } } });
const organizationId = organizationIdSchema.parse(project.organizationId);
const projectId = projectIdSchema.parse(project.id);
const repo = project.repos[0];
if (repo === undefined) throw new Error("the project has no repo");
const admin = await db.member.findFirstOrThrow({ where: { organizationId, role: "admin" }, orderBy: { createdAt: "asc" } });

/** A code task with an ended session, in the state given. */
const codeTask = async (title: string, data: { readonly state: "in_review" | "needs_you"; readonly subState?: "waiting_for_reviewer"; readonly needsYouReason?: "round_cap"; readonly ciRounds: number; readonly reviewRounds: number; readonly automaticTurns: number }) => {
  const task = await db.task.create({
    data: {
      organizationId,
      projectId,
      kind: "code",
      source: "prompt",
      title,
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-review`,
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
      ...data,
    },
  });
  const session = await db.session.create({ data: { organizationId, projectId, taskId: task.id, origin: "new", state: "ended", outcome: "with_changes", endedAt: new Date() } });
  return { taskId: taskIdSchema.parse(task.id), sessionId: sessionIdSchema.parse(session.id), branchName: task.branchName };
};

/** The PR's diff on its head, as `diff.fetch` stores it. */
const storeDiff = async (head: string) => {
  const stored = toStoredDiff(
    {
      aheadBy: 2,
      behindBy: 0,
      mergeBase: "e".repeat(40),
      files: [
        {
          path: "src/settings/about-section.tsx",
          previousPath: null,
          status: "added",
          additions: 6,
          deletions: 0,
          patch: ["@@ -0,0 +1,6 @@", '+import { appVersion } from "../version";', "+", "+export const AboutSection = () => (", '+  <section aria-labelledby="about">', "+    <p>Version {appVersion}</p>", "+  </section>"].join("\n"),
          truncated: false,
        },
        { path: "src/version.ts", previousPath: null, status: "added", additions: 2, deletions: 0, patch: ["@@ -0,0 +1,2 @@", "+export const appVersion =", '+  import.meta.env.VITE_APP_VERSION ?? "dev";'].join("\n"), truncated: false },
      ],
      filesTruncated: false,
      limits,
    },
    { headSha: head, hostUrl: `https://github.com/${repo.fullName}/pull/12/files`, limits },
  );
  await db.diffCache.create({ data: { organizationId, projectId, repoId: repo.id, baseSha: "e".repeat(40), headSha: head, result: stored } });
};

// ---- the task waiting for a reviewer ----
const reviewed = await codeTask("Show the app version in Settings", { state: "in_review", subState: "waiting_for_reviewer", ciRounds: 1, reviewRounds: 1, automaticTurns: 2 });
const head1 = sha("head-1");
const head2 = sha("head-2");
const head3 = sha("head-3");
const prUrl = `https://github.com/${repo.fullName}/pull/12`;
const taskRepo = await db.taskRepo.create({
  data: { organizationId, projectId, taskId: reviewed.taskId, repoId: repo.id, branchName: reviewed.branchName, baseBranch: "main", state: "pr_open", headSha: head3, prNumber: 12, prUrl, prTitle: "Show the app version in Settings" },
});
await db.taskPullRequest.create({ data: { organizationId, projectId, taskRepoId: taskRepo.id, number: 12, url: prUrl, branchName: reviewed.branchName } });
await storeDiff(head3);
// CI round 1: `test` failed on the first head, its log tail handed to the agent.
const log = await db.blob.create({ data: { organizationId, store: "postgres", key: `ci-${randomUUID()}`, purpose: "ci-log", contentType: "text/plain", size: 64, sha256: "0".repeat(64) } });
await db.ciRun.create({ data: { organizationId, projectId, taskRepoId: taskRepo.id, headSha: head1, state: "failed", checks: [{ name: "test", conclusion: "failure", externalId: "1" }, { name: "lint", conclusion: "success", externalId: "2" }], logBlobIds: [{ name: "test", blobId: log.id }], completedAt: new Date(Date.now() - 30 * 60_000) } });
await db.ciRun.create({ data: { organizationId, projectId, taskRepoId: taskRepo.id, headSha: head3, state: "passed", checks: [{ name: "build", conclusion: "success", externalId: "3" }, { name: "test", conclusion: "success", externalId: "4" }, { name: "lint", conclusion: "success", externalId: "5" }], completedAt: new Date() } });
// The AI review's two rounds: round 1's blocking finding fixed, round 2's nit (the reviewing fake's) open.
const heads = (head: string) => [{ repoId: repo.id, prNumber: 12, baseSha: "e".repeat(40), headSha: head }];
const run1 = await db.reviewRun.create({ data: { organizationId, projectId, codeTaskId: reviewed.taskId, round: 1, state: "posted", summary: "One problem.", blocking: 1, nits: 0, postedAt: new Date(Date.now() - 20 * 60_000), heads: heads(head2) } });
const run2 = await db.reviewRun.create({ data: { organizationId, projectId, codeTaskId: reviewed.taskId, round: 2, state: "posted", summary: "Nothing blocking.", blocking: 0, nits: 1, postedAt: new Date(), heads: heads(head3) } });
const fakeReview = sampleReview(repoFullNameSchema.parse(repo.fullName));
const nit = fakeReview.findings.find((finding) => finding.severity === "nit");
const blocking = fakeReview.findings.find((finding) => finding.severity === "blocking");
if (nit === undefined || blocking === undefined) throw new Error("the reviewing fake's sample has no nit or blocking finding");
await db.finding.create({
  data: { organizationId, projectId, reviewRunId: run1.id, taskRepoId: taskRepo.id, path: "src/version.ts", line: 2, side: "new", severity: "blocking", title: "Read the version at build time", body: "`process.env` isn't defined in the browser bundle.", suggestion: null, postedAs: "line_comment", state: "resolved" },
});
const openNit = await db.finding.create({
  data: { organizationId, projectId, reviewRunId: run2.id, taskRepoId: taskRepo.id, path: "src/settings/about-section.tsx", line: 4, side: "new", severity: "nit", title: nit.title, body: nit.body, suggestion: nit.suggestion, postedAs: "line_comment", state: "open" },
});
await db.taskReviewer.create({ data: { organizationId, projectId, taskRepoId: taskRepo.id, githubUserId: "9001", login: "demo-gh", memberId: admin.id, source: "requested", lastReviewState: null } });
await db.taskReviewer.create({ data: { organizationId, projectId, taskRepoId: taskRepo.id, teamSlug: "fake-org/frontend", source: "codeowners" } });
await db.taskRound.create({ data: { organizationId, projectId, taskId: reviewed.taskId, kind: "ci", number: 1, automatic: true, causeRef: `${head1}.1`, state: "started", createdAt: new Date(Date.now() - 29 * 60_000) } });
await db.taskRound.create({ data: { organizationId, projectId, taskId: reviewed.taskId, kind: "findings", number: 1, automatic: true, causeRef: run1.id, state: "started", createdAt: new Date(Date.now() - 19 * 60_000) } });
await db.needsYouItem.create({ data: { organizationId, projectId, taskId: reviewed.taskId, reason: "waiting_for_reviewer", audience: "reviewer" } });

// ---- the task at the CI round limit ----
const capped = await codeTask("Fix the flaky date test", { state: "needs_you", needsYouReason: "round_cap", ciRounds: 2, reviewRounds: 0, automaticTurns: 2 });
const cappedHead = sha("capped");
const cappedRepo = await db.taskRepo.create({
  data: { organizationId, projectId, taskId: capped.taskId, repoId: repo.id, branchName: capped.branchName, baseBranch: "main", state: "pr_open", headSha: cappedHead, prNumber: 13, prUrl: `https://github.com/${repo.fullName}/pull/13`, prTitle: "Fix the flaky date test" },
});
await db.ciRun.create({ data: { organizationId, projectId, taskRepoId: cappedRepo.id, headSha: cappedHead, state: "failed", checks: [{ name: "e2e", conclusion: "failure", externalId: "9" }], logBlobIds: [{ name: "e2e", blobId: log.id }], completedAt: new Date() } });
for (const [number, state] of [[1, "started"], [2, "started"], [3, "capped"]] as const) {
  await db.taskRound.create({ data: { organizationId, projectId, taskId: capped.taskId, kind: "ci", number, automatic: true, causeRef: `${cappedHead}.${String(number)}`, state } });
}
await db.$transaction((tx) => appendServerEvent(tx, { organizationId, projectId, taskId: capped.taskId, sessionId: capped.sessionId, at: Date.now(), event: { kind: "round.capped", round: "ci", reason: "rounds" } }));
await db.needsYouItem.create({ data: { organizationId, projectId, taskId: capped.taskId, reason: "round_cap", audience: "driver" } });

process.stdout.write(`${JSON.stringify({ taskId: reviewed.taskId, cappedTaskId: capped.taskId, findingId: openNit.id, taskRepoId: taskRepo.id, logFile: `${log.id}.log` })}\n`);
await db.$disconnect();
