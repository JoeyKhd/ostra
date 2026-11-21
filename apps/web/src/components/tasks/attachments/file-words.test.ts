import { describe, expect, it } from "vitest";

import {
  agentGotText,
  chipName,
  extensionOf,
  fileLookOf,
  imagesNotSentText,
  leftOutText,
  limitText,
  middleCut,
  peopleText,
  roundSizeText,
  stripOf,
  textExtractedTip,
  textFailedTip,
  typeLabel,
  viewerTitle,
} from "./file-words";

// One look for a file everywhere (app-targets/m9; tickets 15 and 16): its type, its name cut in the
// middle, its size, and the words around a member's and a ticket's files.

const MiB = 1024 * 1024;

describe("a file's look", () => {
  it("names its type by the extension, and picks the icon", () => {
    expect(extensionOf("history-panel-spec.DOCX")).toBe("docx");
    expect(extensionOf("Makefile")).toBe("");
    expect(typeLabel("brand-guide.pdf")).toBe("PDF");
    expect(typeLabel("Makefile")).toBe("File");
    expect(["a.docx", "a.csv", "a.log", "a.zip", "a.mov", "a.eml", "a.bin"].map(fileLookOf)).toEqual(["text", "spreadsheet", "code", "archive", "video", "mail", "file"]);
  });

  it("cuts a long name in the middle and keeps its extension", () => {
    expect(middleCut("history-panel-spec.docx", 24)).toBe("history-panel-spec.docx");
    const cut = middleCut("history-panel-specification-v2.docx", 24);
    expect(cut).toBe("history-panel…on-v2.docx");
    expect(cut.length).toBeLessThanOrEqual(24);
    expect(middleCut("a-very-long-name-without-an-extension", 20)).toMatch(/^a-very-long-na…nsion$/);
  });

  it("writes limits whole and sizes as a sentence needs them", () => {
    expect(limitText(10 * MiB)).toBe("10 MB");
    expect(limitText(2.5 * MiB)).toBe("2.5 MB");
    expect(roundSizeText(48 * MiB)).toBe("48 MB");
    expect(roundSizeText(Math.round(27.4 * MiB))).toBe("27.4 MB");
    expect(roundSizeText(212 * 1024)).toBe("212 KB");
  });
});

describe("the thread's words", () => {
  it("says what ostra read out of a document, and why it couldn't", () => {
    expect(textExtractedTip({ name: "brand-guide.pdf", textWords: 6210 }, "OpenCode")).toBe("ostra took the text out of this file, 6,210 words, so the agent can read it. OpenCode got the PDF and its text.");
    expect(textFailedTip("encrypted", "OpenCode")).toBe("ostra couldn't read the text of this file: it's encrypted. OpenCode got the file.");
    expect(textFailedTip("something-new", "OpenCode")).toBe("ostra couldn't read the text of this file: it couldn't be read. OpenCode got the file.");
    expect(chipName({ name: "history-panel-spec.docx", size: 48 * 1024, text: "ready" })).toBe("Download history-panel-spec.docx, DOCX, 48 KB, text extracted");
    expect(chipName({ name: "results-sample.csv", size: 2 * 1024, text: "none" })).toBe("Download results-sample.csv, CSV, 2 KB");
  });

  it("says when a message's images went as files, and why", () => {
    expect(imagesNotSentText("model", { model: "DeepSeek V4.1 Flash", agent: "OpenCode" })).toBe("DeepSeek V4.1 Flash can't see images: OpenCode got them as files.");
    expect(imagesNotSentText("agent", { model: "DeepSeek V4.1 Flash", agent: "OpenCode" })).toBe("OpenCode takes no images in its prompt: it got them as files.");
    expect(agentGotText(true, null, "OpenCode")).toBe("the image");
    expect(agentGotText(false, "model", "OpenCode")).toBe("a file: the model can't see images");
  });

  it("names why a file was left out, with its size and the limit", () => {
    const limits = { maxFiles: 20, maxFileBytes: 10 * MiB, maxTotalBytes: 50 * MiB };
    expect(leftOutText({ reason: "too-big", size: 84 * MiB }, "ticket", limits, "Linear")).toBe("84 MB, over the 10 MB a file can be");
    expect(leftOutText({ reason: "too-many", size: null }, "ticket", limits, "Linear")).toBe("past the 20 attachments a ticket can give");
    expect(leftOutText({ reason: "too-many", size: null }, "message", { ...limits, maxFiles: 10 }, "")).toBe("past the 10 files a message can hold");
    expect(leftOutText({ reason: "download-failed", size: null }, "ticket", limits, "Linear")).toBe("it didn't load from Linear");
  });

  it("counts people's files, titles the viewer by whose pictures it shows, and folds a long strip", () => {
    expect(peopleText(2, 3)).toBe("2 images · 3 files");
    expect(peopleText(1, 0)).toBe("1 image");
    expect(viewerTitle("capture")).toBe("Screenshots and recordings");
    expect(viewerTitle("message")).toBe("Attachments");
    expect(viewerTitle("ticket")).toBe("The ticket's attachments");
    expect(viewerTitle("unsent")).toBe("Not sent yet");
    expect(stripOf([1, 2, 3, 4, 5, 6])).toEqual({ shown: [1, 2, 3, 4, 5, 6], more: 0 });
    expect(stripOf([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({ shown: [1, 2, 3, 4, 5], more: 3 });
  });
});
