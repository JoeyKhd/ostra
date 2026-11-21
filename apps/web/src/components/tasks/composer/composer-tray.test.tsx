import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerTray, TrayHintLine, TrayNoteLine } from "./composer-tray";
import { FilesNextRow, filesNextWords, NewTaskAttachmentsGroup, takesText } from "./new-task-files";
import type { TrayItemView } from "./tray-item";

// The tray, its lines and the new task's files (composer-attachments.md, new-task-attachments.md;
// ticket 15), drawn as the page draws them.

const MiB = 1024 * 1024;
const limits = { maxFiles: 10, maxFileBytes: 10 * MiB, maxTotalBytes: 25 * MiB };
const noop = () => undefined;
const ready = (state: "none" | "ready" | "failed" | "off" = "none"): TrayItemView["upload"] => ({ state: "ready", uploaded: { kind: state === "none" ? "text" : "document", text: { state, words: state === "ready" ? 2140 : null } } });
const item = (key: string, name: string, look: TrayItemView["look"], upload: TrayItemView["upload"], size = 48 * 1024): TrayItemView => ({ key, name, size, look, previewUrl: look === "image" ? `blob:${key}` : null, upload });

const tray = (items: readonly TrayItemView[]) => renderToStaticMarkup(<ComposerTray items={items} announcement="" onRemove={noop} onRetry={noop} onOpen={noop} returnFocus={noop} />);

describe("the tray", () => {
  it("is a list of its files, pictures from the browser's copy and chips with their type and size", () => {
    const html = tray([item("a", "mock.png", "image", ready()), item("b", "history-panel-spec.docx", "file", ready())]);
    expect(html).toContain('role="list" aria-label="Attachments, 2"');
    expect(html).toContain('src="blob:a"');
    expect(html).toContain("DOCX · 48 KB");
    expect(html).toContain('aria-label="history-panel-spec.docx, DOCX, 48 KB"');
    expect(html).toContain('aria-label="Remove history-panel-spec.docx"');
  });

  it("shows an upload's progress, a failure with Retry, and `text extracted` once a document's upload answers", () => {
    const html = tray([
      item("a", "results-sample.csv", "file", { state: "uploading", progress: 0.62 }),
      item("b", "spec.docx", "file", { state: "failed", reason: "The blob store is full." }),
      item("c", "rules.docx", "file", ready("ready")),
    ]);
    expect(html).toContain("Uploading · 62%");
    expect(html).toContain("width:62%");
    expect(html).toContain("results-sample.csv, CSV, 48 KB, uploading, 62 percent");
    expect(html).toContain("Didn&#x27;t upload");
    expect(html).toContain('data-action="retry-upload"');
    expect(html).toContain('title="The blob store is full."');
    expect(html.match(/data-part="text-extracted"/g)).toHaveLength(1);
  });

  it("draws nothing but its live region when empty", () => {
    expect(tray([])).toBe('<p class="sr-only" aria-live="polite" data-testid="composer-tray-live"></p>');
  });
});

describe("the tray's lines", () => {
  it("draws a refusal in red with its dismiss, the model's note muted", () => {
    const refused = renderToStaticMarkup(<TrayNoteLine note={{ kind: "refused", refusal: { kind: "empty", name: "a.txt" } }} onDismiss={noop} />);
    expect(refused).toContain("text-red");
    expect(refused).toContain('data-action="dismiss-note"');
    const model = renderToStaticMarkup(<TrayNoteLine note={{ kind: "model", model: "DeepSeek V4.1 Flash", input: "no" }} onDismiss={noop} />);
    expect(model).toContain("text-muted");
    expect(model).not.toContain('data-action="dismiss-note"');
  });

  it("puts the tray's own hint over the composer's words", () => {
    expect(renderToStaticMarkup(<TrayHintLine hint={{ kind: "own" }} own="Send queues." />)).toContain("Send queues.");
    expect(renderToStaticMarkup(<TrayHintLine hint={{ kind: "full", count: 10, max: 10 }} own="Send queues." />)).toContain("10 of 10 files");
  });
});

describe("the new task's files", () => {
  it("says where the files go in the box, and the text of a document beside it", () => {
    const docx = item("c", "rounding-rules.docx", "file", ready("ready"));
    const csv = item("d", "percent-cases.csv", "file", ready());
    expect(filesNextWords([docx, csv])).toEqual({ before: "The 2 files go into the box under", after: ", and the text of the docx beside it" });
    expect(filesNextWords([csv])).toEqual({ before: "The file goes into the box under", after: "" });
    // Before core answers, a document is known by its extension.
    expect(filesNextWords([item("e", "a.pdf", "file", { state: "uploading", progress: 0 }), item("f", "b.xlsx", "file", { state: "uploading", progress: 0 })]).after).toBe(", and the text of the documents beside them");
    expect(renderToStaticMarkup(<FilesNextRow entries={[docx]} variant="row" />)).toContain(".ostra/attachments/1/");
    expect(renderToStaticMarkup(<FilesNextRow entries={[]} variant="row" />)).toBe("");
  });

  it("counts the tray in the properties panel, and always says what the model reads", () => {
    const html = renderToStaticMarkup(<NewTaskAttachmentsGroup entries={[item("a", "a.png", "image", ready(), Math.round(1.2 * MiB)), item("b", "b.csv", "file", ready(), Math.round(1.1 * MiB))]} limits={limits} />);
    expect(html).toContain("1 image · 1 file");
    expect(html).toContain("2.3 MB");
    expect(html).toContain(" of 25 MB");
    expect([takesText("yes"), takesText("no"), takesText("unknown")]).toEqual(["text and images", "text only", "text only"]);
  });
});
