import { describe, expect, it } from "vitest";

import { poolChips, poolLines } from "./fleet-words";
import { runnerActions } from "./runner-actions";
import { consequenceLine, executorNote, fingerprintShort, ownLabels, versionFix } from "./runner-page-words";

describe("a runner's page in words", () => {
  it("F-061/c3: a runner one minor behind gets the fix its install calls for; a current one none", () => {
    expect(versionFix("current", "image", "0.5.0", 4, 4)).toBeNull();
    expect(versionFix("behind", "image", "0.5.0", 3, 4)).toContain("run the v0.5.0 image and restart it");
    expect(versionFix("behind", "npm", "0.5.0", 3, 4)).toContain("it installs v0.5.0 at start");
    expect(versionFix("behind", "source", "0.5.0", 3, 4)).toContain("Pull and rebuild ostra at v0.5.0");
    expect(versionFix("outside", null, "0.5.0", 2, 4)).toBe("It speaks protocol 1.2; this server accepts 1.3 to 1.5. Update it to v0.5.0.");
    // A minor-3 runner lacks resume and box sizes; one at minor 4 behind a minor-5 server only needs the update.
    expect(versionFix("behind", "source", "0.5.0", 3, 4)).toContain("gets no resume command");
    expect(versionFix("behind", "source", "0.5.0", 4, 5)).toBe("One minor behind the server: it runs tasks. Update it when you can. Pull and rebuild ostra at v0.5.0.");
  });

  it("F-091: shortens the key's fingerprint to its first and last 4 characters", () => {
    expect(fingerprintShort("SHA256:q7HcAbCdEfGh9fLm")).toBe("SHA256:q7Hc…9fLm");
  });

  it("F-092: an admin drains or resumes by state, and a member's own runner offers Revoke only", () => {
    expect(runnerActions({ state: "online", awaitingApproval: false }, true)).toEqual(["drain", "revoke"]);
    expect(runnerActions({ state: "draining", awaitingApproval: false }, true)).toEqual(["resume", "revoke"]);
    expect(runnerActions({ state: "joining", awaitingApproval: true }, true)).toEqual(["reject", "approve"]);
    expect(runnerActions({ state: "online", awaitingApproval: false }, false)).toEqual(["revoke"]);
    expect(runnerActions({ state: "revoked", awaitingApproval: false }, true)).toEqual([]);
    expect(consequenceLine("online", 3, false)).toBe("Draining lets its 3 tasks finish and takes no new ones. Revoking stops them at once.");
    expect(consequenceLine("online", 1, false)).toBe("Draining lets its running task finish and takes no new one. Revoking stops it at once.");
  });

  it("F-116/c5: a kubernetes runner's page says plainly that its agent has direct internet access, as its pool's page does, and a docker runner's says nothing of it", () => {
    // The Executor row's muted line, from the runner's `direct-internet-access` line (`runners.get`).
    expect(executorNote(["direct-internet-access"])).toEqual([{ chip: false, text: "the agent has direct internet access" }]);
    expect(executorNote([])).toEqual([]);
    // A host runner's chip stays beside it, and the internet line is only kubernetes'.
    expect(executorNote(["not-isolated"])).toEqual([{ chip: true, text: "not isolated" }]);
    // The pool's page says why, and what stays blocked.
    expect(poolLines(["direct-internet-access"])).toEqual([
      { icon: "globe", text: "The agent has direct internet access: on kubernetes it shares the pod's network. Private ranges, the metadata address and other boxes stay blocked." },
    ]);
    expect(poolChips(["direct-internet-access"])).toEqual(["direct internet"]);
  });

  it("keeps the runner's own labels apart from the built-in ones", () => {
    expect(ownLabels(["tier:fast", "executor:docker", "os:linux", "arch:x64", "gpu"])).toEqual(["tier:fast", "gpu"]);
  });
});
