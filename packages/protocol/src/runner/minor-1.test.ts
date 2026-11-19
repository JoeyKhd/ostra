import { describe, expect, it } from "vitest";

import {
  encodeEventForMinor,
  eventKindSupportedAt,
  minor1EventKinds,
  readEventSchema,
  taskEventKinds,
  taskEventSchema,
  taskEventSchemaV0,
} from "../events/agent-events.ts";
import type { TaskEvent } from "../events/agent-events.ts";
import {
  encodeTaskSpecForMinor,
  taskSpecResponseSchemaFor,
  taskSpecSchema,
  taskSpecSchemaV0,
  taskSpecSchemaV1,
} from "../task/spec.ts";
import {
  eventFixtures,
  fixtureDigests,
  fixtureIds as ids,
  minor1FieldFixtures,
  taskSpecFixture,
  taskSpecMinor1Fixture,
} from "../testing/fixtures.ts";
import {
  blobChunkQuerySchema,
  blobDownloadQuerySchema,
  blobRefSchema,
  blobUploadFinishRequestSchema,
  blobUploadStartRequestSchema,
  blobUploadStartResponseSchema,
} from "./blobs.ts";
import { commandKindSchema, commandKindSupportedAt } from "./commands.ts";
import type { Command } from "./commands.ts";
import { minorFromHeader, runnerHttpErrorSchema, runnerPaths } from "./http.ts";
import { runnerLimits } from "./limits.ts";
import { encodeDownFrame, encodeUpFrame, parseDownFrame, parseUpFrame, processContainmentSchema } from "./messages.ts";
import type { UpFrame } from "./messages.ts";
import { negotiate, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./version.ts";

// Protocol minor 1 (milestone 2, ticket 02): every addition round-trips, a minor-0 peer keeps
// working, and nothing minor 1 added reaches it.

const addedKinds = ["session.saved", "session.limit_reached", "ticket.files_ready"] as const;

const eventsFrame = (event: TaskEvent): UpFrame => ({
  type: "events",
  events: [{ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_700_000_000_000, event }],
});

const releaseCommand: Command = {
  type: "command",
  seq: 9,
  id: ids.command,
  notAfter: 1_900_000_000_000,
  kind: "release",
  body: { taskId: ids.task, boxId: ids.box, reason: "idle-expired" },
};

describe("the version", () => {
  it("at a minor-1 server, a minor-0 peer is inside its window and speaks minor 0", () => {
    expect(PROTOCOL_MINOR).toBeGreaterThanOrEqual(1);
    expect(negotiate(1, PROTOCOL_MAJOR, 0)).toEqual({ ok: true, minor: 0 });
    expect(negotiate(1, PROTOCOL_MAJOR, 1)).toEqual({ ok: true, minor: 1 });
    expect(negotiate(0, PROTOCOL_MAJOR, 1)).toEqual({ ok: true, minor: 0 });
  });

  it("names the working values", () => {
    expect(runnerLimits.idleMinutes).toBe(15);
    expect(runnerLimits.sessionMaxMinutes).toBe(120);
    expect(runnerLimits.stallMinutes).toBe(10);
    expect(runnerLimits.uploadChunkMaxBytes).toBe(1024 * 1024);
    expect(runnerLimits.archiveMaxBytes).toBe(64 * 1024 * 1024);
  });
});

describe("minor 1's events", () => {
  const added = addedKinds;

  it("adds three kinds, each with a fixture", () => {
    expect([...minor1EventKinds].sort()).toEqual([...added].sort());
    for (const kind of added) {
      expect(taskEventKinds).toContain(kind);
      expect(eventKindSupportedAt(kind, 0)).toBe(false);
      expect(eventKindSupportedAt(kind, 1)).toBe(true);
    }
    expect(eventKindSupportedAt("turn.started", 0)).toBe(true);
  });

  it.each(Object.entries(minor1FieldFixtures))("%s, with its new fields set, round-trips", (_name, event) => {
    expect(taskEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(readEventSchema.parse(event)).toEqual(event);
  });

  it.each(["user.message", "session.restored", "session.crashed"] as const)(
    "%s still parses without its new fields, as a minor-0 peer writes it",
    (kind) => {
      expect(taskEventSchema.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
      expect(taskEventSchemaV0.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
    },
  );

  it("refuses an unknown field and a bad value on each new shape", () => {
    for (const event of [...Object.values(minor1FieldFixtures), ...added.map((kind) => eventFixtures[kind])]) {
      expect(taskEventSchema.safeParse({ ...event, surprise: 1 }).success).toBe(false);
    }
    expect(taskEventSchema.safeParse({ ...minor1FieldFixtures["user.message"], replayed: false }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...minor1FieldFixtures["session.restored"], origin: "teleported" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["session.limit_reached"], limit: "boredom" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["session.limit_reached"], observed: -1 }).success).toBe(false);
  });

  it("refuses a ticket file name that leaves the ticket folder", () => {
    for (const path of ["../x.png", "a/b.png", "..", ".", "a\\b.png", ""]) {
      const event = { kind: "ticket.files_ready", files: [{ path, blobId: ids.ticketFileBlob }] };
      expect(taskEventSchema.safeParse(event).success).toBe(false);
    }
    const tooMany = {
      kind: "ticket.files_ready",
      files: Array.from({ length: runnerLimits.ticketFilesMax + 1 }, (_, index) => ({
        path: `image-${String(index)}.png`,
        blobId: ids.ticketFileBlob,
      })),
    };
    expect(taskEventSchema.safeParse(tooMany).success).toBe(false);
  });

  it("refuses an archive over the cap and a bad digest", () => {
    const archive = { blobId: ids.blob, size: runnerLimits.archiveMaxBytes + 1, sha256: fixtureDigests.sha256 };
    expect(blobRefSchema.safeParse(archive).success).toBe(false);
    expect(blobRefSchema.safeParse({ ...archive, size: 1, sha256: "A".repeat(64) }).success).toBe(false);
  });

  it("minor 0's union refuses every new kind and every new field", () => {
    for (const kind of added) {
      expect(taskEventSchemaV0.safeParse(eventFixtures[kind]).success).toBe(false);
    }
    for (const event of Object.values(minor1FieldFixtures)) {
      expect(taskEventSchemaV0.safeParse(event).success).toBe(false);
    }
  });

  it("encodes down to minor 0 by dropping the new fields, and keeps them at minor 1", () => {
    expect(encodeEventForMinor(minor1FieldFixtures["session.restored"], 0)).toEqual({ kind: "session.restored" });
    expect(encodeEventForMinor(minor1FieldFixtures["session.crashed"], 0)).toEqual({
      kind: "session.crashed",
      error: "the box went away",
    });
    const message = encodeEventForMinor(minor1FieldFixtures["user.message"], 0);
    expect(message).not.toHaveProperty("replayed");
    expect(message).not.toHaveProperty("reopen");
    expect(encodeEventForMinor(minor1FieldFixtures["session.restored"], 1)).toEqual(minor1FieldFixtures["session.restored"]);
    expect(encodeEventForMinor(eventFixtures["turn.started"], 0)).toEqual(eventFixtures["turn.started"]);
  });

  it("an older reader reads an unknown kind as unsupported, not as an error", () => {
    expect(readEventSchema.parse({ kind: "session.teleported", where: "mars" })).toEqual({
      kind: "unsupported",
      rawKind: "session.teleported",
    });
  });
});

describe("up frames across minors", () => {
  it.each(addedKinds)("%s goes up at minor 1", (kind) => {
    const frame = eventsFrame(eventFixtures[kind]);
    expect(parseUpFrame(encodeUpFrame(frame, 1), 1)).toEqual({ ok: true, frame });
  });

  it.each(addedKinds)("%s is refused from a peer at minor 0", (kind) => {
    const frame = eventsFrame(eventFixtures[kind]);
    expect(parseUpFrame(encodeUpFrame(frame, 1), 0)).toMatchObject({ ok: false, error: { reason: "invalid" } });
  });

  it("a minor-0 peer's codec drops the new fields, and the result parses at minor 0", () => {
    const frame = eventsFrame(minor1FieldFixtures["session.restored"]);
    const text = encodeUpFrame(frame, 0);
    expect(parseUpFrame(text, 0)).toEqual({ ok: true, frame: eventsFrame({ kind: "session.restored" }) });
    expect(parseUpFrame(encodeUpFrame(frame, 1), 0).ok).toBe(false);
  });

  it("a minor-0 peer's frame still parses at minor 1", () => {
    const frame = eventsFrame(eventFixtures["session.crashed"]);
    expect(parseUpFrame(encodeUpFrame(frame, 0), 1)).toEqual({ ok: true, frame });
  });
});

describe("the status's process containment (ticket 42)", () => {
  const status: UpFrame = {
    type: "status",
    executor: "host",
    capacity: 1,
    freeSlots: 1,
    labels: [],
    version: "0.1.0",
    running: [],
    spoolBytes: 0,
    processContainment: "job-object",
  };

  it("F-014: round-trips at minor 1, with each kind and without one", () => {
    expect(parseUpFrame(encodeUpFrame(status, 1), 1)).toEqual({ ok: true, frame: status });
    for (const kind of processContainmentSchema.options) {
      const frame = { ...status, processContainment: kind };
      expect(parseUpFrame(encodeUpFrame(frame, 1), 1)).toEqual({ ok: true, frame });
    }
    const without: UpFrame = { type: "status", executor: "host", capacity: 1, freeSlots: 1, labels: [], version: "0.1.0", running: [], spoolBytes: 0 };
    expect(parseUpFrame(encodeUpFrame(without, 1), 1)).toEqual({ ok: true, frame: without });
  });

  it("F-014: refuses an unknown kind, and a minor-0 peer never sees the field", () => {
    expect(parseUpFrame(JSON.stringify({ ...status, processContainment: "chroot" }), 1).ok).toBe(false);
    const text = encodeUpFrame(status, 0);
    expect(text).not.toContain("processContainment");
    expect(parseUpFrame(text, 0).ok).toBe(true);
    expect(parseUpFrame(encodeUpFrame(status, 1), 0).ok).toBe(false);
  });
});

describe("the release command", () => {
  it("is a command kind, only for minor 1", () => {
    expect(commandKindSchema.options).toContain("release");
    expect(commandKindSupportedAt("release", 0)).toBe(false);
    expect(commandKindSupportedAt("release", 1)).toBe(true);
    expect(commandKindSupportedAt("stop", 0)).toBe(true);
  });

  it("round-trips at minor 1, and a minor-0 peer refuses it", () => {
    expect(parseDownFrame(encodeDownFrame(releaseCommand, 1), 1)).toEqual({ ok: true, frame: releaseCommand });
    expect(parseDownFrame(encodeDownFrame(releaseCommand, 1), 0).ok).toBe(false);
  });

  it("refuses an unknown field and an unknown reason", () => {
    const extra = { ...releaseCommand, body: { ...releaseCommand.body, path: "/" } };
    expect(parseDownFrame(JSON.stringify(extra), 1).ok).toBe(false);
    const reason = { ...releaseCommand, body: { ...releaseCommand.body, reason: "because" } };
    expect(parseDownFrame(JSON.stringify(reason), 1).ok).toBe(false);
  });
});

describe("the task spec at minor 1", () => {
  it("parses with every new field, and without them", () => {
    expect(taskSpecSchema.parse(JSON.parse(JSON.stringify(taskSpecMinor1Fixture)))).toEqual(taskSpecMinor1Fixture);
    expect(taskSpecSchema.parse(taskSpecFixture)).toEqual(taskSpecFixture);
    expect(taskSpecSchemaV0.parse(taskSpecFixture)).toEqual(taskSpecFixture);
  });

  it("parses the token form of the spend cap, and a prompt task's null ticket", () => {
    const tokens = {
      ...taskSpecMinor1Fixture,
      ticket: null,
      limits: { turnMaxMinutes: 60, spendCap: { capTokens: 10_000_000, spentTokens: 0 } },
    };
    expect(taskSpecSchema.parse(tokens)).toEqual(tokens);
  });

  it("refuses an unknown field in each new section, and a cap that mixes both forms", () => {
    const restore = { ...taskSpecMinor1Fixture.restore, token: "x" };
    expect(taskSpecSchema.safeParse({ ...taskSpecMinor1Fixture, restore }).success).toBe(false);
    const ticket = { ...taskSpecMinor1Fixture.ticket, body: "x" };
    expect(taskSpecSchema.safeParse({ ...taskSpecMinor1Fixture, ticket }).success).toBe(false);
    const mixed = {
      ...taskSpecMinor1Fixture,
      limits: { turnMaxMinutes: 60, spendCap: { capTokens: 1, spentTokens: 0, capMicroUsd: 1 } },
    };
    expect(taskSpecSchema.safeParse(mixed).success).toBe(false);
  });

  it("minor 0's schema refuses the new fields, and the down-encoded spec parses with it", () => {
    expect(taskSpecSchemaV0.safeParse(taskSpecMinor1Fixture).success).toBe(false);
    const down = encodeTaskSpecForMinor(taskSpecMinor1Fixture, 0);
    expect(taskSpecSchemaV0.parse(JSON.parse(JSON.stringify(down)))).toEqual(down);
    expect(down).not.toHaveProperty("restore");
    expect(down.limits).toEqual({ turnMaxMinutes: 60 });
    expect(encodeTaskSpecForMinor(taskSpecMinor1Fixture, 1)).toEqual(taskSpecMinor1Fixture);
  });

  it("picks the response schema by the negotiated minor", () => {
    expect(taskSpecResponseSchemaFor(0)).toBe(taskSpecSchemaV0);
    expect(taskSpecResponseSchemaFor(1)).toBe(taskSpecSchemaV1);
    expect(minorFromHeader("1")).toBe(1);
    expect(minorFromHeader(null)).toBe(0);
    expect(minorFromHeader("one")).toBe(0);
  });
});

describe("the bulk path", () => {
  it("names the four endpoints under the task", () => {
    expect(runnerPaths.taskBlobs("t1")).toBe("/runner/v1/tasks/t1/blobs");
    expect(runnerPaths.taskBlobUpload("t1", "u1")).toBe("/runner/v1/tasks/t1/blobs/u1");
    expect(runnerPaths.taskBlobUploadFinish("t1", "u1")).toBe("/runner/v1/tasks/t1/blobs/u1/finish");
    expect(runnerPaths.taskBlob("t1", "b/1")).toBe("/runner/v1/tasks/t1/blobs/b%2F1");
  });

  it("takes the lease epoch on every call", () => {
    const start = {
      purpose: "session-archive",
      sha256: fixtureDigests.sha256,
      size: 1024,
      contentType: "application/gzip",
      leaseEpoch: 2,
    };
    expect(blobUploadStartRequestSchema.parse(start)).toEqual(start);
    const noEpoch = { purpose: start.purpose, sha256: start.sha256, size: start.size, contentType: start.contentType };
    expect(blobUploadStartRequestSchema.safeParse(noEpoch).success).toBe(false);
    expect(blobUploadStartRequestSchema.safeParse({ ...start, purpose: "anything" }).success).toBe(false);
    expect(blobChunkQuerySchema.parse({ offset: "0", leaseEpoch: "2" })).toEqual({ offset: 0, leaseEpoch: 2 });
    expect(blobChunkQuerySchema.safeParse({ offset: "0" }).success).toBe(false);
    expect(blobUploadFinishRequestSchema.safeParse({}).success).toBe(false);
    expect(blobDownloadQuerySchema.parse({ leaseEpoch: "3" })).toEqual({ leaseEpoch: 3 });
    expect(blobUploadStartResponseSchema.parse({ uploadId: ids.upload, receivedBytes: 512 })).toEqual({
      uploadId: ids.upload,
      receivedBytes: 512,
    });
  });

  it("answers a stale epoch with 409's body, and the bulk path's own errors", () => {
    for (const code of ["stale-lease", "offset-mismatch", "digest-mismatch", "too-large"] as const) {
      const body = { error: { code, message: "refused", currentEpoch: 3 } };
      expect(runnerHttpErrorSchema.parse(body)).toEqual(body);
    }
  });
});

