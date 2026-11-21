import { describe, expect, it } from "vitest";

import {
  admitFiles,
  dragDepth,
  dragShowsZone,
  dropAttaches,
  DROP_EXCLUDED,
  hintText,
  limitsText,
  lookOfType,
  noteText,
  pasteDecision,
  pasteName,
  refusalText,
  sendStateOf,
  sendsNow,
  trayHintOf,
  trayNoteOf,
  waitingText,
} from "./attach-words";
import type { TrayUpload } from "./attach-words";

// The message box's attachments (composer-attachments.md; ticket 15): the limits as files arrive,
// the note line and the hint, when Send waits, and which pastes and drags are files.

const MiB = 1024 * 1024;
const limits = { maxFiles: 10, maxFileBytes: 10 * MiB, maxTotalBytes: 25 * MiB };
const arrival = (name: string, size: number, folder = false) => ({ name, size, folder });
const ready: TrayUpload<unknown> = { state: "ready", uploaded: {} };
const uploading = (progress: number): TrayUpload<unknown> => ({ state: "uploading", progress });
const failed: TrayUpload<unknown> = { state: "failed", reason: null };

describe("what the tray takes", () => {
  it("takes files within the limits, in their order", () => {
    const files = [arrival("a.png", 1 * MiB), arrival("b.docx", 2 * MiB)];
    expect(admitFiles([], files, limits)).toEqual({ admitted: files, refusal: null });
  });

  it("refuses a file over one file's size, naming it with its size and the limit, and takes the rest", () => {
    const big = arrival("design-review.mov", 48 * MiB);
    const small = arrival("percent-cases.csv", 6 * 1024);
    const result = admitFiles([], [big, small], limits);
    expect(result.admitted).toEqual([small]);
    expect(result.refusal).toEqual({ kind: "too-big", name: "design-review.mov", size: 48 * MiB, max: 10 * MiB });
    expect(refusalText(result.refusal ?? { kind: "empty", name: "" })).toBe("design-review.mov wasn't added: it's 48 MB, and a file can be up to 10 MB.");
  });

  it("counts the files past the tenth as one note", () => {
    const held = Array.from({ length: 8 }, () => ({ size: 1024 }));
    const result = admitFiles(held, ["a", "b", "c", "d", "e"].map((name) => arrival(`${name}.png`, 1024)), limits);
    expect(result.admitted.map((file) => file.name)).toEqual(["a.png", "b.png"]);
    expect(result.refusal).toEqual({ kind: "too-many", count: 3, max: 10 });
    expect(refusalText({ kind: "too-many", count: 3, max: 10 })).toBe("3 more weren't added: a message holds up to 10 files.");
    expect(refusalText({ kind: "too-many", count: 1, max: 10 })).toBe("1 more wasn't added: a message holds up to 10 files.");
  });

  it("refuses the file that would take the message past its total, saying what it would hold", () => {
    const held = [{ size: Math.round(9.8 * MiB) }, { size: Math.round(9.1 * MiB) }];
    const result = admitFiles(held, [arrival("orders-2026-11.csv", Math.round(8.5 * MiB))], limits);
    expect(result.admitted).toEqual([]);
    expect(refusalText(result.refusal ?? { kind: "empty", name: "" })).toBe("orders-2026-11.csv wasn't added: the message would hold 27.4 MB, over 25 MB.");
  });

  it("refuses an empty file and a folder before weighing anything", () => {
    expect(admitFiles([], [arrival("notes.txt", 0)], limits).refusal).toEqual({ kind: "empty", name: "notes.txt" });
    expect(admitFiles([], [arrival("screens", 4096, true)], limits).refusal).toEqual({ kind: "folder", name: "screens" });
    expect(refusalText({ kind: "empty", name: "notes.txt" })).toBe("notes.txt wasn't added: it's empty.");
    expect(refusalText({ kind: "folder", name: "screens" })).toBe("screens wasn't added: folders can't be attached.");
  });

  it("words the limits with the numbers it's given, not fixed ones", () => {
    expect(limitsText(limits)).toBe("Up to 10 files · 10 MB each · 25 MB in all");
    const small = { maxFiles: 3, maxFileBytes: 1 * MiB, maxTotalBytes: 2 * MiB };
    expect(limitsText(small)).toBe("Up to 3 files · 1 MB each · 2 MB in all");
    expect(refusalText(admitFiles([], [arrival("a.zip", 2 * MiB)], small).refusal ?? { kind: "empty", name: "" })).toBe("a.zip wasn't added: it's 2 MB, and a file can be up to 1 MB.");
  });

  it("draws the four picture types as pictures, anything else as a file", () => {
    expect(["image/png", "image/jpeg", "image/gif", "image/webp"].map(lookOfType)).toEqual(["image", "image", "image", "image"]);
    expect(["image/heic", "image/svg+xml", "application/pdf", ""].map(lookOfType)).toEqual(["file", "file", "file", "file"]);
  });
});

