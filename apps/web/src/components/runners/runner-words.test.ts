import { describe, expect, it } from "vitest";

import { adminLede, hostNote, runnerAge, runnerDot, runnerStateText, runnerTotals, versionRange } from "./runner-words";
import type { RunnerState } from "./runner-words";

const states = ["joining", "online", "offline", "draining", "revoked"] as const satisfies readonly RunnerState[];

describe("runner words", () => {
  it("F-013: has a word for every state, never the raw name of an unmapped one", () => {
    expect(states.map(runnerStateText)).toEqual(["joining", "online", "offline", "draining", "revoked"]);
  });

  it("dots online green, draining half, joining a ring and the rest grey, never amber", () => {
    expect(states.map(runnerDot)).toEqual(["ring", "green", "grey", "half", "grey"]);
  });

  it("says how long ago an offline runner was seen, and just now while one joins", () => {
    const now = Date.UTC(2026, 10, 19, 12);
    expect(runnerAge("offline", now - 3 * 60 * 60 * 1000, now)).toBe("seen 3h ago");
    expect(runnerAge("offline", now - 10_000, now)).toBe("seen just now");
    expect(runnerAge("offline", null, now)).toBe("");
    expect(runnerAge("joining", null, now)).toBe("just now");
    expect(runnerAge("online", now - 3_600_000, now)).toBe("");
  });

  it("shows a pool's versions as one, a range, or a dash", () => {
    expect(versionRange([])).toBe("—");
    expect(versionRange(["0.4.2"])).toBe("v0.4.2");
    expect(versionRange(["0.4.1", "0.4.2"])).toBe("v0.4.1–v0.4.2");
  });
});

describe("the admin lede", () => {
  const runners = [
    { state: "online", capacity: 4, busy: 3 },
    { state: "online", capacity: 4, busy: 2 },
    { state: "draining", capacity: 4, busy: 1 },
    { state: "joining", capacity: 4, busy: 0 },
    { state: "offline", capacity: 4, busy: 0 },
    { state: "online", capacity: 1, busy: 1 },
    { state: "offline", capacity: 1, busy: 0 },
    { state: "online", capacity: 1, busy: 0 },
  ] as const satisfies readonly { state: RunnerState; capacity: number; busy: number }[];

  it("counts runners online and the boxes busy on the runners that take work", () => {
    expect(runnerTotals(runners)).toEqual({ online: 4, total: 8, busy: 7, slots: 14 });
  });

  it("says pools and the admin's machine as they are", () => {
    expect(adminLede(runners, 2, true)).toBe("Where tasks run. 4 of 8 runners online, 7 of 14 boxes busy, across 2 pools and your machine.");
    expect(adminLede(runners, 2, false)).toBe("Where tasks run. 4 of 8 runners online, 7 of 14 boxes busy, across 2 pools.");
    expect(adminLede([], 1, false)).toBe("Where tasks run. 0 of 0 runners online, 0 of 0 boxes busy, across 1 pool.");
    expect(adminLede([], 1, true)).toBe("Where tasks run. 0 of 0 runners online, 0 of 0 boxes busy, across 1 pool and your machine.");
  });
});

describe("the line under Your machine", () => {
  const plain = "Personal runners use the host executor: the agent runs as a process on your machine, not isolated.";

  it("F-014: says a detached process isn't contained when a runner reports process-tree, whatever its system", () => {
    expect(hostNote([{ processContainment: "process-tree" }])).toBe(`${plain} A process the agent detaches isn't contained.`);
    expect(hostNote([{ processContainment: "job-object" }, { processContainment: "process-tree" }])).toBe(
      `${plain} A process the agent detaches isn't contained.`,
    );
  });

  it("F-014: says only the plain line for a job object, a cgroup, no report yet, or no runner", () => {
    for (const mine of [[{ processContainment: "job-object" as const }], [{ processContainment: "cgroup" as const }], [{ processContainment: null }], [], undefined]) {
      expect(hostNote(mine)).toBe(plain);
    }
  });
});
