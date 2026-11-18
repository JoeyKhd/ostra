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
  it("derives the checklist from the tables, in order", async () => {
    const { a, b } = harness.fixture;
    const caller = await harness.as(a.admin);
    expect(await caller.setup.status()).toEqual({
      steps: [
        { id: "admin", done: true },
        { id: "model-provider", done: false },
        { id: "github", done: false },
        { id: "project", done: true },
        { id: "runner", done: false },
        { id: "first-task", done: false },
      ],
      next: "model-provider",
    });
    // Organization B has a project too, and nothing of A's counts for it.
    expect((await (await harness.as(b.admin)).setup.status()).steps.find((step) => step.id === "project")?.done).toBe(true);
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
    expect(steps.find((step) => step.id === "github")?.done).toBe(true);
    expect(steps.find((step) => step.id === "runner")?.done).toBe(true);
    const others = (await (await harness.as(b.admin)).setup.status()).steps;
    expect(others.find((step) => step.id === "github")?.done).toBe(false);
    expect(others.find((step) => step.id === "runner")?.done).toBe(false);
  });

  it("is for signed-in members", async () => {
    await expect(harness.anonymous().setup.status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("setup.state", () => {
  it("is public, and says an install with an account needs no first admin", async () => {
    expect(await harness.anonymous().setup.state()).toEqual({ needsFirstAdmin: false, openSignup: false });
  });
});

describe("the first admin and the log", () => {
  it("never let the setup token or a password into a log line", async () => {
    const password = "a-password-that-must-never-be-logged";
    await expect(
      harness.anonymous().setup.createFirstAdmin({
        setupToken: harness.setupToken,
        username: "late",
        email: "late@example.com",
        password,
        organizationName: "Late",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const lines = JSON.stringify(harness.logs);
    expect(lines).not.toContain(harness.setupToken);
    expect(lines).not.toContain(password);
  });
});
