// The box's side of the native preview in its own process, for the panel's browser spec of milestone
// 8's ticket 26 (`apps/web/e2e/25-native-preview.spec.ts`, F-144): the runner's own tunnel code
// (`createPreviewViews`, `openPreviewConnection`), as a `host` runner's task host serves a native
// view, with every preview port of the box reaching one app on this machine. The e2e stack runs no
// runner, so the spec tells it which views core opened, one JSON line each on stdin:
// `{ "open": { "viewId", "key", "leaseEpoch" } }` or `{ "close": "<viewId>" }`.
// Usage: node native-box-child.ts '<json>' with `serverUrl` (core), `appPort` (the app), and the
// access token in OSTRA_TEST_ACCESS_TOKEN. It prints `ready`, then `served <viewId>` per view, and
// ends with its stdin.
import { createInterface } from "node:readline";

import { silentLogger } from "@ostra/adapter-sdk";
import { leaseEpochSchema, mayReach, previewKeySchema, previewTargets, previewViewIdSchema } from "@ostra/protocol";
import type { LeaseEpoch, PreviewViewId, ReservedPorts } from "@ostra/protocol";
import { z } from "zod";

import { openPreviewConnection } from "../connection/preview-connection.ts";
import { createPreviewViews } from "../task-host/preview-views.ts";

const argsSchema = z.strictObject({ serverUrl: z.string(), appPort: z.number().int().min(1).max(65_535) });
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const token = process.env["OSTRA_TEST_ACCESS_TOKEN"];
if (token === undefined || token === "") {
  process.stderr.write("native-box-child.ts needs OSTRA_TEST_ACCESS_TOKEN\n");
  process.exit(2);
}

const lineSchema = z.union([
  z.strictObject({ open: z.strictObject({ viewId: previewViewIdSchema, key: previewKeySchema, leaseEpoch: leaseEpochSchema }) }),
  z.strictObject({ close: previewViewIdSchema }),
]);

// The box as the e2e world declares it: `web` on 5173, its primary preview. Its own ports aren't known here.
const targets = previewTargets({ processes: [{ name: "web", port: 5173, label: "web", primary: true, position: 0 }], services: [], servicesRun: false }, []);
const reserved: ReservedPorts = { "key-proxy": null, "git-proxy": null, "mcp-proxy": null, "sidecar-control": null, "agent-loopback": null, browser: null };
const epochs = new Map<PreviewViewId, LeaseEpoch>();

const views = createPreviewViews({
  connect: (viewId, mode) => openPreviewConnection({ serverUrl: args.serverUrl, token, viewId, leaseEpoch: epochs.get(viewId) ?? leaseEpochSchema.parse(1), mode }),
  mayReach: (port) => mayReach(port, targets, reserved),
  reachPort: () => Promise.resolve({ ok: true, value: { host: "localhost", port: args.appPort, close: () => Promise.resolve() } }),
  settled: () => Promise.resolve(),
  logger: silentLogger,
  dropped: () => undefined,
});

const lines = createInterface({ input: process.stdin });
const parseLine = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

lines.on("line", (text) => {
  const parsed = lineSchema.safeParse(parseLine(text));
  if (!parsed.success) {
    return;
  }
  const line = parsed.data;
  if ("open" in line) {
    if (views.has(line.open.viewId)) {
      return;
    }
    epochs.set(line.open.viewId, line.open.leaseEpoch);
    views.open({ viewId: line.open.viewId, key: line.open.key, mode: "tunnel", ready: Promise.resolve(true) });
    process.stdout.write(`served ${line.open.viewId}\n`);
    return;
  }
  views.close(line.close, "closed");
});
lines.on("close", () => {
  views.closeAll("box-stopping");
  process.exit(0);
});
process.stdout.write("ready\n");
