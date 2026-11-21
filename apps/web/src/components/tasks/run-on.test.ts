import { describe, expect, it } from "vitest";

import { poolIdSchema, runnerIdSchema } from "@ostra/protocol";

import { personalBlocked, personalReasonText, poolReasonText } from "./run-on";
import type { Choices } from "./run-on";

// F-069, F-014 (ticket 33): New task's runner picker, "A pool" and "Your machine", with their reasons.

type Machine = Choices["personal"][number];
const machine = (reason: Machine["reason"]): Machine => ({ runnerId: runnerIdSchema.parse("01900000-0000-7000-8000-000000000009"), name: "sam-laptop", canRun: reason === null, reason, busy: 2, slots: 2, takesFiles: true });

describe("the runner picker", () => {
  it("F-069/c2: a machine that can't take the task is disabled with its reason, except a busy one, which waits its turn", () => {
    expect(personalBlocked(machine("offline"))).toBe(true);
    expect(personalBlocked(machine("needs-services"))).toBe(true);
    expect(personalBlocked(machine("provider-not-allowed"))).toBe(true);
    expect(personalBlocked(machine("busy"))).toBe(false);
    expect(personalBlocked(machine(null))).toBe(false);
    expect(personalReasonText(machine("busy"))).toBe("busy (2 of 2): it waits its turn");
    expect(personalReasonText(machine("offline"))).toBe("offline");
  });

  it("F-069: \"A pool\" says why it would wait, and a project with no pool can't use it", () => {
    const poolId = poolIdSchema.parse("01900000-0000-7000-8000-000000000001");
    const waits: Choices = { pool: { canRun: false, reason: { code: "no-runner-with-labels", labels: ["gpu"] }, pools: [{ poolId, name: "build-fleet", canRun: false, reason: null }] }, personal: [], model: null, agentTakesImages: false };
    expect(poolReasonText(waits, "test1")).toBe("Waits: No runner in build-fleet has the label gpu.");
    const none: Choices = { pool: { canRun: false, reason: null, pools: [] }, personal: [], model: null, agentTakesImages: false };
    expect(poolReasonText(none, "test1")).toBe("test1 has no pool");
  });
});
