import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { startLocalDockerBox } from "../testing/docker-box.ts";
import { severalReposCases } from "../testing/several-repos-cases.ts";

// Milestone 4's ticket 21 (F-098) on the `docker` executor, as a box's sidecar drives it: `DockerExecutor`
// through the real bridge to a local init, with two bare repos behind the real git proxy. The same
// cases on `host` are `several-repos.host.test.ts`; the box's own resources on the Engine API are
// `box-dispatcher.test.ts` and the executor's `box-per-task.test.ts`, against the fake engine.

const cases = severalReposCases({ name: "docker", makeExecutor: startLocalDockerBox });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("several repos on docker", () => {
  it("F-098/c1,c2: on docker, both repos are checked out side by side on the task's one branch, the agent at the root told about both", cases.sideBySide, 240_000);
  it("F-098/c2: on docker, a turn that changes one repo pushes that one, and the other gets no branch", cases.onePushesOne, 240_000);
  it("F-098/c2: on docker, a turn that changes both repos pushes both, on the same branch", cases.bothPushBoth, 240_000);
  it("F-098/c3: on docker, a reopen on a fresh worktree restores each repo from its own hidden ref, and clones a repo new to the task at its base", cases.reopenRestoresBoth, 300_000);
  it("F-098/c2: on docker, the git proxy refuses a push to another task's branch in either repo, and takes the task's own", cases.proxyRefusesOtherBranch, 240_000);
  it("F-098/c1: on docker, each repo is cloned with its own git token", cases.ownTokenPerRepo, 240_000);
  it("F-136/c10: on docker, repos of two Apps are each committed by their own bot, the agent's commits and ostra's, with the member's trailer", cases.ownIdentityPerRepo, 240_000);
  it("F-098/c1: on docker, each task's workspace holds its own repos and nothing of another task's", cases.containment, 240_000);
  it("F-098/c1: on docker, instructions that name other folders than the spec's repos crash the session before anything is cloned", cases.foldersMustMatch, 240_000);
});
