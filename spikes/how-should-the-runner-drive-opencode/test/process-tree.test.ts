import { describe, expect, it } from "vitest";
import { parsePsSampleLine, sameProcess } from "../src/lib/process-tree.ts";

describe("parsePsSampleLine", () => {
  it("reads Linux cputime, [[DD-]HH:]MM:SS", () => {
    expect(parsePsSampleLine("  123  4567 01:02:03")).toEqual({ pid: 123, rssBytes: 4567 * 1024, cpuMs: 3_723_000 });
    expect(parsePsSampleLine("123 10 1-00:00:01")).toEqual({ pid: 123, rssBytes: 10 * 1024, cpuMs: 86_401_000 });
  });

  it("reads macOS cputime, M:SS.cc", () => {
    expect(parsePsSampleLine("  42  2048   0:01.25")).toEqual({ pid: 42, rssBytes: 2048 * 1024, cpuMs: 1250 });
    expect(parsePsSampleLine("42 2048 12:03.50")).toEqual({ pid: 42, rssBytes: 2048 * 1024, cpuMs: 723_500 });
  });

  it("ignores lines that are not samples", () => {
    expect(parsePsSampleLine("")).toBeUndefined();
    expect(parsePsSampleLine("PID RSS TIME")).toBeUndefined();
  });
});

describe("sameProcess", () => {
  it("needs PID, name and creation time to match", () => {
    const a = { pid: 10, name: "node.exe", startedAt: 1000 };
    expect(sameProcess(a, { ...a })).toBe(true);
    expect(sameProcess(a, { ...a, startedAt: 2000 })).toBe(false);
    expect(sameProcess(a, { ...a, name: "other.exe" })).toBe(false);
  });

  it("never matches without a creation time", () => {
    const a = { pid: 10, name: "node.exe", startedAt: 0 };
    expect(sameProcess(a, { ...a })).toBe(false);
  });
});
