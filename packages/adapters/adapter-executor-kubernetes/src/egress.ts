import type { V1NetworkPolicy, V1NetworkPolicyEgressRule, V1NetworkPolicyPeer } from "@kubernetes/client-node";
import { EGRESS_BLOCKED_V4, EGRESS_BLOCKED_V6 } from "@ostra/adapter-sdk";

import type { NetworkPolicyView } from "./kube-api.ts";
import { BOX_ROLE, LABELS } from "./pod.ts";

// The egress baseline on Kubernetes (ticket 08, F-116, ADR 0060, ADR 0029), ported from spike 3's
// `deploy/k8s/egress-baseline.networkpolicy.yaml`: a box's pod reaches the public internet and
// nothing private (RFC 1918, carrier-grade NAT, link-local with the metadata address, loopback,
// IPv6's private ranges), no other pod, and DNS at the cluster's resolver. Its one exception is the
// ostra server's address on its port (a CIDR, or the server's pods when it runs in the cluster),
// plus `OSTRA_EGRESS_ALLOW` for a private model endpoint an admin names.
//
// The policy is the runner chart's, applied once per namespace (ticket 23): the executor never
// writes it, so a runner's service account needs no right to change policies, which would be the
// right to remove the baseline. `health()` checks it's there (`baselineProblem`) and refuses to
// start boxes without it. A NetworkPolicy selects pods, not containers, so the agent shares the
// sidecar's rules: ADR 0029's recorded difference.
//
// A snapshot build has its own policy in the build namespace (`buildEgressPolicy`): the registry and
// the package hosts the environment names, and nothing else (ADR 0038).

/**
 * What a box never reaches: the egress baseline's one list (ticket 24), which `docker`'s host rules
 * are built from too, so the two executors close the same ranges.
 */
export const BOX_BLOCKED_V4: readonly string[] = EGRESS_BLOCKED_V4;
export const BOX_BLOCKED_V6: readonly string[] = EGRESS_BLOCKED_V6;

/** The ranges `health()` insists the baseline carves out: the private ones and the metadata address's. */
export const REQUIRED_EXCEPTS: readonly string[] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];

export const BASELINE_POLICY_NAME = "ostra-egress-baseline";
export const BUILD_POLICY_NAME = "ostra-build-egress";
/** The role label of a snapshot build's pod. */
export const BUILD_ROLE = "snapshot-build";

/** Where the ostra server is, as a box's sidecar reaches it. */
export type ServerAddress =
  | { readonly kind: "cidr"; readonly cidr: string; readonly port: number }
  /** The server runs in the same cluster: its namespace's and pods' labels. */
  | { readonly kind: "in-cluster"; readonly namespaceLabels: Readonly<Record<string, string>>; readonly podLabels: Readonly<Record<string, string>>; readonly port: number };

const DNS_PORTS = [
  { protocol: "UDP", port: 53 },
  { protocol: "TCP", port: 53 },
];

/** DNS at the cluster's resolver (kube-dns or CoreDNS in `kube-system`) only. */
const dnsRule = (): V1NetworkPolicyEgressRule => ({
  to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
  ports: DNS_PORTS.map((port) => ({ ...port })),
});

const isV6 = (cidr: string): boolean => cidr.includes(":");
const asCidr = (address: string): string => (address.includes("/") ? address : isV6(address) ? `${address}/128` : `${address}/32`);

const serverRule = (server: ServerAddress): V1NetworkPolicyEgressRule => {
  const peer: V1NetworkPolicyPeer =
    server.kind === "cidr"
      ? { ipBlock: { cidr: asCidr(server.cidr) } }
      : { namespaceSelector: { matchLabels: { ...server.namespaceLabels } }, podSelector: { matchLabels: { ...server.podLabels } } };
  return { to: [peer], ports: [{ protocol: "TCP", port: server.port }] };
};

export type BaselineInput = {
  /** The box namespace. */
  readonly namespace: string;
  readonly server: ServerAddress;
  /** `OSTRA_EGRESS_ALLOW`: addresses or CIDRs in the private ranges an admin allows, such as a private model endpoint. */
  readonly allow: readonly string[];
};

/** The baseline policy the runner chart renders (ticket 23), as a typed value. */
export const baselineEgressPolicy = (input: BaselineInput): V1NetworkPolicy => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: { name: BASELINE_POLICY_NAME, namespace: input.namespace, labels: { [LABELS.partOf]: "ostra" } },
  spec: {
    podSelector: { matchLabels: { [LABELS.role]: BOX_ROLE } },
    policyTypes: ["Egress", "Ingress"],
    egress: [
      dnsRule(),
      serverRule(input.server),
      ...(input.allow.length === 0 ? [] : [{ to: input.allow.map((address) => ({ ipBlock: { cidr: asCidr(address) } })) }]),
      {
        to: [
          { ipBlock: { cidr: "0.0.0.0/0", except: [...BOX_BLOCKED_V4] } },
          { ipBlock: { cidr: "::/0", except: [...BOX_BLOCKED_V6] } },
        ],
      },
    ],
    // No ingress rule: nothing may open a connection to a box, another box included.
    ingress: [],
  },
});

