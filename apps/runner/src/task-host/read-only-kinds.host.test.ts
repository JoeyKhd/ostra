import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { readOnlyKindsCases } from "../testing/read-only-kinds-cases.ts";

// Ticket 22 (F-099, F-100) on the `host` executor: a refine and a review task behind the real git
// proxy, with the scripted fake agent. The same cases on `docker` are `read-only-kinds.docker.test.ts`.

const cases = readOnlyKindsCases({ name: "host" });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("refine and review tasks on host (ticket 22)", () => {
  it("F-099/c2: on host, a refine task's push and hidden-ref push from the agent's shell are refused before anything reaches the fake upstream", cases.refinePushRefused, 180_000);
  it("F-099/c2: on host, the runner pushes nothing after a refine turn that changed files, and the session archive still goes up", cases.refinePushesNothing, 180_000);
  it("F-100/c1: on host, a review task's repos sit at the given heads, detached, with the base fetched, and the runner pushes nothing", cases.reviewAtHeads, 180_000);
  it("F-099/c4, F-100/c2: on host, the agent's submit_draft and submit_review reach the fake core with the task's token", cases.toolsReachCore, 240_000);
});
