import { describe, expect, it } from "vitest";

import { attachmentIdSchema, blobIdSchema, taskEventSchema, turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { eventFixtures, minor7EventFixtures } from "@ostra/protocol/testing";

import { foldTaskEvents } from "./fold.ts";
import { storeEvents } from "./testing/index.ts";
import type { AttachmentsData, TaskUIMessage, TaskUIPart } from "./ui-types.ts";

// Milestone 8's ticket 17 (F-121, F-140): the pictures and the app's lines in the thread, folded
// from the events the runner sends (`attachment.added`, `attachment.skipped`, `app.process`,
// `app.browser`). The panel draws each run from the task's attachments; these are their places.

const turnId = turnIdSchema.parse("0196f1a0-0000-7000-8000-0000000000f1");
const nextTurn = turnIdSchema.parse("0196f1a0-0000-7000-8000-0000000000f2");

/** An event from its fields, through the protocol's schema. */
const ev = (event: Readonly<Record<string, unknown>>): TaskEvent => taskEventSchema.parse(event);

const shot = (n: number, width: number, height: number, path = "/history"): TaskEvent => ({
  ...eventFixtures["attachment.added"],
  attachmentId: attachmentIdSchema.parse(`att-${String(n)}`),
  blobId: blobIdSchema.parse(`0196f1a0-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`),
  path,
  width,
  height,
});

const recording: TaskEvent = { ...minor7EventFixtures.recording, attachmentId: attachmentIdSchema.parse("att-rec") };

const pictureCall = (id: string, title: string): TaskEvent[] => [
  ev({ kind: "tool.called", turnId, toolCallId: id, toolKind: "other", title, input: {} }),
  ev({ kind: "tool.completed", toolCallId: id, output: { text: "Saved as att-1" } }),
];

const runsOf = (messages: readonly TaskUIMessage[]): AttachmentsData[] =>
  messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "data-attachments" ? [part.data] : [])));

const typesIn = (message: TaskUIMessage | undefined): string[] => (message?.parts ?? []).map((part: TaskUIPart) => part.type);

describe("the pictures in the thread (F-121)", () => {
  it("F-121/c4: a run of screenshots is one row at its place in the turn, the agent's own calls folded into it, and a recording a row of its own", () => {
    const events: TaskEvent[] = [
      { kind: "turn.started", turnId },
      ev({ kind: "agent.message", turnId, segmentId: "s1", text: "The panel works." }),
      ...pictureCall("c1", "ostra_take_screenshot"),
      shot(1, 1280, 800),
      ...pictureCall("c2", "ostra_take_screenshot"),
      shot(2, 768, 1024),
      ...pictureCall("c3", "ostra_take_screenshot"),
      shot(3, 390, 844),
      ...pictureCall("c4", "ostra_record_app"),
      recording,
      ev({ kind: "turn.ended", turnId, stopReason: "end_turn" }),
    ];
    const messages = foldTaskEvents(storeEvents(events), []);
    const turn = messages.find((message) => message.role === "assistant");
    // The text, then the screenshots' row, then the recording's: no tool row for the picture calls.
    expect(typesIn(turn).filter((type) => type !== "step-start")).toEqual(["text", "data-attachments", "data-attachments"]);
    const [screenshots, recorded] = runsOf(messages);
    expect(screenshots?.kind).toBe("screenshot");
    expect(screenshots?.items.map((item) => [item.attachmentId, item.width, item.height])).toEqual([
      ["att-1", 1280, 800],
      ["att-2", 768, 1024],
      ["att-3", 390, 844],
    ]);
    expect(recorded?.kind).toBe("recording");
    expect(recorded?.items[0]?.durationMs).toBe(4100);
    // The line saying where they're kept goes under the turn's last run only.
    expect([screenshots?.lastInTurn, recorded?.lastInTurn]).toEqual([false, true]);
    expect(recorded?.turnId).toBe(turnId);
  });

  it("F-121/c4: the after-turn screenshots come at the turn's end, after it ended, and a member's from the pane is a row of its own", () => {
    const events: TaskEvent[] = [
      { kind: "turn.started", turnId },
      ev({ kind: "agent.message", turnId, segmentId: "s1", text: "Done." }),
      ev({ kind: "turn.ended", turnId, stopReason: "end_turn" }),
      { ...minor7EventFixtures.afterTurn, attachmentId: attachmentIdSchema.parse("att-a1") },
      { ...minor7EventFixtures.afterTurn, attachmentId: attachmentIdSchema.parse("att-a2"), width: 390, height: 844 },
      minor7EventFixtures.memberScreenshot,
    ];
    const messages = foldTaskEvents(storeEvents(events), []);
    const turn = messages.find((message) => message.role === "assistant");
    const inTurn = runsOf(turn === undefined ? [] : [turn]);
    expect(inTurn).toHaveLength(1);
    expect(inTurn[0]?.source).toBe("after-turn");
    expect(inTurn[0]?.items.map((item) => item.attachmentId)).toEqual(["att-a1", "att-a2"]);
    const member = messages.at(-1);
    expect(member?.role).toBe("system");
    expect(runsOf(member === undefined ? [] : [member])[0]).toMatchObject({ source: "member", turnId: null, lastInTurn: false });
  });

  it("F-121/c8: each picture keeps the browser and the version that took it, and its caption as data", () => {
    const messages = foldTaskEvents(storeEvents([{ kind: "turn.started", turnId }, eventFixtures["attachment.added"]]), []);
    const [item] = runsOf(messages)[0]?.items ?? [];
    expect(item?.browser).toEqual({ name: "Chromium", version: "131.0.6778.85" });
    expect(item?.caption).toBe("The footer shows the API's version.");
  });

  it("F-121/c5: the same events fold to the same rows on a reload, and a later turn's pictures stay in their own turn", () => {
    const events: TaskEvent[] = [
      { kind: "turn.started", turnId },
      shot(1, 1280, 800),
      ev({ kind: "turn.ended", turnId, stopReason: "end_turn" }),
      eventFixtures["session.ended"],
      { kind: "turn.started", turnId: nextTurn },
      shot(2, 1280, 800),
    ];
    const once = runsOf(foldTaskEvents(storeEvents(events), []));
    const again = runsOf(foldTaskEvents(storeEvents(events), []));
    expect(again).toEqual(once);
    expect(once.map((run) => [run.turnId, run.items.map((item) => item.attachmentId)])).toEqual([
      [turnId, ["att-1"]],
      [nextTurn, ["att-2"]],
    ]);
  });

  it("F-121/c9: after-turn screenshots that weren't taken say so at the turn's end", () => {
    const messages = foldTaskEvents(storeEvents([{ kind: "turn.started", turnId }, ev({ kind: "turn.ended", turnId, stopReason: "end_turn" }), eventFixtures["attachment.skipped"]]), []);
    const turn = messages.find((message) => message.role === "assistant");
    const skipped = turn?.parts.find((part) => part.type === "data-attachment-skipped");
    expect(skipped?.type === "data-attachment-skipped" ? skipped.data : null).toEqual({ source: "after-turn", reason: "limit-reached", count: 2 });
  });

  it("F-121/c2: a box with no browser is said once per task, and a box with one says nothing", () => {
    const messages = foldTaskEvents(
      storeEvents([eventFixtures["app.browser"], { kind: "turn.started", turnId }, minor7EventFixtures.noBrowser, minor7EventFixtures.noBrowser]),
      [],
    );
    const said = messages.flatMap((message) => message.parts.filter((part) => part.type === "data-no-browser"));
    expect(said).toHaveLength(1);
  });
});

