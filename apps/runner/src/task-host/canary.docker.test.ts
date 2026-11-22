import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { canaryCases } from "../testing/canary-cases.ts";
import { startLocalDockerBox } from "../testing/docker-box.ts";

// F-116 (ADR 0031) on the `docker` executor as a box's sidecar drives it: the agent in the agent's
// container through the real bridge to a local init, its shell call's read in the event log. The
// same case on `host` and `kubernetes` is `canary.{host,kubernetes}.test.ts`; in a real box on
// Linux, the canary outside `/task` is the live run's.

const cases = canaryCases({ name: "docker", makeExecutor: startLocalDockerBox });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("the canary on docker", () => {
  it("F-116/c7: on docker, a canary file outside the task's workspace, read by a scripted shell call, shows in the event log with its path and what it read", cases.readShowsInTheLog, 180_000);
});
