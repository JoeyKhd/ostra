import { describe, expect, it } from "vitest";

import {
  eventKindSupportedAt,
  minor2EventKinds,
  minor3EventKinds,
  readEventSchema,
  runnerEventSchema,
  serverOnlyKinds,
  taskEventKinds,
  taskEventSchema,
  taskEventSchemaV2,
  turnOriginSchema,
} from "../events/agent-events.ts";
import type { TaskEvent, TaskEventKind } from "../events/agent-events.ts";
import {
  memoryIndexEntrySchema,
  memoryKindSchema,
  memoryNoteSchema,
  memoryProposalInputSchema,
  memoryScopeSchema,
} from "../memory/notes.ts";
import {
  encodeTaskSpecForMinor,
  repoBranchName,
  taskSpecMemorySchema,
  taskSpecNeedsMinor3,
  taskSpecResponseSchemaFor,
  taskSpecSchema,
  taskSpecSchemaV0,
  taskSpecSchemaV1,
  taskSpecSchemaV2,
  taskSpecSchemaV3,
  taskSpecSchemaV5,
} from "../task/spec.ts";
import {
  eventFixtures,
  fixtureIds as ids,
  memoryHttpFixtures,
  memoryIndexEntryFixture,
  memoryNoteFixture,
  memoryProposalInputFixture,
  memoryProposalRefusalFixtures,
  taskSpecFixture,
  taskSpecMinor1Fixture,
  taskSpecMinor2Fixture,
  taskSpecMinor3Fixture,
} from "../testing/fixtures.ts";
import {
  memoryNoteResponseSchema,
  memoryProposalRefusalSchema,
  memoryProposalRequestSchema,
  memoryProposalResponseSchema,
  memorySearchRequestSchema,
  memorySearchResponseSchema,
  runnerPaths,
} from "./http.ts";
import { runnerLimits } from "./limits.ts";
import { downFrameCodec, encodeUpFrame, parseUpFrame, upFrameCodec } from "./messages.ts";
import type { UpFrame } from "./messages.ts";
import { minorWindow, negotiate, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./version.ts";

// Protocol minor 3 (milestone 4, ticket 01): every addition round-trips, a minor-2 peer keeps
// working and never sees what minor 3 added, and a minor-1 peer is outside the window.

const addedKinds = [
  "memory.used",
  "memory.proposed",
  "turn.held",
  "turn.released",
  "review.check_updated",
  "pr.related_updated",
  "effort.changed",
] as const satisfies readonly TaskEventKind[];

const serverOnlyAdded = [
  "memory.proposed",
  "turn.held",
  "turn.released",
  "review.check_updated",
  "pr.related_updated",
  "effort.changed",
] as const;

const eventsFrame = (event: TaskEvent): UpFrame => ({
  type: "events",
  events: [{ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_700_000_000_000, event }],
});

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("the version", () => {
  it("F-061: at a minor-3 server, a minor-2 peer is inside the window and a minor-1 peer is outside it", () => {
    expect(PROTOCOL_MINOR).toBeGreaterThanOrEqual(3);
    expect(minorWindow(3)).toEqual({ min: 2, max: 4 });
    expect(negotiate(3, PROTOCOL_MAJOR, 2)).toEqual({ ok: true, minor: 2 });
    expect(negotiate(3, PROTOCOL_MAJOR, 3)).toEqual({ ok: true, minor: 3 });
    expect(negotiate(3, PROTOCOL_MAJOR, 1)).toEqual({ ok: false, reason: "minor", window: { min: 2, max: 4 } });
    // A minor-3 runner against a minor-2 server speaks minor 2.
    expect(negotiate(2, PROTOCOL_MAJOR, 3)).toEqual({ ok: true, minor: 2 });
    expect(upFrameCodec.minors).toContain(3);
    expect(downFrameCodec.minors).toContain(3);
  });

  it("names the working values", () => {
    expect(runnerLimits.memoryNoteTitleMaxChars).toBe(120);
    expect(runnerLimits.memoryNoteBodyMaxBytes).toBe(4 * 1024);
    expect(runnerLimits.memoryIndexMaxNotes).toBe(100);
    expect(runnerLimits.memoryIndexMaxBytes).toBe(8 * 1024);
    expect(runnerLimits.memoryAlwaysMaxBytes).toBe(8 * 1024);
    expect(runnerLimits.memoryQueryMaxChars).toBe(500);
    expect(runnerLimits.memorySearchResultsMax).toBe(20);
    expect(runnerLimits.memoryProposalsPerTask).toBe(20);
    expect(runnerLimits.searchEntryMaxBytes).toBe(8 * 1024);
  });
});

describe("minor 3's events", () => {
  it("adds seven kinds, each with a fixture, none readable below minor 3", () => {
    expect([...minor3EventKinds].sort()).toEqual([...addedKinds].sort());
    for (const kind of addedKinds) {
      expect(taskEventKinds).toContain(kind);
      expect(eventFixtures[kind].kind).toBe(kind);
      expect(eventKindSupportedAt(kind, 2)).toBe(false);
      expect(eventKindSupportedAt(kind, 3)).toBe(true);
      expect(taskEventSchemaV2.safeParse(eventFixtures[kind]).success).toBe(false);
    }
    for (const kind of minor2EventKinds) {
      expect(eventKindSupportedAt(kind, 2)).toBe(true);
      expect(taskEventSchemaV2.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
    }
  });

  it.each(addedKinds)("%s round-trips and reads back", (kind) => {
    const event = eventFixtures[kind];
    expect(taskEventSchema.parse(roundTrip(event))).toEqual(event);
    expect(readEventSchema.parse(event)).toEqual(event);
  });

  it("refuses an unknown field on every new shape, and bad values", () => {
    for (const kind of addedKinds) {
      expect(taskEventSchema.safeParse({ ...eventFixtures[kind], surprise: 1 }).success).toBe(false);
    }
    const bad: readonly unknown[] = [
      { ...eventFixtures["memory.used"], via: "guess" },
      { ...eventFixtures["memory.used"], noteIds: [] },
      { ...eventFixtures["memory.proposed"], title: "x".repeat(runnerLimits.memoryNoteTitleMaxChars + 1) },
      { ...eventFixtures["turn.held"], origin: "cron" },
      { ...eventFixtures["turn.held"], scope: "member" },
      { ...eventFixtures["review.check_updated"], status: "failed" },
      { ...eventFixtures["review.check_updated"], headSha: "nope" },
      { ...eventFixtures["pr.related_updated"], related: [{ repoId: ids.repo, prNumber: 0 }] },
      { ...eventFixtures["pr.related_updated"], related: [{ repoId: ids.repo, prNumber: 1, url: "x" }] },
    ];
    for (const value of bad) {
      expect(taskEventSchema.safeParse(value).success).toBe(false);
    }
  });

  it("F-037: the gate's origins are one closed list", () => {
    expect(turnOriginSchema.options).toEqual([
      "dispatch",
      "reopen",
      "message",
      "diff-comments",
      "update-branch",
      "pr-comment",
      "keep-working",
      "closing-turn",
      "automatic-round",
      // Milestone 6 (F-105, F-012).
      "changes-requested",
      "linear-follow-up",
    ]);
  });

  it("the server-only set holds the six new server kinds, and a runner's batch with one is refused", () => {
    for (const kind of serverOnlyAdded) {
      expect(serverOnlyKinds.has(kind)).toBe(true);
      const item = { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: eventFixtures[kind] };
      expect(runnerEventSchema.safeParse(item).success).toBe(false);
      expect(parseUpFrame(JSON.stringify(eventsFrame(eventFixtures[kind])), 3).ok).toBe(false);
    }
    expect(serverOnlyKinds.has("memory.used")).toBe(false);
  });

  it("F-110: memory.used goes up at minor 3, and a minor-2 server refuses it", () => {
    const frame = eventsFrame(eventFixtures["memory.used"]);
    expect(parseUpFrame(encodeUpFrame(frame, 3), 3)).toEqual({ ok: true, frame });
    expect(parseUpFrame(encodeUpFrame(frame, 3), 2)).toMatchObject({ ok: false, error: { reason: "invalid" } });
    // A minor-2 peer's frame still parses at minor 3.
    const old = eventsFrame(eventFixtures["check.finished"]);
    expect(parseUpFrame(encodeUpFrame(old, 2), 3)).toEqual({ ok: true, frame: old });
  });
});

describe("the task spec at minor 3", () => {
  it("parses with every new field, and minor-2, minor-1 and minor-0 specs still parse", () => {
    expect(taskSpecSchema.parse(roundTrip(taskSpecMinor3Fixture))).toEqual(taskSpecMinor3Fixture);
    for (const spec of [taskSpecMinor2Fixture, taskSpecMinor1Fixture, taskSpecFixture]) {
      expect(taskSpecSchema.parse(spec)).toEqual(spec);
    }
    expect(taskSpecSchemaV2.parse(taskSpecMinor2Fixture)).toEqual(taskSpecMinor2Fixture);
    expect(taskSpecSchemaV1.parse(taskSpecMinor1Fixture)).toEqual(taskSpecMinor1Fixture);
    expect(taskSpecSchemaV0.parse(taskSpecFixture)).toEqual(taskSpecFixture);
    expect(taskSpecSchema.parse({ ...taskSpecMinor2Fixture, memory: null })).toEqual({ ...taskSpecMinor2Fixture, memory: null });
  });

  it("refuses an unknown field in each new section", () => {
    const spec = taskSpecMinor3Fixture;
    const variants: readonly unknown[] = [
      { ...spec, memory: { ...spec.memory, extra: 1 } },
      { ...spec, memory: { ...spec.memory, omitted: -1 } },
      { ...spec, memory: { ...spec.memory, block: "x".repeat(runnerLimits.memoryBlockMaxBytes + 1) } },
      { ...spec, agent: { ...spec.agent, closingTurn: "yes" } },
      { ...spec, repos: spec.repos.map((repo) => ({ ...repo, gitIdentity: { name: "a<b", email: "a@b" } })) },
      { ...spec, repos: spec.repos.map((repo) => ({ ...repo, gitIdentity: { ...repo.gitIdentity, extra: 1 } })) },
    ];
    for (const value of variants) {
      expect(taskSpecSchema.safeParse(value).success).toBe(false);
    }
    expect(taskSpecMemorySchema.description).toContain("never logged");
  });

  it("F-110: a minor-2 peer's spec drops the memory section and the closing turn, and parses with minor 2's schema", () => {
    expect(taskSpecSchemaV2.safeParse(taskSpecMinor3Fixture).success).toBe(false);
    const down = encodeTaskSpecForMinor(taskSpecMinor3Fixture, 2);
    expect(taskSpecSchemaV2.parse(roundTrip(down))).toEqual(down);
    expect(down).not.toHaveProperty("memory");
    expect(down.agent).not.toHaveProperty("closingTurn");
    // Minor 2's own fields stay.
    expect(down.agent.skills).toEqual(taskSpecMinor2Fixture.agent.skills);
    expect(down.checks).toEqual(taskSpecMinor2Fixture.checks);
    expect(encodeTaskSpecForMinor(taskSpecMinor3Fixture, 3)).toEqual(taskSpecMinor3Fixture);
    // Further down, every older schema still reads it.
    expect(taskSpecSchemaV1.parse(roundTrip(encodeTaskSpecForMinor(taskSpecMinor3Fixture, 1)))).toBeTruthy();
    expect(taskSpecSchemaV0.parse(roundTrip(encodeTaskSpecForMinor(taskSpecMinor3Fixture, 0)))).toBeTruthy();
  });

  it("F-136/c10: a spec with a git identity per repo round-trips, and its minor-2 encoding keeps only the top-level one", () => {
    const [first, second] = taskSpecMinor3Fixture.repos;
    expect(first?.gitIdentity).toEqual(taskSpecFixture.gitIdentity);
    expect(second?.gitIdentity?.name).toBe("client-app[bot]");
    expect(taskSpecSchema.parse(roundTrip(taskSpecMinor3Fixture)).repos).toEqual(taskSpecMinor3Fixture.repos);
    const down = encodeTaskSpecForMinor(taskSpecMinor3Fixture, 2);
    expect(down.gitIdentity).toEqual(taskSpecMinor3Fixture.gitIdentity);
    for (const repo of down.repos) {
      expect(repo).not.toHaveProperty("gitIdentity");
    }
    expect(down.repos.map((repo) => repo.repoId)).toEqual([ids.repo, ids.secondRepo]);
  });

  it("F-136/c10: says a spec whose repos have different bots needs a minor-3 runner", () => {
    expect(taskSpecNeedsMinor3(taskSpecMinor3Fixture)).toBe(true);
    expect(taskSpecNeedsMinor3(taskSpecMinor2Fixture)).toBe(false);
    // The same bot on every repo needs nothing new.
    const sameBot = {
      ...taskSpecMinor3Fixture,
      repos: taskSpecMinor3Fixture.repos.map((repo) => ({ ...repo, gitIdentity: taskSpecFixture.gitIdentity })),
    };
    expect(taskSpecNeedsMinor3(sameBot)).toBe(false);
    // Memory alone needs no minor 3: a minor-2 runner gets it folded into its instructions.
    expect(taskSpecNeedsMinor3({ ...taskSpecMinor2Fixture, memory: taskSpecMinor3Fixture.memory ?? null })).toBe(false);
  });

  it("F-066: says a spec with a repo on a branch of its own needs a minor-3 runner, and a minor-2 one never sees the branch", () => {
    const [first] = taskSpecMinor2Fixture.repos;
    if (first === undefined) throw new Error("a repo");
    const second = { ...first, repoId: ids.secondRepo, checkoutDir: "second" };
    const fresh = `${taskSpecMinor2Fixture.branchName}-2`;
    const own = { ...taskSpecMinor2Fixture, repos: [{ ...first, branchName: fresh }, second] };
    expect(repoBranchName(own, own.repos[0] ?? first)).toBe(fresh);
    expect(repoBranchName(own, second)).toBe(taskSpecMinor2Fixture.branchName);
    expect(taskSpecNeedsMinor3(own)).toBe(true);
    // The task's own name on a repo is no difference.
    expect(taskSpecNeedsMinor3({ ...own, repos: [{ ...first, branchName: taskSpecMinor2Fixture.branchName }, second] })).toBe(false);
    // The schema carries it, and the encoder drops it for a minor-2 runner.
    expect(taskSpecSchema.parse(roundTrip(own)).repos[0]?.branchName).toBe(fresh);
    for (const repo of encodeTaskSpecForMinor(own, 2).repos) {
      expect(repo).not.toHaveProperty("branchName");
    }
  });

  it("picks the response schema by the negotiated minor", () => {
    expect(taskSpecResponseSchemaFor(0)).toBe(taskSpecSchemaV0);
    expect(taskSpecResponseSchemaFor(1)).toBe(taskSpecSchemaV1);
    expect(taskSpecResponseSchemaFor(2)).toBe(taskSpecSchemaV2);
    expect(taskSpecResponseSchemaFor(3)).toBe(taskSpecSchemaV3);
    expect(taskSpecResponseSchemaFor(4)).toBe(taskSpecSchemaV3);
    expect(taskSpecResponseSchemaFor(5)).toBe(taskSpecSchemaV5);
    expect(taskSpecResponseSchemaFor(6)).toBe(taskSpecSchema);
  });
});

describe("the memory types", () => {
  it("round-trip, and refuse an unknown field", () => {
    expect(memoryNoteSchema.parse(roundTrip(memoryNoteFixture))).toEqual(memoryNoteFixture);
    expect(memoryIndexEntrySchema.parse(roundTrip(memoryIndexEntryFixture))).toEqual(memoryIndexEntryFixture);
    expect(memoryProposalInputSchema.parse(roundTrip(memoryProposalInputFixture))).toEqual(memoryProposalInputFixture);
    expect(memoryNoteSchema.safeParse({ ...memoryNoteFixture, author: "x" }).success).toBe(false);
    expect(memoryIndexEntrySchema.safeParse({ ...memoryIndexEntryFixture, body: "x" }).success).toBe(false);
    expect(memoryProposalInputSchema.safeParse({ ...memoryProposalInputFixture, always: true }).success).toBe(false);
    expect(memoryKindSchema.options).toEqual(["convention", "command", "gotcha", "decision", "preference", "term"]);
    expect(memoryScopeSchema.options).toEqual(["organization", "project"]);
  });

  it("F-109: hold a note to its limits", () => {
    const title = "x".repeat(runnerLimits.memoryNoteTitleMaxChars);
    expect(memoryNoteSchema.safeParse({ ...memoryNoteFixture, title }).success).toBe(true);
    expect(memoryNoteSchema.safeParse({ ...memoryNoteFixture, title: `${title}x` }).success).toBe(false);
    expect(memoryNoteSchema.safeParse({ ...memoryNoteFixture, title: "two\nlines" }).success).toBe(false);
    const body = "x".repeat(runnerLimits.memoryNoteBodyMaxBytes);
    expect(memoryNoteSchema.safeParse({ ...memoryNoteFixture, body }).success).toBe(true);
    // 4 KiB is bytes: two-byte characters reach it at half the length.
    expect(memoryNoteSchema.safeParse({ ...memoryNoteFixture, body: "é".repeat(runnerLimits.memoryNoteBodyMaxBytes / 2 + 1) }).success).toBe(false);
    expect(memoryNoteSchema.safeParse({ ...memoryNoteFixture, version: 0 }).success).toBe(false);
  });

  it("F-111: a proposal's relation names the note it relates to", () => {
    expect(memoryProposalInputSchema.safeParse({ ...memoryProposalInputFixture, relatesTo: null }).success).toBe(false);
    expect(memoryProposalInputSchema.safeParse({ ...memoryProposalInputFixture, relation: null }).success).toBe(false);
    expect(memoryProposalInputSchema.safeParse({ ...memoryProposalInputFixture, relatesTo: null, relation: null }).success).toBe(true);
    expect(memoryProposalInputSchema.safeParse({ ...memoryProposalInputFixture, relation: "duplicates" }).success).toBe(false);
  });
});

describe("the sidecar's memory endpoints", () => {
  it("name their paths under the task", () => {
    expect(runnerPaths.taskMemorySearch("t/1")).toBe("/runner/v1/tasks/t%2F1/memory/search");
    expect(runnerPaths.taskMemoryNote("t1", "n/1")).toBe("/runner/v1/tasks/t1/memory/notes/n%2F1");
    expect(runnerPaths.taskMemoryProposals("t1")).toBe("/runner/v1/tasks/t1/memory/proposals");
  });

  it("round-trip each request and answer, and refuse an unknown field", () => {
    const cases = [
      [memorySearchRequestSchema, memoryHttpFixtures.searchRequest],
      [memorySearchResponseSchema, memoryHttpFixtures.searchResponse],
      [memoryNoteResponseSchema, memoryHttpFixtures.noteResponse],
      [memoryProposalRequestSchema, memoryHttpFixtures.proposalRequest],
      [memoryProposalResponseSchema, memoryHttpFixtures.proposalAccepted],
    ] as const;
    for (const [schema, value] of cases) {
      expect(schema.parse(roundTrip(value))).toEqual(value);
      expect(schema.safeParse({ ...value, surprise: 1 }).success).toBe(false);
    }
  });

  it.each(Object.entries(memoryProposalRefusalFixtures))("the %s refusal round-trips", (_code, refusal) => {
    expect(memoryProposalRefusalSchema.parse(roundTrip(refusal))).toEqual(refusal);
    expect(memoryProposalResponseSchema.parse(roundTrip(refusal))).toEqual(refusal);
    expect(memoryProposalRefusalSchema.safeParse({ ...refusal, value: "ghp_x" }).success).toBe(false);
  });

  it("F-110: hold a search to its limits", () => {
    const query = "x".repeat(runnerLimits.memoryQueryMaxChars);
    expect(memorySearchRequestSchema.safeParse({ query, limit: 20 }).success).toBe(true);
    expect(memorySearchRequestSchema.safeParse({ query: `${query}x`, limit: 5 }).success).toBe(false);
    expect(memorySearchRequestSchema.safeParse({ query: "x", limit: runnerLimits.memorySearchResultsMax + 1 }).success).toBe(false);
    expect(memorySearchRequestSchema.safeParse({ query: "   ", limit: 5 }).success).toBe(false);
    const result = memoryHttpFixtures.searchResponse.results[0];
    const tooMany = { results: Array.from({ length: runnerLimits.memorySearchResultsMax + 1 }, () => result) };
    expect(memorySearchResponseSchema.safeParse(tooMany).success).toBe(false);
    expect(memoryProposalRefusalSchema.safeParse({ code: "secret-found", found: [] }).success).toBe(false);
  });
});

describe("what's never logged", () => {
  it("is said in the schemas' descriptions", () => {
    expect(memoryNoteSchema.description).toContain("never logged");
    expect(memoryProposalInputSchema.description).toContain("never logged");
    expect(memorySearchRequestSchema.description).toContain("never logged");
    expect(memorySearchResponseSchema.description).toContain("never logged");
  });
});
