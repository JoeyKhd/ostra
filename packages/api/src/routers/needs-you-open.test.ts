import { createNeedsYouItemInTx, fanOutNotification, moveTaskInTx, resolveNeedsYouItemsInTx } from "@ostra/domain";
import { mapTask } from "@ostra/db";
import type { DbEnum } from "@ostra/db";
import { clientMessageIdSchema } from "@ostra/protocol";
import type { NeedsYouItemId, OrganizationId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// F-062, F-036, F-025, F-065, F-024: what waits on a member is one rule. Home's needs-you section
// and its total, the Needs you page's Open tab and its count, and the sidebar's count all read it,
// so they never disagree; and an item never outlives its reason: stopping a task closes its open
// items, and a message that starts the task's next turn answers what that turn answers. A harness
// of its own, so the totals start at nothing.

let harness: ApiHarness;
let orgA: OrganizationId;
let open: ProjectId;
let restricted: ProjectId;

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  open = harness.fixture.a.openProject.id;
  restricted = harness.fixture.a.restrictedProject.id;
});

afterAll(async () => {
  await harness.dispose();
});

type Member = typeof harness.fixture.a.member;

/** An item the way core's writers make it, and its notifications fanned out as core's job does. */
const raise = async (
  task: SeededTask,
  projectId: ProjectId,
  item: { readonly reason: DbEnum.NeedsYouReason; readonly audience: DbEnum.NeedsYouAudience; readonly organizationId?: OrganizationId },
  fanOut = true,
): Promise<NeedsYouItemId> => {
  const organizationId = item.organizationId ?? orgA;
  const itemId = await harness.test.db.$transaction((tx) =>
    createNeedsYouItemInTx(harness.deps.ports, tx, { organizationId, projectId, taskId: task.taskId, reason: item.reason, audience: item.audience }),
  );
  if (fanOut) {
    await fanOutNotification({ db: harness.test.db, ...harness.deps.ports }, { itemId, change: "created" });
  }
  return itemId;
};

/** Every surface that counts or lists what waits, as the member's panel reads them. */
const surfaces = async (who: Member) => {
  const caller = await harness.as(who);
  const [overview, list, page, sidebar] = await Promise.all([
    caller.home.overview(),
    caller.home.needsYou({ limit: 50 }),
    caller.notifications.list({ tab: "open" }),
    caller.notifications.openCount(),
  ]);
  const keyOf = (view: { readonly itemId: string | null; readonly taskId: string }): string => view.itemId ?? `task:${view.taskId}`;
  return {
    homeTotal: overview.needsYou.total,
    homeRows: overview.needsYou.rows.map(keyOf),
    listTotal: list.total,
    listRows: list.rows.map(keyOf),
    pageTotal: page.total,
    pageRows: page.rows.map((row) => keyOf(row.view)),
    pageStates: [...new Set(page.rows.map((row) => row.view.state))],
    unread: page.unread,
    sidebar: sidebar.count,
  };
};

