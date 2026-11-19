import { EGRESS_BLOCKED_V4, EGRESS_BLOCKED_V6, inCidr, METADATA_ADDRESS } from "../executor/egress-baseline.ts";

// The egress baseline's probes (F-116, ADR 0031; milestone 5's ticket 24), ported from spike 3's
// `src/attack/checklist.ts` and `src/sidecar/box-network.ts`: run from a shell in the agent's
// container, each probe tries a TCP connection to a place the baseline closes. What spike 3 left
// open, they settle:
//
// - **A positive control first.** Each probe names a control that must connect before its own
//   result means anything: the box's own sidecar on `docker`, where the agent has no other route,
//   and a public host on `kubernetes`, where the pod has direct egress. A failed control makes the
//   probe inconclusive, never blocked.
// - **A timeout is inconclusive, never blocked.** The baseline rejects (`docker`'s rules answer
//   `icmp-admin-prohibited`, and on `kubernetes` the network plugin's deny is set to reject), so a
//   block is an immediate error. A connection refused by the far end means the packet got there:
//   reachable.
// - **The box network's gateway is probed,** and on `docker` another box's sidecar ports too.
// - **On `kubernetes`, a control pod** without the box label: a box must be refused by it only
//   where NetworkPolicy is enforced, so a cluster whose network plugin ignores policies shows up as
//   "not enforced" rather than passing.
// - **The canary:** a file outside the workspace, read by a scripted shell call, must show in the
//   task's event log.
//
// The live runs (ticket 35) call these with the probe script below, run in the agent's container
// with `node -e` (the base image has node: the box's init runs on it). Nothing here runs a shell line.

/** What one connection attempt ended as. `code` is the system's error code, such as `EHOSTUNREACH`. */
export type ConnectOutcome =
  | { readonly kind: "connected" }
  | { readonly kind: "error"; readonly code: string }
  | { readonly kind: "timeout" };

/** A probe's verdict: the baseline held, it didn't, or this run can't say. */
export type ProbeVerdict = "blocked" | "reachable" | "inconclusive";

/** The errors that mean the network refused the packet on its way: the baseline's answer. */
const BLOCKED_CODES: ReadonlySet<string> = new Set(["EHOSTUNREACH", "ENETUNREACH", "EACCES", "EPERM"]);

/**
 * One probe's verdict, given its control's outcome: inconclusive unless the control connected;
 * then connected or refused by the far end is reachable, a network refusal is blocked, and a
 * timeout or any other error is inconclusive.
 */
export const judgeProbe = (control: ConnectOutcome, probe: ConnectOutcome): { readonly verdict: ProbeVerdict; readonly detail: string } => {
  if (control.kind !== "connected") {
    return { verdict: "inconclusive", detail: `the positive control ${control.kind === "timeout" ? "timed out" : `failed (${control.code})`}` };
  }
  switch (probe.kind) {
    case "connected":
      return { verdict: "reachable", detail: "connected" };
    case "timeout":
      return { verdict: "inconclusive", detail: "timed out: a drop and a slow host look the same" };
    case "error":
      if (probe.code === "ECONNREFUSED" || probe.code === "ECONNRESET") {
        return { verdict: "reachable", detail: `the far end answered (${probe.code})` };
      }
      return BLOCKED_CODES.has(probe.code) ? { verdict: "blocked", detail: `refused on the way (${probe.code})` } : { verdict: "inconclusive", detail: `an error that says nothing of the path (${probe.code})` };
    default:
      return probe satisfies never;
  }
};

/** A place to connect to. */
export type ProbeAddress = { readonly host: string; readonly port: number };

/** One check of the plan: the place the baseline closes, and its positive control. */
export type EgressProbe = {
  readonly id: string;
  readonly title: string;
  readonly target: ProbeAddress;
  readonly control: ProbeAddress;
};

/** A range's first host: what a probe of the range connects to. The link-local range is probed at the metadata address. */
export const probeAddressOf = (range: string): string => {
  if (range === "169.254.0.0/16") return METADATA_ADDRESS;
  const [base = ""] = range.split("/");
  if (base.includes(":")) return base.endsWith("::") ? `${base}1` : base;
  const parts = base.split(".").map(Number);
  return [...parts.slice(0, 3), (parts[3] ?? 0) + 1].join(".");
};

/** The ranges no TCP connection can leave the box for: loopback stays in the box's own namespace, multicast isn't TCP. */
const PROBED = (range: string): boolean => !["127.0.0.0/8", "224.0.0.0/4", "::1/128", "ff00::/8"].includes(range);

export type EgressPlanInput = {
  readonly executor: "docker" | "kubernetes";
  /** The positive control: the box's own sidecar on `docker`, a public host on `kubernetes`. */
  readonly control: ProbeAddress;
  /** The box network's gateway, as the agent's container sees it. */
  readonly gateway: string;
  /** Another box: its address, and on `docker` its sidecar's ports (the bridge, the proxies). */
  readonly otherBox: { readonly host: string; readonly ports: readonly number[] };
  /** The port the range probes connect on. Default: 443. */
  readonly port?: number;
  /** Probe IPv6 too, where the box has an IPv6 route. Default: false. */
  readonly ipv6?: boolean;
};

