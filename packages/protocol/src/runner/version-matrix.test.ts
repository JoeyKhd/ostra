import { describe, expect, it } from "vitest";

import { minor4CommandFixtures } from "../testing/fixtures.ts";
import { readRecordedBuild, RECORDED_SERVER_MINOR, recordedMinors } from "../testing/recorded.ts";
import type { Command } from "./commands.ts";
import { downFrameCodec, helloSchema, parseDownFrame, parseUpFrame } from "./messages.ts";
import { minorWindow, negotiate, PROTOCOL_MINOR, versionRefusalMessage } from "./version.ts";

// F-061 (ticket 16): the compatibility matrix over recorded frames. A server at minor 4 read the
// recorded builds of minors 3, 4 and 5 and wrote to each in its own minor; it refused 2 and 6 with
// the fix. Milestone 6 (ticket 01) moved the build to minor 5: it reads 4, 5 and 6, writes to the
// minor-4 build exactly what that build recorded reading, and refuses 2, 3 and 7. The carriers'
// half, against core's gateway, is `apps/core/src/gateway/version-matrix.test.ts`.

const outcomesAt = async (serverMinor: number): Promise<readonly (readonly [number, number | "refused"])[]> => {
  const builds = await Promise.all(recordedMinors.map((minor) => readRecordedBuild(minor)));
  return recordedMinors.map((minor, index) => {
    const build = builds[index];
    if (build === undefined) {
      throw new Error(`no recording of minor ${String(minor)}`);
    }
    const hello = helloSchema.parse(build.hello);
    expect(hello.protocolMinor).toBe(minor);
    const negotiation = negotiate(serverMinor, hello.protocolMajor, hello.protocolMinor);
    if (serverMinor === RECORDED_SERVER_MINOR) {
      expect(negotiation.ok ? negotiation.minor : null).toBe(build.negotiated ?? null);
    }
    return [minor, negotiation.ok ? negotiation.minor : "refused"] as const;
  });
};

describe("the compatibility matrix (F-061)", () => {
  it("F-061: the matrix: a server at minor 4 accepts the recorded builds of minors 3, 4 and 5 and refuses 2 and 6", async () => {
    expect(RECORDED_SERVER_MINOR).toBe(4);
    expect(await outcomesAt(RECORDED_SERVER_MINOR)).toEqual([
      [2, "refused"],
      [3, 3],
      [4, 4],
      [5, 4],
      [6, "refused"],
      [7, "refused"],
    ]);
    // The window is one minor either way, and no wider.
    expect(minorWindow(RECORDED_SERVER_MINOR)).toEqual({ min: 3, max: 5 });
  });

  it("F-061: the matrix at minor 5: today's server accepts the recorded builds of minors 4, 5 and 6 and refuses 2, 3 and 7", async () => {
    expect(PROTOCOL_MINOR).toBe(5);
    expect(await outcomesAt(PROTOCOL_MINOR)).toEqual([
      [2, "refused"],
      [3, "refused"],
      [4, 4],
      [5, 5],
      [6, 5],
      [7, "refused"],
    ]);
    expect(minorWindow(PROTOCOL_MINOR)).toEqual({ min: 4, max: 6 });
  });

  it("F-061: each accepted build's frames are read at its minor, and the server writes down to exactly what that build reads", async () => {
    for (const minor of [3, 4, 5] as const) {
      const build = await readRecordedBuild(minor);
      const negotiated = build.negotiated ?? -1;
      // What the build sends after hello, the server reads at the negotiated minor.
      const status = parseUpFrame(JSON.stringify(build.status), negotiated);
      expect(status.ok, `minor ${String(minor)}'s status`).toBe(true);
      // Today's dispatch, with a size and an image, encoded down for this build, is what it recorded
      // reading, and parses at its minor: a minor-3 build never sees `box`.
      const written = downFrameCodec.encodeValue(minor4CommandFixtures["dispatch, with a size and an image"], negotiated);
      expect(written).toEqual(build.dispatch);
      expect(parseDownFrame(JSON.stringify(build.dispatch), negotiated).ok).toBe(true);
      expect(JSON.stringify(written).includes('"box"')).toBe(negotiated >= 4);
    }
    // A minor-3 build can't read minor 4's dispatch: the strict codec refuses `box`, which is why the server encodes down.
    const minor3 = await readRecordedBuild(3);
    expect(parseDownFrame(JSON.stringify((await readRecordedBuild(4)).dispatch), minor3.negotiated ?? -1).ok).toBe(false);
  });

  it("F-061: today's server writes to the minor-4 build exactly what it recorded reading, even for an automatic round's dispatch", async () => {
    const minor4 = await readRecordedBuild(4);
    const fixture = minor4CommandFixtures["dispatch, with a size and an image"];
    const automatic: Command = { ...fixture, body: { ...fixture.body, automatic: true } };
    expect(negotiate(PROTOCOL_MINOR, 1, minor4.minor)).toEqual({ ok: true, minor: 4 });
    expect(downFrameCodec.encodeValue(automatic, 4)).toEqual(minor4.dispatch);
    // Sent as it is, minor 4's strict codec refuses the new field: why the server encodes down.
    expect(parseDownFrame(JSON.stringify(automatic), 4).ok).toBe(false);
    expect(parseDownFrame(JSON.stringify(automatic), 5).ok).toBe(true);
    // The minor-4 build's own frames read at 4, as recorded.
    expect(parseUpFrame(JSON.stringify(minor4.status), 4).ok).toBe(true);
  });

  it("F-061: the refusal's words name the runner's minor, the window and the version to install", async () => {
    const build = await readRecordedBuild(2);
    const hello = helloSchema.parse(build.hello);
    const negotiation = negotiate(RECORDED_SERVER_MINOR, hello.protocolMajor, hello.protocolMinor);
    expect(negotiation).toEqual({ ok: false, reason: "minor", window: { min: 3, max: 5 } });
    const words = versionRefusalMessage({ peerMajor: hello.protocolMajor, peerMinor: hello.protocolMinor, window: minorWindow(RECORDED_SERVER_MINOR), serverVersion: "0.5.0" });
    expect(words).toBe(
      "This runner speaks protocol 1.2; this server accepts 1.3 to 1.5. Update it to v0.5.0. " +
        "Fix: install the runner version this server names (GET /runner/v1/info), then start the runner again.",
    );
    const minor3 = helloSchema.parse((await readRecordedBuild(3)).hello);
    expect(negotiate(PROTOCOL_MINOR, minor3.protocolMajor, minor3.protocolMinor)).toEqual({ ok: false, reason: "minor", window: { min: 4, max: 6 } });
  });
});
