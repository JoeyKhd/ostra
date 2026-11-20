import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { repoIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";

// F-066 (ticket 24), through the runner end to end on `host` with the fake agent and the git
// upstream stub behind the real git proxy: a two-repo task whose first repo merged and was
// reopened has a fresh branch there, and the second repo keeps the task's. Every push goes
// through the proxy, so its policy is part of the proof.

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("repo-branch");
  await shared.upstream.createRepo("ostra-test/test2", { "README.md": "# test2\n" }).catch(() => undefined);
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

describe("a repo on a branch of its own (F-066)", () => {
  it("F-066/c2: a merged repo pushes to its fresh branch and the other keeps the task's, in the events and on the host", async () => {
    harness = await startHarness(shared);
    const h = harness;
    const [first] = taskSpecFixture.repos;
    if (first === undefined) throw new Error("no fixture repo");
    // The task's branch name is made after the harness stamps it: the fresh one follows from it.
    const stamp = `${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
    const taskBranch = `ostra/f066-${stamp}-work`;
    const fresh = `${taskBranch}-2`;
    const merged = { ...first, branchName: fresh };
    const other = { ...first, repoId: repoIdSchema.parse("repo-test2"), fullName: "ostra-test/test2", cloneUrl: "https://github.com/ostra-test/test2.git", checkoutDir: "test2" };
    const { spec } = h.taskFor(fakeMarker("write", "test1/a.txt test2/b.txt"), {
      branchName: taskBranch,
      repos: [merged, other],
      environment: { ...taskSpecFixture.environment, setupScript: null, repos: [...taskSpecFixture.environment.repos, { repoId: other.repoId, variables: [], files: [], envFile: ".env" }] },
    });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1);

    // The events say which branch each repo went to: the merged repo's fresh one, the other's task branch.
    const pushed = h.ofKind(spec, "git.pushed").filter((event) => event.ref.startsWith("refs/heads/"));
    expect(pushed.map((event) => [event.repoId, event.branch, event.ref])).toEqual([
      [merged.repoId, fresh, `refs/heads/${fresh}`],
      [other.repoId, taskBranch, `refs/heads/${taskBranch}`],
    ]);
    // The hidden ref's event carries the repo's own branch as well.
    const hidden = h.ofKind(spec, "git.pushed").filter((event) => event.ref.startsWith("refs/ostra/wip/"));
    expect(hidden.map((event) => [event.repoId, event.branch])).toEqual(expect.arrayContaining([[merged.repoId, fresh], [other.repoId, taskBranch]]));

    // The host has them there, and nowhere else.
    expect(await shared.upstream.treeFiles("ostra-test/test1", `refs/heads/${fresh}`)).toContain("a.txt");
    expect(await shared.upstream.refSha("ostra-test/test1", `refs/heads/${taskBranch}`)).toBeNull();
    expect(await shared.upstream.treeFiles("ostra-test/test2", `refs/heads/${taskBranch}`)).toContain("b.txt");
    expect(await shared.upstream.refSha("ostra-test/test2", `refs/heads/${fresh}`)).toBeNull();
  }, 120_000);
});
