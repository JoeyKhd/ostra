import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EGRESS_BLOCKED_V4, EGRESS_BLOCKED_V6, inCidr, METADATA_ADDRESS } from "@ostra/adapter-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressRules, egressRuleSet } from "./egress.ts";
import type { EgressInput, EgressRule } from "./egress.ts";

// Milestone 5's ticket 24 (F-116): `docker`'s host rules from the egress baseline's one list, and
// `deploy/egress-baseline.sh` applying exactly those, run with stand-ins for `iptables` and
// `ip6tables` that write down each call. The rules on a real host, and every probe from a shell in
// the agent's container, are ticket 35's Linux job.

const SCRIPT = fileURLToPath(new URL("../../../../deploy/egress-baseline.sh", import.meta.url));

const input: EgressInput = {
  egressSubnet: "172.30.0.0/16",
  egressSubnetV6: "fd00:ab::/64",
  server: "172.17.0.1",
  serverPort: 8787,
  allow: ["10.20.0.5", "fd00:cafe::7"],
};

const destinationOf = (rule: EgressRule): string | undefined => rule.args[rule.args.indexOf("-d") + 1];
const chainOf = (rule: EgressRule): string | undefined => rule.args[1];
const target = (rule: EgressRule): string | undefined => rule.args[rule.args.indexOf("-j") + 1];

describe("docker's egress rules (F-116)", () => {
  it("F-116: the rules are built from the baseline's one list: a reject per range in IPv4 and IPv6, the metadata address and the host closed, the server on its port and OSTRA_EGRESS_ALLOW the only accepts", () => {
    const rules = egressRuleSet(input);
    const rejected = (program: EgressRule["program"]) =>
      rules.filter((rule) => rule.program === program && chainOf(rule) === "DOCKER-USER" && target(rule) === "REJECT").map(destinationOf);
    // Every range of the one list, and nothing else, in each family.
    expect(rejected("iptables")).toEqual([...EGRESS_BLOCKED_V4]);
    expect(rejected("ip6tables")).toEqual([...EGRESS_BLOCKED_V6]);
    // The private ranges, carrier-grade NAT, link-local with the metadata address, loopback: in the list.
    for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"]) {
      expect(EGRESS_BLOCKED_V4, range).toContain(range);
    }
    expect(rejected("iptables").some((range) => inCidr(METADATA_ADDRESS, range ?? ""))).toBe(true);
    // The accepts: the server's address and the admin's allowed ones, each family its own, nothing more.
    const accepted = rules.filter((rule) => target(rule) === "ACCEPT");
    expect(new Set(accepted.map(destinationOf))).toEqual(new Set(["172.17.0.1/32", "10.20.0.5/32", "fd00:cafe::7/128"]));
    expect(accepted.every((rule) => (rule.program === "ip6tables") === (destinationOf(rule)?.includes(":") ?? false))).toBe(true);
    // The server's address is open on its TCP port only, in both chains, as on `kubernetes` (ADR 0029,
    // Q239; ADR 0060): on compose it is the Docker host's gateway, whose other ports are the host's
    // own services. The allowed addresses stay port-less.
    const serverAccepts = accepted.filter((rule) => destinationOf(rule) === "172.17.0.1/32");
    expect(serverAccepts.map((rule) => [chainOf(rule), ...rule.args.slice(3)])).toEqual(
      ["DOCKER-USER", "INPUT"].map((chain) => [chain, "-s", "172.30.0.0/16", "-d", "172.17.0.1/32", "-p", "tcp", "--dport", "8787", "-j", "ACCEPT"]),
    );
    expect(accepted.filter((rule) => destinationOf(rule) !== "172.17.0.1/32").every((rule) => !rule.args.includes("-p") && !rule.args.includes("--dport"))).toBe(true);
    // An IPv6 server is open on its port in ip6tables, the same way.
    const v6Server = egressRuleSet({ ...input, server: "fd00:ab::1", allow: [] }).filter((rule) => target(rule) === "ACCEPT");
    expect(v6Server.map((rule) => [rule.program, chainOf(rule), ...rule.args.slice(3)])).toEqual(
      ["DOCKER-USER", "INPUT"].map((chain) => ["ip6tables", chain, "-s", "fd00:ab::/64", "-d", "fd00:ab::1/128", "-p", "tcp", "--dport", "8787", "-j", "ACCEPT"]),
    );
    // Every accept comes before every reject of its chain; each rule is inserted at its own position.
    for (const program of ["iptables", "ip6tables"] as const) {
      for (const chain of ["DOCKER-USER", "INPUT"]) {
        const own = rules.filter((rule) => rule.program === program && chainOf(rule) === chain);
        expect(own.map((rule) => Number(rule.args[2]))).toEqual(own.map((_rule, index) => index + 1));
        const firstReject = own.findIndex((rule) => target(rule) === "REJECT");
        expect(own.slice(firstReject).every((rule) => target(rule) === "REJECT"), `${program} ${chain}`).toBe(true);
      }
    }
    // The host itself (the network's gateway): everything from the subnet that isn't accepted is rejected.
    expect(rules.filter((rule) => rule.program === "iptables" && chainOf(rule) === "INPUT").at(-1)?.args).toEqual([
      "-I",
      "INPUT",
      "3",
      "-s",
      "172.30.0.0/16",
      "-j",
      "REJECT",
      "--reject-with",
      "icmp-admin-prohibited",
    ]);
    // Every rule is from the egress subnet: nothing else on the host is touched.
    expect(rules.every((rule) => rule.args[rule.args.indexOf("-s") + 1] === (rule.program === "iptables" ? input.egressSubnet : input.egressSubnetV6))).toBe(true);
    // Without an IPv6 subnet, no ip6tables rule; milestone 1's shape is the iptables rules' arguments.
    const v4Only = egressRuleSet({ egressSubnet: input.egressSubnet, server: input.server, serverPort: input.serverPort, allow: [] });
    expect(v4Only.every((rule) => rule.program === "iptables")).toBe(true);
    expect(egressRules({ egressSubnet: input.egressSubnet, server: input.server, serverPort: input.serverPort, allow: [] })).toEqual(v4Only.map((rule) => rule.args));
  });
});

