import { describe, expect, it } from "vitest";

import { parseBoxSubnetPool, parseRunnerConfig, runnerConfigFields, runnerConfigKeys, runnerConfigSchema, runnerEnvNames } from "./config.ts";

describe("the runner's config", () => {
  it("lists exactly the keys its fields hold", () => {
    expect([...runnerConfigKeys].sort()).toEqual(Object.keys(runnerConfigFields).sort());
  });

  it("needs only the server's address, and fills every other default", () => {
    expect(parseRunnerConfig({ flags: { server: "http://localhost:8787" }, env: {} })).toEqual({
      ok: true,
      config: {
        serverUrl: "http://localhost:8787",
        transport: "auto",
        executor: "host",
        labels: [],
        shell: "bash",
        boxSubnetPool: "10.89.0.0/16",
        reserveCpuMillis: 1000,
        reserveMemoryMiB: 2048,
        wsRetryMinutes: 10,
        pin: true,
        npmRegistry: "https://registry.npmjs.org",
        k8sNodeWaitMinutes: 15,
        egressAllow: [],
        sidecarCpuMillis: 1000,
        sidecarMemoryMiB: 256,
        serviceCpuMillis: 1000,
        serviceMemoryMiB: 1024,
        subagentWaitMinutes: 30,
        browserDownload: true,
      },
    });
  });

  it("reads the same settings from OSTRA_* variables, and a flag wins", () => {
    const result = parseRunnerConfig({
      flags: { capacity: "3" },
      env: {
        OSTRA_SERVER_URL: "https://ostra.example.com",
        OSTRA_RUNNER_CAPACITY: "2",
        OSTRA_RUNNER_LABELS: "gpu, macos,,",
        OSTRA_RUNNER_EXECUTOR: "docker",
        OSTRA_JOIN_TOKEN: "join-token",
        PATH: "/usr/bin",
      },
    });
    expect(result).toMatchObject({
      ok: true,
      config: { serverUrl: "https://ostra.example.com", capacity: 3, labels: ["gpu", "macos"], executor: "docker" },
    });
  });

  it("refuses an unknown flag and an unknown OSTRA_RUNNER_ variable, listing the known ones", () => {
    const result = parseRunnerConfig({
      flags: { server: "http://localhost:8787", turbo: "1" },
      env: { OSTRA_RUNNER_COLOUR: "blue" },
    });
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors.join("\n")).toContain("--turbo");
    expect(errors.join("\n")).toContain("OSTRA_RUNNER_COLOUR");
    expect(errors.join("\n")).toContain("OSTRA_RUNNER_CAPACITY");
  });

  it("refuses a missing server, a bad executor and a zero capacity", () => {
    expect(parseRunnerConfig({ flags: {}, env: {} }).ok).toBe(false);
    // Milestone 5 (ticket 20): `kubernetes` is an executor now.
    expect(parseRunnerConfig({ flags: { server: "http://x", executor: "kubernetes" }, env: {} })).toMatchObject({ ok: true, config: { executor: "kubernetes" } });
    expect(parseRunnerConfig({ flags: { server: "http://x", executor: "nomad" }, env: {} }).ok).toBe(false);
    expect(parseRunnerConfig({ flags: { server: "http://x", capacity: "0" }, env: {} }).ok).toBe(false);
  });

  it("gives every field a variable, a flag and a description the docs can quote", () => {
    for (const key of Object.keys(runnerConfigSchema.shape)) {
      expect(Object.keys(runnerConfigFields)).toContain(key);
    }
    for (const field of Object.values(runnerConfigFields)) {
      expect(field.env).toMatch(/^OSTRA_[A-Z0-9_]+$/);
      expect(field.description.length).toBeGreaterThan(10);
    }
    expect(runnerEnvNames).toContain("OSTRA_RUNNER_SHELL");
  });

  it("F-017/c5: the docker executor's subnet pool has a working default clear of Docker's own pools, and takes only an IPv4 network of /8 to /24", () => {
    const pool = (value: string) => parseRunnerConfig({ flags: { server: "http://x" }, env: { OSTRA_BOX_SUBNET_POOL: value } });
    expect(parseRunnerConfig({ flags: { server: "http://x" }, env: {} })).toMatchObject({ ok: true, config: { boxSubnetPool: "10.89.0.0/16" } });
    expect(pool("10.200.0.0/20")).toMatchObject({ ok: true, config: { boxSubnetPool: "10.200.0.0/20" } });
    expect(parseRunnerConfig({ flags: { server: "http://x", "box-subnet-pool": "10.1.2.0/24" }, env: {} })).toMatchObject({ ok: true, config: { boxSubnetPool: "10.1.2.0/24" } });
    // Not a network: host bits set, a prefix past /24 (no whole /24 in it) or under /8, a bad octet, IPv6.
    // The schema's rule is the executor's own (`parseBoxSubnetPool`, which the `docker` executor carves with).
    for (const wrong of ["10.89.0.1/16", "10.89.0.0/25", "10.0.0.0/7", "10.300.0.0/16", "fd00::/64", "10.89.0.0", "10.89.0.0/16/1", "10.89.0/16"]) {
      expect(pool(wrong).ok, wrong).toBe(false);
      expect(parseBoxSubnetPool(wrong), wrong).toBeNull();
    }
    expect(parseBoxSubnetPool("10.200.0.0/20")).toEqual({ first: (10 * 256 + 200) * 65_536, size: 16 });
  });
});
