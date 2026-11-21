import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { messageFileIdSchema } from "@ostra/protocol";

import { AttachmentsGroupView } from "./attachments-group";
import type { ThreadFile } from "./file-words";
import { MessageFiles } from "./message-files";

// A member's message's files in the thread (message-attachments.md; ticket 16), and the properties
// panel's one Attachments group.

const MiB = 1024 * 1024;
const limits = { maxFiles: 10, maxFileBytes: 10 * MiB, maxTotalBytes: 25 * MiB };

let next = 0;
const file = (name: string, kind: ThreadFile["kind"], over: Partial<ThreadFile> = {}): ThreadFile => {
  next += 1;
  return {
    fileId: messageFileIdSchema.parse(`0196f1a0-0000-7000-8000-${String(next).padStart(12, "0")}`),
    name,
    kind,
    contentType: kind === "image" ? "image/png" : "application/octet-stream",
    size: 48 * 1024,
    origin: "member",
    asImage: false,
    text: "none",
    downloadPath: `/api/tasks/t/files/${String(next)}`,
    textWords: null,
    textReason: null,
    ...over,
  };
};

const render = (files: readonly ThreadFile[], over: Partial<Parameters<typeof MessageFiles>[0]> = {}) =>
  renderToStaticMarkup(<MessageFiles files={files} author="Sam Rivera" agent="OpenCode" model="DeepSeek V4.1 Flash" imagesNotSent={null} leftOut={[]} skipped={[]} limits={limits} onOpenImage={() => undefined} {...over} />);

describe("a member's message's files", () => {
  it("draws its pictures as thumbnails that open the viewer, and its other files as chips that download", () => {
    const html = render([file("history-panel-mock.png", "image"), file("results-sample.csv", "text")]);
    expect(html).toContain('aria-label="Image history-panel-mock.png from Sam Rivera, open"');
    expect(html).toMatch(/<a href="\/api\/tasks\/t\/files\/\d+" download="results-sample.csv" aria-label="Download results-sample.csv, CSV, 48 KB"/);
  });

  it("marks a document ostra read as `text extracted`, and one it couldn't as `no text`", () => {
    const html = render([file("spec.docx", "document", { text: "ready", textWords: 2140 }), file("scan.pdf", "document", { text: "failed", textReason: "no-text" }), file("notes.txt", "text")]);
    expect(html.match(/data-part="text-extracted"/g)).toHaveLength(1);
    expect(html.match(/data-part="no-text"/g)).toHaveLength(1);
    expect(html).toContain("Download spec.docx, DOCX, 48 KB, text extracted");
  });

  it("says when its images went as files because the model can't see them, and nothing when they went as images", () => {
    const images = [file("a.png", "image")];
    expect(render(images, { imagesNotSent: "model" })).toContain("DeepSeek V4.1 Flash can&#x27;t see images: OpenCode got them as files.");
    expect(render(images)).not.toContain('data-testid="images-not-sent"');
  });

  it("keeps a removed file's name without its link", () => {
    const html = render([file("spec.docx", "document", { downloadPath: null })]);
    expect(html).toContain('data-state="removed"');
    expect(html).toContain("removed with the task&#x27;s files");
    expect(html).not.toContain("<a ");
  });

  it("names what was left out, and what the box couldn't save", () => {
    const html = render([file("a.png", "image")], { leftOut: [{ name: "big.mov", reason: "too-big", size: 48 * MiB }], skipped: [{ name: "a.png", reason: "digest-mismatch" }] });
    expect(html).toContain("1 left out, and the agent was told which");
    expect(html).toContain("48 MB, over the 10 MB a file can be");
    expect(html).toContain("1 file wasn&#x27;t saved in the box");
    expect(html).toContain("its bytes didn&#x27;t match what was sent");
  });

  it("folds more than six pictures into five and a `+n` tile", () => {
    const html = render(Array.from({ length: 8 }, (_, i) => file(`${String(i)}.png`, "image")));
    expect(html.match(/data-part="file-thumb"/g)).toHaveLength(5);
    expect(html).toContain(">+3<");
  });
});

describe("the Attachments group", () => {
  it("is one group for people's files and the agent's captures", () => {
    const html = renderToStaticMarkup(<AttachmentsGroupView captures={[{ kind: "screenshot", bytes: 200 * 1024 }]} people={{ images: 2, files: 3, bytes: Math.round(1.7 * MiB), folders: [".ostra/attachments/"] }} pr={null} />);
    expect(html).toContain(">Attachments<");
    expect(html).toContain("2 images · 3 files");
    expect(html).toContain("1 screenshot");
    expect(html).toContain("1.9 MB");
    expect(html).toContain(".ostra/attachments/");
  });

  it("shows captures alone as before, and nothing when the task holds none", () => {
    expect(renderToStaticMarkup(<AttachmentsGroupView captures={[{ kind: "recording", bytes: 1024 }]} people={null} pr={null} />)).not.toContain("From people");
    expect(renderToStaticMarkup(<AttachmentsGroupView captures={[]} people={{ images: 0, files: 0, bytes: 0, folders: [] }} pr={null} />)).toBe("");
  });
});
