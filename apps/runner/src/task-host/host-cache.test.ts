import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { projectIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";

// Milestone 3's ticket 15 through the task host, on `host` with the real executor and the git
// upstream stub behind the task's own git proxy: a task whose spec names the project's host cache
// reports it in `environment.setup_finished`, cold for the project's first task and warm for the
// next, with the setup's duration (F-051).

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("host-cache");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const SETUP = ['if [ -f "$OSTRA_DEPENDENCY_CACHE/installed" ]; then echo warm; else sleep 1; echo cold; fi', 'touch "$OSTRA_DEPENDENCY_CACHE/installed"', ""].join("\n");

describe("the host cache through the task host (F-051)", () => {
  it("F-051: the project's second task reports a warm dependency cache with its setup's duration", async () => {
    harness = await startHarness(shared);
    const h = harness;
    const projectId = projectIdSchema.parse("project-runner-cache");
    const patch = {
      projectId,
      environment: { ...taskSpecFixture.environment, setupScript: SETUP },
      snapshot: { kind: "host-cache" as const, cacheKey: projectId },
    };
    const first = h.taskFor(fakeMarker("say"), patch);
    h.dispatch(first.spec);
    await h.waitForKind(first.spec, "session.saved", 1, 120_000);
    const second = h.taskFor(fakeMarker("say"), patch);
    h.dispatch(second.spec);
    await h.waitForKind(second.spec, "session.saved", 1, 120_000);

    const [cold] = h.ofKind(first.spec, "environment.setup_finished");
    const [warm] = h.ofKind(second.spec, "environment.setup_finished");
    expect(cold).toMatchObject({ exitCode: 0, dependencyCache: "cold" });
    expect(warm).toMatchObject({ exitCode: 0, dependencyCache: "warm" });
    expect(warm?.durationMs).toBeGreaterThanOrEqual(0);
    // The cold setup slept while it "installed"; the warm one found the cache and didn't.
    expect(warm?.durationMs ?? Infinity).toBeLessThan(cold?.durationMs ?? 0);
    const said = h.ofKind(second.spec, "environment.setup_output").map((event) => event.text).join("");
    expect(said).toContain("warm");

    // A spec without the host cache says nothing of one.
    const plain = h.taskFor(fakeMarker("say"), { environment: { ...taskSpecFixture.environment, setupScript: "echo plain\n" } });
    h.dispatch(plain.spec);
    await h.waitForKind(plain.spec, "session.saved", 1, 120_000);
    expect(h.ofKind(plain.spec, "environment.setup_finished")[0]).not.toHaveProperty("dependencyCache");
  }, 300_000);
});
