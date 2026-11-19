import { egressRuleSet } from "@ostra/adapter-executor-docker";
import { EGRESS_BLOCKED_V4, EGRESS_BLOCKED_V6, inCidr, METADATA_ADDRESS } from "@ostra/adapter-sdk";
import { describe, expect, it } from "vitest";
import { baselineEgressPolicy } from "./egress.ts";

// Milestone 5's ticket 24 (F-116): the two executors' baselines from the one list. `docker`'s host
// rules (`egressRuleSet`) and the NetworkPolicy the runner chart renders (`baselineEgressPolicy`)
// close the same ranges, which are the list's, and each has the server's address and
// `OSTRA_EGRESS_ALLOW` as its only exceptions (DNS too on `kubernetes`, ADR 0060).

describe("the egress baseline on both executors (F-116)", () => {
  it("F-116: docker's rules and the kubernetes NetworkPolicy are built from the one list and close the same ranges, with the server's address and OSTRA_EGRESS_ALLOW as their only exceptions", () => {
    const allow = ["10.20.0.5"];
    const rules = egressRuleSet({ egressSubnet: "172.30.0.0/16", egressSubnetV6: "fd00:ab::/64", server: "10.96.0.10", allow });
    const policy = baselineEgressPolicy({ namespace: "ostra-boxes", server: { kind: "cidr", cidr: "10.96.0.10", port: 8787 }, allow });
    const egress = policy.spec?.egress ?? [];

    // The ranges: docker's rejects, the policy's carve-outs, and the list, all the same.
    const dockerRanges = rules.filter((rule) => rule.args[1] === "DOCKER-USER" && rule.args.includes("REJECT")).map((rule) => rule.args[rule.args.indexOf("-d") + 1]);
    const policyBlocks = egress.flatMap((rule) => (rule.to ?? []).flatMap((peer) => (peer.ipBlock?.except === undefined ? [] : [peer.ipBlock])));
    const policyRanges = policyBlocks.flatMap((block) => block.except ?? []);
    expect(new Set(dockerRanges)).toEqual(new Set([...EGRESS_BLOCKED_V4, ...EGRESS_BLOCKED_V6]));
    expect(new Set(policyRanges)).toEqual(new Set(dockerRanges));
    expect(policyBlocks.map((block) => block.cidr)).toEqual(["0.0.0.0/0", "::/0"]);
    // The metadata address is inside what both close.
    expect(dockerRanges.some((range) => inCidr(METADATA_ADDRESS, range ?? ""))).toBe(true);
    expect(policyRanges.some((range) => inCidr(METADATA_ADDRESS, range))).toBe(true);

    // The exceptions: docker accepts the server and the allowed addresses only; the policy allows
    // DNS at the cluster's resolver, the server on its port and the allowed addresses, besides the
    // internet without the list's ranges.
    const dockerAccepts = new Set(rules.filter((rule) => rule.args.includes("ACCEPT")).map((rule) => rule.args[rule.args.indexOf("-d") + 1]));
    expect(dockerAccepts).toEqual(new Set(["10.96.0.10/32", "10.20.0.5/32"]));
    const policyPeers = egress.flatMap((rule) => (rule.to ?? []).filter((peer) => peer.ipBlock?.except === undefined));
    const policyAccepts = new Set(policyPeers.flatMap((peer) => (peer.ipBlock === undefined ? [] : [peer.ipBlock.cidr])));
    expect(policyAccepts).toEqual(dockerAccepts);
    const selectorPeers = policyPeers.filter((peer) => peer.ipBlock === undefined);
    expect(selectorPeers).toEqual([{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }]);
    expect(egress.find((rule) => rule.to?.[0]?.ipBlock?.cidr === "10.96.0.10/32")?.ports).toEqual([{ protocol: "TCP", port: 8787 }]);
  });
});
