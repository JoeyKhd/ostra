import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

describe("setup.status", () => {
  it("F-076/c1: derives the checklist from the tables, in order, and a first run keeps nothing as done", async () => {
    const { a, b } = harness.fixture;
    const caller = await harness.as(a.admin);
    const status = await caller.setup.status();
    expect({ steps: status.steps.map(({ id, state }) => ({ id, state })), next: status.next, complete: status.complete }).toEqual({
      steps: [
        { id: "admin", state: "done" },
        { id: "model-provider", state: "open" },
        { id: "github", state: "open" },
        { id: "linear", state: "open" },
        { id: "project", state: "done" },
        { id: "runner", state: "open" },
        { id: "first-task", state: "open" },
      ],
      next: "model-provider",
      complete: false,
    });
    // A first run: nothing is kept as done, and the checklist shows (F-076).
    expect(status).toMatchObject({ completedAt: null, runnerOnline: false });
    expect(await harness.test.db.organizationSetting.count({ where: { organizationId: a.organization.id, setupCompletedAt: { not: null } } })).toBe(0);
    // Organization B has a project too, and nothing of A's counts for it.
    expect((await (await harness.as(b.admin)).setup.status()).steps.find((step) => step.id === "project")?.state).toBe("done");
  });

  it("ticks a step when its row exists, only for the organization that has it", async () => {
    const { a, b } = harness.fixture;
    await harness.test.db.connection.create({ data: { organizationId: a.organization.id, kind: "github", appId: "1" } });
    await harness.test.db.runner.create({
      data: {
        organizationId: a.organization.id,
        kind: "personal",
        ownerMemberId: a.admin.id,
        name: "laptop",
        publicKey: "k".repeat(43),
        executor: "host",
        capacity: 1,
        version: "0.0.0",
        state: "online",
      },
    });
    const steps = (await (await harness.as(a.admin)).setup.status()).steps;
    expect(steps.find((step) => step.id === "github")?.state).toBe("done");
    expect(steps.find((step) => step.id === "runner")?.state).toBe("done");
    const others = (await (await harness.as(b.admin)).setup.status()).steps;
    expect(others.find((step) => step.id === "github")?.state).toBe("open");
    expect(others.find((step) => step.id === "runner")?.state).toBe("open");
  });

  it("is for signed-in members", async () => {
    await expect(harness.anonymous().setup.status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
