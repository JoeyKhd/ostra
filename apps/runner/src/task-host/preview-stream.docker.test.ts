import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { localBoxWithFakeBrowser, startLocalDockerBox } from "../testing/docker-box.ts";
import { previewStreamCases } from "../testing/preview-stream-cases.ts";

// Milestone 8's ticket 18 (F-141) on the `docker` executor, as a box's sidecar drives it:
// `DockerExecutor` through the real bridge to a local init, whose browser is the fake box browser
// over the init's DevTools pipe (this machine has no image). The same cases run on every executor
// (`preview-stream.{host,docker,kubernetes}.test.ts`).

const cases = previewStreamCases({ name: "docker", makeExecutor: localBoxWithFakeBrowser("docker"), makeExecutorWithoutBrowser: startLocalDockerBox });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("the browser view on docker", () => {
  it("F-141/c2, c9: on docker, a view streams the box's browser as JPEG frames on its own connection, at most 15 a second, waits on core's acks, and stops when it closes", cases.streams, 300_000);
  it("F-141/c3, c1: on docker, two views of a preview share one page, the width preset applies to it (the last one chosen), and the page goes with the last view", cases.shares, 300_000);
  it("F-141/c2: on docker, a member's input reaches the page in order, and typed text reaches no log line", cases.input, 300_000);
  it("F-141/c4, c9: on docker, a view of a port that isn't a preview is refused, and a stale lease's connection is refused", cases.refuses, 300_000);
  it("F-141/c8: on docker, on the HTTP carrier a view's frames are posted at most 2 a second, its input and the pane's width preset come as preview.input naming an open view, and a closed view ends", cases.http, 300_000);
  it("F-141/c1: on docker, a box with no browser takes a browser view's open, then drops the view before it connects and tells core why (preview.dropped, no-browser)", cases.drops, 300_000);
});
