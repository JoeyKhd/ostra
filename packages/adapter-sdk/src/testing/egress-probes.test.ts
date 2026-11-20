import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { describe, expect, it } from "vitest";
import { EGRESS_BLOCKED_V4, inCidr, METADATA_ADDRESS } from "../executor/egress-baseline.ts";
import {
  baselineHeld,
  canaryFile,
  canaryInEvents,
  clusterEnforcesPolicy,
  egressProbePlan,
  judgeProbe,
  parseProbeOutput,
  probeCommand,
  runEgressProbes,
  targetIsBaseline,
} from "./egress-probes.ts";
import type { ConnectOutcome, Connect, ProbeAddress } from "./egress-probes.ts";

// Milestone 5's ticket 24 (F-116): the egress probes' judgement, from scripted connection results,
// and the probe script itself against a real socket on this machine. The probes from a shell in a
// real agent's container, on Docker and on kind with Calico and without NetworkPolicy, are ticket
// 35's live runs.

const connected: ConnectOutcome = { kind: "connected" };
const timeout: ConnectOutcome = { kind: "timeout" };
const portOf = (server: Server): number => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};
const unreachable: ConnectOutcome = { kind: "error", code: "EHOSTUNREACH" };
const refused: ConnectOutcome = { kind: "error", code: "ECONNREFUSED" };