/** Every probe of a box, built from the baseline's one list, each with its control. */
export const egressProbePlan = (input: EgressPlanInput): readonly EgressProbe[] => {
  const port = input.port ?? 443;
  const ranges = [...EGRESS_BLOCKED_V4, ...(input.ipv6 === true ? EGRESS_BLOCKED_V6 : [])].filter(PROBED);
  return [
    ...ranges.map((range) => ({ id: `range ${range}`, title: `Reach ${range}`, target: { host: probeAddressOf(range), port }, control: input.control })),
    { id: "metadata", title: "Reach the metadata address", target: { host: METADATA_ADDRESS, port: 80 }, control: input.control },
    { id: "gateway", title: "Reach the box network's gateway", target: { host: input.gateway, port: 22 }, control: input.control },
    ...input.otherBox.ports.map((otherPort) => ({
      id: `other-box ${String(otherPort)}`,
      title: `Reach another box${input.executor === "docker" ? "'s sidecar" : ""} on ${String(otherPort)}`,
      target: { host: input.otherBox.host, port: otherPort },
      // The same port on the box's own sidecar shows the port is open where the box may reach it.
      control: input.executor === "docker" ? { host: input.control.host, port: otherPort } : input.control,
    })),
  ];
};

/** One probe's result. */
export type EgressProbeResult = EgressProbe & { readonly verdict: ProbeVerdict; readonly detail: string };

/** How a probe connects: in the agent's container, through the executor's own exec. */
export type Connect = (address: ProbeAddress) => Promise<ConnectOutcome>;

/** Runs a plan: each probe's control, then the probe, in order. */
export const runEgressProbes = async (plan: readonly EgressProbe[], connect: Connect): Promise<readonly EgressProbeResult[]> => {
  const results: EgressProbeResult[] = [];
  for (const probe of plan) {
    const control = await connect(probe.control);
    // A control that failed makes the probe inconclusive whatever it would show: it isn't tried.
    const outcome = control.kind === "connected" ? await connect(probe.target) : control;
    results.push({ ...probe, ...judgeProbe(control, outcome) });
  }
  return results;
};

/** Whether every probe found the baseline holding: all blocked. An inconclusive one is not a pass. */
export const baselineHeld = (results: readonly EgressProbeResult[]): boolean => results.length > 0 && results.every((result) => result.verdict === "blocked");

/**
 * Whether a cluster enforces NetworkPolicy (F-116): a box tries the control pod, which has no box
 * label and is reachable from an unlabelled pod (its own positive control). Refused from the box
 * means enforced; reached means the network plugin ignores the policy; anything else can't say.
 */
export const clusterEnforcesPolicy = (fromUnlabelled: ConnectOutcome, fromBox: ConnectOutcome): "enforced" | "not-enforced" | "inconclusive" => {
  const verdict = judgeProbe(fromUnlabelled, fromBox).verdict;
  return verdict === "blocked" ? "enforced" : verdict === "reachable" ? "not-enforced" : "inconclusive";
};

/** The probe the agent's container runs with `node -e`, the host, the port and the timeout as arguments: it prints one JSON line. */
export const PROBE_SCRIPT = [
  "const [host, port, timeout] = process.argv.slice(1);",
  "const socket = require('node:net').connect(Number(port), host);",
  "const done = (outcome) => { socket.destroy(); console.log(JSON.stringify(outcome)); process.exit(0); };",
  "const timer = setTimeout(() => done({ kind: 'timeout' }), Number(timeout));",
  "socket.once('connect', () => { clearTimeout(timer); done({ kind: 'connected' }); });",
  "socket.once('error', (error) => { clearTimeout(timer); done({ kind: 'error', code: error.code ?? 'error' }); });",
].join(" ");

/** The probe's command in the agent's container. */
export const probeCommand = (address: ProbeAddress, timeoutMs = 3000): readonly string[] => ["node", "-e", PROBE_SCRIPT, address.host, String(address.port), String(timeoutMs)];

/** The probe's printed line as an outcome; anything else is an error that says nothing. */
export const parseProbeOutput = (text: string): ConnectOutcome => {
  try {
    const value: unknown = JSON.parse(text.trim().split("\n").at(-1) ?? "");
    const kind: unknown = Reflect.get(Object(value), "kind");
    const code: unknown = Reflect.get(Object(value), "code");
    if (kind === "connected" || kind === "timeout") return { kind };
    if (kind === "error" && typeof code === "string") return { kind, code };
  } catch {
    // Not the probe's line.
  }
  return { kind: "error", code: "no-answer" };
};

/** A canary: a file outside the workspace, with a marker no task would print by chance. */
export const canaryFile = (path: string, marker: string): { readonly path: string; readonly content: string; readonly command: readonly string[] } => ({
  path,
  content: `${marker}\n`,
  // The scripted shell call the agent makes: reads it, as a tool would.
  command: ["cat", path],
});

/** Whether the task's events show the canary's read: the path in a shell call's command, or the marker in its output. */
export const canaryInEvents = (events: readonly unknown[], canary: { readonly path: string; readonly content: string }): boolean => {
  const marker = canary.content.trim();
  return events.some((event) => {
    const text = JSON.stringify(event);
    return text.includes(canary.path) || text.includes(marker);
  });
};

/** Whether a probe's target is inside the baseline: the plan's sanity, so a probe never tests a public address by mistake. */
export const targetIsBaseline = (probe: EgressProbe): boolean =>
  probe.id.startsWith("range ") ? [...EGRESS_BLOCKED_V4, ...EGRESS_BLOCKED_V6].some((range) => inCidr(probe.target.host, range)) : true;
