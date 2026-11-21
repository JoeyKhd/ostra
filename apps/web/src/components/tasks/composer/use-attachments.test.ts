import { describe, expect, it } from "vitest";

import type { RecordedUpload } from "@ostra/domain";
import { messageFileIdSchema } from "@ostra/protocol";

import { sendStateOf, sendsNow } from "./attach-words";
import { emptyTray, trayReducer } from "./use-attachments";
import type { TrayAction, TrayItem, TrayState } from "./use-attachments";

// The tray's changes (use-attachments.ts; ticket 15): files join uploading, take core's answer or
// fail, retry, go; a pressed Send waits and stops when an upload fails.

const item = (key: string, name: string, type: string): TrayItem => ({
  key,
  file: new File(["x"], name, { type }),
  name,
  size: 1,
  look: type === "image/png" ? "image" : "file",
  previewUrl: type === "image/png" ? `blob:${key}` : null,
  upload: { state: "uploading", progress: 0 },
});

const answer = (name: string, kind: RecordedUpload["kind"], text: RecordedUpload["text"] = { state: "none", words: null }): RecordedUpload => ({
  fileId: messageFileIdSchema.parse("0196f1a0-0000-7000-8000-0000000000f1"),
  name,
  kind,
  contentType: kind === "image" ? "image/png" : "application/octet-stream",
  size: 1,
  text,
});

const run = (actions: readonly TrayAction[], from: TrayState = emptyTray): TrayState => actions.reduce(trayReducer, from);

describe("the tray", () => {
  it("adds files uploading, says so, and keeps the newest refusal until it's dismissed", () => {
    const state = run([{ type: "add", items: [item("t1", "spec.docx", "application/pdf")], refusal: { kind: "empty", name: "a.txt" } }]);
    expect(state.items.map((one) => one.upload.state)).toEqual(["uploading"]);
    expect(state.announcement).toBe("spec.docx added a.txt wasn't added: it's empty.");
    expect(state.refusal).toEqual({ kind: "empty", name: "a.txt" });
    expect(run([{ type: "dismiss" }], state).refusal).toBeNull();
  });

  it("moves an upload's bar forward only, and takes core's answer: its safe name, its kind and its text", () => {
    const state = run([
      { type: "add", items: [item("t1", "Spécification.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")], refusal: null },
      { type: "progress", key: "t1", progress: 0.62 },
      { type: "progress", key: "t1", progress: 0.4 },
    ]);
    expect(state.items[0]?.upload).toEqual({ state: "uploading", progress: 0.62 });
    const done = run([{ type: "uploaded", key: "t1", file: answer("Specification.docx", "document", { state: "ready", words: 2140 }) }], state);
    expect(done.items[0]?.name).toBe("Specification.docx");
    expect(done.items[0]?.upload.state === "ready" ? done.items[0].upload.uploaded.text : null).toEqual({ state: "ready", words: 2140 });
    expect(done.announcement).toBe("Specification.docx uploaded");
  });

  it("draws a picture core says is a file as a chip", () => {
    const state = run([
      { type: "add", items: [item("t1", "photo.png", "image/png")], refusal: null },
      { type: "uploaded", key: "t1", file: answer("photo.png", "file") },
    ]);
    expect(state.items[0]?.look).toBe("file");
  });

  it("stops a waiting Send when an upload fails, and sends once the last lands otherwise", () => {
    const waiting = run([
      { type: "add", items: [item("t1", "a.png", "image/png"), item("t2", "b.docx", "application/pdf")], refusal: null },
      { type: "uploaded", key: "t2", file: answer("b.docx", "document") },
      { type: "press" },
    ]);
    expect(sendStateOf({ entries: waiting.items, text: "", pressed: waiting.pressed, wordsRequired: false })).toEqual({ kind: "waiting", uploading: 1, of: 2 });

    const failed = run([{ type: "failed", key: "t1", reason: "The blob store is full." }], waiting);
    expect(failed.pressed).toBe(false);
    expect(failed.items[0]?.upload).toEqual({ state: "failed", reason: "The blob store is full." });
    expect(failed.announcement).toBe("a.png didn't upload");

    const landed = run([{ type: "uploaded", key: "t1", file: answer("a.png", "image") }], waiting);
    expect(landed.pressed).toBe(true);
    expect(sendsNow(landed.items)).toBe(true);
  });

  it("retries a failed upload, and removes a file, the wait ending with the last one", () => {
    const failed = run([
      { type: "add", items: [item("t1", "a.png", "image/png")], refusal: null },
      { type: "failed", key: "t1", reason: null },
      { type: "retry", key: "t1" },
    ]);
    expect(failed.items[0]?.upload).toEqual({ state: "uploading", progress: 0 });
    const removed = run([{ type: "press" }, { type: "remove", key: "t1" }], failed);
    expect(removed.items).toEqual([]);
    expect(removed.pressed).toBe(false);
  });

  it("ignores an answer for a file that was removed or already answered", () => {
    const state = run([{ type: "add", items: [item("t1", "a.png", "image/png")], refusal: null }, { type: "remove", key: "t1" }]);
    expect(run([{ type: "uploaded", key: "t1", file: answer("a.png", "image") }], state)).toBe(state);
  });

  it("empties once the message went", () => {
    const state = run([{ type: "add", items: [item("t1", "a.png", "image/png")], refusal: { kind: "folder", name: "x" } }, { type: "press" }, { type: "clear" }]);
    expect(state.items).toEqual([]);
    expect(state.refusal).toBeNull();
    expect(state.pressed).toBe(false);
  });
});
