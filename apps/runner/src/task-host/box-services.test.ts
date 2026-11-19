import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ServiceHealth } from "@ostra/adapter-sdk";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { taskSpecSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";

// Milestone 3's ticket 14 through the task host, as a `docker` box's sidecar runs it: the host
// executor on the task volume, declaring the box's services, with each one's health as the box's
// pool runner reports it (here, answered by the test). The task reports `service.healthy` and
// `service.failed`, and a service that didn't start fails the setup before the agent (F-094).

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("box-services");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const services: NonNullable<TaskSpec["services"]> = taskSpecSchema.parse({
  ...taskSpecFixture,
  services: [
    { name: "postgres", image: "postgres:17", port: 5432, variables: [], healthCheck: "pg_isready" },
    { name: "cache", image: "redis:7", port: 6379, variables: [], healthCheck: null },
  ],
}).services ?? [];

const boxWith = async (health: readonly ServiceHealth[]): Promise<{ readonly harness: Harness; readonly asked: string[][] }> => {
  const asked: string[][] = [];
  const started = await startHarness(shared, {
    executor: {
      boxCapabilities: { services: true, snapshots: "image" },
      awaitServices: (spec) => {
        asked.push((spec.services ?? []).map((service) => service.name));
        return Promise.resolve(health);
      },
    },
  });
  return { harness: started, asked };
};

describe("a docker box's services through the task host (F-094)", () => {
  it("F-094: each service's health is reported, in the spec's order, before the setup runs", async () => {
    const box = await boxWith([
      { name: "postgres", outcome: "healthy", afterMs: 2_400 },
      { name: "cache", outcome: "healthy", afterMs: 300 },
    ]);
    harness = box.harness;
    const task = harness.taskFor(fakeMarker("say"), { services, environment: { ...taskSpecFixture.environment, setupScript: "echo set up\n" } });
    harness.dispatch(task.spec);
    await harness.waitForKind(task.spec, "session.saved", 1, 120_000);
    expect(box.asked).toEqual([["postgres", "cache"]]);
    expect(harness.ofKind(task.spec, "service.healthy")).toEqual([
      expect.objectContaining({ kind: "service.healthy", name: "postgres", afterMs: 2_400 }),
      expect.objectContaining({ kind: "service.healthy", name: "cache", afterMs: 300 }),
    ]);
    const kinds = harness.kinds(task.spec);
    expect(kinds.indexOf("service.healthy")).toBeLessThan(kinds.indexOf("environment.setup_finished"));
    expect(kinds).not.toContain("service.failed");
  }, 180_000);

  it("F-094: a service that didn't start is reported with its words, and the setup and the agent never run", async () => {
    const box = await boxWith([
      { name: "postgres", outcome: "failed", reason: "The service's health check kept failing." },
      { name: "cache", outcome: "healthy", afterMs: 300 },
    ]);
    harness = box.harness;
    const task = harness.taskFor(fakeMarker("say"), { services, environment: { ...taskSpecFixture.environment, setupScript: "echo set up\n" } });
    harness.dispatch(task.spec);
    await harness.waitForKind(task.spec, "session.crashed", 1, 120_000);
    expect(harness.ofKind(task.spec, "service.failed")).toEqual([
      expect.objectContaining({ kind: "service.failed", name: "postgres", reason: "The service's health check kept failing." }),
    ]);
    expect(harness.ofKind(task.spec, "service.healthy").map((event) => event.name)).toEqual(["cache"]);
    expect(harness.kinds(task.spec)).not.toContain("environment.setup_finished");
    expect(harness.ofKind(task.spec, "environment.setup_output")).toEqual([]);
    expect(harness.launches).toEqual([]);
    expect(harness.ofKind(task.spec, "session.crashed")[0]?.error).toContain("postgres");
  }, 180_000);
});
