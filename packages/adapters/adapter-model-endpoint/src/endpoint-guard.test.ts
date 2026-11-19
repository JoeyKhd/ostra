import { describe, expect, it } from "vitest";

import { assertPublicEndpoint, isPrivateAddress } from "./endpoint-guard.ts";
import type { Resolver } from "./endpoint-guard.ts";

const refused = [
  "127.0.0.1",
  "127.255.255.254",
  "0.0.0.0",
  "0.1.2.3",
  "169.254.169.254",
  "10.0.0.1",
  "10.255.255.255",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "100.64.0.1",
  "100.127.255.255",
  "198.18.0.1",
  "224.0.0.1",
  "255.255.255.255",
  "192.0.0.8",
  "::1",
  "::",
  "fe80::1",
  "febf::1",
  "fc00::1",
  "fd12:3456::1",
  "fec0::1",
  "ff02::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:169.254.169.254",
  "::ffff:a9fe:a9fe",
  "::ffff:10.0.0.1",
  "::ffff:192.168.0.1",
  "::ffff:100.64.0.1",
  "::127.0.0.1",
  "::10.1.2.3",
  "64:ff9b::7f00:1",
  "64:ff9b::a9fe:a9fe",
  "2002:7f00:1::",
  "2002:a9fe:a9fe::1",
  "0:0:0:0:0:ffff:7f00:1",
  "fe80::1%eth0",
];

const allowed = [
  "8.8.8.8",
  "1.1.1.1",
  "172.15.255.255",
  "172.32.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "169.253.0.1",
  "192.169.0.1",
  "198.20.0.1",
  "223.255.255.255",
  "93.184.216.34",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "::ffff:8.8.8.8",
  "::ffff:808:808",
  "64:ff9b::808:808",
  "2002:808:808::1",
];

describe("the private address check", () => {
  it.each(refused)("refuses %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(allowed)("allows %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("counts a string that is not an IP address as private", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("1.2.3")).toBe(true);
  });
});

describe("assertPublicEndpoint", () => {
  const resolving =
    (...addresses: readonly string[]): Resolver =>
    () =>
      Promise.resolve(addresses.map((address) => ({ address, family: address.includes(":") ? (6 as const) : (4 as const) })));

  it.each([
    "http://localhost/v1",
    "http://LOCALHOST:11434/v1",
    "http://localhost./v1",
    "http://api.localhost/v1",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://127.0.0.1:8787/v1",
    "http://127.1/v1",
    "http://2130706433/v1",
    "http://0x7f.0.0.1/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]:5432/v1",
    "http://[::ffff:127.0.0.1]/v1",
    "http://[::ffff:a9fe:a9fe]/v1",
    "http://[fe80::1]/v1",
    "http://[fd00::1]/v1",
    "http://10.1.2.3/v1",
    "http://192.168.0.10:8000/v1",
    "http://100.100.100.200/v1",
  ])("refuses %s without a lookup", async (url) => {
    const resolve: Resolver = () => Promise.reject(new Error("a literal or a refused name needs no lookup"));
    const result = await assertPublicEndpoint(new URL(url), { allowPrivate: false, resolve });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-input");
      expect(result.error.message).toContain("private address refused");
    }
  });

  it("refuses a name that resolves to a private address, whichever answer comes", async () => {
    for (const address of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "::ffff:10.0.0.5"]) {
      expect(await assertPublicEndpoint(new URL("https://models.example.com/v1"), { allowPrivate: false, resolve: resolving(address) })).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
    }
  });

  it("refuses a name when any of its addresses is private", async () => {
    expect(
      await assertPublicEndpoint(new URL("https://models.example.com/v1"), { allowPrivate: false, resolve: resolving("93.184.216.34", "10.0.0.5") }),
    ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  it("returns the vetted address of a public host", async () => {
    expect(await assertPublicEndpoint(new URL("https://models.example.com/v1"), { allowPrivate: false, resolve: resolving("93.184.216.34") })).toEqual({
      ok: true,
      value: { address: "93.184.216.34", family: 4 },
    });
    expect(await assertPublicEndpoint(new URL("http://[2606:4700:4700::1111]/v1"), { allowPrivate: false })).toEqual({
      ok: true,
      value: { address: "2606:4700:4700::1111", family: 6 },
    });
  });

  it("answers unavailable for a name that does not resolve", async () => {
    const failing: Resolver = () => Promise.reject(new Error("ENOTFOUND"));
    expect(await assertPublicEndpoint(new URL("https://nope.example.com/v1"), { allowPrivate: false, resolve: failing })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(await assertPublicEndpoint(new URL("https://nope.example.com/v1"), { allowPrivate: false, resolve: resolving() })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("lets private targets through when they are allowed", async () => {
    expect(await assertPublicEndpoint(new URL("http://127.0.0.1:8000/v1"), { allowPrivate: true })).toEqual({
      ok: true,
      value: { address: "127.0.0.1", family: 4 },
    });
    expect(await assertPublicEndpoint(new URL("http://localhost/v1"), { allowPrivate: true, resolve: resolving("127.0.0.1") })).toMatchObject({ ok: true });
  });
});
