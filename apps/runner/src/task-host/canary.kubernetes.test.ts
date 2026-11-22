import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { canaryCases } from "../testing/canary-cases.ts";
import { startLocalPodBox } from "../testing/docker-box.ts";

// F-116 (ADR 0031) on the `kubernetes` executor as a pod's sidecar drives it: the same executor and
// init as `docker`, reaching the app at the pod's `localhost`. The same case on `host` and `docker`
// is `canary.{host,docker}.test.ts`.

const cases = canaryCases({ name: "kubernetes", makeExecutor: startLocalPodBox });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("the canary on kubernetes", () => {
  it("F-116/c7: on kubernetes, a canary file outside the task's workspace, read by a scripted shell call, shows in the event log with its path and what it read", cases.readShowsInTheLog, 180_000);
});
