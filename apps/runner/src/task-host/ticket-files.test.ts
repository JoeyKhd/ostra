import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { blobIdSchema, ticketFileNameFor } from "@ostra/protocol";
import type { TaskSpecContextFile } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";

// Ticket 26's "done when": files land under `.ostra/ticket/` with safe names; a path in a ticket
// can't escape the folder; the files aren't in a commit or the hidden ref; a failed download
// doesn't stop the turn.

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("ticket-files");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (): Promise<Harness> => {
  harness = await startHarness(shared);
  return harness;
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = Buffer.from("%PDF-1.7\n% a tiny document\n");

describe("ticket files in the workspace (F-064)", () => {
  it("writes images and PDFs under .ostra/ticket/ by blob and type, skips the rest, and starts the turn", async () => {
    const h = await start();
    const { spec, credentials } = h.taskFor(fakeMarker("write", "change.txt"));
    const blob = (bytes: Buffer, type: string, id?: string): TaskSpecContextFile => {
      const blobId = blobIdSchema.parse(h.server.putBlob(spec.taskId, bytes, type, id));
      // The name core puts in the spec may be anything the schema allows: the runner names the file itself.
      return { blobId, path: "Screenshot 1.png", contentType: type, size: bytes.length };
    };
    const image = blob(PNG, "image/png");
    const document = blob(PDF, "application/pdf");
    const page = blob(Buffer.from("<script>alert(1)</script>"), "text/html");
    const missing = blob(PNG, "image/png");
    h.server.bulkFaults.failDownloads.add(missing.blobId);
    const corrupt = blob(PNG, "image/png");
    h.server.bulkFaults.corruptDownloads.add(corrupt.blobId);
    // A blob ID that reads like a path: its name still can't leave the folder.
    const climbing = blob(PNG, "image/jpeg", "../../escape");
    const withFiles = { ...spec, contextFiles: [image, document, page, missing, corrupt, climbing] };
    h.server.tasks.set(spec.taskId, { spec: withFiles, credentials });
    h.dispatch(withFiles);
    await h.waitForKind(withFiles, "session.saved");

    const [ready] = h.ofKind(withFiles, "ticket.files_ready");
    expect(ready?.files).toEqual([
      { path: ticketFileNameFor(image.blobId, "image/png"), blobId: image.blobId },
      { path: ticketFileNameFor(document.blobId, "application/pdf"), blobId: document.blobId },
      { path: "escape.jpg", blobId: climbing.blobId },
    ]);
    expect(ready?.skipped).toEqual([
      { blobId: page.blobId, reason: "type-not-allowed" },
      { blobId: missing.blobId, reason: "download-failed" },
      { blobId: corrupt.blobId, reason: "digest-mismatch" },
    ]);
    // Before the agent started, and the turn ran anyway.
    expect(h.kinds(withFiles).indexOf("ticket.files_ready")).toBeLessThan(h.kinds(withFiles).indexOf("turn.started"));

    // One repo: the agent's session opens in its checkout, so the files are in its `.ostra/ticket/`.
    const checkout = path.join(h.dataDir, "tasks", spec.taskId, "workspace", "test1");
    const folder = path.join(checkout, ".ostra", "ticket");
    expect((await readdir(folder)).sort()).toEqual([...(ready?.files ?? []).map((file) => file.path)].sort());
    expect(await readFile(path.join(folder, ticketFileNameFor(image.blobId, "image/png") ?? ""))).toEqual(PNG);
    expect(await readFile(path.join(folder, ticketFileNameFor(document.blobId, "application/pdf") ?? ""))).toEqual(PDF);
    // Nothing landed above the folder.
    expect(await readdir(path.join(checkout, ".ostra"))).toEqual(["ticket"]);
    expect(await readdir(path.join(h.dataDir, "tasks", spec.taskId))).not.toContain("escape.jpg");

    // Not in the commit, not in the hidden ref: every repo's git excludes `.ostra/`.
    const branch = await shared.upstream.treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`);
    const hidden = await shared.upstream.treeFiles("ostra-test/test1", `refs/ostra/wip/${spec.taskId}`);
    expect(branch).toContain("change.txt");
    for (const tree of [branch, hidden]) {
      expect(tree.some((file) => file.startsWith(".ostra"))).toBe(false);
    }
    expect(await readFile(path.join(checkout, ".git", "info", "exclude"), "utf8")).toContain("/.ostra");
  }, 120_000);

  it("sends no event for a task without files", async () => {
    const h = await start();
    const { spec } = h.taskFor(fakeMarker("say"));
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(h.kinds(spec)).not.toContain("ticket.files_ready");
    expect(h.server.bulkCalls.filter((call) => call === "download")).toEqual([]);
  }, 120_000);
});
