import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { localBoxWithFakeBrowser } from "../testing/docker-box.ts";
import { previewStreamCases } from "../testing/preview-stream-cases.ts";

// Milestone 8's ticket 18 (F-141) on the `kubernetes` executor, as a box's sidecar drives it:
// `DockerExecutor` through the real bridge to a local init, whose browser is the fake box browser
// over the init's DevTools pipe (this machine has no image). The same cases run on every executor
// (`preview-stream.{host,docker,kubernetes}.test.ts`).

const cases = previewStreamCases({ name: "kubernetes", makeExecutor: localBoxWithFakeBrowser("kubernetes") });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("the browser view on kubernetes", () => {
  it("F-141/c2, c9: on kubernetes, a view streams the box's browser as JPEG frames on its own connection, at most 15 a second, waits on core's acks, and stops when it closes", cases.streams, 300_000);
  it("F-141/c3, c1: on kubernetes, two views of a preview share one page, the width preset applies to it (the last one chosen), and the page goes with the last view", cases.shares, 300_000);
  it("F-141/c2: on kubernetes, a member's input reaches the page in order, and typed text reaches no log line", cases.input, 300_000);
  it("F-141/c4, c9: on kubernetes, a view of a port that isn't a preview is refused, and a stale lease's connection is refused", cases.refuses, 300_000);
  it("F-141/c8: on kubernetes, on the HTTP carrier a view's frames are posted at most 2 a second, its input comes as preview.input naming an open view, and a closed view ends", cases.http, 300_000);
});
