import { describe, expect, it } from "vitest";

import { attachmentIdSchema, memberIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";

import { bytesText, capturedText, captions, captureSubject, durationText, earlierOf, frameAt, stepAt, stepWords, thumbWidth, viewerSet } from "./attachment-words";
import type { AttachmentView } from "./attachment-words";

// Milestone 8's ticket 17 (F-121): the thread's pictures, their captions and sizes, the viewer's
// set and its "Compare with", and where the recording's player is in its reel.

const taskId = taskIdSchema.parse("0196f1a0-0000-7000-8000-0000000000b1");
const turn = { turnId: turnIdSchema.parse("0196f1a0-0000-7000-8000-0000000000c1"), ordinal: 2, startSeq: 10 };
const earlierTurn = { turnId: turnIdSchema.parse("0196f1a0-0000-7000-8000-0000000000c0"), ordinal: 1, startSeq: 2 };

const view = (id: string, overrides: Partial<AttachmentView> = {}): AttachmentView => ({
  attachmentId: attachmentIdSchema.parse(id),
  taskId,
  kind: "screenshot",
  source: "agent",
  target: { kind: "process", name: "web" },
  path: "/history",
  width: 1280,
  height: 800,
  bytes: 217_088,
  contentType: "image/png",
  durationMs: null,
  frameCount: null,
  caption: null,
  browser: { name: "Chromium", version: "131.0.6778.85" },
  turn,
  takenBy: null,
  inDraft: false,
  draftImageId: null,
  createdAt: 1_795_000_000_000,
  downloadPath: `/api/tasks/${taskId}/attachments/${id}`,
  ...overrides,
});

describe("the thread's pictures (F-121)", () => {
  it("F-121/c4: each thumbnail is 110px tall at its capture's own aspect, captioned with its width and its route where it changes", () => {
    expect([thumbWidth({ width: 1280, height: 800 }), thumbWidth({ width: 768, height: 1024 }), thumbWidth({ width: 390, height: 844 })]).toEqual([176, 83, 51]);
    const items = [
      { kind: "screenshot" as const, path: "/history", width: 1280 },
      { kind: "screenshot" as const, path: "/history", width: 768 },
      { kind: "screenshot" as const, path: "/history", width: 390 },
    ];
    expect(captions(items)).toEqual(["1280 · /history", "768", "390"]);
    expect(captions([...items, { kind: "screenshot" as const, path: "/settings", width: 1280 }]).at(-1)).toBe("1280 · /settings");
    expect(captions([{ kind: "recording" as const, path: "/", width: 1280 }])).toEqual(["1280 · recording"]);
  });

  it("F-121/c4: the capture row says how many and of which route, or the environment's routes after a turn", () => {
    expect(captureSubject([{ path: "/history", source: "agent" }, { path: "/history", source: "agent" }, { path: "/history", source: "agent" }])).toEqual({ words: "3 screenshots of", route: "/history" });
    expect(captureSubject([{ path: "/", source: "agent" }, { path: "/settings", source: "agent" }])).toEqual({ words: "2 screenshots", route: null });
    expect(captureSubject([{ path: "/", source: "after-turn" }, { path: "/history", source: "after-turn" }, { path: "/settings", source: "after-turn" }])).toEqual({ words: "the environment's 3 routes", route: null });
  });

  it("F-121/c4: the viewer moves through the turn's pictures, and compares a screenshot with the newest earlier one of its route and width", () => {
    const old = view("att-old", { turn: earlierTurn, createdAt: 1_794_999_000_000 });
    const oldPhone = view("att-old-phone", { turn: earlierTurn, width: 390, height: 844, createdAt: 1_794_999_000_100 });
    const shots = [view("att-1"), view("att-2", { width: 768, height: 1024 }), view("att-3", { width: 390, height: 844 })];
    const recording = view("att-rec", { kind: "recording", durationMs: 42_000, frameCount: 300, path: "/" });
    const all = [old, oldPhone, ...shots, recording];
    expect(viewerSet(all, shots[0] ?? old).map((one) => one.attachmentId)).toEqual(["att-1", "att-2", "att-3", "att-rec"]);
    expect(earlierOf(all, shots[0] ?? old)?.attachmentId).toBe("att-old");
    expect(earlierOf(all, shots[2] ?? old)?.attachmentId).toBe("att-old-phone");
    expect(earlierOf(all, shots[1] ?? old)).toBeNull();
    // A member's picture from the pane stands alone.
    const member = view("att-m", { source: "member", turn: null, takenBy: { memberId: memberIdSchema.parse("0196f1a0-0000-7000-8000-0000000000d1"), name: "Sam Rivera" } });
    expect(viewerSet([...all, member], member)).toEqual([member]);
  });

  it("F-121/c4: the properties group counts the pictures and their size", () => {
    const all = [view("att-1"), view("att-2", { width: 768 }), view("att-3", { width: 390 }), view("att-rec", { kind: "recording", bytes: 3_250_586 })];
    expect(capturedText(all)).toBe("3 screenshots · 1 recording");
    expect(bytesText(217_088)).toBe("212 KB");
    expect(bytesText(3_250_586)).toBe("3.1 MB");
    expect(durationText(42_000)).toBe("0:42");
  });

  it("F-121/c4: the player shows the frame at or before its time, and marks the step playing then", () => {
    const times = [0, 100, 200, 300, 400];
    expect([frameAt(times, 0), frameAt(times, 150), frameAt(times, 400), frameAt(times, 10_000)]).toEqual([0, 1, 4, 4]);
    expect([stepAt([0, 1200, 2500], 50), stepAt([0, 1200, 2500], 1300), stepAt([500], 0)]).toEqual([0, 1, -1]);
    expect(stepWords({ action: "click", target: { text: "Add" } })).toBe("Click “Add”");
    expect(stepWords({ action: "fill", selector: "#amount", value: "1027.6" })).toBe("Fill #amount with “1027.6”");
    expect(stepWords({ action: "goto", path: "/history" })).toBe("Open /history");
  });
});
