import { randomUUID } from "node:crypto";

import { organizationIdSchema, parseRunnerConfig, poolIdSchema, registryIdSchema, runnerIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { dispatchNoteFor, dispatchWaitFromDb, dispatchWaitSchema } from "./dispatch-wait.ts";
import type { DispatchWait } from "./dispatch-wait.ts";
import { jobKey, jobNames, jobPayloadSchemas, jobSending, parseJobPayload, queueAdmitSingletonSeconds } from "./jobs.ts";
import { parseServerSettings } from "./settings.ts";

// Milestone 5's domain contracts (spec section 5.4): the wait reasons, the jobs and their keys,
// and the server's and the runner's new settings with their defaults.

const organizationId = organizationIdSchema.parse(randomUUID());
const poolId = poolIdSchema.parse(randomUUID());

describe("milestone 5's wait reasons", () => {
  const reasons: readonly DispatchWait[] = [
    { code: "needs-registry", poolId },
    { code: "needs-services" },
    { code: "no-runner-with-labels", labels: ["gpu", "tier:fast"] },
    { code: "size-too-large", size: "large" },
    { code: "project-share-reached", poolId, cap: 2 },
    { code: "pool-full", poolId },
    { code: "queued", poolId, place: 3 },
  ];

  it.each(reasons.map((reason) => [reason.code, reason] as const))("F-069: %s round-trips through the stored column, with milestone 1's sentence", (_code, reason) => {
    expect(dispatchWaitFromDb(JSON.parse(JSON.stringify(dispatchWaitSchema.parse(reason))))).toEqual(reason);
    expect(dispatchNoteFor(reason).length).toBeGreaterThan(10);
  });

  it("refuses a place of 0, a size by another name and an unknown field", () => {
    expect(dispatchWaitSchema.safeParse({ code: "queued", poolId, place: 0 }).success).toBe(false);
    expect(dispatchWaitSchema.safeParse({ code: "size-too-large", size: "huge" }).success).toBe(false);
    expect(dispatchWaitSchema.safeParse({ code: "pool-full", poolId, extra: 1 }).success).toBe(false);
  });
});

describe("milestone 5's jobs", () => {
  it("F-067: names queue.admit, runner.join-notice and registry.check, each with its key rule", () => {
    for (const name of ["queue.admit", "runner.join-notice", "registry.check"] as const) {
      expect(jobNames).toContain(name);
      expect(jobSending[name]).toEqual({ kind: "event" });
    }
    expect(Object.keys(jobPayloadSchemas).sort()).toEqual([...jobNames].sort());
    // One admission per pool at a time, whichever change sent it.
    expect(jobKey("queue.admit", { organizationId, poolId })).toBe(`pool:${poolId}:admit`);
    expect(queueAdmitSingletonSeconds).toBe(1);
    const runnerId = runnerIdSchema.parse(randomUUID());
    expect(jobKey("runner.join-notice", { organizationId, runnerId })).toBe(`runner:${runnerId}:join-notice`);
    // One check per organization and settings' version: a second save checks again.
    const registryId = registryIdSchema.parse(randomUUID());
    expect(jobKey("registry.check", { organizationId, registryId, version: 1 })).toBe(`organization:${organizationId}:registry-check:1`);
    expect(jobKey("registry.check", { organizationId, registryId, version: 2 })).not.toBe(jobKey("registry.check", { organizationId, registryId, version: 1 }));
  });

  it("carries IDs only, and refuses anything else", () => {
    expect(parseJobPayload("queue.admit", { organizationId, poolId }).ok).toBe(true);
    expect(parseJobPayload("queue.admit", { organizationId, poolId, prompt: "x" }).ok).toBe(false);
    expect(parseJobPayload("runner.join-notice", { organizationId, runnerId: "not an id" }).ok).toBe(false);
  });
});

describe("milestone 5's settings", () => {
  it("F-091, F-067: the server's have working defaults", () => {
    const parsed = parseServerSettings({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.settings).toMatchObject({ joinTokenDays: 30, personalRunnerCapacity: 2, queueSweepSeconds: 5, devHostPoolSameUser: false });
    const set = parseServerSettings({ OSTRA_JOIN_TOKEN_DAYS: "0", OSTRA_PERSONAL_RUNNER_CAPACITY: "3", OSTRA_QUEUE_SWEEP_SECONDS: "10" });
    expect(set.ok && set.settings).toMatchObject({ joinTokenDays: 0, personalRunnerCapacity: 3, queueSweepSeconds: 10 });
    expect(parseServerSettings({ OSTRA_PERSONAL_RUNNER_CAPACITY: "0" }).ok).toBe(false);
  });

  it("refuses OSTRA_DEV_HOST_POOL_SAME_USER as true unless NODE_ENV is development or test", () => {
    for (const mode of ["development", "test"] as const) {
      const parsed = parseServerSettings({ NODE_ENV: mode, OSTRA_DEV_HOST_POOL_SAME_USER: "true" });
      expect(parsed.ok && parsed.settings.devHostPoolSameUser).toBe(true);
    }
    const production = parseServerSettings({ NODE_ENV: "production", DATABASE_URL: "postgresql://x@db/ostra", OSTRA_DEV_HOST_POOL_SAME_USER: "true" });
    expect(production).toMatchObject({ ok: false });
    expect(production.ok ? "" : production.errors.join(" ")).toContain("OSTRA_DEV_HOST_POOL_SAME_USER");
    expect(parseServerSettings({ NODE_ENV: "production", DATABASE_URL: "postgresql://x@db/ostra", OSTRA_DEV_HOST_POOL_SAME_USER: "false" }).ok).toBe(true);
  });

  it("F-013: the runner's have working defaults, and read their variables", () => {
    const defaults = parseRunnerConfig({ flags: { server: "http://localhost:8787" }, env: {} });
    expect(defaults.ok && defaults.config).toMatchObject({
      transport: "auto",
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
    });
    const set = parseRunnerConfig({
      flags: { server: "http://localhost:8787", transport: "http" },
      env: {
        OSTRA_RUNNER_SLOTS: "20",
        OSTRA_RUNNER_PIN: "false",
        OSTRA_K8S_NAMESPACE: "ostra-runner",
        OSTRA_EGRESS_ALLOW: "10.0.0.5, registry.internal",
        OSTRA_HOST_POOL_AGENT_USER: "ostra-agent",
      },
    });
    expect(set.ok && set.config).toMatchObject({
      transport: "http",
      slots: 20,
      pin: false,
      k8sNamespace: "ostra-runner",
      egressAllow: ["10.0.0.5", "registry.internal"],
      hostPoolAgentUser: "ostra-agent",
    });
    expect(parseRunnerConfig({ flags: { server: "http://localhost:8787" }, env: { OSTRA_K8S_NAMESPACE: "Not_A_Name" } }).ok).toBe(false);
    expect(parseRunnerConfig({ flags: { server: "http://localhost:8787", transport: "carrier-pigeon" }, env: {} }).ok).toBe(false);
  });
});
