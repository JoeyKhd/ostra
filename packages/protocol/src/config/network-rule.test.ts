import { describe, expect, it } from "vitest";

import { cidrSchema, networkRuleHostSchema, networkRulePortSchema, networkRuleSchema, networkRulesSchema } from "./network-rule.ts";

// F-052/c1 (ADR 0073): a network rule is a host name or a CIDR and one or more TCP ports. The
// schema normalises what a person types and refuses what no destination can be. The baseline's
// refusal (a private CIDR) is the domain's (`packages/domain`'s `networkRuleProblem`).

const parses = (value: unknown): boolean => networkRuleSchema.safeParse(value).success;

describe("a network rule's shape (F-052/c1)", () => {
  it("F-052/c1: accepts an exact host, a *.suffix, a /32 and an IPv6 CIDR with ports, and normalises case, a trailing dot and port order", () => {
    expect(networkRuleSchema.parse({ kind: "host", host: "registry.npmjs.org", ports: [443] })).toEqual({ kind: "host", host: "registry.npmjs.org", ports: [443] });
    expect(networkRuleSchema.parse({ kind: "host", host: "*.githubusercontent.com", ports: [443, 80] })).toEqual({ kind: "host", host: "*.githubusercontent.com", ports: [80, 443] });
    expect(networkRuleSchema.parse({ kind: "host", host: " EXAMPLE.com. ", ports: [443, 80] })).toEqual({ kind: "host", host: "example.com", ports: [80, 443] });
    expect(networkRuleSchema.parse({ kind: "cidr", cidr: "140.82.112.34/32", ports: [22] })).toEqual({ kind: "cidr", cidr: "140.82.112.34/32", ports: [22] });
    expect(networkRuleSchema.parse({ kind: "cidr", cidr: "2001:db8::/32", ports: [443] })).toEqual({ kind: "cidr", cidr: "2001:db8::/32", ports: [443] });
    // Round-trips through JSON, as it travels in the spec and the API.
    const rule = { kind: "cidr", cidr: "::1/128", ports: [8080] } as const;
    expect(networkRuleSchema.parse(JSON.parse(JSON.stringify(rule)))).toEqual(rule);
  });

  it("F-052/c1: refuses a bare *, an IP literal or localhost in a host, a scheme, a path, a port, an underscore and a single label", () => {
    for (const host of [
      "*",
      "*.com",
      "1.2.3.4",
      "2001:db8::1",
      "https://example.com",
      "example.com/path",
      "example.com:443",
      "exa_mple.com",
      "localhost",
      "example",
      "-example.com",
      "example-.com",
      ".example.com",
      "example..com",
    ]) {
      expect(networkRuleHostSchema.safeParse(host).success, host).toBe(false);
    }
    // `.localhost` and `localhost` are the domain's refusal: their syntax is a name's.
    expect(networkRuleHostSchema.parse("FOO.localhost.")).toBe("foo.localhost");
    expect(networkRulePortSchema.safeParse(0).success).toBe(false);
    expect(networkRulePortSchema.safeParse(65_536).success).toBe(false);
    expect(networkRulePortSchema.safeParse(443.5).success).toBe(false);
  });

  it("F-052/c1: refuses an empty port list, more than 16 ports and a repeated port", () => {
    expect(parses({ kind: "host", host: "example.com", ports: [] })).toBe(false);
    const seventeen = Array.from({ length: 17 }, (_, index) => 1000 + index);
    expect(parses({ kind: "host", host: "example.com", ports: seventeen })).toBe(false);
    expect(networkRuleSchema.parse({ kind: "host", host: "example.com", ports: seventeen.slice(0, 16) })).toEqual({ kind: "host", host: "example.com", ports: seventeen.slice(0, 16) });
    expect(parses({ kind: "host", host: "example.com", ports: [443, 443] })).toBe(false);
  });

  it("F-052/c1: refuses an unknown field in a rule", () => {
    expect(parses({ kind: "host", host: "example.com", ports: [443], method: "GET" })).toBe(false);
    expect(parses({ kind: "cidr", cidr: "10.0.0.0/8", ports: [443], path: "/v1" })).toBe(false);
  });

  it("F-052/c1: cidrSchema requires a written prefix, a bit count in range and a well-formed address in either family", () => {
    for (const cidr of ["140.82.112.0", "140.82.112.0/33", "140.82.112.256/24", "140.82.112/24", "2001:db8::/129", "2001:db8::", "2001:db8:::1/64", "2001:db8::g/64", "example.com/32", "", "/24"]) {
      expect(cidrSchema.safeParse(cidr).success, cidr).toBe(false);
    }
    for (const cidr of ["0.0.0.0/0", "255.255.255.255/32", "::/0", "2001:db8::/32", "::1/128"]) {
      expect(cidrSchema.safeParse(cidr).success, cidr).toBe(true);
    }
  });

  it("F-052/c1: an environment's list is at most 100 rules, each (kind, value) once", () => {
    const host = { kind: "host", host: "registry.npmjs.org", ports: [443] } as const;
    const cidr = { kind: "cidr", cidr: "140.82.112.0/20", ports: [443] } as const;
    expect(networkRulesSchema.parse([])).toEqual([]);
    expect(networkRulesSchema.parse([host, cidr])).toEqual([host, cidr]);
    // The same value under another kind is another rule.
    expect(networkRulesSchema.safeParse([host, { kind: "cidr", cidr: "140.82.112.0/20", ports: [80] }, { kind: "host", host: "registry.npmjs.org", ports: [80] }]).success).toBe(false);
    expect(networkRulesSchema.safeParse([cidr, { ...cidr, ports: [80] }]).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, index) => ({ kind: "host" as const, host: `host-${String(index)}.example.com`, ports: [443] }));
    expect(networkRulesSchema.safeParse(many.slice(0, 100)).success).toBe(true);
    expect(networkRulesSchema.safeParse(many).success).toBe(false);
  });
});
