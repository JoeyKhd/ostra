import { describe, expect, it } from "vitest";

import { poolIdSchema } from "../ids.ts";

import { isReservedLabel, reservedLabelPrefixes, runnerLabelSchema } from "../common.ts";
import {
  eventKindSupportedAt,
  minor3EventKinds,
  minor4EventKinds,
  readEventSchema,
  runnerEventSchema,
  serverOnlyKinds,
  taskEventKinds,
  taskEventSchema,
  taskEventSchemaV3,
} from "../events/agent-events.ts";
import type { TaskEvent, TaskEventKind } from "../events/agent-events.ts";
import {
  commandFixtures,
  eventFixtures,
  fixtureIds as ids,
  kubernetesCapabilitiesFixture,
  minor4CommandFixtures,
  minor4HelloFixture,
  minor4HostStatusFixture,
  minor4HttpFixtures,
  minor4StatusFixture,
  registryCredentialRefusalFixtures,
} from "../testing/fixtures.ts";
import { commandKindMinMinor, commandKindSupportedAt, commandSchema, dispatchBodySchema, encodeCommandForMinor } from "./commands.ts";
import type { Command } from "./commands.ts";
import {
  connectionEpochFromHeader,
  encodeInfoForMinor,
  httpCarrierStatus,
  httpHelloRefusalSchema,
  httpHelloRequestSchema,
  httpSupersededSchema,
  infoResponseSchema,
  infoResponseSchemaV3,
  parseHttpDownBody,
  parseHttpUpBody,
  pullCredentialRequestSchema,
  pullCredentialResponseSchema,
  pushCredentialRequestSchema,
  pushCredentialResponseSchema,
  registryCredentialRefusalSchema,
  registryCredentialSchema,
  runnerHeaders,
  runnerPaths,
} from "./http.ts";
import {
  downFrameCodec,
  encodeDownFrame,
  encodeUpFrame,
  executorMinMinor,
  helloSchema,
  parseDownFrame,
  parseUpFrame,
  refuseHelloExecutor,
  runnerCapabilitiesSchema,
  runnerResourcesSchema,
  statusSchema,
  upFrameCodec,
} from "./messages.ts";
import type { Hello, Status, UpFrame } from "./messages.ts";
import { minorWindow, negotiate, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./version.ts";

// Protocol minor 4 (milestone 5, ticket 01): every addition round-trips, a minor-3 peer keeps
// working and never sees what minor 4 added, a minor-2 peer is outside the window, and a
// `kubernetes` runner below minor 4 is refused (F-013, F-061, F-092, F-093, F-095, F-120).

const addedKinds = ["box.waiting", "box.scheduled", "task.cancelled", "runner.drained", "runner.resumed"] as const satisfies readonly TaskEventKind[];
const serverOnlyAdded = ["task.cancelled", "runner.drained", "runner.resumed"] as const satisfies readonly TaskEventKind[];
const runnerAdded = ["box.waiting", "box.scheduled"] as const satisfies readonly TaskEventKind[];

const eventsFrame = (event: TaskEvent): UpFrame => ({
  type: "events",
  events: [{ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_700_000_000_000, event }],
});

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const decoded = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new Error("not an object");
  }
  return { ...value };
};

/** A status as a minor-3 runner sends it: no resources, capabilities or install. */
const minor3Status: Status = {
  type: "status",
  executor: "docker",
  capacity: 4,
  freeSlots: 3,
  labels: ["gpu"],
  version: "0.4.0",
  running: [ids.session],
  spoolBytes: 0,
  processContainment: "container",
};