describe("the app's lines in the thread (F-140)", () => {
  it("F-140/c5: a process's start is one quiet line, updated in place as it gets ready, with the time it took", () => {
    const stored = storeEvents([
      { kind: "turn.started", turnId },
      { ...minor7EventFixtures.ready, state: "starting" },
      { ...minor7EventFixtures.ready },
    ]);
    const ready = stored[2];
    if (ready !== undefined) Object.assign(ready, { at: (stored[1]?.at ?? 0) + 6000 });
    const messages = foldTaskEvents(stored, []);
    const lines = messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "data-app-process" ? [part.data] : [])));
    expect(lines).toEqual([{ name: "web", port: 5173, state: "ready", exitCode: null, reason: null, logBlobId: null, readyAfterMs: 6000 }]);
  });

  it("F-140/c5: a process stopped with its box once it was ready keeps its ready line", () => {
    const messages = foldTaskEvents(
      storeEvents([{ ...minor7EventFixtures.ready, state: "starting" }, minor7EventFixtures.ready, { ...minor7EventFixtures.ready, state: "stopped", reason: "box-stopped" }]),
      [],
    );
    const lines = messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "data-app-process" ? [part.data] : [])));
    expect(lines.map((line) => line.state)).toEqual(["ready"]);
  });

  it("F-140/c5: a process that exits names its exit code and its log's tail, and a new start is a new line", () => {
    const messages = foldTaskEvents(
      storeEvents([
        { kind: "app.process", name: "api", state: "starting", port: 3001, exitCode: null, reason: null, logBlobId: null },
        eventFixtures["app.process"],
        { kind: "app.process", name: "api", state: "starting", port: 3001, exitCode: null, reason: null, logBlobId: null },
        { kind: "app.process", name: "api", state: "stopped", port: 3001, exitCode: null, reason: null, logBlobId: null },
      ]),
      [],
    );
    const lines = messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "data-app-process" ? [part.data] : [])));
    expect(lines.map((line) => [line.state, line.exitCode, line.logBlobId])).toEqual([
      ["failed", 1, "0196f1a0-0000-7000-8000-00000000002c"],
      ["stopped", null, null],
    ]);
  });
});