describe("the egress probes' verdicts (F-116)", () => {
  it("F-116/c6: a probe is blocked only when its control connected and the network refused it; reachable when it connected or the far end answered; a timeout is inconclusive, never blocked", () => {
    expect(judgeProbe(connected, unreachable).verdict).toBe("blocked");
    expect(judgeProbe(connected, { kind: "error", code: "ENETUNREACH" }).verdict).toBe("blocked");
    expect(judgeProbe(connected, connected).verdict).toBe("reachable");
    expect(judgeProbe(connected, refused).verdict).toBe("reachable");
    expect(judgeProbe(connected, timeout).verdict).toBe("inconclusive");
    expect(judgeProbe(connected, { kind: "error", code: "ENOTFOUND" }).verdict).toBe("inconclusive");
  });

  it("F-116/c6: a positive control that fails makes the probe inconclusive, whatever the probe would show, and the probe isn't tried", async () => {
    for (const control of [timeout, unreachable, refused]) {
      for (const probe of [connected, unreachable, timeout]) {
        expect(judgeProbe(control, probe).verdict, `${JSON.stringify(control)} then ${JSON.stringify(probe)}`).toBe("inconclusive");
      }
    }
    const tried: ProbeAddress[] = [];
    const control = { host: "sidecar", port: 7101 };
    const connect: Connect = (address) => {
      tried.push(address);
      return Promise.resolve(address.host === "sidecar" ? timeout : unreachable);
    };
    const results = await runEgressProbes([{ id: "metadata", title: "metadata", target: { host: METADATA_ADDRESS, port: 80 }, control }], connect);
    expect(results.map((result) => result.verdict)).toEqual(["inconclusive"]);
    expect(tried).toEqual([control]);
    expect(baselineHeld(results)).toBe(false);
  });

  it("F-116/c6: the plan probes every routable range of the one list, the metadata address, the box network's gateway and another box's sidecar ports, each with its control", () => {
    const sidecar = { host: "sidecar", port: 7101 };
    const plan = egressProbePlan({ executor: "docker", control: sidecar, gateway: "172.30.0.1", otherBox: { host: "172.30.0.9", ports: [7101, 7102] } });
    const ranges = plan.filter((probe) => probe.id.startsWith("range ")).map((probe) => probe.id.slice("range ".length));
    expect(ranges).toEqual(EGRESS_BLOCKED_V4.filter((range) => range !== "127.0.0.0/8" && range !== "224.0.0.0/4"));
    expect(plan.every(targetIsBaseline)).toBe(true);
    for (const probe of plan.filter((each) => each.id.startsWith("range "))) {
      expect(inCidr(probe.target.host, probe.id.slice("range ".length)), probe.id).toBe(true);
    }
    expect(plan.find((probe) => probe.id === "metadata")?.target).toEqual({ host: METADATA_ADDRESS, port: 80 });
    expect(plan.find((probe) => probe.id === "gateway")?.target.host).toBe("172.30.0.1");
    // On docker, another box's sidecar port is controlled by the same port on the box's own sidecar.
    expect(plan.filter((probe) => probe.id.startsWith("other-box")).map((probe) => [probe.target, probe.control])).toEqual([
      [{ host: "172.30.0.9", port: 7101 }, { host: "sidecar", port: 7101 }],
      [{ host: "172.30.0.9", port: 7102 }, { host: "sidecar", port: 7102 }],
    ]);
    // On kubernetes the control is a public host, the pod having direct egress.
    const publicHost = { host: "1.1.1.1", port: 443 };
    const pod = egressProbePlan({ executor: "kubernetes", control: publicHost, gateway: "10.244.0.1", otherBox: { host: "10.244.1.7", ports: [7101] }, ipv6: true });
    expect(pod.every((probe) => probe.control === publicHost)).toBe(true);
    expect(pod.some((probe) => probe.id === "range fc00::/7")).toBe(true);
  });

  it("F-116/c6: a control pod tells a cluster that enforces NetworkPolicy from one whose network plugin ignores it", () => {
    expect(clusterEnforcesPolicy(connected, unreachable)).toBe("enforced");
    expect(clusterEnforcesPolicy(connected, connected)).toBe("not-enforced");
    expect(clusterEnforcesPolicy(connected, timeout)).toBe("inconclusive");
    // The control pod down: nothing can be said.
    expect(clusterEnforcesPolicy(timeout, unreachable)).toBe("inconclusive");
  });

  it("F-116/c6: the probe script, run with node, reports a connection, a refusal and a timeout as the verdicts read them", async () => {
    const server: Server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const open = portOf(server);
    const closedServer: Server = createServer();
    await new Promise<void>((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
    const closed = portOf(closedServer);
    await new Promise<void>((resolve) => closedServer.close(() => { resolve(); }));
    const probe = (address: ProbeAddress, timeoutMs: number): Promise<ConnectOutcome> =>
      new Promise((resolve) => {
        const [, ...args] = probeCommand(address, timeoutMs);
        const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (text: string) => (out += text));
        child.once("exit", () => { resolve(parseProbeOutput(out)); });
      });
    try {
      expect(await probe({ host: "127.0.0.1", port: open }, 3000)).toEqual({ kind: "connected" });
      expect(await probe({ host: "127.0.0.1", port: closed }, 3000)).toEqual({ kind: "error", code: "ECONNREFUSED" });
      // A TEST-NET-1 address no route answers: the timeout, which judges as inconclusive.
      const silent = await probe({ host: "192.0.2.1", port: 443 }, 300);
      expect(["timeout", "error"]).toContain(silent.kind);
      expect(judgeProbe(connected, silent).verdict === "reachable").toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }
    expect(parseProbeOutput("garbage")).toEqual({ kind: "error", code: "no-answer" });
  }, 30_000);

  it("F-116/c7: the canary's read shows in the event log by its path or its marker, and an event log without it doesn't pass", () => {
    const canary = canaryFile("/etc/ostra-canary", "ostra-canary-5f1e2d3c");
    expect(canary.command).toEqual(["cat", "/etc/ostra-canary"]);
    const events = [
      { kind: "tool.started", tool: "bash", input: { command: "cat /etc/ostra-canary" } },
      { kind: "tool.finished", output: "ostra-canary-5f1e2d3c\n" },
    ];
    expect(canaryInEvents(events, canary)).toBe(true);
    expect(canaryInEvents([{ kind: "message", text: "hello" }], canary)).toBe(false);
  });
});
