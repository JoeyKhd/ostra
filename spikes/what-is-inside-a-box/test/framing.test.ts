import { describe, expect, it } from "vitest";
import { createLineSplitter, encodeFrame, parseFrame, toBase64Chunks } from "../src/bridge/framing.ts";
import { initFrameSchema, sidecarFrameSchema } from "../src/bridge/protocol.ts";

describe("createLineSplitter", () => {
  it("reassembles frames split across chunks", () => {
    const splitter = createLineSplitter();
    expect(splitter.push(Buffer.from('{"a":'))).toEqual([]);
    expect(splitter.push(Buffer.from('1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });
  it("throws on an oversized unterminated line", () => {
    const splitter = createLineSplitter(16);
    expect(() => splitter.push(Buffer.from("x".repeat(17)))).toThrow(/longer than/);
  });
});

describe("parseFrame", () => {
  it("accepts a valid frame and rejects a malformed one", () => {
    const frame = { t: "welcome", version: 1 };
    const ok = parseFrame(sidecarFrameSchema, encodeFrame(frame).trimEnd());
    expect(ok.ok).toBe(true);
    const bad = parseFrame(sidecarFrameSchema, '{"t":"welcome"}');
    expect(bad.ok).toBe(false);
  });
  it("rejects a spawn frame with a non-absolute cwd", () => {
    const frame = { t: "spawn", reqId: 1, procId: 1, command: "opencode", args: ["acp"], cwd: "relative", env: {} };
    expect(parseFrame(sidecarFrameSchema, JSON.stringify(frame)).ok).toBe(false);
  });
  it("rejects an env var with an illegal name", () => {
    const frame = { t: "spawn", reqId: 1, procId: 1, command: "opencode", args: [], cwd: "/task", env: { "bad-name": "x" } };
    expect(parseFrame(sidecarFrameSchema, JSON.stringify(frame)).ok).toBe(false);
  });
  it("accepts a hello with a platform", () => {
    const frame = { t: "hello", version: 1, boxId: "box-abc", nonce: "n".repeat(32), initPid: 2, agentUid: 1000, platform: "linux" };
    expect(parseFrame(initFrameSchema, JSON.stringify(frame)).ok).toBe(true);
  });
});

describe("toBase64Chunks", () => {
  it("splits by source byte size and round-trips", () => {
    const data = Buffer.from("0123456789");
    const chunks = toBase64Chunks(data, 4);
    expect(chunks).toHaveLength(3);
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c, "base64"))).toString()).toBe("0123456789");
  });
});
