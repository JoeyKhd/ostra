import { describe, expect, it } from "vitest";

import { appAddressName, appInstructionsBlock, ONE_ORIGIN_RULE } from "../agent/prompts.ts";
import {
  cliPreviewTunnelRefusalWords,
  cliPreviewTunnelRequestSchema,
  cliPreviewTunnelResponseSchema,
  cliStartAppRefusalWords,
  cliStartAppRequestSchema,
  cliStartAppResponseSchema,
  cliPaths,
  cliTunnelQuerySchema,
  CORE_CLI_TUNNEL_PATH,
} from "../cli/http.ts";
import {
  eventKindSupportedAt,
  minor6EventKinds,
  minor7EventKinds,
  readEventSchema,
  runnerEventSchema,
  serverOnlyKinds,
  taskEventSchema,
  taskEventSchemaV6,
} from "../events/agent-events.ts";
import type { TaskEvent, TaskEventKind } from "../events/agent-events.ts";
import {
  appToolRefusal,
  appToolRefusalText,
  attachmentResultText,
  encodeEnvironmentProposalForMinor,
  encodeReviewRequestForMinor,
  environmentProposalRequestFromTool,
  environmentProposalSchema,
  findingSchema,
  proposeEnvironmentInputSchema,
  recordAppDescription,
  recordAppInputSchema,
  recordStepSchema,
  showPreviewInputSchema,
  startAppInputSchema,
  startAppResultText,
  takeScreenshotDescription,
  takeScreenshotInputSchema,
} from "../mcp/tools.ts";
import type { AppToolCall, AppToolContext } from "../mcp/tools.ts";
import { appLogPath, appPathSchema, previewKeyFor, previewKeySchema } from "../task/app.ts";
import { encodeTaskCredentialsForMinor, secretHeaderValues, taskCredentialsSchema } from "../task/credentials.ts";
import { decodeFrameReel, encodeFrameReel, frameReelMaxFrames } from "../task/frame-reel.ts";
import {
  appProcessesSchema,
  encodeTaskSpecForMinor,
  isTaskOfferable,
  taskNotOfferableWords,
  taskSpecMinMinor,
  taskSpecResponseSchemaFor,
  taskSpecSchema,
  taskSpecSchemaV6,
} from "../task/spec.ts";
import type { TaskSpec } from "../task/spec.ts";
import {
  appProcessesFixture,
  appToolInputFixtures,
  cliPreviewFixtures,
  commandFixtures,
  eventFixtures,
  fixtureIds as ids,
  frameReelFixture,
  jpegFixture,
  minor7CommandFixtures,
  minor7EventFixtures,
  minor7HelloFixture,
  minor7HostStatusFixture,
  minor7ProposalFixtures,
  minor7ReviewRequestFixture,
  previewFramesFixtures,
  previewMessageFixtures,
  recordStepFixtures,
  reservedPortsFixture,
  taskCredentialsMinor2Fixture,
  taskSpecAppFixture,
  taskSpecMinor3Fixture,
  taskSpecOnboardingFixture,
  taskSpecRefineFixture,
  taskSpecReviewFixture,
} from "../testing/fixtures.ts";
import { blobUploadPurposeMinMinor, blobUploadPurposeSchema } from "./blobs.ts";
import { commandKindMinMinor, commandKindSupportedOn, encodeCommandForMinor, minor7CommandKinds } from "./commands.ts";
import type { Command, CommandKind } from "./commands.ts";
import { portRefusal, runnerLimits } from "./limits.ts";
import {
  downFrameCodec,
  encodeDownFrame,
  encodeUpFrame,
  httpDownFrameCodec,
  parseDownFrame,
  parseUpFrame,
  statusSchema,
  upFrameCodec,
} from "./messages.ts";
import type { UpFrame } from "./messages.ts";
import {
  decodePreviewMessage,
  encodePreviewMessage,
  isPreviewable,
  previewConnectionQuerySchema,
  previewControlSchema,
  previewFrameHeaderSchema,
  previewFramesBodySchema,
  previewFramesResponseSchema,
  previewMessageMaxBytes,
  previewMessageTypeBytes,
  previewOpenRefusalOf,
  previewPaths,
  previewRefusalReasonSchema,
  previewRefusalWords,
} from "./preview.ts";
import { runnerPaths } from "./http.ts";
import { minorWindow, negotiate, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./version.ts";

// Protocol minor 7 (milestone 8, ticket 01, ADR 0068): the app's processes, the pictures, the
// previews and `ostra preview`. Every addition round-trips; a minor-6 peer keeps working inside the
// window and is never sent any of it; a minor-5 peer is outside the window.

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const runnerKinds = ["app.process", "app.browser", "attachment.added", "attachment.skipped", "preview.list", "preview.dropped"] as const satisfies readonly TaskEventKind[];
const serverKinds = [
  "preview.opened",
  "preview.closed",
  "preview.level_changed",
  "preview.link_created",
  "preview.link_revoked",
  "app.started_by",
] as const satisfies readonly TaskEventKind[];
const newCommands = ["app.start", "app.stop", "screenshot.take", "preview.open", "preview.close", "preview.input"] as const satisfies readonly CommandKind[];

const eventsFrame = (event: TaskEvent): UpFrame => ({
  type: "events",
  events: [{ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_900_000_000_000, event }],
});

const noPorts: AppToolContext = {
  reservedPorts: reservedPortsFixture,
  processNames: ["web", "api", "docs"],
  previews: [
    { port: 5173, primary: true, source: "declared" },
    { port: 3001, primary: false, source: "declared" },
  ],
  attachmentsThisTurn: 0,
  browser: true,
};

describe("the version", () => {
  it("F-061: is minor 7; a minor-6 peer is inside the window and a minor-5 peer is outside it", () => {
    expect(PROTOCOL_MINOR).toBe(7);
    expect(minorWindow(PROTOCOL_MINOR)).toEqual({ min: 6, max: 8 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 6)).toEqual({ ok: true, minor: 6 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 7)).toEqual({ ok: true, minor: 7 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 8)).toEqual({ ok: true, minor: 7 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 5)).toEqual({ ok: false, reason: "minor", window: { min: 6, max: 8 } });
    // A minor-7 runner against a minor-6 server speaks minor 6.
    expect(negotiate(6, PROTOCOL_MAJOR, PROTOCOL_MINOR)).toEqual({ ok: true, minor: 6 });
    expect(upFrameCodec.minors).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(downFrameCodec.minors).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(httpDownFrameCodec.minors).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("minor 7's events", () => {
  it("F-121, F-140, F-141: adds the runner's four kinds and the server's six, each with a fixture that round-trips, none readable below minor 7", () => {
    expect([...minor7EventKinds].sort()).toEqual([...runnerKinds, ...serverKinds].sort());
    for (const kind of minor7EventKinds) {
      expect(eventKindSupportedAt(kind, 6)).toBe(false);
      expect(eventKindSupportedAt(kind, 7)).toBe(true);
      expect(taskEventSchema.parse(roundTrip(eventFixtures[kind]))).toEqual(eventFixtures[kind]);
      expect(readEventSchema.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
      expect(taskEventSchemaV6.safeParse(eventFixtures[kind]).success, kind).toBe(false);
    }
    for (const event of Object.values(minor7EventFixtures)) {
      expect(taskEventSchema.parse(roundTrip(event))).toEqual(event);
    }
    // Minor 6's kinds still parse at minor 6.
    for (const kind of minor6EventKinds) {
      expect(taskEventSchemaV6.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
    }
  });

  it("F-141, F-142: the server-only set holds every new server kind, and a runner can send none of them", () => {
    for (const kind of serverKinds) {
      expect(serverOnlyKinds.has(kind), kind).toBe(true);
      const sent = { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: eventFixtures[kind] };
      expect(runnerEventSchema.safeParse(sent).success, kind).toBe(false);
      expect(parseUpFrame(JSON.stringify(eventsFrame(eventFixtures[kind])), 7).ok, kind).toBe(false);
    }
    for (const kind of runnerKinds) {
      expect(serverOnlyKinds.has(kind), kind).toBe(false);
      const frame = eventsFrame(eventFixtures[kind]);
      expect(parseUpFrame(encodeUpFrame(frame, 7), 7)).toEqual({ ok: true, frame });
      // A minor-6 server refuses the kind: a minor-7 runner never sends it one.
      expect(parseUpFrame(JSON.stringify(frame), 6).ok, kind).toBe(false);
    }
  });

  it("F-121, F-140: refuses an unknown field, a bad state, a path to another host and a caption over 1 KiB", () => {
    for (const kind of minor7EventKinds) {
      expect(taskEventSchema.safeParse({ ...eventFixtures[kind], surprise: 1 }).success, kind).toBe(false);
    }
    expect(taskEventSchema.safeParse({ ...eventFixtures["app.process"], state: "paused" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["app.process"], port: 80 }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["attachment.added"], path: "//evil.example" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["attachment.added"], path: "/\\evil.example" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["attachment.added"], caption: "é".repeat(513) }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["attachment.added"], caption: "é".repeat(512) }).success).toBe(true);
    const browser = { kind: "app.browser", browser: { available: true, name: "Chromium", version: "131", surprise: 1 } };
    expect(taskEventSchema.safeParse(browser).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["preview.opened"], by: { kind: "link", linkId: ids.previewLink, memberId: ids.member } }).success).toBe(false);
  });

  it("F-141: a preview's key is its target's, the same on every box", () => {
    expect(previewKeyFor({ process: "web" })).toBe("app-web");
    expect(previewKeyFor({ port: 4100 })).toBe("port-4100");
    expect(previewKeyFor({ service: "mailpit" })).toBe("service-mailpit");
    for (const bad of ["web", "app-", "port-80", "service-Mail", "app-web/../x"]) {
      expect(previewKeySchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("minor 7's commands", () => {
  it("F-140, F-141: adds six kinds, each with a fixture that round-trips at minor 7 and none sent below it", () => {
    expect([...minor7CommandKinds].sort()).toEqual([...newCommands].sort());
    for (const kind of newCommands) {
      const command = commandFixtures[kind];
      expect(commandKindMinMinor(kind)).toBe(7);
      expect(httpDownFrameCodec.parse(encodeDownFrame(command, 7), 7)).toEqual({ ok: true, frame: command });
      // A minor-6 peer refuses it on both carriers: the outbox checks the minor first.
      expect(parseDownFrame(JSON.stringify(command), 6).ok, kind).toBe(false);
      expect(httpDownFrameCodec.parse(JSON.stringify(command), 6).ok, kind).toBe(false);
      expect(commandKindSupportedOn(kind, 6, "http")).toBe(false);
    }
    for (const command of Object.values(minor7CommandFixtures)) {
      expect(parseDownFrame(encodeDownFrame(command, 7), 7)).toEqual({ ok: true, frame: command });
    }
  });

  it("F-141: preview.input is the HTTP carrier's only: the WebSocket's codec refuses it and the outbox never writes it there", () => {
    const input = commandFixtures["preview.input"];
    expect(parseDownFrame(JSON.stringify(input), 7).ok).toBe(false);
    expect(httpDownFrameCodec.parse(JSON.stringify(input), 7).ok).toBe(true);
    // It carries the pane's width preset, path and reload too, one at a time, and never with input.
    const at = { sessionId: input.body.sessionId, viewId: input.body.viewId };
    for (const control of [{ kind: "viewport", viewport: { width: 390, height: 844 } }, { kind: "navigate", path: "/history?tab=2" }, { kind: "reload" }] as const) {
      const command = { ...input, body: { ...at, control } };
      expect(httpDownFrameCodec.parse(JSON.stringify(command), 7)).toEqual({ ok: true, frame: command });
      expect(parseDownFrame(JSON.stringify(command), 7).ok).toBe(false);
    }
    for (const body of [{ ...at, control: { kind: "reload" }, events: [{ kind: "text", text: "hello" }] }, { ...at, control: { kind: "navigate", path: "//evil.example/" } }, { ...at, control: { kind: "reload", seq: 1 } }]) {
      expect(httpDownFrameCodec.parse(JSON.stringify({ ...input, body }), 7).ok).toBe(false);
    }
    expect(commandKindSupportedOn("preview.input", 7, "websocket")).toBe(false);
    expect(commandKindSupportedOn("preview.input", 7, "http")).toBe(true);
    for (const kind of newCommands.filter((kind) => kind !== "preview.input")) {
      expect(commandKindSupportedOn(kind, 7, "websocket"), kind).toBe(true);
      expect(parseDownFrame(JSON.stringify(commandFixtures[kind]), 7).ok, kind).toBe(true);
    }
  });

  it("F-141: a minor-6 peer's codec drops the dispatch's purpose, and the purpose travels at minor 7", () => {
    const dispatch = minor7CommandFixtures["dispatch, start the app"];
    const down = encodeCommandForMinor(dispatch, 6);
    expect(down.kind === "dispatch" && "purpose" in down.body).toBe(false);
    expect(parseDownFrame(encodeDownFrame(dispatch, 6), 6).ok).toBe(true);
    expect(parseDownFrame(JSON.stringify(dispatch), 6).ok).toBe(false);
    expect(parseDownFrame(encodeDownFrame(dispatch, 7), 7)).toEqual({ ok: true, frame: dispatch });
    // Below minor 5 it loses minor 5's field too, as before.
    expect(parseDownFrame(encodeDownFrame(dispatch, 4), 4).ok).toBe(true);
    // A dispatch without a purpose is a turn's, and goes down to minor 6 as it is.
    expect(encodeCommandForMinor(commandFixtures.dispatch, 6)).toEqual(commandFixtures.dispatch);
  });

  it("F-140, F-141: refuses an unknown field, a mode, a viewport and a path past their rules", () => {
    for (const kind of newCommands) {
      const command: Command = commandFixtures[kind];
      expect(httpDownFrameCodec.parse(JSON.stringify({ ...command, body: { ...command.body, surprise: 1 } }), 7).ok, kind).toBe(false);
    }
    const open = commandFixtures["preview.open"];
    expect(parseDownFrame(JSON.stringify({ ...open, body: { ...open.body, mode: "native" } }), 7).ok).toBe(false);
    expect(parseDownFrame(JSON.stringify({ ...open, body: { ...open.body, viewport: { width: 4000, height: 900 } } }), 7).ok).toBe(false);
    const shot = commandFixtures["screenshot.take"];
    expect(parseDownFrame(JSON.stringify({ ...shot, body: { ...shot.body, path: "settings" } }), 7).ok).toBe(false);
    const start = commandFixtures["app.start"];
    expect(parseDownFrame(JSON.stringify({ ...start, body: { ...start.body, names: [] } }), 7).ok).toBe(false);
  });
});

describe("the task spec at minor 7", () => {
  it("F-140: app processes, screenshots, a service's preview and the app tools round-trip, and minor 6's specs still parse", () => {
    expect(taskSpecSchema.parse(roundTrip(taskSpecAppFixture))).toEqual(taskSpecAppFixture);
    for (const spec of [taskSpecMinor3Fixture, taskSpecRefineFixture, taskSpecReviewFixture, taskSpecOnboardingFixture]) {
      expect(taskSpecSchema.parse(roundTrip(spec))).toEqual(spec);
      expect(taskSpecSchemaV6.parse(roundTrip(spec))).toEqual(spec);
    }
    expect(taskSpecSchemaV6.safeParse(taskSpecAppFixture).success).toBe(false);
    expect(taskSpecResponseSchemaFor(7)).toBe(taskSpecSchema);
    expect(taskSpecResponseSchemaFor(6)).toBe(taskSpecSchemaV6);
  });

  it("F-140: a minor-6 peer's spec drops the app processes, the screenshots, the app tools and the service's preview", () => {
    const down = encodeTaskSpecForMinor(taskSpecAppFixture, 6);
    expect(taskSpecSchemaV6.parse(roundTrip(down))).toEqual(down);
    expect("appProcesses" in down.environment).toBe(false);
    expect("screenshots" in down.environment).toBe(false);
    expect(down.tools).toEqual(["pr-text", "memory"]);
    expect((down.services ?? []).every((service) => !("preview" in service))).toBe(true);
    // Everything else is as it was.
    expect(down.environment.repos).toEqual(taskSpecAppFixture.environment.repos);
    expect(down.services?.[0]?.image).toBe("axllent/mailpit:v1.21");
    expect(encodeTaskSpecForMinor(taskSpecAppFixture, 7)).toBe(taskSpecAppFixture);
    // And down to minor 0, every older shape still reads it.
    for (const minor of [0, 1, 2, 3, 4, 5]) {
      expect(taskSpecResponseSchemaFor(minor).safeParse(roundTrip(encodeTaskSpecForMinor(taskSpecAppFixture, minor))).success, String(minor)).toBe(true);
    }
  });

  it("F-140: isTaskOfferable refuses a spec with app processes or the app tools for a minor-6 peer, and allows it at minor 7", () => {
    expect(isTaskOfferable(taskSpecAppFixture, 6)).toEqual({ offerable: false, reason: "app-processes", minMinor: 7 });
    expect(isTaskOfferable(taskSpecAppFixture, 7)).toEqual({ offerable: true });
    const toolsOnly: TaskSpec = { ...taskSpecMinor3Fixture, tools: ["pr-text", "memory", "app"] };
    expect(isTaskOfferable(toolsOnly, 6)).toEqual({ offerable: false, reason: "app-tools", minMinor: 7 });
    expect(isTaskOfferable(toolsOnly, 7)).toEqual({ offerable: true });
    expect(taskSpecMinMinor(taskSpecAppFixture)).toBe(7);
    // Screenshots and a service's preview alone act only with app processes: no minor of their own.
    const settingsOnly: TaskSpec = {
      ...taskSpecMinor3Fixture,
      environment: { ...taskSpecMinor3Fixture.environment, appProcesses: [], screenshots: { afterTurn: true, routes: ["/"], widths: ["desktop"] } },
      services: taskSpecAppFixture.services ?? [],
    };
    expect(isTaskOfferable(settingsOnly, 6)).toEqual({ offerable: true });
    expect(taskNotOfferableWords("app-processes", 7)).toBe("The environment's app processes need a runner at protocol 1.7 or later: update the runner.");
    expect(taskNotOfferableWords("app-tools", 7)).toBe("The app tools need a runner at protocol 1.7 or later: update the runner.");
  });

  it("F-140: the environment's rules: one primary, names and ports once, no port below 1024, and a strict process", () => {
    expect(appProcessesSchema.safeParse(appProcessesFixture).success).toBe(true);
    const [web, api] = appProcessesFixture;
    expect(appProcessesSchema.safeParse([web, { ...api, primary: true }]).success).toBe(false);
    expect(appProcessesSchema.safeParse([web, { ...api, name: "web" }]).success).toBe(false);
    expect(appProcessesSchema.safeParse([web, { ...api, port: 5173 }]).success).toBe(false);
    expect(appProcessesSchema.safeParse([{ ...web, port: 1023 }]).success).toBe(false);
    expect(appProcessesSchema.safeParse([{ ...web, port: 1024 }]).success).toBe(true);
    expect(appProcessesSchema.safeParse([{ ...web, surprise: 1 }]).success).toBe(false);
    expect(appProcessesSchema.safeParse([{ ...web, name: "Web" }]).success).toBe(false);
    expect(appProcessesSchema.safeParse([{ ...web, folder: "../outside" }]).success).toBe(false);
    expect(appProcessesSchema.safeParse([{ ...web, ready: { kind: "http", path: "//evil.example" } }]).success).toBe(false);
    expect(appProcessesSchema.safeParse([{ ...web, ready: { kind: "tcp" } }]).success).toBe(false);
    expect(appProcessesSchema.safeParse(Array.from({ length: 11 }, (_, index) => ({ ...api, name: `p${String(index)}`, port: 3000 + index }))).success).toBe(false);
    const screenshots = taskSpecAppFixture.environment.screenshots;
    const environment = { ...taskSpecAppFixture.environment, screenshots: { ...screenshots, routes: ["/", "/"] } };
    expect(taskSpecSchema.safeParse({ ...taskSpecAppFixture, environment }).success).toBe(false);
    const sixRoutes = { ...taskSpecAppFixture.environment, screenshots: { afterTurn: true, routes: ["/", "/a", "/b", "/c", "/d", "/e"], widths: ["desktop"] } };
    expect(taskSpecSchema.safeParse({ ...taskSpecAppFixture, environment: sixRoutes }).success).toBe(false);
    expect(taskSpecSchema.safeParse({ ...taskSpecAppFixture, tools: ["app", "app"] }).success).toBe(false);
    expect(appPathSchema.safeParse("/a b").success).toBe(false);
    expect(appPathSchema.safeParse("/settings?tab=2#x").success).toBe(true);
  });
});

describe("the credentials at minor 7", () => {
  const library = taskCredentialsSchema.parse({
    ...taskCredentialsMinor2Fixture,
    mcpServers: [
      ...(taskCredentialsMinor2Fixture.mcpServers ?? []),
      { name: "acme-mcp", url: "https://mcp.example.com/mcp", headers: { "X-Acme-Version": "2025-06-18", Authorization: "Bearer fixture-acme-secret" }, plainHeaders: ["X-Acme-Version"] },
    ],
  });

  it("F-145/c12: a server's plain headers round-trip by name, only its own and once; every other header is a secret, and a minor-6 runner is sent each header without the names", () => {
    expect(taskCredentialsSchema.parse(roundTrip(library))).toEqual(library);
    const [own, acme] = library.mcpServers ?? [];
    if (own === undefined || acme === undefined) throw new Error("two servers");
    expect(secretHeaderValues(acme)).toEqual(["Bearer fixture-acme-secret"]);
    // No names: every header is a secret, as a profile's own server's are.
    expect(secretHeaderValues(own)).toEqual(["Bearer fixture-mcp-secret"]);
    const withPlain = (plainHeaders: readonly string[]) => ({ ...library, mcpServers: [{ ...acme, plainHeaders }] });
    expect(taskCredentialsSchema.safeParse(withPlain(["X-Other"])).success).toBe(false);
    expect(taskCredentialsSchema.safeParse(withPlain(["X-Acme-Version", "X-Acme-Version"])).success).toBe(false);
    expect(taskCredentialsSchema.safeParse(withPlain(["x-acme-version"])).success).toBe(false);
    expect(taskCredentialsSchema.safeParse({ ...library, mcpServers: [{ ...acme, secret: ["Authorization"] }] }).success).toBe(false);
    for (const minor of [6, 2]) {
      const down = encodeTaskCredentialsForMinor(library, minor);
      expect(down.mcpServers?.map((server) => Object.keys(server).sort())).toEqual([
        ["headers", "name", "url"],
        ["headers", "name", "url"],
      ]);
      expect(down.mcpServers?.[1]?.headers).toEqual(acme.headers);
    }
    expect(encodeTaskCredentialsForMinor(library, 7)).toBe(library);
    expect(encodeTaskCredentialsForMinor(taskCredentialsMinor2Fixture, 6)).toEqual(taskCredentialsMinor2Fixture);
  });
});

describe("hello and status at minor 7", () => {
  it("F-141: what a runner can preview and a host runner's browser round-trip, and a minor-6 peer's codec drops them", () => {
    expect(parseUpFrame(encodeUpFrame(minor7HostStatusFixture, 7), 7)).toEqual({ ok: true, frame: minor7HostStatusFixture });
    expect(parseUpFrame(encodeUpFrame(minor7HelloFixture, 7), 7)).toEqual({ ok: true, frame: minor7HelloFixture });
    const status: unknown = JSON.parse(encodeUpFrame(minor7HostStatusFixture, 6));
    expect(statusSchema.parse(status)).not.toHaveProperty("preview");
    expect(statusSchema.parse(status)).not.toHaveProperty("browser");
    expect(parseUpFrame(JSON.stringify(status), 6).ok).toBe(true);
    // Sent as it is, a minor-6 server refuses the status's new fields.
    expect(parseUpFrame(JSON.stringify(minor7HostStatusFixture), 6).ok).toBe(false);
    const hello: unknown = JSON.parse(encodeUpFrame(minor7HelloFixture, 6));
    expect(hello).not.toHaveProperty("preview");
    expect(hello).not.toHaveProperty("browser");
    // Below minor 4 they go with minor 4's fields.
    expect(parseUpFrame(encodeUpFrame(minor7HostStatusFixture, 3), 3).ok).toBe(true);
    expect(statusSchema.safeParse({ ...minor7HostStatusFixture, preview: { stream: true, tunnel: true, surprise: 1 } }).success).toBe(false);
  });

  it("F-141, F-143: isPreviewable gives nothing below minor 7, no tunnel on the HTTP carrier, and 2 frames a second there", () => {
    const both = { stream: true, tunnel: true } as const;
    expect(isPreviewable(6, "websocket", both)).toEqual({ previewable: false, reason: "runner-needs-upgrade" });
    expect(isPreviewable(6, "http", both)).toEqual({ previewable: false, reason: "runner-needs-upgrade" });
    expect(isPreviewable(7, "websocket", both)).toEqual({ previewable: true, stream: true, tunnel: true, framesPerSecond: 15 });
    expect(isPreviewable(7, "http", both)).toEqual({ previewable: true, stream: true, tunnel: false, framesPerSecond: 2 });
    // It fails closed: a minor-7 runner that reported nothing gets no view.
    expect(isPreviewable(7, "websocket", undefined)).toEqual({ previewable: false, reason: "runner-cannot-preview" });
    expect(isPreviewable(7, "websocket", null)).toEqual({ previewable: false, reason: "runner-cannot-preview" });
    // A runner that said it can tunnel still gets none over HTTP.
    expect(isPreviewable(7, "http", { stream: true, tunnel: true })).toMatchObject({ tunnel: false });
    expect(isPreviewable(7, "websocket", { stream: false, tunnel: true })).toMatchObject({ previewable: true, stream: false, tunnel: true });
    expect(isPreviewable(7, "http", { stream: false, tunnel: false })).toEqual({ previewable: false, reason: "runner-cannot-preview" });
    for (const reason of previewRefusalReasonSchema.options) {
      expect(previewRefusalWords(reason).length).toBeGreaterThan(0);
    }
    expect(previewRefusalWords("runner-needs-upgrade")).toMatch(/protocol 1\.7 or later/);
  });
});

describe("the preview connection", () => {
  it("F-141: the endpoint's path and query, and the HTTP carrier's frames", () => {
    expect(previewPaths.connection).toBe("/runner/v1/preview");
    expect(runnerPaths.preview).toBe(previewPaths.connection);
    expect(runnerPaths.previewFrames).toBe("/runner/v1/preview/frames");
    expect(previewConnectionQuerySchema.parse({ view: ids.previewView, leaseEpoch: "3" })).toEqual({ view: ids.previewView, leaseEpoch: 3 });
    expect(previewConnectionQuerySchema.safeParse({ view: ids.previewView, leaseEpoch: "0" }).success).toBe(false);
    expect(previewConnectionQuerySchema.safeParse({ view: ids.previewView }).success).toBe(false);
    expect(previewConnectionQuerySchema.safeParse({ view: ids.previewView, leaseEpoch: "1", token: "x" }).success).toBe(false);
    expect(previewFramesBodySchema.parse(roundTrip(previewFramesFixtures.body))).toEqual(previewFramesFixtures.body);
    const three = { ...previewFramesFixtures.body, frames: [...previewFramesFixtures.body.frames, { ...previewFramesFixtures.body.frames[0], seq: 3 }] };
    expect(previewFramesBodySchema.safeParse(three).success).toBe(false);
    for (const answer of [previewFramesFixtures.acked, ...previewFramesFixtures.refusals]) {
      expect(previewFramesResponseSchema.parse(roundTrip(answer))).toEqual(answer);
    }
  });

  it("F-141: every stream message round-trips through its binary framing", () => {
    for (const [name, message] of Object.entries(previewMessageFixtures)) {
      const bytes = encodePreviewMessage(message);
      expect(bytes[0], name).toBe(previewMessageTypeBytes[message.type]);
      expect(decodePreviewMessage(bytes), name).toEqual({ ok: true, message });
    }
  });

  it("F-141: the decoder refuses a truncated, oversized, unknown or non-JPEG message, and an unknown field", () => {
    const frame = encodePreviewMessage(previewMessageFixtures.frame);
    expect(decodePreviewMessage(new Uint8Array())).toEqual({ ok: false, reason: "empty" });
    expect(decodePreviewMessage(frame.subarray(0, 3))).toEqual({ ok: false, reason: "truncated" });
    expect(decodePreviewMessage(frame.subarray(0, 12))).toEqual({ ok: false, reason: "truncated" });
    // The header's length says more than the message holds.
    const headerOnly = frame.subarray(0, frame.length - jpegFixture.length);
    expect(decodePreviewMessage(headerOnly)).toEqual({ ok: false, reason: "truncated" });
    expect(decodePreviewMessage(new Uint8Array(previewMessageMaxBytes + 1))).toEqual({ ok: false, reason: "too-large" });
    // A header past its cap, by its length field alone.
    const bigHeader = new Uint8Array(16);
    bigHeader[0] = previewMessageTypeBytes.frame;
    new DataView(bigHeader.buffer).setUint32(1, runnerLimits.previewJsonMaxBytes + 1, false);
    expect(decodePreviewMessage(bigHeader)).toEqual({ ok: false, reason: "too-large" });
    // A JPEG past its cap.
    const bigJpeg = new Uint8Array(runnerLimits.previewFrameMaxBytes + 1);
    bigJpeg.set([0xff, 0xd8]);
    expect(decodePreviewMessage(encodePreviewMessage({ ...previewMessageFixtures.frame, jpeg: bigJpeg }))).toEqual({ ok: false, reason: "too-large" });
    expect(decodePreviewMessage(encodePreviewMessage({ ...previewMessageFixtures.frame, jpeg: new Uint8Array([1, 2, 3]) }))).toEqual({ ok: false, reason: "not-jpeg" });
    expect(decodePreviewMessage(new Uint8Array([9, 0x7b, 0x7d]))).toEqual({ ok: false, reason: "unknown-type" });
    expect(decodePreviewMessage(new Uint8Array([previewMessageTypeBytes.ack, 0x7b]))).toEqual({ ok: false, reason: "not-json" });
    expect(decodePreviewMessage(new Uint8Array([previewMessageTypeBytes.ack, 0xff, 0xfe]))).toEqual({ ok: false, reason: "not-json" });
    expect(decodePreviewMessage(new Uint8Array([previewMessageTypeBytes.control]))).toEqual({ ok: false, reason: "truncated" });
    const encoder = new TextEncoder();
    const withField = (type: number, value: unknown): Uint8Array => new Uint8Array([type, ...encoder.encode(JSON.stringify(value))]);
    expect(decodePreviewMessage(withField(previewMessageTypeBytes.ack, { seq: 1, surprise: 1 }))).toEqual({ ok: false, reason: "invalid" });
    expect(decodePreviewMessage(withField(previewMessageTypeBytes.control, { kind: "reload", seq: 1, surprise: 1 }))).toEqual({ ok: false, reason: "invalid" });
    expect(decodePreviewMessage(withField(previewMessageTypeBytes.close, { reason: "bored" }))).toEqual({ ok: false, reason: "invalid" });
    // A refusal is core's `refused` close only, and always says why.
    expect(decodePreviewMessage(withField(previewMessageTypeBytes.close, { reason: "refused" }))).toEqual({ ok: false, reason: "invalid" });
    expect(decodePreviewMessage(withField(previewMessageTypeBytes.close, { reason: "closed", refusal: "too-many-pages" }))).toEqual({ ok: false, reason: "invalid" });
    expect(decodePreviewMessage(withField(previewMessageTypeBytes.close, { reason: "refused", refusal: "bored" }))).toEqual({ ok: false, reason: "invalid" });
  });

  it("F-141: a box's reason for refusing a view's open, or dropping one it took, is one the pane can word, and any other is `other`", () => {
    const dropped = ["not-servable", "no-browser", "browser-failed", "connect-failed"] as const;
    for (const reason of ["not-a-preview", "too-many-pages", "session-ending", "unknown-session", "tunnel-needs-websocket", "past-not-after", ...dropped] as const) {
      expect(previewOpenRefusalOf(reason)).toBe(reason);
    }
    expect(previewOpenRefusalOf("the box's sidecar takes it")).toBe("other");
    expect(previewOpenRefusalOf(null)).toBe("other");
    // A dropped view says why with one of them, and only one of them.
    for (const refusal of dropped) {
      expect(taskEventSchema.safeParse({ ...eventFixtures["preview.dropped"], refusal }).success, refusal).toBe(true);
    }
    expect(taskEventSchema.safeParse({ ...eventFixtures["preview.dropped"], refusal: "bored" }).success).toBe(false);
  });

  it("F-141: the JSON parts are strict, and input stays within its limits", () => {
    expect(previewFrameHeaderSchema.safeParse({ seq: 1, at: 1, width: 10, height: 10, surprise: 1 }).success).toBe(false);
    const input = { kind: "input", seq: 1, events: [{ kind: "text", text: "x".repeat(runnerLimits.previewInputTextMaxChars + 1) }] };
    expect(previewControlSchema.safeParse(input).success).toBe(false);
    const many = { kind: "input", seq: 1, events: Array.from({ length: runnerLimits.previewInputEventsMax + 1 }, () => ({ kind: "text", text: "a" })) };
    expect(previewControlSchema.safeParse(many).success).toBe(false);
    expect(previewControlSchema.safeParse({ kind: "navigate", seq: 1, path: "https://evil.example/" }).success).toBe(false);
    expect(previewControlSchema.safeParse({ kind: "input", seq: 1, events: [{ kind: "mouse", action: "down", x: 1, y: 1, button: "left", clickCount: 1, modifiers: 16 }] }).success).toBe(false);
  });
});

describe("the app tools (F-121, F-140, F-141)", () => {
  it("F-121: each tool's input round-trips, and the steps are a closed list of six actions", () => {
    expect(startAppInputSchema.parse(roundTrip(appToolInputFixtures.startApp))).toEqual(appToolInputFixtures.startApp);
    expect(showPreviewInputSchema.parse(roundTrip(appToolInputFixtures.showPreview))).toEqual(appToolInputFixtures.showPreview);
    expect(takeScreenshotInputSchema.parse(roundTrip(appToolInputFixtures.takeScreenshot))).toEqual(appToolInputFixtures.takeScreenshot);
    expect(recordAppInputSchema.parse(roundTrip(appToolInputFixtures.recordApp))).toEqual(appToolInputFixtures.recordApp);
    expect(recordStepSchema.options.map((option) => option.shape.action.value)).toEqual(["goto", "click", "fill", "press", "scroll", "wait"]);
    for (const step of recordStepFixtures) {
      expect(recordStepSchema.parse(roundTrip(step))).toEqual(step);
    }
    expect(recordStepSchema.safeParse({ action: "eval", script: "fetch('/')" }).success).toBe(false);
    expect(recordStepSchema.safeParse({ action: "click", target: { selector: "a", text: "b" } }).success).toBe(false);
    expect(takeScreenshotInputSchema.safeParse({ ...appToolInputFixtures.takeScreenshot, size: { width: 800, height: 600 } }).success).toBe(false);
    expect(takeScreenshotInputSchema.safeParse({ ...appToolInputFixtures.takeScreenshot, surprise: 1 }).success).toBe(false);
  });

  it("F-121: record_app refuses a 21st step and a recording past 30 s", () => {
    const steps = Array.from({ length: runnerLimits.recordingStepsMax }, () => ({ action: "press", key: "Tab" }));
    expect(recordAppInputSchema.safeParse({ target: { process: "web" }, steps }).success).toBe(true);
    expect(recordAppInputSchema.safeParse({ target: { process: "web" }, steps: [...steps, { action: "press", key: "Tab" }] }).success).toBe(false);
    expect(recordAppInputSchema.safeParse({ target: { process: "web" }, steps: [] }).success).toBe(false);
    expect(recordAppInputSchema.safeParse({ ...appToolInputFixtures.recordApp, seconds: 31 }).success).toBe(false);
  });

  it("F-141: each tool refuses a reserved port and a port below 1024, with the words for each", () => {
    const calls = (port: number): readonly AppToolCall[] => [
      { tool: "show_preview", input: { port, label: "Mine" } },
      { tool: "take_screenshot", input: { target: { port } } },
      { tool: "record_app", input: { target: { port }, steps: [{ action: "goto", path: "/" }] } },
    ];
    for (const port of Object.values(reservedPortsFixture).filter((value) => value !== null)) {
      for (const call of calls(port)) {
        expect(appToolRefusal(call, noPorts), `${call.tool} ${String(port)}`).toEqual({ code: "port-not-allowed", port, why: "reserved" });
      }
    }
    for (const port of [22, 80, 443, 1023]) {
      for (const call of calls(port)) {
        expect(appToolRefusal(call, noPorts), `${call.tool} ${String(port)}`).toEqual({ code: "port-not-allowed", port, why: "below-min" });
      }
    }
    for (const call of calls(4100)) {
      expect(appToolRefusal(call, noPorts), call.tool).toBeNull();
    }
    expect(portRefusal(1024, reservedPortsFixture)).toBeNull();
    expect(appToolRefusalText({ code: "port-not-allowed", port: 22, why: "below-min" })).toBe("Port 22 isn't allowed: an app's port is 1024 or above.");
    expect(appToolRefusalText({ code: "port-not-allowed", port: 9222, why: "reserved" })).toBe("Port 9222 isn't allowed: it's one of this box's own ports, not the app's.");
  });

  it("F-140: show_preview refuses a second primary and an 11th announced port", () => {
    expect(appToolRefusal({ tool: "show_preview", input: { port: 4100, label: "Docs", primary: true } }, noPorts)).toEqual({ code: "second-primary" });
    // The primary itself may be shown again as the primary.
    expect(appToolRefusal({ tool: "show_preview", input: { port: 5173, label: "Web", primary: true } }, noPorts)).toBeNull();
    const announced = Array.from({ length: runnerLimits.announcedPreviewsMax }, (_, index) => ({ port: 5000 + index, primary: false, source: "announced" as const }));
    const full = { ...noPorts, previews: [...noPorts.previews, ...announced] };
    expect(appToolRefusal({ tool: "show_preview", input: { port: 4100, label: "Docs" } }, full)).toEqual({ code: "limit-reached", limit: "previews" });
    expect(appToolRefusal({ tool: "show_preview", input: { port: 5000, label: "Again" } }, full)).toBeNull();
  });

  it("F-121: the pictures' tools refuse no browser, an unknown process and a 21st picture in a turn", () => {
    const shot: AppToolCall = { tool: "take_screenshot", input: appToolInputFixtures.takeScreenshot };
    expect(appToolRefusal(shot, noPorts)).toBeNull();
    expect(appToolRefusal(shot, { ...noPorts, browser: false })).toEqual({ code: "no-browser" });
    expect(appToolRefusal(shot, { ...noPorts, attachmentsThisTurn: runnerLimits.attachmentsPerTurnMax })).toEqual({ code: "limit-reached", limit: "attachments" });
    expect(appToolRefusal({ tool: "record_app", input: { ...appToolInputFixtures.recordApp, target: { process: "admin" } } }, noPorts)).toEqual({
      code: "unknown-process",
      name: "admin",
    });
    expect(appToolRefusal({ tool: "start_app", input: { names: ["web", "admin"] } }, noPorts)).toEqual({ code: "unknown-process", name: "admin" });
    expect(appToolRefusal({ tool: "start_app", input: {} }, { ...noPorts, processNames: [] })).toEqual({ code: "no-app-processes" });
    expect(appToolRefusal({ tool: "start_app", input: {} }, noPorts)).toBeNull();
  });

  it("F-121: every refusal has its words, and the results name the process, its address and its log", () => {
    const refusals = [
      { code: "no-browser" },
      { code: "limit-reached", limit: "attachments" },
      { code: "limit-reached", limit: "previews" },
      { code: "not-ready", name: "api", logPath: appLogPath("api") },
      { code: "unknown-process", name: "admin" },
      { code: "second-primary" },
      { code: "no-app-processes" },
    ] as const;
    for (const refusal of refusals) {
      expect(appToolRefusalText(refusal).length, refusal.code).toBeGreaterThan(10);
    }
    expect(appToolRefusalText({ code: "not-ready", name: "api", logPath: appLogPath("api") })).toContain(".ostra/app/api.log");
    expect(appToolRefusalText({ code: "no-browser" })).toContain("no browser in this box");
    expect(startAppResultText({ processes: [{ name: "web", label: "Web", state: "ready", address: "http://localhost:5173", logPath: appLogPath("web") }] })).toBe(
      "web (Web): ready at http://localhost:5173; its log is .ostra/app/web.log.",
    );
    expect(attachmentResultText({ attachmentId: ids.attachment, kind: "screenshot", width: 1440, height: 900, durationMs: null, frameCount: null })).toContain(ids.attachment);
    expect(attachmentResultText({ attachmentId: ids.recordingAttachment, kind: "recording", width: 1440, height: 900, durationMs: 4100, frameCount: 41 })).toContain("4.1 s");
    // The descriptions carry the limits and the one-origin convention.
    expect(takeScreenshotDescription).toContain(ONE_ORIGIN_RULE);
    expect(recordAppDescription).toContain(String(runnerLimits.recordingStepsMax));
  });

  it("F-140: propose_environment takes the app processes and a service's preview, with the environment's rules", () => {
    expect(proposeEnvironmentInputSchema.parse(roundTrip(minor7ProposalFixtures.input))).toEqual(minor7ProposalFixtures.input);
    expect(environmentProposalSchema.parse(roundTrip(minor7ProposalFixtures.request))).toEqual(minor7ProposalFixtures.request);
    const [first, second] = minor7ProposalFixtures.input.appProcesses;
    if (first === undefined || second === undefined) {
      throw new Error("the fixture has processes");
    }
    expect(proposeEnvironmentInputSchema.safeParse({ ...minor7ProposalFixtures.input, appProcesses: [first, { ...second, primary: true }] }).success).toBe(false);
    expect(proposeEnvironmentInputSchema.safeParse({ ...minor7ProposalFixtures.input, appProcesses: [first, { ...second, port: 80 }] }).success).toBe(false);
    const mapped = environmentProposalRequestFromTool(minor7ProposalFixtures.input, [{ repoId: ids.repo, fullName: "ostra-test/test1" }]);
    expect(mapped).toEqual({ ok: true, value: minor7ProposalFixtures.request });
    const unknown = environmentProposalRequestFromTool(
      { ...minor7ProposalFixtures.input, appProcesses: [{ ...first, repo: "ostra-test/other" }] },
      [{ repoId: ids.repo, fullName: "ostra-test/test1" }],
    );
    expect(unknown).toEqual({ ok: false, unknownRepo: "ostra-test/other" });
  });

  it("F-121, F-140: a minor-6 core is sent no app process, service preview or finding attachment", () => {
    const proposal = encodeEnvironmentProposalForMinor(minor7ProposalFixtures.request, 6);
    expect("appProcesses" in proposal).toBe(false);
    expect(proposal.services.every((service) => !("preview" in service))).toBe(true);
    expect(encodeEnvironmentProposalForMinor(minor7ProposalFixtures.request, 7)).toBe(minor7ProposalFixtures.request);
    const review = encodeReviewRequestForMinor(minor7ReviewRequestFixture, 6);
    expect(review.findings.every((finding) => !("attachmentIds" in finding))).toBe(true);
    expect(encodeReviewRequestForMinor(minor7ReviewRequestFixture, 7)).toBe(minor7ReviewRequestFixture);
    expect(minor7ReviewRequestFixture.findings[0]?.attachmentIds).toEqual([ids.attachment]);
    // A finding names at most five.
    const finding = minor7ReviewRequestFixture.findings[0];
    expect(findingSchema.safeParse(finding).success).toBe(true);
    const six = Array.from({ length: runnerLimits.findingAttachmentsMax + 1 }, () => ids.attachment);
    expect(findingSchema.safeParse({ ...finding, attachmentIds: six }).success).toBe(false);
  });
});

describe("the frame reel (F-121)", () => {
  it("F-121: a reel round-trips its header, steps and frames", () => {
    const decoded = decodeFrameReel(encodeFrameReel(frameReelFixture));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.reel.header).toEqual({ version: 1, width: 1440, height: 900, frameCount: 3, durationMs: 200, steps: frameReelFixture.steps });
    expect(decoded.reel.frames.map((frame) => frame.atMs)).toEqual([0, 100, 200]);
    expect(decoded.reel.frames.every((frame) => frame.jpeg.length === jpegFixture.length)).toBe(true);
  });

  it("F-121: the player refuses a reel past its limits, out of order, truncated or with trailing bytes", () => {
    const bytes = encodeFrameReel(frameReelFixture);
    expect(decodeFrameReel(bytes.subarray(0, bytes.length - 1))).toEqual({ ok: false, reason: "truncated" });
    expect(decodeFrameReel(new Uint8Array([...bytes, 0]))).toMatchObject({ ok: false });
    expect(decodeFrameReel(new Uint8Array([0x4f, 0x53, 0x52, 0x4d, 0, 0, 0, 0]))).toEqual({ ok: false, reason: "not-a-reel" });
    expect(decodeFrameReel(new Uint8Array(runnerLimits.recordingMaxBytes + 1))).toEqual({ ok: false, reason: "too-large" });
    const late = { ...frameReelFixture, frames: [{ atMs: 100, jpeg: jpegFixture }, { atMs: 50, jpeg: jpegFixture }] };
    expect(decodeFrameReel(encodeFrameReel(late))).toEqual({ ok: false, reason: "out-of-order" });
    const pastEnd = { ...frameReelFixture, frames: [{ atMs: 300, jpeg: jpegFixture }] };
    expect(decodeFrameReel(encodeFrameReel(pastEnd))).toEqual({ ok: false, reason: "out-of-order" });
    const tooMany = { ...frameReelFixture, durationMs: 30_000, frames: Array.from({ length: frameReelMaxFrames + 1 }, () => ({ atMs: 0, jpeg: jpegFixture })) };
    expect(decodeFrameReel(encodeFrameReel(tooMany))).toEqual({ ok: false, reason: "too-many-frames" });
    const notJpeg = { ...frameReelFixture, frames: [{ atMs: 0, jpeg: new Uint8Array([1, 2]) }] };
    expect(decodeFrameReel(encodeFrameReel(notJpeg))).toEqual({ ok: false, reason: "not-jpeg" });
    const steps = Array.from({ length: runnerLimits.recordingStepsMax + 1 }, () => ({ step: { action: "press", key: "Tab" }, atMs: 0 }) as const);
    expect(decodeFrameReel(encodeFrameReel({ ...frameReelFixture, steps }))).toEqual({ ok: false, reason: "bad-header" });
    expect(decodeFrameReel(encodeFrameReel({ ...frameReelFixture, durationMs: 30_001 }))).toEqual({ ok: false, reason: "bad-header" });
  });
});

describe("the CLI's tunnel (F-143)", () => {
  it("F-143: the endpoints, their requests, answers and refusals round-trip, and core's tunnel path takes a ticket alone", () => {
    expect(cliPaths.previewTunnel("OST-12")).toBe("/api/cli/v1/tasks/OST-12/previews/tunnel");
    expect(cliPaths.startApp("OST-12")).toBe("/api/cli/v1/tasks/OST-12/app/start");
    expect(CORE_CLI_TUNNEL_PATH).toBe("/cli/v1/tunnel");
    expect(cliPreviewTunnelRequestSchema.parse(cliPreviewFixtures.tunnelRequest)).toEqual(cliPreviewFixtures.tunnelRequest);
    for (const answer of [cliPreviewFixtures.tunnelGrant, ...cliPreviewFixtures.tunnelRefusals]) {
      expect(cliPreviewTunnelResponseSchema.parse(roundTrip(answer))).toEqual(answer);
    }
    expect(cliStartAppRequestSchema.parse(cliPreviewFixtures.startAppRequest)).toEqual({});
    for (const answer of [cliPreviewFixtures.startAppStarted, ...cliPreviewFixtures.startAppRefusals]) {
      expect(cliStartAppResponseSchema.parse(roundTrip(answer))).toEqual(answer);
    }
    expect(cliTunnelQuerySchema.parse(cliPreviewFixtures.tunnelQuery)).toEqual(cliPreviewFixtures.tunnelQuery);
    expect(cliTunnelQuerySchema.safeParse({ ticket: "ostra_cli_abc" }).success).toBe(false);
    expect(cliTunnelQuerySchema.safeParse({ ...cliPreviewFixtures.tunnelQuery, port: "5173" }).success).toBe(false);
    expect(cliPreviewTunnelResponseSchema.safeParse({ code: "forbidden" }).success).toBe(false);
    expect(cliPreviewTunnelRefusalWords({ code: "port-not-allowed" }, 22)).toBe("port 22 isn't one of this task's previews");
    for (const refusal of cliPreviewFixtures.tunnelRefusals) {
      expect(cliPreviewTunnelRefusalWords(refusal, null).length).toBeGreaterThan(10);
    }
    for (const refusal of cliPreviewFixtures.startAppRefusals) {
      expect(cliStartAppRefusalWords(refusal).length).toBeGreaterThan(10);
    }
  });
});

describe("the fixed words and the blobs", () => {
  it("F-140: the in-box addresses' names and the app's block in the agent's instructions", () => {
    expect(appAddressName("web")).toBe("OSTRA_APP_WEB_URL");
    expect(appAddressName("my-api")).toBe("OSTRA_APP_MY_API_URL");
    expect(appAddressName("mailpit", "service")).toBe("OSTRA_SERVICE_MAILPIT_URL");
    const block = appInstructionsBlock({
      processes: appProcessesFixture.map(({ name, label, port, primary }) => ({ name, label, port, primary })),
      services: [{ name: "mailpit", label: "Mail", address: "http://mailpit:8025" }],
      tools: true,
    });
    expect(block).toContain(`"Web" (web, the primary preview): http://localhost:5173, also in OSTRA_APP_WEB_URL`);
    expect(block).toContain(`"API" (api): http://localhost:3001, also in OSTRA_APP_API_URL`);
    expect(block).toContain(`"Mail" (mailpit): http://mailpit:8025, also in OSTRA_SERVICE_MAILPIT_URL`);
    expect(block).toContain(ONE_ORIGIN_RULE);
    expect(block).toContain("take_screenshot");
    const withoutTools = appInstructionsBlock({ processes: [{ name: "web", label: "Web", port: 5173, primary: true }], services: [], tools: false });
    expect(withoutTools).not.toContain("take_screenshot");
    expect(withoutTools).toContain(ONE_ORIGIN_RULE);
    expect(appInstructionsBlock({ processes: [], services: [], tools: true })).toBe("");
  });

  it("F-121: the pictures' and the log's upload purposes are minor 7's", () => {
    expect(blobUploadPurposeSchema.options).toEqual(["session-archive", "check-output", "app-screenshot", "app-recording", "app-log"]);
    for (const purpose of ["app-screenshot", "app-recording", "app-log"] as const) {
      expect(blobUploadPurposeMinMinor(purpose)).toBe(7);
    }
    expect(blobUploadPurposeMinMinor("check-output")).toBe(2);
  });

  it("each new schema's description says what is never logged", () => {
    expect(takeScreenshotInputSchema.description).toMatch(/never logged/);
    expect(recordAppInputSchema.description).toMatch(/never logged/);
    expect(environmentProposalSchema.description).toMatch(/commands are never logged/);
    expect(cliTunnelQuerySchema.shape.ticket.description).toMatch(/Never logged/);
  });
});
