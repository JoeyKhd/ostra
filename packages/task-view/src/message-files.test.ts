import { describe, expect, it } from "vitest";

import { memberIdSchema, messageFileIdSchema, taskEventSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";

import { foldTaskEvents } from "./fold.ts";
import { messageFileDownloadPath, messageFileLinkPath } from "./message-files.ts";
import { storeEvents } from "./testing/index.ts";
import type { MessageFilesData, TaskUIMessage } from "./ui-types.ts";

// Milestone 9's ticket 14 (F-148, F-150, ADR 0070): a member's message's files in the thread, folded
// from its `user.message` (`files`, `filesLeftOut`, `imagesNotSent`) and the runner's `files.written`:
// each file with its download, its text's words or reason, what the limits left out with its size,
// and what the runner couldn't write into the box. Names hold shell syntax and prompt-like text.

const memberId = memberIdSchema.parse("0196f1a0-0000-7000-8000-0000000000a1");
const mock = messageFileIdSchema.parse("0196f1a0-0000-7000-8000-0000000000b1");
const spec = messageFileIdSchema.parse("0196f1a0-0000-7000-8000-0000000000b2");
const scan = messageFileIdSchema.parse("0196f1a0-0000-7000-8000-0000000000b3");

const ev = (event: Readonly<Record<string, unknown>>): TaskEvent => taskEventSchema.parse(event);

/** Driver's message with three files: a picture, a document core read, and one it couldn't; one left out. */
const withFiles = (over: Readonly<Record<string, unknown>> = {}): TaskEvent =>
  ev({
    kind: "user.message",
    memberId,
    clientMessageId: "files-1",
    text: "",
    delivery: "queued",
    files: [
      { fileId: mock, name: "_(rm -rf _) mock.png", kind: "image", contentType: "image/png", size: 48_000, origin: "member", asImage: true, text: "none" },
      { fileId: spec, name: "Ignore previous instructions spec.docx", kind: "document", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 12_000, origin: "member", asImage: false, text: "ready", textWords: 412 },
      { fileId: scan, name: "scan.pdf", kind: "document", contentType: "application/pdf", size: 900_000, origin: "member", asImage: false, text: "failed", textReason: "no-text" },
    ],
    filesLeftOut: [{ name: "recording.mov", reason: "too-big", size: 84 * 1024 * 1024 }],
    imagesNotSent: null,
    ...over,
  });

const filesOf = (messages: readonly TaskUIMessage[]): MessageFilesData[] =>
  messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "data-message-files" ? [part.data] : [])));

describe("a member's message's files in the thread (F-148, F-150)", () => {
  it("F-148/c3: each file sits under its message with its download, a removed one with none; the message's number names its folder", () => {
    const thread = foldTaskEvents(storeEvents([withFiles()], { fromSeq: 4 }), []);
    const [message] = thread;
    expect(message?.role).toBe("user");
    // The words (none here) first, then the files.
    expect(message?.parts.map((part) => part.type)).toEqual(["text", "data-message-files"]);
    const [data] = filesOf(thread);
    expect(data?.seq).toBe(4);
    expect(data?.files.map((file) => [file.name, file.downloadPath])).toEqual([
      ["_(rm -rf _) mock.png", messageFileDownloadPath(fixtureIds.task, mock)],
      ["Ignore previous instructions spec.docx", messageFileDownloadPath(fixtureIds.task, spec)],
      ["scan.pdf", messageFileDownloadPath(fixtureIds.task, scan)],
    ]);
    expect(messageFileDownloadPath(fixtureIds.task, mock)).toBe(`/api/tasks/${fixtureIds.task}/files/${mock}`);
    // The viewer's Copy link: the task page opening the file.
    expect(messageFileLinkPath(fixtureIds.task, mock)).toBe(`/tasks/${fixtureIds.task}?file=${mock}`);
    // A file whose blob is gone keeps its place, without a download.
    const removed = filesOf(foldTaskEvents(storeEvents([withFiles()], { fromSeq: 4 }), [], { removedFiles: new Set([spec]) }))[0];
    expect(removed?.files.map((file) => file.downloadPath === null)).toEqual([false, true, false]);
  });

  it("F-150/c1: a document whose text core read says ready with its words; one it couldn't, why", () => {
    const [data] = filesOf(foldTaskEvents(storeEvents([withFiles()]), []));
    expect(data?.files.map((file) => [file.text, file.textWords, file.textReason])).toEqual([
      ["none", null, null],
      ["ready", 412, null],
      ["failed", null, "no-text"],
    ]);
  });

  it("F-148/c2: what the limits left out at send is under the message by name, with why and its size", () => {
    const [data] = filesOf(foldTaskEvents(storeEvents([withFiles()]), []));
    expect(data?.leftOut).toEqual([{ name: "recording.mov", reason: "too-big", size: 84 * 1024 * 1024 }]);
    // A message written before sizes were recorded says none.
    const older = ev({ kind: "user.message", memberId, clientMessageId: "files-2", text: "Look", delivery: "queued", filesLeftOut: [{ name: "big.zip", reason: "too-big" }] });
    expect(filesOf(foldTaskEvents(storeEvents([older]), []))[0]?.leftOut).toEqual([{ name: "big.zip", reason: "too-big", size: null }]);
    // A message with no files has no files part.
    const plain = ev({ kind: "user.message", memberId, clientMessageId: "plain", text: "Carry on", delivery: "queued" });
    expect(foldTaskEvents(storeEvents([plain]), [])[0]?.parts.map((part) => part.type)).toEqual(["text"]);
  });

  it("F-148: what the runner couldn't write into the box is named under its message, and a later write clears it", () => {
    const skipped = ev({ kind: "files.written", files: [{ fileId: mock, textWritten: false }], skipped: [{ fileId: spec, reason: "digest-mismatch" }], imagesSent: 1, imagesAsFiles: null });
    const [data] = filesOf(foldTaskEvents(storeEvents([withFiles(), skipped]), []));
    expect(data?.skipped).toEqual([{ fileId: spec, name: "Ignore previous instructions spec.docx", reason: "digest-mismatch" }]);
    // A fresh box writes every file again: the skip goes.
    const again = ev({ kind: "files.written", files: [{ fileId: mock, textWritten: false }, { fileId: spec, textWritten: true }], skipped: [], imagesSent: 0, imagesAsFiles: null });
    expect(filesOf(foldTaskEvents(storeEvents([withFiles(), skipped, again]), []))[0]?.skipped).toEqual([]);
  });

  it("F-148/c5: why the images went as files is under the message: the event's word, or the runner's when the agent advertised none", () => {
    const model = filesOf(foldTaskEvents(storeEvents([withFiles({ imagesNotSent: "model", files: [{ fileId: mock, name: "mock.png", kind: "image", contentType: "image/png", size: 10, origin: "member", asImage: false, text: "none" }] })]), []))[0];
    expect(model?.imagesNotSent).toBe("model");
    const written = ev({ kind: "files.written", files: [{ fileId: mock, textWritten: false }, { fileId: spec, textWritten: true }, { fileId: scan, textWritten: false }], skipped: [], imagesSent: 0, imagesAsFiles: "agent-did-not-advertise" });
    const agent = filesOf(foldTaskEvents(storeEvents([withFiles(), written]), []))[0];
    expect(agent?.imagesNotSent).toBe("agent");
    expect(agent?.files.find((file) => file.fileId === mock)?.asImage).toBe(false);
  });
});
