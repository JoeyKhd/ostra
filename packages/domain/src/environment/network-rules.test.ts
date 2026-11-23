import { networkRuleIdSchema, networkRuleSchema } from "@ostra/protocol";
import type { NetworkRule } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { auditActions } from "../audit/actions.ts";
import { networkRuleProblem, networkRulesView, normalizeNetworkRule } from "./network-rules.ts";

// F-052/c1 (ADR 0073): what a rule may not say. An environment narrows the egress baseline
// (F-116) and never widens it; a private endpoint is `OSTRA_EGRESS_ALLOW`, the runner admin's.

const BASELINE = "this address is inside the egress baseline (F-116). A runner admin allows a private endpoint with OSTRA_EGRESS_ALLOW, not an environment";
const PRIVATE_HOST = "a rule names a public host; localhost and private names are inside the egress baseline";

const rule = (value: unknown): NetworkRule => networkRuleSchema.parse(value);

describe("what a rule may not say (F-052/c1)", () => {
  it("F-052/c1: refuses a private CIDR inside a baseline range, and the message is the spec's sentence", () => {
    for (const cidr of ["10.0.0.0/8", "10.1.2.0/24", "172.16.0.0/12", "192.168.1.0/24", "169.254.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "fc00::/7", "fe80::/10", "::1/128"]) {
      expect(networkRuleProblem(rule({ kind: "cidr", cidr, ports: [443] })), cidr).toBe(BASELINE);
    }
    // Not only a single address: the rule's range meets the baseline even when its base is outside it.
    expect(networkRuleProblem(rule({ kind: "cidr", cidr: "0.0.0.0/0", ports: [443] }))).toBe(BASELINE);
    expect(networkRuleProblem(rule({ kind: "cidr", cidr: "0.0.0.0/1", ports: [443] }))).toBe(BASELINE);
    expect(networkRuleProblem(rule({ kind: "cidr", cidr: "::/0", ports: [443] }))).toBe(BASELINE);
  });

  it("F-052/c1: allows a public CIDR, and a public host, exact or with a wildcard", () => {
    for (const cidr of ["140.82.112.0/20", "140.82.112.34/32", "2001:4860::/32", "::2/128"]) {
      expect(networkRuleProblem(rule({ kind: "cidr", cidr, ports: [443] })), cidr).toBeNull();
    }
    for (const host of ["registry.npmjs.org", "*.githubusercontent.com", "api.example.co.uk"]) {
      expect(networkRuleProblem(rule({ kind: "host", host, ports: [443] })), host).toBeNull();
    }
  });

  it("F-052/c1: refuses localhost, a name under it, and a single-label name, and says why", () => {
    // `localhost` and a single label are refused by the schema's pattern too; the domain's own
    // check is what an API that skipped the schema sees, and what names a host rule may not have.
    for (const host of ["localhost", "foo.localhost", "*.localhost", "intranet", "registry"]) {
      expect(networkRuleProblem({ kind: "host", host, ports: [443] }), host).toBe(PRIVATE_HOST);
    }
  });
});

describe("the stored rule (F-052/c1)", () => {
  it("F-052/c1: normalises the host, an IPv6 CIDR's case and the ports, and leaves an IPv4 CIDR and a host's ports canonical", () => {
    expect(normalizeNetworkRule(rule({ kind: "host", host: "EXAMPLE.com.", ports: [443, 80] }))).toEqual({ kind: "host", host: "example.com", ports: [80, 443] });
    expect(normalizeNetworkRule(rule({ kind: "cidr", cidr: "2001:DB8::/032", ports: [443] }))).toEqual({ kind: "cidr", cidr: "2001:db8::/32", ports: [443] });
    expect(normalizeNetworkRule(rule({ kind: "cidr", cidr: "140.82.112.0/020", ports: [443] }))).toEqual({ kind: "cidr", cidr: "140.82.112.0/20", ports: [443] });
    // A row written before a rule's shape was tightened still comes back canonical.
    expect(normalizeNetworkRule({ kind: "host", host: "Registry.NPMJS.org.", ports: [443, 443, 80] })).toEqual({ kind: "host", host: "registry.npmjs.org", ports: [80, 443] });
  });
});

describe("the API's view (F-052/c1)", () => {
  it("F-052/c1: maps rows to host and CIDR views, stable-ordered by kind and then value", () => {
    const hostId = networkRuleIdSchema.parse("rule-host");
    const apiId = networkRuleIdSchema.parse("rule-api");
    const cidrId = networkRuleIdSchema.parse("rule-cidr");
    const view = networkRulesView([
      { id: hostId, kind: "host", value: "registry.npmjs.org", ports: [443] },
      { id: cidrId, kind: "cidr", value: "140.82.112.0/20", ports: [22, 443] },
      { id: apiId, kind: "host", value: "api.example.com", ports: [443] },
    ]);
    expect(view).toEqual([
      { ruleId: cidrId, kind: "cidr", cidr: "140.82.112.0/20", ports: [22, 443] },
      { ruleId: apiId, kind: "host", host: "api.example.com", ports: [443] },
      { ruleId: hostId, kind: "host", host: "registry.npmjs.org", ports: [443] },
    ]);
    expect(networkRulesView([])).toEqual([]);
  });

  it("F-052/c1: the three audit actions are the environment's, with one spelling each", () => {
    expect(auditActions["environment.network-rule-added"]).toBe("environment");
    expect(auditActions["environment.network-rule-changed"]).toBe("environment");
    expect(auditActions["environment.network-rule-removed"]).toBe("environment");
  });
});
