import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { startLocalPodBox } from "../testing/docker-box.ts";
import { readOnlyKindsCases } from "../testing/read-only-kinds-cases.ts";

// Milestone 10 (ticket 06, F-151) on the `kubernetes` executor, as a pod's sidecar drives it: a
// refine or review task's after-turn save lists no repos there too, since the save never reads the
// executor. Ticket 22's other cases run on `host` and `docker` (`read-only-kinds.{host,docker}.test.ts`);
// a pod's sidecar is the same executor and proxy as a docker box's, but for how it reaches the app.

const cases = readOnlyKindsCases({ name: "kubernetes", makeExecutor: startLocalPodBox });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("refine and review tasks on kubernetes (ticket 06)", () => {
  it("F-151/c1: on kubernetes, a review and a refine task's after-turn save lists no repos and still uploads the archive, and a code task's lists each repo with its hidden ref", cases.savesNoRepos, 240_000);
});
