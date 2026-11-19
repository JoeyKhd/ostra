import { describe, expect, it } from "vitest";

import {
  eventKindSupportedAt,
  encodeEventForMinor,
  serverOnlyKinds,
  taskEventSchema,
  taskEventSchemaV2,
} from "../events/agent-events.ts";
import {
  commandKindSupportedAt,
  commandSchema,
  commandSchemaV2,
  encodeCommandForMinor,
  setEffortBodySchema,
} from "../runner/commands.ts";
import { downFrameCodec, encodeUpFrame, parseUpFrame } from "../runner/messages.ts";
import type { UpFrame } from "../runner/messages.ts";
import {
  encodeTaskSpecForMinor,
  taskSpecNeedsMinor3,
  taskSpecResponseSchemaFor,
  taskSpecSchema,
  taskSpecSchemaV2,
} from "../task/spec.ts";
import {
  commandFixtures,
  eventFixtures,
  fixtureIds as ids,
  minor3FieldFixtures,
  reasoningControlsFixtures,
  taskSpecEffortFixture,
  taskSpecMinor2Fixture,
} from "../testing/fixtures.ts";
import { clampEffort, EFFORT_SCALE, effortLevelSchema, effortLevels, reasoningControlsSchema } from "./effort.ts";
import type { EffortLevel } from "./effort.ts";

