// What the repos spec needs (F-098, F-104, ticket 39), in a project the spec made through the panel
// with the fake GitHub's two repos: a task with a branch in the second repo (so its removal is
// refused), and a task with a PR in each repo, one waiting for an independent reviewer because only
// its drivers approved, the other approved by Sam. The throwaway e2e database only.
// Run as `node e2e/seed-repos-world.ts '<json>'`; prints one JSON line.

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { z } from "zod";

const args = z.strictObject({ databaseUrl: z.string(), password: z.string(), projectId: z.string().optional() }).parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

// Without a project: the newest one the spec's desktop case made (`repos-…`).
const project = await db.project.findFirstOrThrow({
  where: args.projectId === undefined ? { slug: { startsWith: "repos-" } } : { id: args.projectId },
  orderBy: { createdAt: "desc" },
  include: { repos: { orderBy: { position: "asc" } } },
});
const organizationId = project.organizationId;
const admin = await db.member.findFirstOrThrow({ where: { organizationId, role: "admin" }, orderBy: { createdAt: "asc" } });
const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: "repos-sam", email: "repos-sam@example.com", password: args.password, role: "member" });
const samId = seeded.ok ? seeded.seeded.memberId : ((await db.user.findFirstOrThrow({ where: { username: "repos-sam" }, select: { members: { select: { id: true } } } })).members[0]?.id ?? "");
const byName = (name: string) => {
  const repo = project.repos.find((one) => one.fullName.endsWith(`/${name}`));
  if (repo === undefined) throw new Error(`the project has no ${name}`);
  return repo;
};
const test1 = byName("test1");
const test2 = byName("test2");

const task = async (title: string) =>
  db.task.create({
    data: {
      organizationId,
      projectId: project.id,
      kind: "code",
      source: "prompt",
      title,
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-repos`,
      state: "in_review",
      subState: "waiting_for_reviewer",
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
    },
  });

// A task with a branch in test2 only: test2 can't be removed while it's open.
const working = await task("Parse negative exponents");
await db.taskRepo.create({ data: { organizationId, projectId: project.id, taskId: working.id, repoId: test2.id, branchName: working.branchName, baseBranch: "main", state: "branch_pushed", headSha: "b".repeat(40) } });

// A task with a PR in each repo, and the independent-review check on each.
const both = await task("Bump the API version in both repos");
const pr = async (repo: typeof test1, number: number, check: { readonly status: "pending" | "passed"; readonly reason: string; readonly approver: string | null }) => {
  const taskRepo = await db.taskRepo.create({
    data: { organizationId, projectId: project.id, taskId: both.id, repoId: repo.id, branchName: both.branchName, baseBranch: "main", state: "pr_open", headSha: "c".repeat(40), prNumber: number, prUrl: `https://github.com/${repo.fullName}/pull/${String(number)}` },
  });
  await db.taskPullRequest.create({ data: { organizationId, projectId: project.id, taskRepoId: taskRepo.id, number, url: `https://github.com/${repo.fullName}/pull/${String(number)}`, branchName: both.branchName } });
  await db.reviewCheck.create({ data: { organizationId, projectId: project.id, taskRepoId: taskRepo.id, prNumber: number, headSha: "c".repeat(40), status: check.status, reason: check.reason, approverMemberId: check.approver } });
};
await pr(test1, 12, { status: "pending", reason: "only-drivers-approved", approver: null });
await pr(test2, 7, { status: "passed", reason: "approved", approver: samId });

process.stdout.write(`${JSON.stringify({ workingTaskId: working.id, bothTaskId: both.id })}\n`);
await db.$disconnect();
