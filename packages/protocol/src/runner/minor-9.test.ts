import { describe, expect, it } from "vitest";

import {
  encodeEventForMinor,
  eventKindMinMinor,
  isTaskEventKind,
  minor10EventKinds,
  QUESTION_OTHER_MAX,
  readEventSchema,
  runnerEventSchema,
  serverOnlyKinds,
  storedEventSchema,
  taskEventKinds,
  taskEventSchema,
} from "../events/agent-events.ts";
import type { TaskEvent } from "../events/agent-events.ts";
import { reviewRunIdSchema } from "../ids.ts";
import {
  memoryToolNames,
  ostraToolKinds,
  ostraToolOf,
  PROPOSE_ENVIRONMENT_TOOL,
  RECORD_APP_TOOL,
  reviewResultText,
  SHOW_PREVIEW_TOOL,
  START_APP_TOOL,
  SUBMIT_DRAFT_TOOL,
  SUBMIT_REVIEW_TOOL,
  TAKE_SCREENSHOT_TOOL,
} from "../mcp/tools.ts";
import {
  commandFixtures,
  eventFixtures,
  fixtureIds as ids,
  minor5HttpFixtures,
  minor7CommandFixtures,
  minor8CommandFixtures,
  minor8EventFixtures,
  minor9EventFixtures,
  minor9HttpFixtures,
} from "../testing/fixtures.ts";
import { commandSchema, encodeCommandForMinor, questionAnswerBodySchema } from "./commands.ts";
import type { Command } from "./commands.ts";
import {
  REVIEW_ALREADY_MINOR,
  reviewAnswerFor,
  reviewResponseSchema,
  reviewResponseSchemaV8,
  reviewSavedSchema,
  reviewSavedSchemaV8,
} from "./http.ts";
import type { ReviewSaved } from "./http.ts";
import { downFrameCodec, httpDownFrameCodec, runnerScopedEventSupportedAt, upFrameCodec } from "./messages.ts";
import type { UpFrame } from "./messages.ts";
import { minorWindow, negotiate, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./version.ts";

// Protocol minor 9 (milestone 10, ticket 01, F-151): the compact thread. Optional fields only: a
// repeat review's `already`, which a minor-8 sidecar is never sent; three server events' optional
// fields; and `ostraToolOf`. A minor-8 peer keeps working inside the window, with every frame as it
// was; a minor-7 peer is outside it.

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const reviewRunId = reviewRunIdSchema.parse("review-run-1");
const already: ReviewSaved = { reviewRunId, already: true };

const ALREADY_WORDS = "This round's review is already handed in, and it stands as it was. Nothing more is needed.";
const SAVED_WORDS = "The review is saved. ostra posts it on the pull requests as comments, and a member reads every finding.";

describe("the version", () => {
  it("F-061, F-151: minor 9 stays in the codecs after minor 10; its own window is as it was", () => {
    // Post-v1 (F-052) moved the build to minor 10 (`minor-10.test.ts`).
    expect(PROTOCOL_MINOR).toBe(10);
    expect(minorWindow(9)).toEqual({ min: 8, max: 10 });
    expect(negotiate(9, PROTOCOL_MAJOR, 8)).toEqual({ ok: true, minor: 8 });
    expect(negotiate(9, PROTOCOL_MAJOR, 9)).toEqual({ ok: true, minor: 9 });
    expect(negotiate(9, PROTOCOL_MAJOR, 10)).toEqual({ ok: true, minor: 9 });
    expect(negotiate(9, PROTOCOL_MAJOR, 7)).toEqual({ ok: false, reason: "minor", window: { min: 8, max: 10 } });
    expect(negotiate(9, PROTOCOL_MAJOR, 11)).toEqual({ ok: false, reason: "minor", window: { min: 8, max: 10 } });
    // A minor-9 runner against a minor-8 server speaks minor 8.
    expect(negotiate(8, PROTOCOL_MAJOR, 9)).toEqual({ ok: true, minor: 8 });
    expect(upFrameCodec.minors).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(downFrameCodec.minors).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(httpDownFrameCodec.minors).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("a repeat review's answer (F-151/c7)", () => {
  it("F-151/c7: reviewAnswerFor(8, { reviewRunId, already: true }) has no already, and minor 8's reviewSavedSchema parses it; minor 9's keeps it", () => {
    // A minor-8 runner gets the saved answer it always read: no `already`.
    const toMinor8 = reviewAnswerFor(8, already);
    expect(toMinor8).toEqual({ reviewRunId });
    expect("already" in toMinor8).toBe(false);
    expect(reviewSavedSchemaV8.parse(roundTrip(toMinor8))).toEqual({ reviewRunId });
    expect(reviewResponseSchemaV8.parse(roundTrip(toMinor8))).toEqual({ reviewRunId });
    // Below minor 8 too: the field is minor 9's.
    for (const minor of [0, 5, 7, REVIEW_ALREADY_MINOR - 1]) {
      expect(reviewAnswerFor(minor, already), String(minor)).toEqual({ reviewRunId });
    }
    // A minor-9 runner, and a newer one, keep it, and read it with today's schema.
    expect(REVIEW_ALREADY_MINOR).toBe(9);
    for (const minor of [9, 10]) {
      const answer = reviewAnswerFor(minor, already);
      expect(answer, String(minor)).toEqual(already);
      expect(reviewSavedSchema.parse(roundTrip(answer))).toEqual(already);
      expect(reviewResponseSchema.parse(roundTrip(answer))).toEqual(already);
    }
    // A first hand-in has no `already`, and is the same answer at every minor.
    const first: ReviewSaved = { reviewRunId };
    for (const minor of [7, 8, 9, 10]) {
      expect(reviewAnswerFor(minor, first)).toEqual(first);
      expect(reviewSavedSchemaV8.parse(roundTrip(reviewAnswerFor(minor, first)))).toEqual(first);
    }
  });

  it("F-151/c7: minor 8's strict schema refuses already, which is why core answers by the runner's minor", () => {
    // What reviewAnswerFor guards against: `already` sent to a minor-8 sidecar fails its parse.
    expect(reviewSavedSchemaV8.safeParse(roundTrip(already)).success).toBe(false);
    expect(reviewResponseSchemaV8.safeParse(roundTrip(already)).success).toBe(false);
    expect(reviewResponseSchemaV8.safeParse(roundTrip(minor9HttpFixtures.reviewAlready)).success).toBe(false);
    // Today's schema takes `already: true` only, and nothing else new.
    expect(reviewSavedSchema.safeParse({ reviewRunId, already: false }).success).toBe(false);
    expect(reviewSavedSchema.safeParse({ reviewRunId, already: "yes" }).success).toBe(false);
    expect(reviewSavedSchema.safeParse({ reviewRunId, already: true, surprise: 1 }).success).toBe(false);
    expect(reviewResponseSchema.parse(minor9HttpFixtures.reviewAlready)).toEqual(minor9HttpFixtures.reviewAlready);
    // The refusals are as they were, on both minors' schemas.
    for (const refusal of minor5HttpFixtures.reviewRefusals) {
      expect(reviewResponseSchema.parse(refusal)).toEqual(refusal);
      expect(reviewResponseSchemaV8.parse(refusal)).toEqual(refusal);
    }
  });

  it("F-151/c7: reviewResultText gives the already words for it, a success, and the saved and refused answers keep their words", () => {
    expect(reviewResultText(already)).toBe(ALREADY_WORDS);
    expect(reviewResultText(minor9HttpFixtures.reviewAlready)).toBe(ALREADY_WORDS);
    // A minor-8 sidecar, answered without `already`, tells its agent the review is saved: a success too.
    expect(reviewResultText(reviewAnswerFor(8, already))).toBe(SAVED_WORDS);
    expect(reviewResultText({ reviewRunId })).toBe(SAVED_WORDS);
    expect(reviewResultText({ code: "wrong-kind" })).toBe("Only a review task hands in a review. This task can't.");
    expect(reviewResultText({ code: "invalid" })).toBe(
      "The review doesn't fit the tool's limits. Check each field's limit in the tool's description, and call it again.",
    );
    expect(reviewResultText({ code: "limit-reached" })).toBe("This round's review is already handed in. It stands as it is.");
    expect(reviewResultText({ code: "not-in-review" })).toBe("The pull requests are no longer waiting for this review. Nothing was saved.");
  });
});

describe("ostra's tools by name (F-151/c8)", () => {
  it("F-151/c8: ostraToolOf names ostra's tools bare and with any agent's prefix, the memory tools as one kind, and null for anyone else's", () => {
    const named: readonly (readonly [string, (typeof ostraToolKinds)[number] | null])[] = [
      // Bare, as the sidecar serves them.
      ["submit_review", "submit_review"],
      [SUBMIT_DRAFT_TOOL, "submit_draft"],
      [SHOW_PREVIEW_TOOL, "show_preview"],
      [TAKE_SCREENSHOT_TOOL, "take_screenshot"],
      [RECORD_APP_TOOL, "record_app"],
      [PROPOSE_ENVIRONMENT_TOOL, "propose_environment"],
      // With each agent's prefix: OpenCode's `{server}_{tool}`, a dotted one and the fakes' slash.
      ["ostra_submit_review", "submit_review"],
      ["ostra.show_preview", "show_preview"],
      ["ostra/submit_draft", "submit_draft"],
      ["ostra_take_screenshot", "take_screenshot"],
      ["ostra.record_app", "record_app"],
      ["ostra/propose_environment", "propose_environment"],
      // The suffix forms the fold's isPictureTool matched, which ostraToolOf replaces.
      ["mcp__ostra__take_screenshot", "take_screenshot"],
      ["ostra-sidecar/record_app", "record_app"],
      // The memory tools, one kind, bare or prefixed.
      ["memory_search", "memory"],
      ["ostra_memory_read", "memory"],
      ["ostra.memory_propose", "memory"],
      ["ostra/memory_search", "memory"],
      // Anyone else's tool, and a name that merely holds one of ostra's.
      ["bash", null],
      ["github_create_issue", null],
      ["my_submit_review_helper", null],
      ["submit_review_v2", null],
      ["ostra_submit_reviews", null],
      ["memory", null],
      ["ostra_", null],
      ["", null],
      // ostra's tools the thread draws by their own events, not by name.
      [START_APP_TOOL, null],
      ["ostra_set_pull_request_text", null],
    ];
    for (const [title, kind] of named) {
      expect(ostraToolOf(title), title).toBe(kind);
    }
    for (const name of memoryToolNames) {
      expect(ostraToolOf(name)).toBe("memory");
      expect(ostraToolOf(`ostra_${name}`)).toBe("memory");
    }
    // Every kind is some tool's.
    const kinds = new Set([SUBMIT_REVIEW_TOOL, SUBMIT_DRAFT_TOOL, SHOW_PREVIEW_TOOL, TAKE_SCREENSHOT_TOOL, RECORD_APP_TOOL, PROPOSE_ENVIRONMENT_TOOL, ...memoryToolNames].map((name) => ostraToolOf(name)));
    expect([...kinds].sort()).toEqual([...ostraToolKinds].sort());
  });
});

describe("minor 9's server events, optional fields", () => {
  it("F-151/c5: question.answered with other parses, and refuses a repeated ID; an event without it still parses", () => {
    const words = minor9EventFixtures.answeredInWords;
    expect(taskEventSchema.parse(roundTrip(words))).toEqual(words);
    expect(readEventSchema.parse(roundTrip(words))).toEqual(words);
    expect(storedEventSchema.parse({ taskId: ids.task, seq: 3, sessionId: ids.session, sessionSeq: null, at: 1_900_000_000_000, event: words }).event).toEqual(words);
    // Each field once.
    const repeated = { ...words, other: ["reason", "reason"] };
    expect(taskEventSchema.safeParse(repeated).success).toBe(false);
    expect(readEventSchema.safeParse(repeated).success).toBe(false);
    // An event without it, as an older server wrote it, still parses, and so does an empty list.
    const before = eventFixtures["question.answered"];
    expect("other" in before).toBe(false);
    expect(taskEventSchema.parse(roundTrip(before))).toEqual(before);
    expect(readEventSchema.parse(roundTrip(before))).toEqual(before);
    expect(taskEventSchema.safeParse({ ...before, other: [] }).success).toBe(true);
    // A field answered in words is one of the answered fields; IDs only, within the limits.
    expect(taskEventSchema.safeParse({ ...words, other: ["runner", "reason"] }).success).toBe(true);
    expect(taskEventSchema.safeParse({ ...words, other: ["unasked"] }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...words, other: [""] }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...words, other: ["x".repeat(201)] }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...words, other: "reason" }).success).toBe(false);
    const many = Array.from({ length: QUESTION_OTHER_MAX + 1 }, (_, index) => `field-${String(index)}`);
    const answers = Object.fromEntries(many.map((id) => [id, "in words"]));
    expect(QUESTION_OTHER_MAX).toBe(100);
    expect(taskEventSchema.safeParse({ ...words, answers, other: many.slice(0, QUESTION_OTHER_MAX) }).success).toBe(true);
    expect(taskEventSchema.safeParse({ ...words, answers, other: many }).success).toBe(false);
  });

  it("F-151/c7: review.submitted's repeat and draft.submitted's counts parse; the events without them still parse", () => {
    const repeat = minor9EventFixtures.repeatReview;
    expect(taskEventSchema.parse(roundTrip(repeat))).toEqual(repeat);
    expect(readEventSchema.parse(roundTrip(repeat))).toEqual(repeat);
    expect(taskEventSchema.safeParse({ ...repeat, repeat: false }).success).toBe(false);
    expect(taskEventSchema.parse(roundTrip(eventFixtures["review.submitted"]))).toEqual(eventFixtures["review.submitted"]);

    const draft = minor9EventFixtures.draftWithCounts;
    expect(taskEventSchema.parse(roundTrip(draft))).toEqual(draft);
    expect(readEventSchema.parse(roundTrip(draft))).toEqual(draft);
    expect(taskEventSchema.parse(roundTrip(eventFixtures["draft.submitted"]))).toEqual(eventFixtures["draft.submitted"]);
    // Counts only: non-negative integers within the draft's own limits (30 criteria, 20 sub-tickets).
    expect(taskEventSchema.safeParse({ ...draft, acceptanceCriteria: 0, subTickets: 0 }).success).toBe(true);
    expect(taskEventSchema.safeParse({ ...draft, acceptanceCriteria: 30, subTickets: 20 }).success).toBe(true);
    for (const bad of [{ acceptanceCriteria: 31 }, { subTickets: 21 }, { acceptanceCriteria: -1 }, { subTickets: 1.5 }, { acceptanceCriteria: "4" }]) {
      expect(taskEventSchema.safeParse({ ...draft, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("F-151: the three kinds stay the server's own: a runner can't send one, with or without the new fields", () => {
    const grown: readonly TaskEvent[] = [minor9EventFixtures.answeredInWords, minor9EventFixtures.repeatReview, minor9EventFixtures.draftWithCounts];
    for (const event of grown) {
      expect(serverOnlyKinds.has(event.kind)).toBe(true);
      expect(runnerEventSchema.safeParse({ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_900_000_000_000, event }).success, event.kind).toBe(false);
      // No new kind: each is a kind a minor-8 reader already has.
      expect(eventKindMinMinor(event.kind), event.kind).toBeLessThanOrEqual(8);
    }
  });
});

describe("unchanged at minor 9", () => {
  it("F-151: question-answer's body is as it was: each answer any string, no field for the words", () => {
    expect(questionAnswerBodySchema.keyof().options).toEqual(["sessionId", "questionId", "answers"]);
    const fixture = commandFixtures["question-answer"];
    // An answer in the member's own words is just the field's answer.
    const inWords: Command = { ...fixture, body: { ...fixture.body, answers: { runner: "Use the repo's own `pnpm test`; don't add a runner." } } };
    expect(commandSchema.parse(roundTrip(inWords))).toEqual(inWords);
    expect(commandSchema.safeParse({ ...fixture, body: { ...fixture.body, other: ["runner"] } }).success).toBe(false);
    expect(encodeCommandForMinor(inWords, 8)).toEqual(inWords);
  });

  it("F-151: every runner event and every command is minor 8's: encoded for a minor-8 peer exactly as for a minor-9 one", () => {
    // Minor 10 adds one kind (`egress.blocked`, F-052): 99 in all.
    expect(taskEventKinds).toHaveLength(99);
    const runnerEvents = [...Object.values(eventFixtures), ...Object.values(minor8EventFixtures)].filter(
      (event) => !serverOnlyKinds.has(event.kind) && !minor10EventKinds.has(event.kind),
    );
    expect(runnerEvents.length).toBeGreaterThan(40);
    for (const event of runnerEvents) {
      expect(encodeEventForMinor(event, 8), event.kind).toEqual(event);
      const frame: UpFrame = { type: "events", events: [{ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_900_000_000_000, event }] };
      expect(upFrameCodec.encode(frame, 8), event.kind).toBe(upFrameCodec.encode(frame, 9));
      expect(upFrameCodec.parse(upFrameCodec.encode(frame, 9), 8), event.kind).toEqual({ ok: true, frame });
    }
    const commands: readonly Command[] = [...Object.values(commandFixtures), ...Object.values(minor7CommandFixtures), ...Object.values(minor8CommandFixtures)];
    for (const command of commands) {
      expect(encodeCommandForMinor(command, 8), command.kind).toEqual(command);
      expect(httpDownFrameCodec.encode(command, 8), command.kind).toBe(httpDownFrameCodec.encode(command, 9));
      expect(httpDownFrameCodec.parse(httpDownFrameCodec.encode(command, 9), 8), command.kind).toEqual({ ok: true, frame: command });
    }
  });
});

describe("a box never placed (ADR 0060, added 2026-11-22 before minor 9's release)", () => {
  it("F-093/c3: box.unscheduled travels in a runner-event frame at minor 9, never at minor 8 nor in a session's events, and ostra owns its shape: strict, with its box and a reason", () => {
    for (const reason of ["no-node", "no-room"] as const) {
      const frame: UpFrame = { type: "runner-event", at: 1_900_000_000_000, event: { kind: "box.unscheduled", boxId: ids.box, reason } };
      expect(upFrameCodec.parse(upFrameCodec.encode(frame, 9), 9)).toEqual({ ok: true, frame });
      expect(upFrameCodec.parse(JSON.stringify(frame), 8).ok).toBe(false);
      expect(runnerScopedEventSupportedAt(frame.event, 9)).toBe(true);
      expect(runnerScopedEventSupportedAt(frame.event, 8)).toBe(false);
    }
    // Minor 8's lost box still travels at minor 8.
    const lost: UpFrame = { type: "runner-event", at: 1, event: eventFixtures["box.lost"] };
    expect(upFrameCodec.parse(JSON.stringify(lost), 8)).toEqual({ ok: true, frame: lost });
    expect(runnerScopedEventSupportedAt(eventFixtures["box.lost"], 8)).toBe(true);
    // It's the runner's word to core alone, no task event: a session's events refuse it.
    expect(isTaskEventKind("box.unscheduled")).toBe(false);
    expect(runnerEventSchema.safeParse({ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: { kind: "box.unscheduled", boxId: ids.box, reason: "no-room" } }).success).toBe(false);
    // Strict: a reason it doesn't know, no box, a field it doesn't have.
    const at9 = (event: unknown): boolean => upFrameCodec.parse(JSON.stringify({ type: "runner-event", at: 1, event }), 9).ok;
    expect(at9({ kind: "box.unscheduled", boxId: ids.box, reason: "no-room" })).toBe(true);
    expect(at9({ kind: "box.unscheduled", boxId: ids.box, reason: "no-image" })).toBe(false);
    expect(at9({ kind: "box.unscheduled", reason: "no-room" })).toBe(false);
    expect(at9({ kind: "box.unscheduled", boxId: ids.box, reason: "no-room", exitCode: 1 })).toBe(false);
  });
});
