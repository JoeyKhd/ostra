import { describe, expect, it } from "vitest";

import { minor4CommandFixtures } from "../testing/fixtures.ts";
import { readRecordedBuild, RECORDED_SERVER_MINOR, recordedMinors } from "../testing/recorded.ts";
import type { Command } from "./commands.ts";
import { downFrameCodec, helloSchema, parseDownFrame, parseUpFrame } from "./messages.ts";
import { minorWindow, negotiate, PROTOCOL_MINOR, versionRefusalMessage } from "./version.ts";

// F-061 (ticket 16): the compatibility matrix over recorded frames. A server at minor 4 read the
// recorded builds of minors 3, 4 and 5 and wrote to each in its own minor; it refused 2 and 6 with
// the fix. Milestone 6 (ticket 01) moved the build to minor 5: it read 4, 5 and 6, wrote to the
// minor-4 build exactly what that build recorded reading, and refused 2, 3 and 7. Milestone 7
// (F-138) moved it to minor 6: it read 5, 6 and 7, and refused 2, 3, 4 and 8. Milestone 8 moved
// it to minor 7: it read 6, 7 and 8, and refused 2 to 5 and 9. Milestone 9 moved it to minor 8: it
// read 7, 8 and 9, and refused 2 to 6 and 10. Milestone 10 moved it to minor 9: it reads 8, 9 and
// 10, and refuses 2 to 7 and 11. Post-v1 (F-052) moved it to minor 10: it reads 9, 10 and 11, and
// refuses 2 to 8. The carriers' half, against core's gateway, is
// `apps/core/src/gateway/version-matrix.test.ts`.

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
  it("F-061/c1: the matrix: a server at minor 4 accepts the recorded builds of minors 3, 4 and 5 and refuses 2 and 6", async () => {
    expect(RECORDED_SERVER_MINOR).toBe(4);
    expect(await outcomesAt(RECORDED_SERVER_MINOR)).toEqual([
      [2, "refused"],
      [3, 3],
      [4, 4],
      [5, 4],
      [6, "refused"],
      [7, "refused"],
      [8, "refused"],
      [9, "refused"],
      [10, "refused"],
      [11, "refused"],
    ]);
    // The window is one minor either way, and no wider.
    expect(minorWindow(RECORDED_SERVER_MINOR)).toEqual({ min: 3, max: 5 });
  });

  it("F-061: the matrix at minor 5: a minor-5 server accepted the recorded builds of minors 4, 5 and 6 and refused 2, 3, 7 and 8", async () => {
    expect(await outcomesAt(5)).toEqual([
      [2, "refused"],
      [3, "refused"],
      [4, 4],
      [5, 5],
      [6, 5],
      [7, "refused"],
      [8, "refused"],
      [9, "refused"],
      [10, "refused"],
      [11, "refused"],
    ]);
    expect(minorWindow(5)).toEqual({ min: 4, max: 6 });
  });

  it("F-061, F-138: the matrix at minor 6: a minor-6 server accepted the recorded builds of minors 5, 6 and 7 and refused 2, 3, 4, 8 and 9", async () => {
    expect(await outcomesAt(6)).toEqual([
      [2, "refused"],
      [3, "refused"],
      [4, "refused"],
      [5, 5],
      [6, 6],
      [7, 6],
      [8, "refused"],
      [9, "refused"],
      [10, "refused"],
      [11, "refused"],
    ]);
    expect(minorWindow(6)).toEqual({ min: 5, max: 7 });
  });

  it("F-061: the matrix at minor 7: a minor-7 server accepted the recorded builds of minors 6, 7 and 8 and refused 2 to 5, 9 and 10", async () => {
    expect(await outcomesAt(7)).toEqual([
      [2, "refused"],
      [3, "refused"],
      [4, "refused"],
      [5, "refused"],
      [6, 6],
      [7, 7],
      [8, 7],
      [9, "refused"],
      [10, "refused"],
      [11, "refused"],
    ]);
    expect(minorWindow(7)).toEqual({ min: 6, max: 8 });
  });

  it("F-061: the matrix at minor 8: a minor-8 server accepted the recorded builds of minors 7, 8 and 9 and refused 2 to 6, 10 and 11", async () => {
    expect(await outcomesAt(8)).toEqual([
      [2, "refused"],
      [3, "refused"],
      [4, "refused"],
      [5, "refused"],
      [6, "refused"],
      [7, 7],
      [8, 8],
      [9, 8],
      [10, "refused"],
      [11, "refused"],
    ]);
    expect(minorWindow(8)).toEqual({ min: 7, max: 9 });
  });

  it("F-061, F-052: the matrix at minor 10: today's server accepts the recorded builds of minors 9, 10 and 11 and refuses 2 to 8", async () => {
    expect(PROTOCOL_MINOR).toBe(10);
    expect(await outcomesAt(PROTOCOL_MINOR)).toEqual([
      [2, "refused"],
      [3, "refused"],
      [4, "refused"],
      [5, "refused"],
      [6, "refused"],
      [7, "refused"],
      [8, "refused"],
      [9, 9],
      [10, 10],
      [11, 10],
    ]);
    expect(minorWindow(PROTOCOL_MINOR)).toEqual({ min: 9, max: 11 });
  });

  it("F-061/c1: each accepted build's frames are read at its minor, and the server writes down to exactly what that build reads", async () => {
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

  it("F-061: a minor-5 server writes to the minor-4 build exactly what it recorded reading, even for an automatic round's dispatch", async () => {
    const minor4 = await readRecordedBuild(4);
    const fixture = minor4CommandFixtures["dispatch, with a size and an image"];
    const automatic: Command = { ...fixture, body: { ...fixture.body, automatic: true } };
    expect(negotiate(5, 1, minor4.minor)).toEqual({ ok: true, minor: 4 });
    expect(downFrameCodec.encodeValue(automatic, 4)).toEqual(minor4.dispatch);
    // Sent as it is, minor 4's strict codec refuses the new field: why the server encodes down.
    expect(parseDownFrame(JSON.stringify(automatic), 4).ok).toBe(false);
    expect(parseDownFrame(JSON.stringify(automatic), 5).ok).toBe(true);
    // The minor-4 build's own frames read at 4, as recorded.
    expect(parseUpFrame(JSON.stringify(minor4.status), 4).ok).toBe(true);
  });

  it("F-061/c1: the refusal's words name the runner's minor, the window and the version to install", async () => {
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
    expect(negotiate(5, minor3.protocolMajor, minor3.protocolMinor)).toEqual({ ok: false, reason: "minor", window: { min: 4, max: 6 } });
    // A minor-6 server refused the minor-4 build with the window 5 to 7, a minor-7 server the minor-5
    // build with 6 to 8, a minor-8 server the minor-6 build with 7 to 9, a minor-9 server the minor-7
    // build with 8 to 10, and today's minor-10 server refuses it with 9 to 11.
    const minor4 = helloSchema.parse((await readRecordedBuild(4)).hello);
    expect(negotiate(6, minor4.protocolMajor, minor4.protocolMinor)).toEqual({ ok: false, reason: "minor", window: { min: 5, max: 7 } });
    const minor5 = helloSchema.parse((await readRecordedBuild(5)).hello);
    expect(negotiate(7, minor5.protocolMajor, minor5.protocolMinor)).toEqual({ ok: false, reason: "minor", window: { min: 6, max: 8 } });
    const minor6 = helloSchema.parse((await readRecordedBuild(6)).hello);
    expect(negotiate(8, minor6.protocolMajor, minor6.protocolMinor)).toEqual({ ok: false, reason: "minor", window: { min: 7, max: 9 } });
    const minor7 = helloSchema.parse((await readRecordedBuild(7)).hello);
    expect(negotiate(PROTOCOL_MINOR, minor7.protocolMajor, minor7.protocolMinor)).toEqual({ ok: false, reason: "minor", window: { min: 9, max: 11 } });
  });
});