// Reasoning effort's contracts (F-137, ADR 0066, ticket 56): the level vocabulary, the model's
// controls, what minor 3 adds to the spec, the commands and the events, and the clamp.

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("the levels and the controls", () => {
  it("F-137: the level is a closed union in the panel's order, and the scale is models.dev's", () => {
    expect(effortLevels).toEqual(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "on"]);
    expect(EFFORT_SCALE).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const unknown of ["extra-high", "thinking", "HIGH", "", 3, null]) {
      expect(effortLevelSchema.safeParse(unknown).success).toBe(false);
    }
  });

  it("F-137: the controls parse in models.dev's v2 shape", () => {
    for (const controls of Object.values(reasoningControlsFixtures)) {
      expect(reasoningControlsSchema.parse(roundTrip(controls))).toEqual(controls);
    }
  });

  it("F-137: the controls refuse an unknown field, an unknown level, an empty list and a list holding default", () => {
    const refused: readonly unknown[] = [
      { supported: false, toggle: true },
      { supported: true, effort: ["low"], surprise: 1 },
      { supported: true, budget: { min: 1_024, step: 2 } },
      { supported: true, effort: ["low", "thinking"] },
      { supported: true, effort: [] },
      { supported: true, effort: ["default", "low"] },
      { supported: true, effort: ["on"] },
      { supported: true, effort: ["low", "low"] },
      { supported: true, budget: { min: 0 } },
      { supported: "yes" },
      {},
    ];
    for (const value of refused) {
      expect(reasoningControlsSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("minor 3's spec, command and events", () => {
  it("F-137: the spec carries the level, the controls and the limits, and refuses unknown fields and levels", () => {
    expect(taskSpecSchema.parse(roundTrip(taskSpecEffortFixture))).toEqual(taskSpecEffortFixture);
    const agent = taskSpecEffortFixture.agent;
    const refused: readonly unknown[] = [
      { ...taskSpecEffortFixture, agent: { ...agent, effort: "turbo" } },
      { ...taskSpecEffortFixture, agent: { ...agent, limits: { contextWindow: 1, maxOutputTokens: 1, extra: 1 } } },
      { ...taskSpecEffortFixture, agent: { ...agent, limits: { contextWindow: 0, maxOutputTokens: null } } },
      { ...taskSpecEffortFixture, agent: { ...agent, reasoning: { supported: true, effort: ["default"] } } },
      { ...taskSpecEffortFixture, agent: { ...agent, reasoning: { supported: true, levels: ["low"] } } },
    ];
    for (const value of refused) {
      expect(taskSpecSchema.safeParse(value).success).toBe(false);
    }
    // Unknown limits are `null`.
    const unknownLimits = { ...taskSpecEffortFixture, agent: { ...agent, limits: { contextWindow: null, maxOutputTokens: null } } };
    expect(taskSpecSchema.parse(unknownLimits)).toEqual(unknownLimits);
  });

  it("F-137: a minor-2 encoding of the spec drops the level, the controls and the limits", () => {
    const minor2 = encodeTaskSpecForMinor(taskSpecEffortFixture, 2);
    expect(minor2.agent).not.toHaveProperty("effort");
    expect(minor2.agent).not.toHaveProperty("reasoning");
    expect(minor2.agent).not.toHaveProperty("limits");
    expect(minor2).toEqual(taskSpecMinor2Fixture);
    expect(taskSpecSchemaV2.parse(minor2)).toEqual(minor2);
    expect(taskSpecResponseSchemaFor(2).safeParse(taskSpecEffortFixture).success).toBe(false);
    expect(encodeTaskSpecForMinor(taskSpecEffortFixture, 3)).toEqual(taskSpecEffortFixture);
  });

  it("F-137: a level other than default needs a minor-3 runner; default, the controls and the limits don't", () => {
    expect(taskSpecNeedsMinor3(taskSpecEffortFixture)).toBe(true);
    const atDefault = { ...taskSpecEffortFixture, agent: { ...taskSpecEffortFixture.agent, effort: "default" as const } };
    expect(taskSpecNeedsMinor3(atDefault)).toBe(false);
    expect(taskSpecNeedsMinor3(taskSpecMinor2Fixture)).toBe(false);
  });

  it("F-137: set-effort is minor 3's, refuses unknown fields and levels, and is never encoded for a minor-2 peer", () => {
    const command = commandFixtures["set-effort"];
    expect(commandSchema.parse(roundTrip(command))).toEqual(command);
    expect(commandKindSupportedAt("set-effort", 3)).toBe(true);
    expect(commandKindSupportedAt("set-effort", 2)).toBe(false);
    expect(commandSchemaV2.safeParse(command).success).toBe(false);
    // The minor-2 codec has no shape for it: a minor-2 peer refuses the frame.
    expect(downFrameCodec.parse(downFrameCodec.encode(command, 3), 3)).toEqual({ ok: true, frame: command });
    expect(downFrameCodec.parse(JSON.stringify(encodeCommandForMinor(command, 2)), 2)).toMatchObject({ ok: false });
    expect(setEffortBodySchema.safeParse({ ...command.body, extra: 1 }).success).toBe(false);
    expect(setEffortBodySchema.safeParse({ ...command.body, level: "turbo" }).success).toBe(false);
    expect(setEffortBodySchema.safeParse({ sessionId: ids.session, level: "high" }).success).toBe(false);
  });

  it("F-137: turn.started and usage.recorded carry the level and the reasoning tokens at minor 3", () => {
    for (const event of Object.values(minor3FieldFixtures)) {
      expect(taskEventSchema.parse(roundTrip(event))).toEqual(event);
      expect(taskEventSchemaV2.safeParse(event).success).toBe(false);
      expect(taskEventSchema.safeParse({ ...event, surprise: 1 }).success).toBe(false);
    }
    expect(taskEventSchema.safeParse({ ...minor3FieldFixtures["turn.started"], effort: "turbo" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...minor3FieldFixtures["usage.recorded"], reasoningTokens: -1 }).success).toBe(false);
  });

  it("F-137: a minor-2 encoding of turn.started and usage.recorded drops the new fields", () => {
    const turn = encodeEventForMinor(minor3FieldFixtures["turn.started"], 2);
    expect(turn).toEqual({ kind: "turn.started", turnId: ids.turn, mode: "build" });
    const usage = encodeEventForMinor(minor3FieldFixtures["usage.recorded"], 2);
    expect(usage).not.toHaveProperty("reasoningTokens");
    expect(taskEventSchemaV2.parse(usage)).toEqual(usage);
    // Through the frame codec, as a minor-3 runner sends to a minor-2 server.
    const frame: UpFrame = {
      type: "events",
      events: [{ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: minor3FieldFixtures["turn.started"] }],
    };
    const parsed = parseUpFrame(encodeUpFrame(frame, 2), 2);
    expect(parsed).toEqual({ ok: true, frame: { ...frame, events: [{ ...frame.events[0], event: turn }] } });
    // Below minor 2, minor 2's `mode` goes too.
    expect(encodeEventForMinor(minor3FieldFixtures["turn.started"], 1)).toEqual({ kind: "turn.started", turnId: ids.turn });
  });

  it("F-137: effort.changed is server-only and minor 3's, and refuses an unknown field or level", () => {
    const event = eventFixtures["effort.changed"];
    expect(serverOnlyKinds.has("effort.changed")).toBe(true);
    expect(eventKindSupportedAt("effort.changed", 2)).toBe(false);
    expect(taskEventSchema.safeParse({ ...event, surprise: 1 }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...event, to: "turbo" }).success).toBe(false);
  });
});

// The clamp (ADR 0066, "A level the model doesn't have"). Each row is the level each requested
// level runs at, in the order of `effortLevels`: default, none, minimal, low, medium, high, xhigh,
// max, on. `offered` is what the agent can send for the model, `default` first.
const columns = effortLevels;

const clampTable: readonly { readonly name: string; readonly offered: readonly EffortLevel[]; readonly expected: string }[] = [
  { name: "no levels", offered: ["default"], expected: "default default default default default default default default default" },
  { name: "nothing at all", offered: [], expected: "default default default default default default default default default" },
  { name: "a toggle", offered: ["default", "none", "on"], expected: "default none on on on on on on on" },
  { name: "a toggle that can't switch off", offered: ["default", "on"], expected: "default default on on on on on on on" },
  { name: "a budget (high, max)", offered: ["default", "high", "max"], expected: "default high high high high high max max default" },
  { name: "a toggle and effort levels", offered: ["default", "none", "low", "high", "on"], expected: "default none low low high high high high on" },
];

// The fifteen most common effort sets of models.dev's live v1 catalog, among the models that
// reason and call tools (research `opencode-reasoning-effort.md`, section 2.2; recounted from
// https://models.dev/api.json on 2026-11-19, with each set's model count).
const commonSets: readonly { readonly set: readonly EffortLevel[]; readonly models: number; readonly expected: string }[] = [
  { set: ["low", "medium", "high", "xhigh", "max"], models: 832, expected: "default low low low medium high xhigh max default" },
  { set: ["low", "medium", "high"], models: 795, expected: "default low low low medium high high high default" },
  { set: ["low", "high", "max"], models: 608, expected: "default low low low high high max max default" },
  { set: ["none", "low", "medium", "high", "xhigh", "max"], models: 388, expected: "default none low low medium high xhigh max default" },
  { set: ["minimal", "low", "medium", "high"], models: 268, expected: "default minimal minimal low medium high high high default" },
  { set: ["none", "low", "high", "max"], models: 249, expected: "default none low low high high max max default" },
  { set: ["none", "low", "medium", "high", "max"], models: 241, expected: "default none low low medium high max max default" },
  { set: ["none", "high"], models: 235, expected: "default none none high high high high high default" },
  { set: ["none", "low", "medium", "high", "xhigh"], models: 232, expected: "default none low low medium high xhigh xhigh default" },
  { set: ["none", "low", "medium", "high"], models: 219, expected: "default none low low medium high high high default" },
  { set: ["low", "medium", "high", "xhigh"], models: 218, expected: "default low low low medium high xhigh xhigh default" },
  { set: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], models: 210, expected: "default none minimal low medium high xhigh max default" },
  { set: ["low", "medium", "xhigh"], models: 99, expected: "default low low low medium xhigh xhigh xhigh default" },
  { set: ["high", "max"], models: 96, expected: "default high high high high high max max default" },
  { set: ["low", "medium", "high", "max"], models: 91, expected: "default low low low medium high max max default" },
];

const rows = [
  ...clampTable,
  ...commonSets.map(({ set, models, expected }) => ({ name: `${set.join(", ")} (${String(models)} models)`, offered: ["default", ...set] as const, expected })),
].flatMap(({ name, offered, expected }) => {
  const levels = expected.split(" ");
  return columns.map((requested, index) => ({ name, offered, requested, level: levels[index] }));
});

describe("the clamp", () => {
  it("F-137: the table covers fifteen common sets and every level", () => {
    expect(commonSets).toHaveLength(15);
    expect(rows).toHaveLength((clampTable.length + commonSets.length) * columns.length);
  });

  it.each(rows)("F-137: $name: $requested runs at $level", ({ offered, requested, level }) => {
    expect(clampEffort(requested, offered)).toEqual({ level, adjusted: level !== requested });
  });

  it("F-137: never returns a level the model doesn't offer, other than default", () => {
    for (const { offered, requested } of rows) {
      const { level } = clampEffort(requested, offered);
      expect(level === "default" || offered.includes(level)).toBe(true);
    }
  });
});
