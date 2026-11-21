import { readFile } from "node:fs/promises";

import { setupTimelineSteps } from "@ostra/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureFirstAdmin } from "../auth/first-admin.ts";
import { createApiHarness, createBareHarness, cookieHeaderFrom, TEST_PASSWORD } from "../testing/index.ts";
import type { ApiHarness, BareHarness } from "../testing/index.ts";
import { seedConnectionAndModel, seedLinearConnection, seedPersonalRunner, seedTask } from "../testing/world.ts";
import { createContext } from "../trpc/context.ts";
import { setupStepDocs, setupStepIds } from "./setup.ts";

// F-076, milestone 7 ticket 24: setup's last pieces. The checklist is complete without Linear and
// ticks Linear once it's connected; each step links to its page in the docs; and `setup.timeline`
// reads each step's time from the audit entries and the first PR's event, for the 30-minute measure.

const minute = 60_000;
const start = Date.UTC(2026, 10, 20, 9, 0, 0);

describe("the checklist without Linear (F-076)", () => {
  let harness: ApiHarness;

  beforeAll(async () => {
    harness = await createApiHarness();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it("F-076/c1: setup completes without Linear, and ticks Linear when it's connected", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const linearOf = async () => (await admin.setup.status()).steps.find((step) => step.id === "linear")?.state;

    // Organization A has its project already; the model provider and GitHub come next.
    await seedConnectionAndModel(harness);
    expect(await admin.setup.status()).toMatchObject({ next: "linear", complete: false });
    const runnerId = await seedPersonalRunner(harness, a.admin.id, "laptop");
    expect((await admin.setup.status()).complete).toBe(false);
    await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id, runnerId });

    // Every required step done, Linear untouched: setup is complete, and Linear stays offered.
    const done = await admin.setup.status();
    expect(done.steps.filter((step) => step.state !== "done").map((step) => [step.id, step.state])).toEqual([["linear", "open"]]);
    expect(done).toMatchObject({ next: "linear", complete: true });

    // A connection in progress says so, and still doesn't hold setup back.
    const pending = await seedLinearConnection(harness, { state: "pending" });
    expect(await linearOf()).toBe("pending");
    expect((await admin.setup.status()).complete).toBe(true);

    // Connected: the step ticks, and nothing is left.
    await harness.test.db.connection.update({ where: { id: pending }, data: { state: "active" } });
    expect(await linearOf()).toBe("done");
    expect(await admin.setup.status()).toMatchObject({ next: null, complete: true });
    expect((await admin.setup.status()).steps.every((step) => step.state === "done")).toBe(true);

    // A required step undone later reopens it, and setup stays done (2026-11-21): the runner offline
    // brings no checklist back, and Home says no runner is online instead.
    await harness.test.db.runner.update({ where: { id: runnerId }, data: { state: "offline" } });
    expect(await admin.setup.status()).toMatchObject({ next: "runner", complete: true, runnerOnline: false });
  });

  it("F-076/c1: each step links to its page in the docs, under OSTRA_DOCS_URL, and the page and heading exist", async () => {
    const steps = (await (await harness.as(harness.fixture.a.member)).setup.status()).steps;
    expect(steps.map((step) => step.id)).toEqual([...setupStepIds]);
    const slug = (heading: string): string =>
      heading
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .replace(/ /g, "-");
    for (const step of steps) {
      expect(step.docs, step.id).toBe(`https://docs.example.com/ostra/${setupStepDocs[step.id]}`);
      const [page = "", anchor] = setupStepDocs[step.id].replace(/^docs\//, "").split("#");
      const source = await readFile(new URL(`../../../../apps/docs/content/${page.replace(/\/$/, "")}.mdx`, import.meta.url), "utf8");
      if (anchor !== undefined) {
        const headings = [...source.matchAll(/^#{2,3} (.+)$/gm)].map((match) => slug(match[1] ?? ""));
        expect(headings, step.id).toContain(anchor);
      }
    }
  });
});

describe("setup.timeline (F-076)", () => {
  let harness: ApiHarness;

  beforeAll(async () => {
    harness = await createApiHarness();
    const { a } = harness.fixture;
    // A is the install's first organization; its admin is the instance admin.
    await harness.test.db.organization.update({ where: { id: a.organization.id }, data: { createdAt: new Date(Date.UTC(2026, 0, 1)) } });
    await harness.test.db.user.update({ where: { id: a.admin.userId }, data: { role: "admin" } });
  });

  afterAll(async () => {
    await harness.dispose();
  });

  /** Each step's entry, minutes after the start; a repeat and another organization's mixed in. */
  const seeded: Readonly<Record<string, number>> = {
    "password.changed": 1,
    "provider.added": 3,
    "installation.linked": 6,
    "linear.connected": 7,
    "project.created": 9,
    "runner.approved": 12,
    "task.created": 14,
  };

  /** Writes the named actions' entries (every one by default). Entries are never deleted (F-073). */
  const seed = async (actions: readonly string[] = Object.keys(seeded)) => {
    const { a, b } = harness.fixture;
    const rows = actions.flatMap((action) => {
      const minutes = seeded[action] ?? 0;
      return [
        { organizationId: a.organization.id, actorKind: "member" as const, action, createdAt: new Date(start + minutes * minute) },
        // A later repeat: the earliest counts.
        { organizationId: a.organization.id, actorKind: "member" as const, action, createdAt: new Date(start + (minutes + 30) * minute) },
        // Organization B did it earlier: it counts for nothing in A's timeline.
        { organizationId: b.organization.id, actorKind: "member" as const, action, createdAt: new Date(start - 60 * minute) },
      ];
    });
    await harness.test.db.auditEntry.createMany({ data: rows });
  };

  const seedPullRequest = async (at: number) => {
    const { a } = harness.fixture;
    const task = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id });
    await harness.test.db.event.create({
      data: {
        organizationId: a.organization.id,
        projectId: a.openProject.id,
        taskId: task.taskId,
        seq: 1,
        sessionId: task.sessionId,
        sessionSeq: 1,
        kind: "pr.opened",
        payload: {},
        occurredAt: new Date(at),
      },
    });
  };

  it("F-076: a step whose entry is missing is reported missing, and the total waits for it", async () => {
    // Every step's entry but the model provider's and Linear's.
    await seed(Object.keys(seeded).filter((action) => action !== "provider.added" && action !== "linear.connected"));
    const timeline = await (await harness.as(harness.fixture.a.admin)).setup.timeline({ start });
    expect(timeline.steps.find((row) => row.step === "model-provider")).toEqual({ step: "model-provider", state: "missing", optional: false });
    // Linear is optional: missing, but not what holds the total back.
    expect(timeline.steps.find((row) => row.step === "linear")).toEqual({ step: "linear", state: "missing", optional: true });
    // No PR yet either: the last step is missing too.
    expect(timeline.missing).toEqual(["model-provider", "first-pr"]);
    expect(timeline.totalMs).toBeNull();
  });

  it("F-076: the timeline's times equal the seeded audit entries' and the first PR's event, measured from the start", async () => {
    // The two entries the test before left out: now every step has one.
    await seed(["provider.added", "linear.connected"]);
    await seedPullRequest(start + 22 * minute);
    // A second PR, later: the first one counts.
    await seedPullRequest(start + 40 * minute);
    const timeline = await (await harness.as(harness.fixture.a.admin)).setup.timeline({ start });
    expect(timeline.organizationId).toBe(harness.fixture.a.organization.id);
    expect(timeline.steps.map((row) => row.step)).toEqual([...setupTimelineSteps]);
    const expected = [1, 3, 6, 7, 9, 12, 14, 22];
    expect(timeline.steps.map((row) => (row.state === "done" ? row.at : row.state))).toEqual(expected.map((minutes) => start + minutes * minute));
    expect(timeline.steps.map((row) => (row.state === "done" ? row.sinceStartMs : row.state))).toEqual(expected.map((minutes) => minutes * minute));
    expect(timeline).toMatchObject({ start, missing: [], totalMs: 22 * minute });
  });

  it("is the instance admin's alone, and takes nothing but the start", async () => {
    const { a } = harness.fixture;
    await harness.test.db.user.update({ where: { id: a.member.userId }, data: { role: "user" } });
    await expect((await harness.as(a.member)).setup.timeline({ start })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // An organization admin who isn't the instance admin is refused too.
    await harness.test.db.user.update({ where: { id: a.admin.userId }, data: { role: "user" } });
    await expect((await harness.as(a.admin)).setup.timeline({ start })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await harness.test.db.user.update({ where: { id: a.admin.userId }, data: { role: "admin" } });
    const admin = await harness.as(a.admin);
    // @ts-expect-error the input is the start alone: no organization can be named
    await expect(admin.setup.timeline({ start, organizationId: harness.fixture.b.organization.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(harness.anonymous().setup.timeline({ start })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("the password change's entry (F-076)", () => {
  let harness: BareHarness;

  beforeAll(async () => {
    harness = await createBareHarness();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it("F-076: changing the password through better-auth writes password.changed, which the timeline reads as the first step", async () => {
    const seeded = await ensureFirstAdmin({
      db: harness.test.db,
      settings: { firstAdmin: { email: "first@example.com", username: "first", password: TEST_PASSWORD, organizationName: "First Co" } },
      hashPassword: harness.deps.hashPassword,
      ports: harness.deps.ports,
      logger: harness.deps.logger,
    });
    if (seeded === null) throw new Error("the install already had an account");
    const signIn = async (password: string) =>
      cookieHeaderFrom((await harness.auth.api.signInUsername({ body: { username: "first", password }, returnHeaders: true })).headers);
    const before = Date.now();
    const newPassword = `${TEST_PASSWORD}-changed`;
    await harness.auth.api.changePassword({ body: { currentPassword: TEST_PASSWORD, newPassword }, headers: await signIn(TEST_PASSWORD) });

    const entries = await harness.test.db.auditEntry.findMany({ where: { action: "password.changed" } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({ organizationId: seeded.organizationId, actorId: seeded.memberId, entity: "user", entityId: seeded.userId });
    expect(JSON.stringify(entry?.data)).not.toContain(newPassword);

    const caller = harness.callerFor(await createContext(harness.deps, { headers: await signIn(newPassword), resHeaders: new Headers() }));
    const timeline = await caller.setup.timeline({ start: before });
    expect(timeline.steps.find((row) => row.step === "password")).toEqual({
      step: "password",
      state: "done",
      optional: false,
      at: entry?.createdAt.getTime(),
      sinceStartMs: (entry?.createdAt.getTime() ?? 0) - before,
    });
  });
});
