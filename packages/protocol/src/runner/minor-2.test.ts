import { describe, expect, it } from "vitest";

import {
  encodeEventForMinor,
  eventKindSupportedAt,
  minor1EventKinds,
  minor2EventKinds,
  readEventSchema,
  runnerEventSchema,
  serverOnlyKinds,
  taskEventKinds,
  taskEventSchema,
  taskEventSchemaV0,
  taskEventSchemaV1,
} from "../events/agent-events.ts";
import type { TaskEvent, TaskEventKind } from "../events/agent-events.ts";
import {
  encodeTaskCredentialsForMinor,
  snapshotCredentialsSchema,
  taskCredentialsResponseSchemaFor,
  taskCredentialsSchema,
  taskCredentialsSchemaV1,
} from "../task/credentials.ts";
import {
  encodeTaskSpecForMinor,
  taskSpecMcpServerSchema,
  taskSpecNeedsMinor2,
  taskSpecResponseSchemaFor,
  taskSpecSchema,
  taskSpecSchemaV0,
  taskSpecSchemaV1,
  taskSpecSchemaV2,
  taskSpecSchemaV3,
} from "../task/spec.ts";
import {
  commandFixtures,
  eventFixtures,
  fixtureIds as ids,
  minor1FieldFixtures,
  minor2CommandFixtures,
  minor2FieldFixtures,
  snapshotCredentialsFixture,
  taskCredentialsFixture,
  taskCredentialsMinor2Fixture,
  taskSpecFixture,
  taskSpecMinor1Fixture,
  taskSpecMinor2Fixture,
} from "../testing/fixtures.ts";
import { blobUploadStartRequestSchema } from "./blobs.ts";
import {
  commandKindSchema,
  commandKindSupportedAt,
  commandSchema,
  commandSchemaV1,
  encodeCommandForMinor,
} from "./commands.ts";
import type { Command } from "./commands.ts";
import { runnerPaths } from "./http.ts";
import { runnerLimits } from "./limits.ts";
import { encodeDownFrame, encodeUpFrame, parseDownFrame, parseUpFrame } from "./messages.ts";
import type { UpFrame } from "./messages.ts";
import { minorWindow, negotiate, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./version.ts";

// Protocol minor 2 (milestone 3, ticket 01): every addition round-trips, a minor-1 peer keeps
// working and never sees what minor 2 added, and a minor-0 peer is outside the window.

const addedKinds = [
  "plan.proposed",
  "plan.answered",
  "check.started",
  "check.finished",
  "snapshot.built",
  "snapshot.failed",
  "service.healthy",
  "service.failed",
  "diff.comments_sent",
  "ticket.closed",
  "pr.comment_received",
] as const satisfies readonly TaskEventKind[];

const serverOnlyAdded = ["plan.answered", "diff.comments_sent", "ticket.closed", "pr.comment_received"] as const;
const serverOnlyAddedSet: ReadonlySet<string> = new Set(serverOnlyAdded);
const runnerSentAdded = addedKinds.filter((kind) => !serverOnlyAddedSet.has(kind));

const addedCommands = ["question-answer", "plan-answer", "snapshot-build"] as const;

const eventsFrame = (event: TaskEvent): UpFrame => ({
  type: "events",
  events: [{ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_700_000_000_000, event }],
});

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("the version", () => {
  it("F-061: at a minor-2 server, a minor-1 peer is inside the window and a minor-0 peer is outside it", () => {
    expect(PROTOCOL_MINOR).toBeGreaterThanOrEqual(2);
    expect(minorWindow(2)).toEqual({ min: 1, max: 3 });
    expect(negotiate(2, PROTOCOL_MAJOR, 1)).toEqual({ ok: true, minor: 1 });
    expect(negotiate(2, PROTOCOL_MAJOR, 2)).toEqual({ ok: true, minor: 2 });
    expect(negotiate(2, PROTOCOL_MAJOR, 0)).toEqual({ ok: false, reason: "minor", window: { min: 1, max: 3 } });
    // A minor-2 runner against a minor-1 server speaks minor 1.
    expect(negotiate(1, PROTOCOL_MAJOR, 2)).toEqual({ ok: true, minor: 1 });
  });

  it("names the working values", () => {
    expect(runnerLimits.checkTimeoutSeconds).toBe(600);
    expect(runnerLimits.checksTotalMinutes).toBe(30);
    expect(runnerLimits.checkOutputTailMaxBytes).toBe(16 * 1024);
    expect(runnerLimits.checkOutputBlobMaxBytes).toBe(4 * 1024 * 1024);
    expect(runnerLimits.planMessageMaxBytes).toBe(64 * 1024);
    expect(runnerLimits.diffCommentMaxChars).toBe(4000);
    expect(runnerLimits.diffCommentsPerSendMax).toBe(50);
    expect(runnerLimits.denyReasonMaxChars).toBe(2000);
    expect(runnerLimits.approvalWaitMinutes).toBe(15);
  });
});

describe("minor 2's events", () => {
  it("adds eleven kinds, each with a fixture, none readable below minor 2", () => {
    expect([...minor2EventKinds].sort()).toEqual([...addedKinds].sort());
    for (const kind of addedKinds) {
      expect(taskEventKinds).toContain(kind);
      expect(eventFixtures[kind].kind).toBe(kind);
      expect(eventKindSupportedAt(kind, 1)).toBe(false);
      expect(eventKindSupportedAt(kind, 2)).toBe(true);
    }
    for (const kind of minor1EventKinds) {
      expect(eventKindSupportedAt(kind, 1)).toBe(true);
    }
  });

  it.each(addedKinds)("%s round-trips and reads back", (kind) => {
    const event = eventFixtures[kind];
    expect(taskEventSchema.parse(roundTrip(event))).toEqual(event);
    expect(readEventSchema.parse(event)).toEqual(event);
  });

  it.each(Object.entries(minor2FieldFixtures))("%s, with its new fields set, round-trips", (_name, event) => {
    expect(taskEventSchema.parse(roundTrip(event))).toEqual(event);
  });

  it.each(["user.message", "turn.started", "approval.requested", "approval.answered", "session.saved"] as const)(
    "%s still parses without its new fields, as a minor-1 peer writes it",
    (kind) => {
      expect(taskEventSchema.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
      expect(taskEventSchemaV1.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
    },
  );

  it("refuses an unknown field on every new shape, and bad values", () => {
    for (const event of [...Object.values(minor2FieldFixtures), ...addedKinds.map((kind) => eventFixtures[kind])]) {
      expect(taskEventSchema.safeParse({ ...event, surprise: 1 }).success).toBe(false);
    }
    const bad: readonly unknown[] = [
      { ...eventFixtures["check.finished"], status: "flaky" },
      { ...eventFixtures["check.finished"], outputTail: "x".repeat(runnerLimits.checkOutputTailMaxBytes + 1) },
      { ...eventFixtures["snapshot.built"], imageDigest: "sha256:XYZ" },
      { ...eventFixtures["snapshot.failed"], reason: "bored" },
      { ...eventFixtures["service.healthy"], name: "Not A Host" },
      { ...eventFixtures["ticket.closed"], category: "started" },
      { ...eventFixtures["diff.comments_sent"], commentIds: [] },
      { ...eventFixtures["plan.proposed"], message: "x".repeat(runnerLimits.planMessageMaxBytes + 1) },
      { ...minor2FieldFixtures["user.message"], intent: "shout" },
      { ...minor2FieldFixtures["turn.started"], mode: "dream" },
      { ...minor2FieldFixtures["approval.requested"], rule: { source: "repo", ruleId: "r", name: "n" } },
      { ...minor2FieldFixtures["approval.requested"], subject: { kind: "file", value: "x" } },
      { ...minor2FieldFixtures["approval.answered, denied with a reason"], reason: "x".repeat(2001) },
      { ...minor2FieldFixtures["approval.answered, for this task"], taskRule: { tool: "execute", pattern: "pnpm add" } },
    ];
    for (const value of bad) {
      expect(taskEventSchema.safeParse(value).success).toBe(false);
    }
  });

  it("F-063: an approved plan without its entries still parses", () => {
    const approve = { kind: "plan.answered", decision: "approve", text: "1. Do it", memberId: ids.member };
    expect(taskEventSchema.parse(approve)).toEqual(approve);
  });

  it("minor 1's union refuses every new kind and every new field", () => {
    for (const kind of addedKinds) {
      expect(taskEventSchemaV1.safeParse(eventFixtures[kind]).success).toBe(false);
    }
    for (const event of Object.values(minor2FieldFixtures)) {
      expect(taskEventSchemaV1.safeParse(event).success).toBe(false);
    }
    // Minor 1's own events still parse with it.
    expect(minor1FieldFixtures["user.message"].kind).toBe("user.message");
    for (const event of Object.values(minor1FieldFixtures)) {
      expect(taskEventSchemaV1.parse(event)).toEqual(event);
    }
  });

  it("encodes down to minor 1 by dropping the new fields, and the result parses at minor 1", () => {
    const grown = Object.values(minor2FieldFixtures).filter((event) => eventKindSupportedAt(event.kind, 1));
    expect(grown.length).toBeGreaterThanOrEqual(5);
    for (const event of grown) {
      const down = encodeEventForMinor(event, 1);
      expect(taskEventSchemaV1.parse(roundTrip(down))).toEqual(down);
    }
    expect(encodeEventForMinor(minor2FieldFixtures["turn.started"], 1)).toEqual({ kind: "turn.started", turnId: ids.turn });
    expect(encodeEventForMinor(minor2FieldFixtures["user.message"], 1)).not.toHaveProperty("intent");
    expect(encodeEventForMinor(minor2FieldFixtures["session.saved"], 1)).not.toHaveProperty("checks");
    expect(encodeEventForMinor(minor2FieldFixtures["session.restored"], 1)).not.toHaveProperty("fallbackReason");
    expect(encodeEventForMinor(minor2FieldFixtures["ticket.files_ready"], 1)).not.toHaveProperty("skipped");
    expect(encodeEventForMinor(minor2FieldFixtures["environment.setup_finished, from a warm cache"], 1)).toEqual({ kind: "environment.setup_finished", exitCode: 0, durationMs: 800 });
    expect(encodeEventForMinor(minor2FieldFixtures["environment.setup_finished, without the snapshot"], 0)).not.toHaveProperty("snapshot");
    expect(encodeEventForMinor(minor2FieldFixtures["session.restored"], 0)).toEqual({ kind: "session.restored" });
    expect(encodeEventForMinor(minor2FieldFixtures["approval.requested"], 2)).toEqual(minor2FieldFixtures["approval.requested"]);
    // Down to minor 0 drops both minors' fields.
    const v0 = encodeEventForMinor({ ...minor1FieldFixtures["user.message"], intent: "pr-comment" }, 0);
    expect(taskEventSchemaV0.parse(v0)).toEqual(v0);
  });

  it("the server-only set holds the new server-only kinds, and a runner's batch with one is refused", () => {
    for (const kind of serverOnlyAdded) {
      expect(serverOnlyKinds.has(kind)).toBe(true);
      const item = { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: eventFixtures[kind] };
      expect(runnerEventSchema.safeParse(item).success).toBe(false);
      expect(parseUpFrame(JSON.stringify(eventsFrame(eventFixtures[kind])), 2).ok).toBe(false);
    }
    for (const kind of runnerSentAdded) {
      expect(serverOnlyKinds.has(kind)).toBe(false);
    }
  });
});

describe("up frames across minors", () => {
  it.each(runnerSentAdded)("%s goes up at minor 2 and is refused at minor 1", (kind) => {
    const frame = eventsFrame(eventFixtures[kind]);
    expect(parseUpFrame(encodeUpFrame(frame, 2), 2)).toEqual({ ok: true, frame });
    expect(parseUpFrame(encodeUpFrame(frame, 2), 1)).toMatchObject({ ok: false, error: { reason: "invalid" } });
  });

  it("a minor-1 peer's codec drops the new fields, and the result parses at minor 1", () => {
    const frame = eventsFrame(minor2FieldFixtures["approval.requested"]);
    expect(parseUpFrame(encodeUpFrame(frame, 2), 1).ok).toBe(false);
    const down = parseUpFrame(encodeUpFrame(frame, 1), 1);
    expect(down.ok).toBe(true);
    expect(down.ok && down.frame.type === "events" ? down.frame.events[0]?.event : null).not.toHaveProperty("rule");
  });

  it("a minor-1 peer's frame still parses at minor 2", () => {
    const frame = eventsFrame(eventFixtures["session.saved"]);
    expect(parseUpFrame(encodeUpFrame(frame, 1), 2)).toEqual({ ok: true, frame });
  });

  it("F-051: a runner event carries a snapshot's result outside a task, only at minor 2", () => {
    const frame: UpFrame = { type: "runner-event", at: 1_700_000_000_000, event: eventFixtures["snapshot.failed"] };
    expect(parseUpFrame(encodeUpFrame(frame, 2), 2)).toEqual({ ok: true, frame });
    expect(parseUpFrame(encodeUpFrame(frame, 2), 1).ok).toBe(false);
    const other = { ...frame, event: eventFixtures["check.started"] };
    expect(parseUpFrame(JSON.stringify(other), 2).ok).toBe(false);
  });
});

describe("minor 2's commands", () => {
  it("are command kinds only for minor 2, each with a fixture", () => {
    for (const kind of addedCommands) {
      expect(commandKindSchema.options).toContain(kind);
      expect(commandFixtures[kind].kind).toBe(kind);
      expect(commandKindSupportedAt(kind, 1)).toBe(false);
      expect(commandKindSupportedAt(kind, 2)).toBe(true);
    }
    expect(Object.keys(commandFixtures).sort()).toEqual([...commandKindSchema.options].sort());
  });

  it.each(addedCommands)("%s round-trips at minor 2, and a minor-1 peer refuses it", (kind) => {
    const command = commandFixtures[kind];
    expect(parseDownFrame(encodeDownFrame(command, 2), 2)).toEqual({ ok: true, frame: command });
    expect(parseDownFrame(encodeDownFrame(command, 2), 1).ok).toBe(false);
  });

  it.each(Object.entries(minor2CommandFixtures))("%s round-trips, and goes down to minor 1 without its new fields", (_name, command) => {
    expect(parseDownFrame(encodeDownFrame(command, 2), 2)).toEqual({ ok: true, frame: command });
    expect(parseDownFrame(encodeDownFrame(command, 2), 1).ok).toBe(false);
    const down = parseDownFrame(encodeDownFrame(command, 1), 1);
    expect(down.ok).toBe(true);
    expect(commandSchemaV1.safeParse(encodeCommandForMinor(command, 1)).success).toBe(true);
  });

  it("drops the new fields for a minor-1 peer, and keeps them at minor 2", () => {
    const steer = minor2CommandFixtures["steer, from diff comments"];
    const deny = minor2CommandFixtures["approval-answer, denied with a reason"];
    const downSteer = encodeCommandForMinor(steer, 1);
    const downDeny = encodeCommandForMinor(deny, 1);
    expect(downSteer.kind === "steer" ? downSteer.body : null).not.toHaveProperty("intent");
    expect(downDeny.kind === "approval-answer" ? downDeny.body : null).not.toHaveProperty("reason");
    expect(encodeCommandForMinor(steer, 2)).toEqual(steer);
  });

  it("refuses an unknown field, a bad decision and an empty plan", () => {
    const bad: readonly unknown[] = [
      { ...commandFixtures["plan-answer"], body: { ...commandFixtures["plan-answer"].body, decision: "maybe" } },
      { ...commandFixtures["plan-answer"], body: { ...commandFixtures["plan-answer"].body, text: "" } },
      { ...commandFixtures["question-answer"], body: { ...commandFixtures["question-answer"].body, memberId: ids.member } },
      {
        ...commandFixtures["snapshot-build"],
        body: { ...commandFixtures["snapshot-build"].body, environment: { ...commandFixtures["snapshot-build"].body.environment, token: "x" } },
      },
      { ...minor2CommandFixtures["approval-answer, denied with a reason"], body: { ...minor2CommandFixtures["approval-answer, denied with a reason"].body, reason: "x".repeat(2001) } },
    ];
    for (const value of bad) {
      expect(commandSchema.safeParse(value).success).toBe(false);
    }
  });

  it("F-051: a snapshot build carries secret names, never values", () => {
    const command: Command = commandFixtures["snapshot-build"];
    const text = JSON.stringify(command);
    expect(text).toContain("NPM_TOKEN");
    expect(text).not.toContain("fixture-npm-token");
    expect(runnerPaths.snapshotCredentials("s/1")).toBe("/runner/v1/snapshots/s%2F1/credentials");
    expect(snapshotCredentialsSchema.parse(roundTrip(snapshotCredentialsFixture))).toEqual(snapshotCredentialsFixture);
    expect(snapshotCredentialsSchema.safeParse({ ...snapshotCredentialsFixture, extra: 1 }).success).toBe(false);
  });
});

describe("the task spec at minor 2", () => {
  it("parses with every new field, and a minor-1 spec and a minor-0 spec still parse", () => {
    expect(taskSpecSchema.parse(roundTrip(taskSpecMinor2Fixture))).toEqual(taskSpecMinor2Fixture);
    expect(taskSpecSchema.parse(taskSpecMinor1Fixture)).toEqual(taskSpecMinor1Fixture);
    expect(taskSpecSchema.parse(taskSpecFixture)).toEqual(taskSpecFixture);
    expect(taskSpecSchemaV1.parse(taskSpecMinor1Fixture)).toEqual(taskSpecMinor1Fixture);
    expect(taskSpecSchemaV0.parse(taskSpecFixture)).toEqual(taskSpecFixture);
  });

  it("F-021: an MCP server without readOnly parses as not read-only", () => {
    expect(taskSpecMcpServerSchema.parse({ name: "linear", transport: "http", proxyPath: "/mcp/linear" })).toEqual({
      name: "linear",
      transport: "http",
      proxyPath: "/mcp/linear",
      readOnly: false,
    });
    expect(taskSpecMcpServerSchema.safeParse({ name: "x", transport: "http", proxyPath: "/mcp/x", url: "https://x" }).success).toBe(false);
    expect(taskSpecMcpServerSchema.safeParse({ name: "x", transport: "stdio", command: "x", args: [], env: { "bad name": "v" } }).success).toBe(false);
  });

  it("refuses an unknown field in each new section", () => {
    const spec = taskSpecMinor2Fixture;
    const variants: readonly unknown[] = [
      { ...spec, surprise: 1 },
      { ...spec, firstTurnMode: "dream" },
      { ...spec, agent: { ...spec.agent, surprise: 1 } },
      { ...spec, checks: [{ ...spec.checks?.[0], env: {} }] },
      { ...spec, checks: [{ ...spec.checks?.[0], timeoutSeconds: runnerLimits.checkTimeoutMaxSeconds + 1 }] },
      { ...spec, services: [{ ...spec.services?.[0], privileged: true }] },
      { ...spec, snapshot: { kind: "host-cache", cacheKey: "../x" } },
      { ...spec, snapshot: { kind: "image", snapshotId: ids.snapshot, imageRef: "x", digest: "nope" } },
      { ...spec, agent: { ...spec.agent, skills: [{ name: "a b", blobId: ids.skillBlob, files: [] }] } },
      { ...spec, agent: { ...spec.agent, approvalRules: [{ ruleId: "r", name: "n", tool: "edit", match: { kind: "mcp-not-read-only" } }] } },
    ];
    for (const value of variants) {
      expect(taskSpecSchema.safeParse(value).success).toBe(false);
    }
  });

  it("minor 1's schema refuses the new fields, and the down-encoded spec parses with it", () => {
    expect(taskSpecSchemaV1.safeParse(taskSpecMinor2Fixture).success).toBe(false);
    const down = encodeTaskSpecForMinor(taskSpecMinor2Fixture, 1);
    expect(taskSpecSchemaV1.parse(roundTrip(down))).toEqual(down);
    for (const field of ["firstTurnMode", "checks", "checksTotalMinutes", "services", "snapshot"]) {
      expect(down).not.toHaveProperty(field);
    }
    for (const field of ["skills", "mcpServers", "approvalRules", "taskRules", "planFirst"]) {
      expect(down.agent).not.toHaveProperty(field);
    }
    expect(down.restore).toEqual(taskSpecMinor1Fixture.restore);
    const v0 = encodeTaskSpecForMinor(taskSpecMinor2Fixture, 0);
    expect(taskSpecSchemaV0.parse(roundTrip(v0))).toEqual(v0);
    expect(encodeTaskSpecForMinor(taskSpecMinor2Fixture, 2)).toEqual(taskSpecMinor2Fixture);
  });

  it("picks the response schema by the negotiated minor", () => {
    expect(taskSpecResponseSchemaFor(0)).toBe(taskSpecSchemaV0);
    expect(taskSpecResponseSchemaFor(1)).toBe(taskSpecSchemaV1);
    expect(taskSpecResponseSchemaFor(2)).toBe(taskSpecSchemaV2);
    expect(taskSpecResponseSchemaFor(3)).toBe(taskSpecSchemaV3);
  });

  it("F-063: says when a spec needs a minor-2 runner", () => {
    expect(taskSpecNeedsMinor2(taskSpecMinor2Fixture)).toBe(true);
    expect(taskSpecNeedsMinor2(taskSpecMinor1Fixture)).toBe(false);
    expect(taskSpecNeedsMinor2({ ...taskSpecFixture, firstTurnMode: "build", checks: [], snapshot: null })).toBe(false);
    expect(taskSpecNeedsMinor2({ ...taskSpecFixture, firstTurnMode: "plan" })).toBe(true);
    expect(taskSpecNeedsMinor2({ ...taskSpecFixture, snapshot: { kind: "host-cache", cacheKey: "p1" } })).toBe(true);
  });
});

describe("the credentials at minor 2", () => {
  it("F-021: carry the MCP servers' headers for the sidecar, and drop them for a minor-1 runner", () => {
    expect(taskCredentialsSchema.parse(roundTrip(taskCredentialsMinor2Fixture))).toEqual(taskCredentialsMinor2Fixture);
    expect(taskCredentialsSchemaV1.safeParse(roundTrip(taskCredentialsMinor2Fixture)).success).toBe(false);
    const down = encodeTaskCredentialsForMinor(taskCredentialsMinor2Fixture, 1);
    expect(down).not.toHaveProperty("mcpServers");
    expect(taskCredentialsSchemaV1.parse(roundTrip(down))).toEqual(down);
    expect(taskCredentialsSchemaV1.parse(roundTrip(taskCredentialsFixture))).toEqual(taskCredentialsFixture);
    expect(taskCredentialsResponseSchemaFor(1)).toBe(taskCredentialsSchemaV1);
    expect(taskCredentialsResponseSchemaFor(2)).toBe(taskCredentialsSchema);
    expect(taskCredentialsSchema.description).toContain("never logged");
  });

  it("F-094: carry the services' secret variables by service, refuse a name that isn't a host name, and drop them for a minor-1 runner", () => {
    const withServices = taskCredentialsSchema.parse({
      ...taskCredentialsFixture,
      services: [{ name: "db", variables: [{ name: "POSTGRES_PASSWORD", value: "fixture-db-secret" }] }],
    });
    expect(taskCredentialsSchema.parse(roundTrip(withServices))).toEqual(withServices);
    expect(taskCredentialsSchema.safeParse({ ...taskCredentialsFixture, services: [{ name: "DB_1", variables: [] }] }).success).toBe(false);
    expect(taskCredentialsSchema.safeParse({ ...taskCredentialsFixture, services: [{ name: "db", variables: [], extra: 1 }] }).success).toBe(false);
    const down = encodeTaskCredentialsForMinor(withServices, 1);
    expect(down).not.toHaveProperty("services");
    expect(JSON.stringify(down)).not.toContain("fixture-db-secret");
  });
});

describe("the bulk path at minor 2", () => {
  it("F-054: uploads a check's output", () => {
    const start = { purpose: "check-output", sha256: "a".repeat(64), size: 10, contentType: "text/plain", leaseEpoch: 1 };
    expect(blobUploadStartRequestSchema.parse(start)).toEqual(start);
  });
});

describe("what's never logged", () => {
  it("is said in the schemas' descriptions", () => {
    expect(taskSpecSchema.description).toContain("no secret");
    expect(snapshotCredentialsSchema.description).toContain("never logged");
  });
});
