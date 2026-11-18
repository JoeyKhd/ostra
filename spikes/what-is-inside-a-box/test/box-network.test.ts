import { describe, expect, it } from "vitest";
import { inCidr, isBlockedDestination, isInsideBox, parseAddress } from "../src/sidecar/box-network.ts";

describe("parseAddress", () => {
  it("parses IPv4", () => {
    expect(parseAddress("10.0.0.1")?.family).toBe(4);
    expect(parseAddress("256.0.0.1")).toBeUndefined();
  });
  it("treats an IPv4-mapped IPv6 address as IPv4", () => {
    const mapped = parseAddress("::ffff:169.254.169.254");
    const direct = parseAddress("169.254.169.254");
    expect(mapped?.family).toBe(4);
    expect(mapped?.value).toBe(direct?.value);
  });
  it("parses compressed IPv6", () => {
    expect(parseAddress("fe80::1")?.family).toBe(6);
    expect(parseAddress("::1")?.family).toBe(6);
  });
});

describe("inCidr", () => {
  it("matches within the prefix", () => {
    expect(inCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(inCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
    expect(inCidr("172.20.0.5", "172.16.0.0/12")).toBe(true);
    expect(inCidr("172.32.0.5", "172.16.0.0/12")).toBe(false);
  });
  it("never crosses families", () => {
    expect(inCidr("::1", "10.0.0.0/8")).toBe(false);
  });
});

describe("isBlockedDestination (the egress baseline ranges)", () => {
  it("blocks the metadata address, private ranges and loopback", () => {
    for (const address of ["169.254.169.254", "10.0.0.1", "172.16.5.5", "192.168.1.1", "127.0.0.1", "100.64.0.1"]) {
      expect(isBlockedDestination(address)).toBe(true);
    }
  });
  it("blocks IPv6 ULA, link-local and loopback", () => {
    for (const address of ["fc00::1", "fe80::1", "::1"]) expect(isBlockedDestination(address)).toBe(true);
  });
  it("allows ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) expect(isBlockedDestination(address)).toBe(false);
  });
  it("blocks the metadata address even when IPv4-mapped (an SSRF dodge)", () => {
    expect(isBlockedDestination("::ffff:169.254.169.254")).toBe(true);
  });
});

describe("isInsideBox", () => {
  it("Docker: anything in the box CIDR is inside", () => {
    const network = { boxCidrs: ["10.89.0.0/24"], sharedNetns: false };
    expect(isInsideBox("10.89.0.7", network)).toBe(true);
    expect(isInsideBox("203.0.113.9", network)).toBe(false);
  });
  it("Kubernetes: loopback is inside when the pod shares a netns", () => {
    expect(isInsideBox("127.0.0.1", { boxCidrs: [], sharedNetns: true })).toBe(true);
    expect(isInsideBox("127.0.0.1", { boxCidrs: [], sharedNetns: false })).toBe(false);
  });
});
