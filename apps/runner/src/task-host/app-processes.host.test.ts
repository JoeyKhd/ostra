import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { appProcessesCases } from "../testing/app-processes-cases.ts";

// Milestone 8's ticket 12 (F-140, F-141) on the `host` executor, live, with the `test-web` fixture
// on this machine's own `localhost`. The same cases run on every executor
// (`app-processes.{host,docker,kubernetes}.test.ts`).

const cases = appProcessesCases({ name: "host" });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("the app's processes on host", () => {
  it("F-140/c4,c5,c6,c11,c12: on host, start_app starts the app's processes in the list's order, each once the one before is ready, logs them in the task's folder, gives each the in-box addresses, answers the frontend's /api through Vite's proxy, and stops them with the box", cases.inOrder, 300_000);
  it("F-140/c5, F-121/c10: on host, a process that exits or never gets ready is reported with its code and its log's tail as a blob, and its log's hostile text reaches no log line, event or argument list", cases.failures, 240_000);
  it("F-140/c4: on host, app.start and then app.stop sent while the box still gets ready start nothing behind the stop: never ready, its port closed", cases.stoppedBeforeTheBox, 240_000);
  it("F-140/c4,c9, F-141/c4: on host, a port the agent's own server holds is reported in use, show_preview adds the agent's port to the previews, and the box's own port and one below 1024 are refused", cases.takenAndAnnounced, 240_000);
  it("F-141/c6,c7: on host, a dispatch with the purpose app starts the processes and no agent, with no model call, and a member's message then starts a turn in that box", cases.appOnly, 240_000);
});
