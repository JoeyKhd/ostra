import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { appPicturesCases, liveBrowser } from "../testing/app-pictures-cases.ts";

// Milestone 8's ticket 13 (F-121) on the `host` executor, live, with the `test-web` fixture on this
// machine's own `localhost` and its own browser (Edge here); on a Linux CI machine without
// OSTRA_RUNNER_BROWSER, the fake box browser over the same pipe. The same cases run on every
// executor (`app-pictures.{host,docker,kubernetes}.test.ts`).

const cases = appPicturesCases({ name: "host" });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe(`the app's pictures on host (${liveBrowser ? "the machine's browser" : "the fake browser"})`, () => {
  it("F-121/c1,c3,c4,c8: on host, take_screenshot and record_app each give a blob of the task and its event naming the browser, a recording a frame reel within its limits and one cut short by a failing step, and each refusal says why", cases.tools, 300_000);
  it("F-121/c1,c4: on host, after a turn that changed a repo each route is taken at each width before session.saved, and none after a turn that changed nothing, with no primary, or with a primary that never gets ready", cases.afterTurn, 300_000);
  it("F-121/c7,c8: on host, a member's screenshot from the pane is one of a preview's, with the member's and the request's IDs, and a key that isn't a preview is refused", cases.member, 240_000);
  it("F-121/c9: on host, the turn's 21st picture is refused, the after-turn screenshots are skipped with a note, a member's doesn't count, and the next turn counts from 0", cases.limit, 300_000);
  it("F-121/c1,c8: on host, a box with no browser says so in each tool's answer and in app.browser, and skips the after-turn screenshots with a note", cases.noBrowser, 240_000);
  it("F-121/c10: on host, a caption and steps holding shell syntax and prompt-like text are in the event and the reel, and in no log line", cases.hostileText, 240_000);
});
