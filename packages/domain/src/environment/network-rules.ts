import { EGRESS_BLOCKED_V4, EGRESS_BLOCKED_V6, inCidr } from "@ostra/adapter-sdk";
import type { NetworkRule, NetworkRuleId } from "@ostra/protocol";

// An environment's network rules (F-052, ADR 0073): what a rule is, and what it may not say. A
// rule's shape and its ports are the protocol's (`networkRuleSchema`), so this file normalises
// what the panel sends and refuses a rule that would widen the egress baseline (F-116). An
// environment narrows the baseline and never widens it; a private endpoint is the runner
// administrator's exception (`OSTRA_EGRESS_ALLOW`), not an environment's.

const PRIVATE_HOST_PROBLEM = "a rule names a public host; localhost and private names are inside the egress baseline";

const BASELINE_PROBLEM = "this address is inside the egress baseline (F-116). A runner admin allows a private endpoint with OSTRA_EGRESS_ALLOW, not an environment";

/**
 * The rule as it is stored: the host lowercased and without a trailing dot, an IPv6 CIDR's address
 * canonical in lower case with a plain bit count, and the ports sorted and without repeats. The
 * schema has already done this; the domain repeats it because a row may have been written before a
 * rule's shape was tightened.
 */
export const normalizeNetworkRule = (rule: NetworkRule): NetworkRule => {
  const ports = [...new Set(rule.ports)].sort((a, b) => a - b);
  if (rule.kind === "host") {
    return { kind: "host", host: rule.host.toLowerCase().replace(/\.$/, ""), ports };
  }
  const [address = "", bits = ""] = rule.cidr.split("/");
  const cidr = `${address.includes(":") ? address.toLowerCase() : address}/${String(Number(bits))}`;
  return { kind: "cidr", cidr, ports };
};

/**
 * Whether a CIDR meets the egress baseline: it is inside a blocked range, or it contains one (a
 * `/0` is not inside `10.0.0.0/8`, but it opens it). Either way the rule would widen the baseline.
 */
const meetsBaseline = (cidr: string): boolean => {
  const [address = ""] = cidr.split("/");
  const ranges = address.includes(":") ? EGRESS_BLOCKED_V6 : EGRESS_BLOCKED_V4;
  return ranges.some((range) => inCidr(address, range) || inCidr(range.split("/")[0] ?? "", cidr));
};

/**
 * Why a rule may not be saved, in the words the panel shows, or `null` when it may. A host rule
 * that resolves to a baseline address is not checked here: DNS changes, and the egress proxy
 * refuses the connection with `reason: "baseline"` (`egress.blocked`).
 */
export const networkRuleProblem = (rule: NetworkRule): string | null => {
  if (rule.kind === "host") {
    const host = rule.host.toLowerCase().replace(/\.$/, "");
    return host === "localhost" || host.endsWith(".localhost") || !host.includes(".") ? PRIVATE_HOST_PROBLEM : null;
  }
  return meetsBaseline(rule.cidr) ? BASELINE_PROBLEM : null;
};

/** A rule as stored: one `EnvironmentNetworkRule` row, read for the API's view. */
export type NetworkRuleRow = {
  readonly id: NetworkRuleId;
  readonly kind: "host" | "cidr";
  /** The host name or the CIDR, as the domain normalised it. */
  readonly value: string;
  readonly ports: readonly number[];
};

/** A rule as the API hands it to the panel (spec section 5.5), the stored normalised values. */
export type NetworkRuleView =
  | { readonly ruleId: NetworkRuleId; readonly kind: "host"; readonly host: string; readonly ports: readonly number[] }
  | { readonly ruleId: NetworkRuleId; readonly kind: "cidr"; readonly cidr: string; readonly ports: readonly number[] };

/** The rows as the API's view, stable-ordered by kind and then value. */
export const networkRulesView = (rows: readonly NetworkRuleRow[]): readonly NetworkRuleView[] =>
  [...rows]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value))
    .map((row) =>
      row.kind === "host"
        ? { ruleId: row.id, kind: "host" as const, host: row.value, ports: [...row.ports] }
        : { ruleId: row.id, kind: "cidr" as const, cidr: row.value, ports: [...row.ports] },
    );
