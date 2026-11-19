import { poolIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { healthOf, moved, poolsText, runnerNote, servicesWaitText, shortDigest, snapshotFailureText, snapshotReasonText, timeoutText, variablesText } from "./environment-services-words";

// The words of the environment's Services and checks tab (environment-services.md, ticket 48).

const where = (overrides: Partial<Parameters<typeof runnerNote>[0]> = {}): Parameters<typeof runnerNote>[0] => ({
  pools: [{ poolId: poolIdSchema.parse("01a1f3c0-0000-7000-8000-000000000001"), name: "build-fleet" }],
  servicesRunnersOnline: 2,
  executorsOnline: ["docker"],
  poolExecutors: ["docker"],
  services: 3,
  noServicesRunner: false,
  ...overrides,
});

describe("the environment's services and checks, in words", () => {
  it("F-054: a check's timeout reads in whole minutes, otherwise in seconds", () => {
    expect(timeoutText(600)).toBe("10 min");
    expect(timeoutText(60)).toBe("1 min");
    expect(timeoutText(90)).toBe("90 s");
  });

  it("F-094: a service's variables read as a count and its secrets, and none as none", () => {
    expect(variablesText([])).toBeNull();
    expect(variablesText([{ kind: "plain", name: "A", value: "1" }])).toBe("1");
    expect(
      variablesText([
        { kind: "plain", name: "A", value: "1" },
        { kind: "plain", name: "B", value: "2" },
        { kind: "secret", name: "C", set: true },
      ]),
    ).toBe("3 · 1 secret");
  });

  it("F-094: the runner note names the pools and who can start services, and turns into the blocker when no runner can", () => {
    expect(runnerNote(where({ services: 0 }))).toBeNull();
    expect(runnerNote(where())).toEqual({
      kind: "note",
      text: "Host runners start no services, so this project's tasks run only on docker runners. build-fleet has 2 online.",
    });
    expect(runnerNote(where({ pools: [{ poolId: poolIdSchema.parse("01a1f3c0-0000-7000-8000-000000000001"), name: "build-fleet" }, { poolId: poolIdSchema.parse("01a1f3c0-0000-7000-8000-000000000002"), name: "gpu-pool" }], servicesRunnersOnline: 3 }))).toMatchObject({
      text: "Host runners start no services, so this project's tasks run only on docker runners. build-fleet and gpu-pool have 3 online.",
    });
    expect(runnerNote(where({ servicesRunnersOnline: 0, noServicesRunner: true }))).toEqual({
      kind: "blocked",
      detail: "It has services, and no runner online can start them. Host runners start none; a docker runner of build-fleet can.",
    });
    expect(runnerNote(where({ servicesRunnersOnline: 0, noServicesRunner: true, poolExecutors: ["host"] }))).toEqual({
      kind: "blocked",
      detail: "It has services, and none of this project's runners can start them: they all use the host executor. Remove the services, or add a docker runner to build-fleet.",
    });
  });

  it("F-094: a service's last box reads healthy with its time, failed, or started with no check", () => {
    expect(healthOf(null)).toBeNull();
    expect(healthOf({ state: "healthy", at: 0, runnerName: "build-01", afterMs: 4_000, reason: null })).toEqual({ tone: "green", word: "healthy", extra: "4s" });
    expect(healthOf({ state: "failed", at: 0, runnerName: null, afterMs: null, reason: "image not found" })).toEqual({ tone: "red", word: "failed", extra: null });
    expect(healthOf({ state: "started", at: 0, runnerName: null, afterMs: 900, reason: null })).toEqual({ tone: "grey", word: "started", extra: "no check" });
  });

  it("F-094: a task that waits for a services runner names the runners online", () => {
    expect(servicesWaitText([{ name: "alex-mbp", executor: "host" }])).toBe("Waiting for a runner that can start services. Online now: alex-mbp (host).");
    expect(servicesWaitText([])).toBe("Waiting for a runner that can start services. None is online.");
  });

  it("F-054: reordering moves one check and keeps the rest in order", () => {
    expect(moved(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moved(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moved(["a", "b", "c"], 1, 5)).toEqual(["a", "b", "c"]);
    expect(poolsText(["a", "b", "c"])).toBe("a, b and c");
    expect(shortDigest(`sha256:9c41e2a${"0".repeat(57)}`)).toBe("sha256:9c41e2a");
  });

  it("F-051: the snapshot panel says why a build ran, who rebuilt it, and why one failed", () => {
    expect(snapshotReasonText("environment-changed", null)).toBe("Environment changed");
    expect(snapshotReasonText("lockfile-changed", null)).toBe("A lockfile changed");
    expect(snapshotReasonText("nightly", null)).toBe("Nightly");
    expect(snapshotReasonText("rebuild", "Alex Kim")).toBe("Rebuilt by Alex Kim");
    expect(snapshotReasonText("rebuild", null)).toBe("Rebuilt by hand");
    expect(snapshotFailureText("setup-failed")).toBe("The setup script failed");
    expect(snapshotFailureText("secret-found")).toBe("A setup secret was found in the image, so it was deleted");
    expect(snapshotFailureText("build-failed")).toBe("The image didn't build");
  });
});
