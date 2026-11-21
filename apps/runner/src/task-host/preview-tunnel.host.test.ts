import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { previewTunnelCases } from "../testing/preview-tunnel-cases.ts";

// Milestone 8's ticket 22 (F-143, F-144) on the `host` executor, live, with the `test-web` fixture on this machine's own `localhost`. The same cases run on every executor
// (`preview-tunnel.{host,docker,kubernetes}.test.ts`).

const cases = previewTunnelCases({ name: "host" });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("a view's tunnel on host", () => {
  it("F-143/c2, F-144/c1,c5: on host, the view's tunnel carries the fixture's Vite: CONNECTs with an HTTP request and a WebSocket at once, /api through Vite's proxy and HMR, and the native preview's plain requests and extended CONNECT with an edit's HMR message", cases.carries, 300_000);
  it("F-143/c3: on host, a stream to a port outside the task's previews, one of the box's own or one below 1024 is refused 403 before anything is dialled, and so is a view of another key", cases.refuses, 300_000);
  it("F-141/c5: on host, the box stays past its idle timer while one of its views is open, and ends at once when the last one closes", cases.idleHold, 300_000);
  it("F-143/c2: on host, preview.close ends the view's connection and its way to the port (on docker the forwarder its first stream opened), and a connection core closes ends the view", cases.closes, 300_000);
});