describe("one rule for what waits", () => {
  it("F-025, F-065, F-062, F-036: stopping a task whose no-changes item is open closes the item, and Home, the Needs you page and the sidebar all show 0", async () => {
    const { member } = harness.fixture.a;
    // A session ended without changes: the task needs its driver, with a `no_changes` item for them.
    const task = await seedTask(harness, { organizationId: orgA, projectId: open, title: "hiiiiiiiii", state: "needs_you", driverMemberId: member.id, sessionState: "ended" });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { needsYouReason: "no_changes" } });
    const itemId = await raise(task, open, { reason: "no_changes", audience: "driver" });

    const before = await surfaces(member);
    expect(before).toMatchObject({ homeTotal: 1, homeRows: [itemId], listTotal: 1, pageTotal: 1, pageRows: [itemId], unread: 1, sidebar: 1 });

    const caller = await harness.as(member);
    expect(await caller.tasks.stop({ taskId: task.taskId })).toEqual({ stopped: true });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "stopped", needsYouReason: null });
    const closed = await harness.test.db.needsYouItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(closed).toMatchObject({ state: "dismissed", resolvedByMemberId: member.id });
    expect(closed.resolvedAt).not.toBeNull();
    // Its fan-out is owed, so the member's notification closes too.
    expect(harness.fakes.jobs.jobs.some((job) => job.job === "notify.fanout" && JSON.stringify(job.payload).includes(itemId) && JSON.stringify(job.payload).includes("dismissed"))).toBe(true);

    expect(await surfaces(member)).toMatchObject({ homeTotal: 0, homeRows: [], listTotal: 0, pageTotal: 0, pageRows: [], unread: 0, sidebar: 0 });
    // Once the fan-out runs, the Done tab says it closed without an answer.
    await fanOutNotification({ db: harness.test.db, ...harness.deps.ports }, { itemId, change: "dismissed" });
    const done = await caller.notifications.list({ tab: "done" });
    expect(done.rows.find((row) => row.view.itemId === itemId)).toMatchObject({ state: "dismissed", view: { outcome: { kind: "closed" } } });
  });

  it("F-036, F-062: a move that ends the task, its runner lost or its last PR merged, dismisses its open items, and a move that doesn't keeps them", async () => {
    const { member } = harness.fixture.a;
    const lost = await seedTask(harness, { organizationId: orgA, projectId: open, title: "runner lost", state: "needs_you", driverMemberId: member.id });
    const merged = await seedTask(harness, { organizationId: orgA, projectId: open, title: "merged", state: "in_review", driverMemberId: member.id });
    const queued = await seedTask(harness, { organizationId: orgA, projectId: open, title: "queued again", state: "needs_you", driverMemberId: member.id });
    const items = {
      lost: await raise(lost, open, { reason: "question", audience: "driver" }),
      merged: await raise(merged, open, { reason: "files_outside_repos", audience: "driver" }),
      queued: await raise(queued, open, { reason: "no_provider_for_model", audience: "organization_admins" }),
    };
    const move = (task: SeededTask, input: Parameters<typeof moveTaskInTx>[2]) =>
      harness.test.db.$transaction(async (tx) => moveTaskInTx({ tx, notices: harness.deps.ports.notices, jobs: harness.deps.ports.jobs }, mapTask(await tx.task.findUniqueOrThrow({ where: { id: task.taskId } })), input));
    expect(await move(lost, { type: "stop", reason: "runner_lost" })).toBe(true);
    expect(await move(merged, { type: "last_pr_merged" })).toBe(true);
    expect(await move(queued, { type: "provider_changed" })).toBe(true);

    expect(await harness.test.db.needsYouItem.findUniqueOrThrow({ where: { id: items.lost } })).toMatchObject({ state: "dismissed", resolvedByMemberId: null });
    expect(await harness.test.db.needsYouItem.findUniqueOrThrow({ where: { id: items.merged } })).toMatchObject({ state: "dismissed", resolvedByMemberId: null });
    // Queued for a fresh session, the task still waits on its admins' item.
    expect(await harness.test.db.needsYouItem.findUniqueOrThrow({ where: { id: items.queued } })).toMatchObject({ state: "open" });
    const seen = await surfaces(harness.fixture.a.admin);
    expect(seen.pageRows).toContain(items.queued);
    expect(seen.pageRows).not.toContain(items.lost);
    expect(seen.pageRows).not.toContain(items.merged);
    // Close it as a provider's return does, so the next tests start from nothing.
    await harness.test.db.$transaction((tx) => resolveNeedsYouItemsInTx(harness.deps.ports, tx, { id: items.queued }, { state: "answered", at: new Date(), byMemberId: null }));
  });

  it("F-024, F-065, F-062: a message that starts the task's next turn answers its no-changes item, and leaves an approval waiting on its own answer", async () => {
    const { a } = harness.fixture;
    const world = await seedConnectionAndModel(harness);
    const projectId = (await seedProject(harness, world, "next-turn")).projectId;
    const runnerId = await seedPersonalRunner(harness, a.member.id, "next-turn-runner");
    const task = await seedTask(harness, { organizationId: orgA, projectId, state: "needs_you", driverMemberId: a.member.id, sessionState: "waiting" });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { needsYouReason: "no_changes" } });
    await seedLease(harness, task, orgA, projectId, runnerId);
    const noChanges = await raise(task, projectId, { reason: "no_changes", audience: "driver" });
    const approval = await raise(task, projectId, { reason: "approval", audience: "driver" });
    expect((await surfaces(a.member)).pageRows).toEqual(expect.arrayContaining([noChanges, approval]));

    const caller = await harness.as(a.member);
    await caller.tasks.send({ taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse("c-next-turn"), text: "Try again, and change the README this time." });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
    expect(await harness.test.db.needsYouItem.findUniqueOrThrow({ where: { id: noChanges } })).toMatchObject({ state: "answered", resolvedByMemberId: a.member.id });
    expect(await harness.test.db.needsYouItem.findUniqueOrThrow({ where: { id: approval } })).toMatchObject({ state: "open" });
    const after = await surfaces(a.member);
    expect(after.pageRows).not.toContain(noChanges);
    expect(after.pageRows).toContain(approval);
    expect(after.homeTotal).toBe(after.pageTotal);
  });

  it("F-062, F-036: for every mix of item and task states, Home's total and rows, the page's Open tab and its count, and the sidebar's count agree", async () => {
    const { a, b } = harness.fixture;
    const taskStates = ["needs_you", "running", "in_review", "stopped", "merged"] as const;
    const itemStates = ["open", "answered", "dismissed"] as const;
    const audiences: readonly { readonly audience: DbEnum.NeedsYouAudience; readonly driver: string | null }[] = [
      { audience: "driver", driver: a.member.id },
      { audience: "driver", driver: a.insider.id },
      { audience: "driver", driver: null },
      { audience: "project_members", driver: a.insider.id },
    ];
    let seeded = 0;
    for (const taskState of taskStates) {
      for (const itemState of itemStates) {
        for (const [index, { audience, driver }] of audiences.entries()) {
          const projectId = index === 3 && itemState === "open" ? restricted : open;
          const task = await seedTask(harness, { organizationId: orgA, projectId, title: `${taskState} ${itemState} ${audience}`, state: taskState === "merged" ? "in_review" : taskState, driverMemberId: driver });
          if (taskState === "merged") {
            await harness.test.db.task.update({ where: { id: task.taskId }, data: { state: "merged", subState: null } });
          }
          // Every other open item reached nobody yet: its fan-out hasn't run.
          const itemId = await raise(task, projectId, { reason: index === 1 ? "approval" : "question", audience }, seeded % 2 === 0);
          if (itemState !== "open") {
            await harness.test.db.$transaction((tx) => resolveNeedsYouItemsInTx(harness.deps.ports, tx, { id: itemId }, { state: itemState, at: new Date(), byMemberId: null }));
            // Half the closes haven't reached the notifications yet: theirs still read open.
            if (seeded % 3 === 0) {
              await fanOutNotification({ db: harness.test.db, ...harness.deps.ports }, { itemId, change: itemState });
            }
          }
          seeded += 1;
        }
      }
    }
    // A task in needs you from before items; an admins' item; another organization's.
    await seedTask(harness, { organizationId: orgA, projectId: open, title: "before items", state: "needs_you" });
    const noKey = await seedTask(harness, { organizationId: orgA, projectId: open, title: "no key", state: "queued" });
    await raise(noKey, open, { reason: "no_provider_for_model", audience: "organization_admins" });
    const theirs = await seedTask(harness, { organizationId: b.organization.id, projectId: b.project.id, title: "theirs", state: "needs_you" });
    await raise(theirs, b.project.id, { reason: "question", audience: "project_members", organizationId: b.organization.id });

    for (const who of [a.admin, a.member, a.insider, b.admin]) {
      const seen = await surfaces(who);
      expect(seen.homeTotal).toBeGreaterThan(0);
      expect(seen.listTotal).toBe(seen.homeTotal);
      expect(seen.pageTotal).toBe(seen.homeTotal);
      expect(seen.sidebar).toBe(seen.homeTotal);
      expect(seen.listRows).toHaveLength(seen.homeTotal);
      expect([...seen.pageRows].sort()).toEqual([...seen.listRows].sort());
      expect(seen.homeRows).toEqual(seen.listRows.slice(0, 5));
      expect(seen.pageStates).toEqual(["open"]);
      expect(seen.unread).toBeLessThanOrEqual(seen.pageTotal);
    }
  });
});