describe("the version", () => {
  it("F-061: a minor-4 server took minors 3 to 5, and minor 4 stays in the codecs after minor 5", () => {
    // Milestone 6 moved the build to minor 5 (`minor-5.test.ts`), milestone 7 to minor 6
    // (`minor-6.test.ts`) and milestone 8 to minor 7; a minor-4 build's window is as it was.
    expect(PROTOCOL_MINOR).toBe(7);
    expect(minorWindow(4)).toEqual({ min: 3, max: 5 });
    expect(negotiate(4, PROTOCOL_MAJOR, 3)).toEqual({ ok: true, minor: 3 });
    expect(negotiate(4, PROTOCOL_MAJOR, 4)).toEqual({ ok: true, minor: 4 });
    expect(negotiate(4, PROTOCOL_MAJOR, 2)).toEqual({ ok: false, reason: "minor", window: { min: 3, max: 5 } });
    // A minor-4 runner against a minor-3 server speaks minor 3, against a minor-5 server minor 4,
    // and a minor-6 server and today's minor-7 one refuse it.
    expect(negotiate(3, PROTOCOL_MAJOR, 4)).toEqual({ ok: true, minor: 3 });
    expect(negotiate(5, PROTOCOL_MAJOR, 4)).toEqual({ ok: true, minor: 4 });
    expect(negotiate(6, PROTOCOL_MAJOR, 4)).toEqual({ ok: false, reason: "minor", window: { min: 5, max: 7 } });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 4)).toEqual({ ok: false, reason: "minor", window: { min: 6, max: 8 } });
    expect(upFrameCodec.minors).toContain(4);
    expect(downFrameCodec.minors).toContain(4);
  });

  it("F-093: a kubernetes hello below minor 4 is refused with its own reason, at the window's edges", () => {
    expect(executorMinMinor("kubernetes")).toBe(4);
    expect(executorMinMinor("docker")).toBe(0);
    expect(executorMinMinor("host")).toBe(0);
    const kubernetes = (protocolMinor: number): Hello => ({ ...minor4HelloFixture, protocolMinor });
    // A minor-3 kubernetes runner was inside a minor-4 server's window, and still refused.
    expect(negotiate(4, PROTOCOL_MAJOR, 3)).toMatchObject({ ok: true });
    expect(refuseHelloExecutor(kubernetes(3), 3)).toEqual({ reason: "executor-needs-minor", executor: "kubernetes", minMinor: 4 });
    // A minor-4 kubernetes runner against a minor-3 server speaks minor 3: refused too.
    expect(refuseHelloExecutor(kubernetes(4), 3)).toEqual({ reason: "executor-needs-minor", executor: "kubernetes", minMinor: 4 });
    expect(refuseHelloExecutor(kubernetes(4), 4)).toBeNull();
    expect(refuseHelloExecutor(kubernetes(5), 4)).toBeNull();
    // Docker, host, and a hello that names no executor, at minor 3.
    expect(refuseHelloExecutor({ ...kubernetes(3), executor: "docker" }, 3)).toBeNull();
    expect(refuseHelloExecutor({ ...kubernetes(3), executor: "host" }, 3)).toBeNull();
    const noExecutor: Record<string, unknown> = { ...kubernetes(3) };
    Reflect.deleteProperty(noExecutor, "executor");
    expect(refuseHelloExecutor(helloSchema.parse(noExecutor), 3)).toBeNull();
    // A minor-3 runner's hello names no executor: the one it registered with decides.
    expect(refuseHelloExecutor(helloSchema.parse(noExecutor), 3, "kubernetes")).toEqual({
      reason: "executor-needs-minor",
      executor: "kubernetes",
      minMinor: 4,
    });
    expect(refuseHelloExecutor(helloSchema.parse(noExecutor), 3, "docker")).toBeNull();
    expect(refuseHelloExecutor(kubernetes(4), 4, "docker")).toBeNull();
  });
});

