import { seedInstallation } from "@ostra/db/testing";
import { questionIdSchema, turnIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedPersonalRunner, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { countByDay, homeLimits, sessionCost, startOfDay, startOfMonth } from "./home.ts";

// F-062, home.md: Home's one read. It covers every project the member can open and nothing else:
// another organization's tasks and a restricted project's, for a member who isn't on it, stay out.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
  const { a, b } = harness.fixture;
  const at = (projectId: typeof a.openProject.id) => ({ organizationId: a.organization.id, projectId });

  const question = await seedTask(harness, { ...at(a.openProject.id), title: "Crash in the share sheet", state: "needs_you" });
  await appendEvent(harness, question, at(a.openProject.id), {
    kind: "question.asked",
    turnId: turnIdSchema.parse("turn-1"),
    questionId: questionIdSchema.parse("q-1"),
    message: "Keep the old share API?\nThe new one needs Android 13.",
    fields: [],
  });
  await seedTask(harness, { ...at(a.openProject.id), title: "Running one", state: "running" });
  await seedTask(harness, { ...at(a.openProject.id), title: "Queued one", state: "queued" });
  await seedTask(harness, { ...at(a.restrictedProject.id), title: "Secret plan", state: "needs_you" });
  await seedTask(harness, { organizationId: b.organization.id, projectId: b.project.id, title: "Other org", state: "needs_you" });
  await harness.test.db.auditEntry.create({
    data: { organizationId: a.organization.id, projectId: a.openProject.id, actorKind: "system", action: "pr.opened", entity: "task", entityId: question.taskId, data: { number: 12, reused: false } },
  });
  await seedPersonalRunner(harness, a.admin.id, "admin-laptop");
});

afterAll(async () => {
  await harness.dispose();
});

describe("home.overview", () => {
  it("gives an admin every project's needs-you tasks, with the question's first line", async () => {
    const { a } = harness.fixture;
    const home = await (await harness.as(a.admin)).home.overview();
    expect(home.needsYou.total).toBe(2);
    const row = home.needsYou.rows.find((r) => r.title === "Crash in the share sheet");
    expect(row?.detail).toEqual({ reason: "question", question: "Keep the old share API?" });
    expect(row?.project.name).toBe(a.openProject.name);
    expect(home.summary).toMatchObject({ projects: 2, running: 1, queued: 1, prsToday: 1 });
    expect(home.prsOpened.days).toHaveLength(7);
    expect(home.runners.map((runner) => runner.name)).toEqual(["admin-laptop"]);
  });

  it("F-062/c1: leaves out a restricted project the member isn't on, and another organization", async () => {
    const { a } = harness.fixture;
    const home = await (await harness.as(a.member)).home.overview();
    expect(home.needsYou.rows.map((r) => r.title)).toEqual(["Crash in the share sheet"]);
    expect(home.projects.rows.map((p) => p.id)).toEqual([a.openProject.id]);
    // A member sees pool runners and their own, not an admin's personal runner.
    expect(home.runners).toEqual([]);
  });

  it("gives the right panel the PRs merged this week, the organization's budget and its pools (home.md)", async () => {
    const { a } = harness.fixture;
    const db = harness.test.db;
    const task = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id, title: "Merged one", state: "in_review" });
    const connection = await db.connection.create({ data: { organizationId: a.organization.id, kind: "github", appId: "home-app" } });
    await seedInstallation(db, { organizationId: a.organization.id, connectionId: connection.id, installationId: "home-install" });
    const repo = await db.repo.create({
      data: { organizationId: a.organization.id, projectId: a.openProject.id, connectionId: connection.id, installationId: "home-install", hostRepoId: "home-1", fullName: "ostra-test/home", defaultBranch: "main", checkoutDir: "home" },
    });
    const taskRepo = await db.taskRepo.create({ data: { organizationId: a.organization.id, projectId: a.openProject.id, taskId: task.taskId, repoId: repo.id, branchName: "ostra/merged-one", baseBranch: "main", state: "merged" } });
    await db.taskPullRequest.create({
      data: { organizationId: a.organization.id, projectId: a.openProject.id, taskRepoId: taskRepo.id, number: 7, url: "https://example.com/pull/7", branchName: "ostra/merged-one", state: "merged", closedAt: new Date() },
    });
    await db.budget.create({ data: { organizationId: a.organization.id, monthlyMicroUsd: 6_000_000_000n } });
    const pool = await db.runnerPool.create({ data: { organizationId: a.organization.id, name: "build-fleet" } });
    await db.runner.create({ data: { organizationId: a.organization.id, kind: "pool", poolId: pool.id, name: "build-01", publicKey: "home-pool-runner", executor: "docker", capacity: 4, version: "0.4.2", state: "online" } });

    const home = await (await harness.as(a.admin)).home.overview();
    expect(home.prsMerged.total).toBe(1);
    expect(home.prsMerged.days.at(-1)?.count).toBe(1);
    expect(home.summary.mergedToday).toBe(1);
    expect(home.spendCap).toBe(6000);
    expect(home.pools.find((one) => one.name === "build-fleet")).toMatchObject({ busy: 0, slots: 4, online: 1, runners: 1 });
  });

  it("words the PR it opened as recent activity, newest first", async () => {
    const { a } = harness.fixture;
    const home = await (await harness.as(a.admin)).home.overview();
    expect(home.activity[0]?.event).toMatchObject({ kind: "pr.opened", prNumber: 12, title: "Crash in the share sheet" });
    expect(home.activity.length).toBeLessThanOrEqual(homeLimits.activity);
  });

  it("is for signed-in members only", async () => {
    await expect(harness.anonymous().home.overview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("the figures", () => {
  it("prices tokens at the model's price per million, or not at all", () => {
    expect(sessionCost({ inputTokens: 1_000_000, outputTokens: 100_000 }, { input: 3, output: 15 })).toBeCloseTo(4.5);
    expect(sessionCost({ inputTokens: 5, outputTokens: 5 }, { input: null, output: 15 })).toBeNull();
    expect(sessionCost({ inputTokens: 5, outputTokens: 5 }, undefined)).toBeNull();
  });

  it("counts by UTC day, oldest first, today last", () => {
    const now = Date.UTC(2026, 10, 19, 15, 0);
    const days = countByDay([now - 60_000, now - 86_400_000, now - 8 * 86_400_000], now, 7);
    expect(days.map((day) => day.count)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(days.at(-1)?.day).toBe(startOfDay(now));
    expect(startOfMonth(now)).toBe(Date.UTC(2026, 10, 1));
  });
});
