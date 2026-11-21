import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { liveBrowser } from "../testing/app-pictures-cases.ts";
import { previewStreamCases } from "../testing/preview-stream-cases.ts";

// Milestone 8's ticket 18 (F-141) on the `host` executor, live, with the `test-web` fixture on this
// machine's own `localhost` and its own browser (Edge here); on a Linux CI machine without
// OSTRA_RUNNER_BROWSER, the fake box browser over the same pipe. The same cases run on every
// executor (`preview-stream.{host,docker,kubernetes}.test.ts`).

const cases = previewStreamCases({ name: "host" });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe(`the browser view on host (${liveBrowser ? "the machine's browser" : "the fake browser"})`, () => {
  it("F-141/c2, c9: on host, a view streams the box's browser as JPEG frames on its own connection, at most 15 a second, waits on core's acks, and stops when it closes", cases.streams, 300_000);
  it("F-141/c3, c1: on host, two views of a preview share one page, the width preset applies to it (the last one chosen), and the page goes with the last view", cases.shares, 300_000);
  it("F-141/c2: on host, a member's click counts the counter, typed keys and pasted text land in the field, and typed text reaches no log line", cases.input, 300_000);
  it("F-141/c4, c9: on host, a view of a port that isn't a preview is refused, the page never loads a box port no preview may reach, and a stale lease's connection is refused", cases.refuses, 300_000);
  it("F-141/c8: on host, on the HTTP carrier a view's frames are posted at most 2 a second, its input and the pane's width preset come as preview.input naming an open view, and a closed view ends", cases.http, 300_000);
});