describe("the note line", () => {
  const image = [{ look: "image" as const }];
  const model = (imageInput: "yes" | "no" | "unknown") => ({ name: "DeepSeek V4.1 Flash", imageInput });

  it("says the model can't see the tray's images, and its own words when it isn't known", () => {
    const no = trayNoteOf({ refusal: null, entries: image, model: model("no"), oldRunner: null });
    expect(no === null ? null : noteText(no)).toBe("DeepSeek V4.1 Flash can't see images; the agent gets them as files.");
    const unknown = trayNoteOf({ refusal: null, entries: image, model: model("unknown"), oldRunner: null });
    expect(unknown === null ? null : noteText(unknown)).toBe("ostra doesn't know whether DeepSeek V4.1 Flash can see images; the agent gets them as files.");
  });

  it("says nothing of the model when it sees images, or when the tray holds no image", () => {
    expect(trayNoteOf({ refusal: null, entries: image, model: model("yes"), oldRunner: null })).toBeNull();
    expect(trayNoteOf({ refusal: null, entries: [{ look: "file" }], model: model("no"), oldRunner: null })).toBeNull();
  });

  it("says the runner can't take files while the tray holds any", () => {
    const note = trayNoteOf({ refusal: null, entries: [{ look: "file" }], model: model("yes"), oldRunner: "alex-laptop" });
    expect(note === null ? null : noteText(note)).toBe("alex-laptop runs an older ostra and can't take files: update it, or remove them to send.");
    expect(trayNoteOf({ refusal: null, entries: [], model: model("yes"), oldRunner: "alex-laptop" })).toBeNull();
  });

  it("shows a file that wasn't added over the others: the newest wins", () => {
    const refusal = { kind: "empty" as const, name: "a.txt" };
    expect(trayNoteOf({ refusal, entries: image, model: model("no"), oldRunner: "alex-laptop" })).toEqual({ kind: "refused", refusal });
  });
});

describe("the hint", () => {
  it("asks to retry or remove a failed upload, before anything else", () => {
    const hint = trayHintOf([{ name: "a.png", size: 1, upload: ready }, { name: "history-panel-spec.docx", size: 1, upload: failed }], limits);
    expect(hint).toEqual({ kind: "failed", name: "history-panel-spec.docx" });
    expect(hint.kind === "own" ? null : hintText(hint)).toBe("Retry or remove history-panel-spec.docx to send.");
  });

  it("counts the files once the tray is full", () => {
    const hint = trayHintOf(Array.from({ length: 10 }, (_, i) => ({ name: `${String(i)}.png`, size: 1024, upload: ready })), limits);
    expect(hint.kind === "own" ? null : hintText(hint)).toBe("10 of 10 files");
  });

  it("counts the size once the tray passes 80% of the total, or a file was just refused for it", () => {
    const heavy = trayHintOf([{ name: "a.sql", size: Math.round(21.2 * MiB), upload: ready }], limits);
    expect(heavy.kind === "own" ? null : hintText(heavy)).toBe("21.2 MB of 25 MB");
    const files = [{ name: "a.sql", size: Math.round(9.8 * MiB), upload: ready }, { name: "b.csv", size: Math.round(9.1 * MiB), upload: ready }];
    expect(trayHintOf(files, limits)).toEqual({ kind: "own" });
    const refused = trayHintOf(files, limits, { kind: "total-too-big", name: "c.csv", total: Math.round(27.4 * MiB), max: limits.maxTotalBytes });
    expect(refused.kind === "own" ? null : hintText(refused)).toBe("18.9 MB of 25 MB");
  });
});

