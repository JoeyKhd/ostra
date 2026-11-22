import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { canaryCases } from "../testing/canary-cases.ts";

// F-116 (ADR 0031) on the `host` executor: the canary, read by the agent's scripted shell call, in
// the event log. The same case on `docker` and `kubernetes` is `canary.{docker,kubernetes}.test.ts`.

const cases = canaryCases({ name: "host" });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("the canary on host", () => {
  it("F-116/c7: on host, a canary file outside the task's workspace, read by a scripted shell call, shows in the event log with its path and what it read", cases.readShowsInTheLog, 120_000);
});