export type BuildPolicyInput = {
  /** The build namespace. */
  readonly namespace: string;
  /** The registry's addresses (CIDRs or addresses) and its port. */
  readonly registry: { readonly addresses: readonly string[]; readonly port: number };
  /** The package hosts the environment names, as addresses or CIDRs, on HTTPS. */
  readonly packageHosts: readonly string[];
  /** The code host's addresses, which the build's context step clones from through the git proxy's origin. */
  readonly codeHosts: readonly string[];
};

/** The build namespace's policy (ADR 0038): DNS, the registry, the package and code hosts on HTTPS, and nothing else. */
export const buildEgressPolicy = (input: BuildPolicyInput): V1NetworkPolicy => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: { name: BUILD_POLICY_NAME, namespace: input.namespace, labels: { [LABELS.partOf]: "ostra" } },
  spec: {
    podSelector: { matchLabels: { [LABELS.role]: BUILD_ROLE } },
    policyTypes: ["Egress", "Ingress"],
    egress: [
      dnsRule(),
      // A rule with no peers allows every destination, so no address means no rule (the runner chart
      // renders the same policy before an admin names the registry's addresses).
      ...(input.registry.addresses.length === 0
        ? []
        : [{ to: input.registry.addresses.map((address) => ({ ipBlock: { cidr: asCidr(address) } })), ports: [{ protocol: "TCP", port: input.registry.port }] }]),
      ...(input.packageHosts.length + input.codeHosts.length === 0
        ? []
        : [{ to: [...input.packageHosts, ...input.codeHosts].map((address) => ({ ipBlock: { cidr: asCidr(address) } })), ports: [{ protocol: "TCP", port: 443 }] }]),
    ],
    ingress: [],
  },
});

/** Whether a policy selects pods with these labels: its `matchLabels` all match, and it has no expressions to evaluate. */
const selects = (policy: NetworkPolicyView, labels: Readonly<Record<string, string>>): boolean =>
  !policy.hasExpressions && Object.entries(policy.matchLabels).every(([key, value]) => labels[key] === value);

/**
 * What's wrong with a namespace's policies for boxes, or `null` when a baseline is there: a policy
 * that selects the box pods, restricts their egress, and carves the private ranges and the metadata
 * address out of whatever it allows.
 */
export const baselineProblem = (policies: readonly NetworkPolicyView[], namespace: string, podLabels: Readonly<Record<string, string>>, what = "boxes"): string | null => {
  const fix = what === "boxes" ? "Install the runner chart's egress baseline (deploy/helm/ostra-runner), which applies it once per namespace." : "Install the runner chart's build policy (deploy/helm/ostra-runner).";
  const selecting = policies.filter((policy) => selects(policy, podLabels) && policy.policyTypes.includes("Egress"));
  if (selecting.length === 0) {
    return `The namespace ${namespace} has no NetworkPolicy restricting the egress of its ${what}, so ostra won't start them there. ${fix}`;
  }
  const good = selecting.some((policy) => REQUIRED_EXCEPTS.every((range) => policy.egressExcepts.includes(range) || !allowsRange(policy, range)));
  if (!good) {
    return `The NetworkPolicy for ${what} in ${namespace} lets them reach private ranges or the metadata address, so ostra won't start them there. ${fix}`;
  }
  return null;
};

/** Whether a policy's egress rules allow a range: an `ipBlock` that contains it and doesn't except it, or a rule with no peers (everything). */
const allowsRange = (policy: NetworkPolicyView, range: string): boolean =>
  policy.egress.some((rule) => rule.allowsAll || rule.blocks.some((block) => contains(block.cidr, range) && !block.except.includes(range)));

const toNumber = (ip: string): number | null => {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((sum, part) => sum * 256 + part, 0);
};

/** Whether an IPv4 CIDR contains another (IPv6 only when it's `::/0`). */
const contains = (outer: string, inner: string): boolean => {
  const [outerIp = "", outerBits = "32"] = outer.split("/");
  const [innerIp = "", innerBits = "32"] = inner.split("/");
  if (isV6(outer) || isV6(inner)) return outer === "::/0" && isV6(inner);
  const a = toNumber(outerIp);
  const b = toNumber(innerIp);
  const bits = Number(outerBits);
  if (a === null || b === null || Number(innerBits) < bits) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(b / size);
};