describe("deploy/egress-baseline.sh (F-116)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ostra-egress-script-"));
    for (const program of ["iptables", "ip6tables"]) {
      const stub = path.join(dir, program);
      await writeFile(stub, `#!/bin/sh\necho "${program} $*" >> "$EGRESS_LOG"\n`);
      await chmod(stub, 0o755);
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const runScript = (args: readonly string[], env: Readonly<Record<string, string>>): Promise<{ readonly code: number | null; readonly log: string }> =>
    new Promise((resolve) => {
      const log = path.join(dir, `calls-${String(Date.now())}-${String(Math.random()).slice(2)}.log`);
      const child = spawn("sh", [SCRIPT, ...args], {
        env: { ...process.env, ...env, EGRESS_LOG: log, PATH: `${dir}${path.delimiter}${process.env["PATH"] ?? ""}` },
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("exit", (code) => {
        void readFile(log, "utf8")
          .catch(() => "")
          .then((text) => {
            resolve({ code, log: text });
          });
      });
    });

  it("F-116: the script applies exactly the rules egressRuleSet builds, in order, and refuses anything that isn't an address or a port", async () => {
    const ran = await runScript([input.egressSubnet, input.server, String(input.serverPort), ...input.allow], { EGRESS_SUBNET_V6: input.egressSubnetV6 ?? "" });
    expect(ran.code).toBe(0);
    const lines = ran.log.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toEqual(egressRuleSet(input).map((rule) => [rule.program, ...rule.args].join(" ")));
    const v4Only = await runScript([input.egressSubnet, input.server, String(input.serverPort)], { EGRESS_SUBNET_V6: "" });
    expect(v4Only.log.split("\n").filter((line) => line.trim() !== "")).toEqual(
      egressRuleSet({ egressSubnet: input.egressSubnet, server: input.server, serverPort: input.serverPort, allow: [] }).map((rule) => [rule.program, ...rule.args].join(" ")),
    );
    const v6Server = await runScript([input.egressSubnet, "fd00:ab::1", String(input.serverPort)], { EGRESS_SUBNET_V6: input.egressSubnetV6 ?? "" });
    expect(v6Server.log.split("\n").filter((line) => line.trim() !== "")).toEqual(
      egressRuleSet({ ...input, server: "fd00:ab::1", allow: [] }).map((rule) => [rule.program, ...rule.args].join(" ")),
    );
    const refused = await runScript([input.egressSubnet, "10.0.0.1;reboot", "8787"], {});
    expect(refused.code).toBe(64);
    expect(refused.log).toBe("");
    // The server's port is a port, nothing else: never a missing one (which would open every port).
    for (const port of ["", "0", "65536", "8787;reboot", "-1", "08787"]) {
      const badPort = await runScript([input.egressSubnet, input.server, port], {});
      expect(badPort.code, port).not.toBe(0);
      expect(badPort.log, port).toBe("");
    }
    const noPort = await runScript([input.egressSubnet, input.server], {});
    expect(noPort.code).not.toBe(0);
    expect(noPort.log).toBe("");
  }, 120_000);
});
