import { randomBytes } from "node:crypto";

import { branchNameFor, claimBranchNameInTx, createPromptTask } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { taskIdSchema } from "@ostra/protocol";
import type { ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 2's ticket 46 (F-016, Q136 item 10): two tasks of a project never share a branch. The
// unique index refuses it, and a create that meets a taken name takes 4 more hex digits of its ID.

let harness: ApiHarness;
let projectId: ProjectId;
let scope: MemberScope;

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "nightly")).projectId;
  const context = await harness.contextOf(harness.fixture.a.member);
  if (context.member === null) {
    throw new Error("the member has no scope");
  }
  scope = context.member.scope;
});

afterAll(async () => {
  await harness.dispose();
});

/**
 * The naming with a faked ID: its last `zeroed` hex digits read as zeros, so every task gets the
 * same name until the ID part is longer than that.
 */
const fakedSuffix =
  (zeroed: number) =>
  (taskId: TaskId, title: string, digits: number): string => {
    const hex = taskId.replaceAll("-", "");
    const faked = `${hex.slice(0, hex.length - zeroed)}${"0".repeat(zeroed)}`;
    return branchNameFor(taskIdSchema.parse(faked), title, digits);
  };

const create = (naming: (taskId: TaskId, title: string, digits: number) => string) =>
  harness.test.db.$transaction((tx) =>
    createPromptTask(
      { tx, scope, jobs: harness.fakes.jobs, notices: harness.deps.ports.notices, audit: harness.deps.ports.audit, clock: harness.deps.ports.clock, branchNameFor: naming },
      { projectId, prompt: "Write the nightly report", title: "Nightly report" },
    ),
  );

const branchesOf = async (taskId: TaskId) => {
  const task = await harness.test.db.task.findUniqueOrThrow({ where: { id: taskId }, include: { repos: true } });
  return { task: task.branchName, repos: task.repos.map((repo) => repo.branchName) };
};

describe("a task's branch name (ticket 46)", () => {
  it("F-016/c3: two tasks forced to the same name, with a faked ID suffix, end with different branches", async () => {
    const naming = fakedSuffix(8);
    const first = await create(naming);
    const second = await create(naming);
    if (!first.ok || !second.ok) {
      throw new Error("a create was refused");
    }
    expect(first.branchName).toBe("ostra/00000000-nightly-report");
    // The second met the taken name and took 4 more digits of its own ID.
    const hex = second.taskId.replaceAll("-", "");
    expect(second.branchName).toBe(`ostra/${hex.slice(-12, -8)}00000000-nightly-report`);
    expect(second.branchName).not.toBe(first.branchName);
    // The task's repos carry the name the task got, and the transaction went on after the clash.
    expect(await branchesOf(first.taskId)).toEqual({ task: first.branchName, repos: [first.branchName] });
    expect(await branchesOf(second.taskId)).toEqual({ task: second.branchName, repos: [second.branchName] });
    expect(await harness.test.db.session.count({ where: { taskId: second.taskId } })).toBe(1);

    // Zeros up to 12 digits: the third takes 16.
    const wider = fakedSuffix(12);
    const third = await create(wider);
    const fourth = await create(wider);
    if (!third.ok || !fourth.ok) {
      throw new Error("a create was refused");
    }
    // The third meets the first's name at 8 digits and takes 12; the fourth meets both and takes 16.
    expect(third.branchName).toBe(`ostra/${"0".repeat(12)}-nightly-report`);
    expect(fourth.branchName).toBe(`ostra/${fourth.taskId.replaceAll("-", "").slice(-16, -12)}${"0".repeat(12)}-nightly-report`);
    const names = await harness.test.db.task.findMany({ where: { id: { in: [first.taskId, second.taskId, third.taskId, fourth.taskId] } }, select: { branchName: true } });
    expect(new Set(names.map((row) => row.branchName)).size).toBe(4);
  });

  it("F-016: refuses to name past 16 digits, and leaves another project's names alone", async () => {
    const taken = `ostra/${randomBytes(4).toString("hex")}-taken`;
    const always = (): string => taken;
    const holder = await create(always);
    expect(holder).toMatchObject({ ok: true, branchName: taken });
    await expect(create(always)).rejects.toThrow("clashed at 16 digits");
    // The refused create left nothing behind: its transaction rolled back whole.
    expect(await harness.test.db.task.count({ where: { projectId, branchName: { in: [taken, "pending"] } } })).toBe(1);
  });

  it("F-016/c3: two creates at the same moment don't block each other on the placeholder", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let placeholderWritten: () => void = () => undefined;
    const written = new Promise<void>((resolve) => {
      placeholderWritten = resolve;
    });
    // One create has written its placeholder and is still open.
    const first = harness.test.db.$transaction(
      async (tx) => {
        const row = await tx.task.create({
          data: { organizationId: scope.organizationId, projectId, kind: "code", source: "prompt", title: "Held", prompt: "p", branchName: "pending" },
          select: { id: true },
        });
        placeholderWritten();
        await held;
        return claimBranchNameInTx(tx, { id: taskIdSchema.parse(row.id), title: "Held" });
      },
      { timeout: 20_000 },
    );
    await written;
    // Another create writes its own placeholder and commits while the first is open.
    const started = Date.now();
    const second = await harness.test.db.$transaction(
      (tx) =>
        createPromptTask(
          { tx, scope, jobs: harness.fakes.jobs, notices: harness.deps.ports.notices, audit: harness.deps.ports.audit, clock: harness.deps.ports.clock },
          { projectId, prompt: "Another one", title: "Another one" },
        ),
      { timeout: 5_000, maxWait: 5_000 },
    );
    expect(second).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    release();
    expect(await first).toMatch(/^ostra\/[0-9a-f]{8}-held$/);
  });
});
