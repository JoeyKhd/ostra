import { describe, expect, it } from "vitest";

import { minor4CommandFixtures } from "../testing/fixtures.ts";
import { readRecordedBuild, RECORDED_SERVER_MINOR, recordedMinors } from "../testing/recorded.ts";
import { downFrameCodec, helloSchema, parseDownFrame, parseUpFrame } from "./messages.ts";
import { minorWindow, negotiate, PROTOCOL_MINOR, versionRefusalMessage } from "./version.ts";

// F-061 (ticket 16): the compatibility matrix over recorded frames. A server at minor 4 reads the
// recorded builds of minors 3, 4 and 5 and writes to each in its own minor; it refuses 2 and 6 with
// the fix. The carriers' half, against core's gateway, is `apps/core/src/gateway/version-matrix.test.ts`.

describe("the compatibility matrix (F-061)", () => {
  it("F-061: the matrix: a server at minor 4 accepts the recorded builds of minors 3, 4 and 5 and refuses 2 and 6", async () => {
    expect(PROTOCOL_MINOR).toBe(RECORDED_SERVER_MINOR);
    const builds = await Promise.all(recordedMinors.map((minor) => readRecordedBuild(minor)));
    const outcomes = recordedMinors.map((minor, index) => {
      const build = builds[index];
      if (build === undefined) {
        throw new Error(`no recording of minor ${String(minor)}`);
      }
      const hello = helloSchema.parse(build.hello);
      expect(hello.protocolMinor).toBe(minor);
      const negotiation = negotiate(RECORDED_SERVER_MINOR, hello.protocolMajor, hello.protocolMinor);
      expect(negotiation.ok ? negotiation.minor : null).toBe(build.negotiated ?? null);
      return [minor, negotiation.ok ? negotiation.minor : "refused"] as const;
    });
    expect(outcomes).toEqual([
      [2, "refused"],
      [3, 3],
      [4, 4],
      [5, 4],
      [6, "refused"],
    ]);
    // The window is one minor either way, and no wider.
    expect(minorWindow(RECORDED_SERVER_MINOR)).toEqual({ min: 3, max: 5 });
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
  });
});
