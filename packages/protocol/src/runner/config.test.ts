import { describe, expect, it } from "vitest";

import { parseRunnerConfig, runnerConfigFields, runnerConfigKeys, runnerConfigSchema, runnerEnvNames } from "./config.ts";

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
});
