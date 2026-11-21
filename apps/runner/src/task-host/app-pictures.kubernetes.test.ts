import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { localBoxWithFakeBrowser, startLocalPodBox } from "../testing/docker-box.ts";
import { appPicturesCases } from "../testing/app-pictures-cases.ts";

// Milestone 8's ticket 13 (F-121) on the `kubernetes` executor, as a pod's sidecar drives it: the
// same executor and init, with the fake box browser over the init's DevTools pipe, reaching the
// app at the pod's `localhost` (`appReach: "loopback"`). The same cases run on every executor
// (`app-pictures.{host,docker,kubernetes}.test.ts`).

const cases = appPicturesCases({ name: "kubernetes", makeExecutor: localBoxWithFakeBrowser("kubernetes"), makeExecutorWithoutBrowser: startLocalPodBox });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("the app's pictures on kubernetes", () => {
  it("F-121/c1,c3,c4,c8: on kubernetes, take_screenshot and record_app each give a blob of the task and its event naming the browser, a recording a frame reel within its limits and one cut short by a failing step, and each refusal says why", cases.tools, 300_000);
  it("F-121/c1,c4: on kubernetes, after a turn that changed a repo each route is taken at each width before session.saved, and none after a turn that changed nothing, with no primary, or with a primary that never gets ready", cases.afterTurn, 300_000);
  it("F-121/c7,c8: on kubernetes, a member's screenshot from the pane is one of a preview's, with the member's and the request's IDs, and a key that isn't a preview is refused", cases.member, 240_000);
  it("F-121/c9: on kubernetes, the turn's 21st picture is refused, the after-turn screenshots are skipped with a note, a member's doesn't count, and the next turn counts from 0", cases.limit, 300_000);
  it("F-121/c1,c8: on kubernetes, a box with no browser says so in each tool's answer and in app.browser, and skips the after-turn screenshots with a note", cases.noBrowser, 240_000);
  it("F-121/c10: on kubernetes, a caption and steps holding shell syntax and prompt-like text are in the event and the reel, and in no log line", cases.hostileText, 240_000);
});
