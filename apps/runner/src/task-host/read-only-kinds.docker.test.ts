import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { startLocalDockerBox } from "../testing/docker-box.ts";
import { readOnlyKindsCases } from "../testing/read-only-kinds-cases.ts";

// Ticket 22 (F-099, F-100) on the `docker` executor as a box's sidecar drives it: `DockerExecutor`
// through the real bridge to a local init, the git proxy and ostra's tools in the sidecar, as on
// the box network. The same cases on `host` are `read-only-kinds.host.test.ts`; on Linux with
// Docker, the proxy on a real box network is F-017's live run.

const cases = readOnlyKindsCases({ name: "docker", makeExecutor: startLocalDockerBox });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("refine and review tasks on docker (ticket 22)", () => {
  it("F-099/c2: on docker, a refine task's push and hidden-ref push from the agent's shell are refused before anything reaches the fake upstream", cases.refinePushRefused, 180_000);
  it("F-099/c2: on docker, the runner pushes nothing after a refine turn that changed files, and the session archive still goes up", cases.refinePushesNothing, 180_000);
  it("F-100/c1: on docker, a review task's repos sit at the given heads, detached, with the base fetched, and the runner pushes nothing", cases.reviewAtHeads, 180_000);
  it("F-151/c1: on docker, a review and a refine task's after-turn save lists no repos and still uploads the archive, and a code task's lists each repo with its hidden ref", cases.savesNoRepos, 240_000);
  it("F-099/c4, F-100/c2: on docker, the agent's submit_draft and submit_review reach the fake core with the task's token", cases.toolsReachCore, 240_000);
});