describe("Send", () => {
  it("sends files with no words, but the new task's box needs words", () => {
    const entries = [{ name: "a.png", upload: ready }];
    expect(sendStateOf({ entries, text: "", pressed: false, wordsRequired: false })).toEqual({ kind: "ready" });
    expect(sendStateOf({ entries, text: "  ", pressed: false, wordsRequired: true })).toEqual({ kind: "empty" });
    expect(sendStateOf({ entries: [], text: "", pressed: false, wordsRequired: false })).toEqual({ kind: "empty" });
  });

  it("waits for the uploads it was pressed during, and says how many", () => {
    const entries = [{ name: "a.png", upload: uploading(0.4) }, { name: "b.docx", upload: ready }];
    const state = sendStateOf({ entries, text: "See the screenshot.", pressed: true, wordsRequired: false });
    expect(state).toEqual({ kind: "waiting", uploading: 1, of: 2 });
    expect(state.kind === "waiting" ? waitingText(state) : null).toBe("Uploading 1 of 2…");
    expect(sendsNow(entries)).toBe(false);
    expect(sendsNow([{ upload: ready }, { upload: ready }])).toBe(true);
  });

  it("stays enabled while files upload, until it's pressed", () => {
    expect(sendStateOf({ entries: [{ name: "a.png", upload: uploading(0.1) }], text: "hi", pressed: false, wordsRequired: false })).toEqual({ kind: "ready" });
  });

  it("can't send while an upload failed", () => {
    const entries = [{ name: "spec.docx", upload: failed }];
    expect(sendStateOf({ entries, text: "hi", pressed: true, wordsRequired: false })).toEqual({ kind: "blocked", name: "spec.docx" });
    expect(sendsNow(entries)).toBe(false);
  });
});

describe("paste", () => {
  it("attaches a screenshot and pastes nothing", () => {
    expect(pasteDecision({ types: ["Files"], fileTypes: ["image/png"] })).toEqual({ attach: true, keepText: false });
    // A browser's "Copy image": the picture and its HTML, no plain text.
    expect(pasteDecision({ types: ["text/html", "Files"], fileTypes: ["image/png"] })).toEqual({ attach: true, keepText: false });
  });

  it("pastes text as text", () => {
    expect(pasteDecision({ types: ["text/plain"], fileTypes: [] })).toEqual({ attach: false, keepText: true });
  });

  it("pastes an office app's cells as text, without their picture", () => {
    expect(pasteDecision({ types: ["text/plain", "text/html", "Files"], fileTypes: ["image/png"] })).toEqual({ attach: false, keepText: true });
  });

  it("attaches a copied file and still pastes the text that came with it", () => {
    expect(pasteDecision({ types: ["text/plain", "Files"], fileTypes: ["application/pdf"] })).toEqual({ attach: true, keepText: true });
  });

  it("names a pasted screenshot by the time, and keeps a real file's name", () => {
    const at = new Date(2026, 10, 21, 14, 51, 8);
    expect(pasteName("image.png", "image/png", at)).toBe("Pasted image 14.51.08.png");
    expect(pasteName("", "image/jpeg", at)).toBe("Pasted image 14.51.08.jpg");
    expect(pasteName("spec.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", at)).toBe("spec.docx");
  });
});

describe("the drop zone", () => {
  it("shows for files from outside the page only", () => {
    expect(dragShowsZone({ types: ["Files"], fromPage: false })).toBe(true);
    expect(dragShowsZone({ types: ["text/plain", "text/uri-list"], fromPage: false })).toBe(false);
    // A picture dragged from the page itself, which the browser offers as a file too.
    expect(dragShowsZone({ types: ["Files", "text/uri-list", "text/html"], fromPage: true })).toBe(false);
  });

  it("stays while the drag moves between the page's parts, and hides on leaving, dropping or Escape", () => {
    let depth = 0;
    for (const event of ["enter", "enter", "leave"] as const) depth = dragDepth(depth, event);
    expect(depth).toBe(1);
    expect(dragDepth(depth, "leave")).toBe(0);
    expect(dragDepth(3, "drop")).toBe(0);
    expect(dragDepth(3, "escape")).toBe(0);
    expect(dragDepth(0, "leave")).toBe(0);
  });

  it("attaches a drop anywhere on the page but the preview pane", () => {
    const inside = (excluded: boolean) => ({ closest: (selector: string) => (excluded && selector === DROP_EXCLUDED ? {} : null) });
    expect(dropAttaches(inside(false))).toBe(true);
    expect(dropAttaches(inside(true))).toBe(false);
    expect(dropAttaches(null)).toBe(true);
  });
});