describe("minor 4's events", () => {
  it("adds five kinds, each with a fixture, none readable below minor 4", () => {
    expect([...minor4EventKinds].sort()).toEqual([...addedKinds].sort());
    for (const kind of addedKinds) {
      expect(taskEventKinds).toContain(kind);
      expect(eventFixtures[kind].kind).toBe(kind);
      expect(eventKindSupportedAt(kind, 3)).toBe(false);
      expect(eventKindSupportedAt(kind, 4)).toBe(true);
      expect(taskEventSchema.parse(roundTrip(eventFixtures[kind]))).toEqual(eventFixtures[kind]);
      expect(readEventSchema.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
      expect(taskEventSchemaV3.safeParse(eventFixtures[kind]).success).toBe(false);
    }
    for (const kind of minor3EventKinds) {
      expect(eventKindSupportedAt(kind, 3)).toBe(true);
      expect(taskEventSchemaV3.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
    }
  });

  it("F-092: the server-only set holds task.cancelled, runner.drained and runner.resumed, and a runner can't send them", () => {
    for (const kind of serverOnlyAdded) {
      expect(serverOnlyKinds.has(kind)).toBe(true);
      const sent = { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: eventFixtures[kind] };
      expect(runnerEventSchema.safeParse(sent).success).toBe(false);
    }
    for (const kind of runnerAdded) {
      expect(serverOnlyKinds.has(kind)).toBe(false);
      const sent = { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: eventFixtures[kind] };
      expect(runnerEventSchema.parse(sent)).toEqual(sent);
    }
  });

  it("F-093: box.waiting and box.scheduled travel at minor 4 and are refused at minor 3", () => {
    for (const kind of runnerAdded) {
      const frame = eventsFrame(eventFixtures[kind]);
      expect(parseUpFrame(encodeUpFrame(frame, 4), 4)).toEqual({ ok: true, frame });
      expect(parseUpFrame(JSON.stringify(frame), 3).ok).toBe(false);
    }
  });

  it("refuses an unknown field and a bad reason", () => {
    expect(taskEventSchema.safeParse({ ...eventFixtures["box.waiting"], extra: 1 }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["box.waiting"], reason: "quota" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["box.scheduled"], afterMs: -1 }).success).toBe(false);
    expect(taskEventSchema.safeParse({ kind: "task.cancelled" }).success).toBe(false);
  });

  it("minor-3 events still parse at minor 3", () => {
    const frame = eventsFrame(eventFixtures["memory.used"]);
    expect(parseUpFrame(JSON.stringify(frame), 3)).toEqual({ ok: true, frame });
    expect(parseUpFrame(encodeUpFrame(frame, 3), 4)).toEqual({ ok: true, frame });
  });
});

describe("minor 4's commands", () => {
  it("F-092: resume is a minor-4 kind, with a fixture, refused by a minor-3 peer", () => {
    expect(commandKindMinMinor("resume")).toBe(4);
    expect(commandKindSupportedAt("resume", 3)).toBe(false);
    expect(commandKindSupportedAt("resume", 4)).toBe(true);
    const resume = commandFixtures.resume;
    expect(commandSchema.parse(roundTrip(resume))).toEqual(resume);
    expect(parseDownFrame(encodeDownFrame(resume, 4), 4)).toEqual({ ok: true, frame: resume });
    // The kind is never encoded down; a minor-3 or minor-2 codec refuses it.
    expect(parseDownFrame(JSON.stringify(resume), 3).ok).toBe(false);
    expect(parseDownFrame(JSON.stringify(resume), 2).ok).toBe(false);
    expect(commandSchema.safeParse({ ...resume, body: { now: true } }).success).toBe(false);
  });

  it("F-095, F-120: every minor-4 command field round-trips at minor 4", () => {
    for (const command of Object.values(minor4CommandFixtures)) {
      const typed: Command = command;
      expect(commandSchema.parse(roundTrip(typed))).toEqual(typed);
      expect(parseDownFrame(encodeDownFrame(typed, 4), 4)).toEqual({ ok: true, frame: typed });
    }
  });

  it("F-095, F-120: a minor-3 peer's codec drops the dispatch's box and the build's push and builder", () => {
    for (const minor of [3, 2]) {
      const dispatch = minor4CommandFixtures["dispatch, with a size and an image"];
      const sent = decoded(encodeDownFrame(dispatch, minor));
      expect(sent).toEqual({ ...dispatch, body: { taskId: ids.task, sessionId: ids.session, boxId: ids.box, leaseEpoch: 1 } });
      expect(parseDownFrame(JSON.stringify(sent), minor).ok).toBe(true);
      // Written as minor 4 and read as minor 3, the box is refused.
      expect(parseDownFrame(JSON.stringify(dispatch), minor).ok).toBe(false);

      const build = minor4CommandFixtures["snapshot-build, pushed by BuildKit"];
      const builtFor3 = decoded(encodeDownFrame(build, minor));
      expect(builtFor3).toEqual(roundTrip({ ...build, body: commandFixtures["snapshot-build"].body }));
      expect(parseDownFrame(JSON.stringify(builtFor3), minor).ok).toBe(true);
      expect(parseDownFrame(JSON.stringify(build), minor).ok).toBe(false);
    }
    // A command minor 4 didn't change goes down as it is.
    expect(encodeCommandForMinor(commandFixtures.steer, 3)).toEqual(commandFixtures.steer);
  });

  it("minor-3 and minor-2 commands still parse at their minors", () => {
    for (const minor of [2, 3]) {
      expect(parseDownFrame(JSON.stringify(commandFixtures.dispatch), minor)).toEqual({ ok: true, frame: commandFixtures.dispatch });
      expect(parseDownFrame(JSON.stringify(commandFixtures["snapshot-build"]), minor)).toEqual({
        ok: true,
        frame: commandFixtures["snapshot-build"],
      });
      expect(parseDownFrame(JSON.stringify(commandFixtures["plan-answer"]), minor).ok).toBe(true);
    }
    // Minor 3's own kind still travels at minor 3, and minor 2 still refuses it.
    expect(parseDownFrame(encodeDownFrame(commandFixtures["set-effort"], 3), 3)).toEqual({ ok: true, frame: commandFixtures["set-effort"] });
    expect(parseDownFrame(JSON.stringify(commandFixtures["set-effort"]), 2).ok).toBe(false);
  });

  it("refuses an unknown field in the box, a size without limits and an image without a digest", () => {
    const body = minor4CommandFixtures["dispatch, with a size and an image"].body;
    expect(dispatchBodySchema.safeParse({ ...body, box: { ...body.box, extra: 1 } }).success).toBe(false);
    expect(dispatchBodySchema.safeParse({ ...body, box: { size: { name: "small" }, image: null } }).success).toBe(false);
    expect(dispatchBodySchema.safeParse({ ...body, box: { size: { name: "huge", cpuMillis: 1, memoryMiB: 1 }, image: null } }).success).toBe(false);
    expect(dispatchBodySchema.safeParse({ ...body, box: { size: null, image: { ref: "r/x:1" } } }).success).toBe(false);
    expect(dispatchBodySchema.safeParse({ ...body, box: { size: null, image: { ref: "r/x@sha256:1", digest: "sha256:1" } } }).success).toBe(false);
  });
});

describe("what a runner reports", () => {
  it("F-067, F-095: hello and status carry resources, capabilities and install at minor 4", () => {
    for (const status of [minor4StatusFixture, minor4HostStatusFixture]) {
      expect(statusSchema.parse(roundTrip(status))).toEqual(status);
      expect(parseUpFrame(encodeUpFrame(status, 4), 4)).toEqual({ ok: true, frame: status });
    }
    expect(helloSchema.parse(roundTrip(minor4HelloFixture))).toEqual(minor4HelloFixture);
    expect(parseUpFrame(encodeUpFrame(minor4HelloFixture, 4), 4)).toEqual({ ok: true, frame: minor4HelloFixture });
    expect(httpHelloRequestSchema.parse(minor4HelloFixture)).toEqual(minor4HelloFixture);
    expect(runnerCapabilitiesSchema.parse(kubernetesCapabilitiesFixture)).toEqual(kubernetesCapabilitiesFixture);
  });

  it("a minor-3 server is sent no resources, capabilities or install, and only the labels it reads", () => {
    const status = decoded(encodeUpFrame(minor4StatusFixture, 3));
    expect(status).not.toHaveProperty("resources");
    expect(status).not.toHaveProperty("capabilities");
    expect(status).not.toHaveProperty("install");
    expect(status["labels"]).toEqual(["gpu"]);
    expect(status["processContainment"]).toBe("container");
    expect(parseUpFrame(JSON.stringify(status), 3).ok).toBe(true);
    // Minor 0 also loses the containment, as before.
    expect(decoded(encodeUpFrame(minor4StatusFixture, 0))).not.toHaveProperty("processContainment");

    const hello = decoded(encodeUpFrame(minor4HelloFixture, 3));
    for (const key of ["resources", "capabilities", "install"]) {
      expect(hello).not.toHaveProperty(key);
    }
    // The loose hello keeps the executor, which a minor-3 server ignores.
    expect(hello["executor"]).toBe("kubernetes");
    expect(parseUpFrame(JSON.stringify(hello), 3).ok).toBe(true);
  });

  it("a minor-3 codec refuses a status with minor 4's fields, and still reads a minor-3 status", () => {
    expect(parseUpFrame(JSON.stringify(minor4StatusFixture), 3).ok).toBe(false);
    expect(parseUpFrame(JSON.stringify(minor3Status), 3)).toEqual({ ok: true, frame: minor3Status });
    expect(parseUpFrame(JSON.stringify(minor3Status), 4)).toEqual({ ok: true, frame: minor3Status });
  });

  it("refuses an unknown field in the status, the resources and the capabilities", () => {
    expect(statusSchema.safeParse({ ...minor4StatusFixture, extra: 1 }).success).toBe(false);
    expect(runnerResourcesSchema.safeParse({ slots: 1, cpuMillis: 1, memoryMiB: 1, gpu: 1 }).success).toBe(false);
    expect(runnerCapabilitiesSchema.safeParse({ ...kubernetesCapabilitiesFixture, gpu: true }).success).toBe(false);
    expect(runnerCapabilitiesSchema.safeParse({ ...kubernetesCapabilitiesFixture, registry: "maybe" }).success).toBe(false);
    expect(statusSchema.safeParse({ ...minor4StatusFixture, install: "brew" }).success).toBe(false);
    // `hello` stays the one loose message.
    expect(helloSchema.safeParse({ ...minor4HelloFixture, extra: 1 }).success).toBe(true);
  });
});

describe("labels", () => {
  it("F-069: allows a colon and a slash, and reserves executor:, os: and arch:", () => {
    expect(runnerLabelSchema.parse("tier:fast")).toBe("tier:fast");
    expect(runnerLabelSchema.parse("team/web")).toBe("team/web");
    expect(runnerLabelSchema.safeParse("Tier:Fast").success).toBe(false);
    expect(runnerLabelSchema.safeParse(":fast").success).toBe(false);
    expect(runnerLabelSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(reservedLabelPrefixes).toEqual(["executor:", "os:", "arch:"]);
    for (const label of ["executor:docker", "os:linux", "arch:arm64"]) {
      expect(isReservedLabel(label)).toBe(true);
    }
    for (const label of ["tier:fast", "gpu", "executors:x", "macos"]) {
      expect(isReservedLabel(label)).toBe(false);
    }
  });
});

describe("the HTTP carrier", () => {
  it("F-013: names the headers, the answers and the superseded body", () => {
    expect(runnerHeaders.connectionEpoch).toBe("x-ostra-epoch");
    expect(runnerHeaders.minor).toBe("x-ostra-minor");
    expect(httpCarrierStatus).toEqual({ ok: 200, idle: 204, superseded: 409 });
    expect(httpSupersededSchema.parse(minor4HttpFixtures.superseded)).toEqual({ code: "superseded" });
    expect(httpSupersededSchema.safeParse({ code: "superseded", extra: 1 }).success).toBe(false);
    expect(httpSupersededSchema.safeParse({ code: "replaced" }).success).toBe(false);
    expect(connectionEpochFromHeader("7")).toBe(7);
    for (const bad of [undefined, null, "", "0", "-1", "1.5", "x", "01"]) {
      expect(connectionEpochFromHeader(bad)).toBeNull();
    }
  });

  it("F-013: hello's answer, an up batch and a down batch parse at minor 4, and minor 3 still reads its own", () => {
    const welcome = {
      type: "welcome",
      minor: 4,
      serverTime: 1_700_000_000_000,
      connectionEpoch: 2,
      replicaId: ids.replica,
      pingMs: 20_000,
      creditFrames: 256,
      creditBytes: 4_194_304,
      maxConnectionAgeMs: 3_600_000,
    };
    expect(parseHttpDownBody({ frames: [welcome, { type: "ack", sessionId: ids.session, upTo: 3 }] }, 4)).toMatchObject({ ok: true });
    const refusal = {
      frames: [{ type: "error", code: "version-unsupported", message: "update", supported: { min: 3, max: 5 }, serverMinor: 4 }],
    };
    expect(httpHelloRefusalSchema.parse(refusal)).toEqual(refusal);
    expect(httpHelloRefusalSchema.safeParse({ frames: [] }).success).toBe(false);

    const up = { frames: [minor4StatusFixture, eventsFrame(eventFixtures["box.waiting"])] };
    expect(parseHttpUpBody(roundTrip(up), 4)).toEqual({ ok: true, frames: up.frames });
    expect(parseHttpUpBody(roundTrip(up), 3).ok).toBe(false);
    expect(parseHttpUpBody({ frames: [minor3Status] }, 3)).toEqual({ ok: true, frames: [minor3Status] });

    const down = { frames: [commandFixtures.resume, minor4CommandFixtures["dispatch, with a size and an image"]] };
    expect(parseHttpDownBody(roundTrip(down), 4)).toEqual({ ok: true, frames: down.frames });
    expect(parseHttpDownBody(roundTrip(down), 3).ok).toBe(false);
  });
});

describe("the registry's credentials", () => {
  it("F-120: names both endpoints, round-trips their requests and answer, and refuses an unknown field", () => {
    expect(runnerPaths.taskPullCredential(ids.task)).toBe(`/runner/v1/tasks/${ids.task}/pull-credential`);
    expect(runnerPaths.snapshotPushCredential(ids.snapshot)).toBe(`/runner/v1/snapshots/${ids.snapshot}/push-credential`);
    expect(pullCredentialRequestSchema.parse(minor4HttpFixtures.pullCredentialRequest)).toEqual({ leaseEpoch: 1 });
    expect(pullCredentialRequestSchema.safeParse({}).success).toBe(false);
    expect(pushCredentialRequestSchema.parse(minor4HttpFixtures.pushCredentialRequest)).toEqual({});
    expect(pushCredentialRequestSchema.safeParse({ snapshotId: ids.snapshot }).success).toBe(false);
    for (const schema of [pullCredentialResponseSchema, pushCredentialResponseSchema, registryCredentialSchema]) {
      expect(schema.parse(roundTrip(minor4HttpFixtures.credential))).toEqual(minor4HttpFixtures.credential);
      expect(schema.safeParse({ ...minor4HttpFixtures.credential, password: "x" }).success).toBe(false);
    }
    expect(registryCredentialSchema.description).toMatch(/never logged/);
  });

  it("F-120: names its three refusals", () => {
    expect(registryCredentialRefusalSchema.shape.error.shape.code.options).toEqual(["no-image", "not-the-builder", "stale-lease"]);
    for (const refusal of Object.values(registryCredentialRefusalFixtures)) {
      expect(registryCredentialRefusalSchema.parse(roundTrip(refusal))).toEqual(refusal);
    }
    expect(registryCredentialRefusalSchema.safeParse({ error: { code: "expired", message: "" } }).success).toBe(false);
  });
});

describe("GET /runner/v1/info", () => {
  it("F-061: carries the minor window and the npm registry the pin reads, only to a runner at minor 4", () => {
    const info = minor4HttpFixtures.info;
    expect(infoResponseSchema.parse(roundTrip(info))).toEqual(info);
    expect(infoResponseSchema.safeParse({ ...info, more: true }).success).toBe(false);
    expect(infoResponseSchema.parse({ ...info, npm: null }).npm).toBeNull();
    expect(encodeInfoForMinor(info, 4)).toEqual(info);
    const forMinor3 = encodeInfoForMinor(info, 3);
    expect(forMinor3).not.toHaveProperty("minorWindow");
    expect(forMinor3).not.toHaveProperty("npm");
    expect(infoResponseSchemaV3.parse(forMinor3)).toEqual(forMinor3);
    expect(infoResponseSchemaV3.safeParse(info).success).toBe(false);
    // A minor-3 server's answer still parses here.
    expect(infoResponseSchema.parse(forMinor3)).toEqual(forMinor3);
  });
});

describe("welcome's pool (minor 4)", () => {
  it("F-091: tells a pool runner its pool and whether it waits for approval, only at minor 4", () => {
    const welcome = {
      type: "welcome" as const,
      minor: 4,
      serverTime: 1_700_000_000_000,
      connectionEpoch: 2,
      replicaId: ids.replica,
      pingMs: 20_000,
      creditFrames: 256,
      creditBytes: 4_194_304,
      maxConnectionAgeMs: 3_600_000,
      pool: { poolId: poolIdSchema.parse("pool-1"), name: "Build farm", awaitingApproval: true },
    };
    expect(parseDownFrame(encodeDownFrame(welcome, 4), 4)).toEqual({ ok: true, frame: welcome });
    // A minor-3 runner reads minor 3's welcome: the pool is dropped, and refused if it were sent.
    const { pool: _dropped, ...minor3 } = welcome;
    expect(_dropped.awaitingApproval).toBe(true);
    expect(parseDownFrame(encodeDownFrame(welcome, 3), 3)).toEqual({ ok: true, frame: minor3 });
    expect(parseDownFrame(JSON.stringify(welcome), 3).ok).toBe(false);
    expect(parseDownFrame(JSON.stringify({ ...welcome, pool: { ...welcome.pool, extra: 1 } }), 4).ok).toBe(false);
  });
});

describe("a box's wait as a runner event (minor 4)", () => {
  it("F-093/c3: box.waiting and box.scheduled travel in a runner-event frame at minor 4, and are refused in one below it", () => {
    for (const kind of runnerAdded) {
      const frame: UpFrame = { type: "runner-event", at: 1_700_000_000_000, event: eventFixtures[kind] };
      expect(parseUpFrame(encodeUpFrame(frame, 4), 4)).toEqual({ ok: true, frame });
      expect(parseUpFrame(JSON.stringify(frame), 3).ok).toBe(false);
    }
    // A snapshot's result still travels at minor 3, and a task's other events never as a runner event.
    const built: UpFrame = { type: "runner-event", at: 1_700_000_000_000, event: eventFixtures["snapshot.built"] };
    expect(parseUpFrame(JSON.stringify(built), 3)).toEqual({ ok: true, frame: built });
    expect(parseUpFrame(JSON.stringify({ type: "runner-event", at: 1, event: eventFixtures["task.cancelled"] }), 4).ok).toBe(false);
  });
});
