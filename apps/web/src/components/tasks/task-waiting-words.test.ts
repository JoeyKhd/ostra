import { describe, expect, it } from "vitest";

import { dispatchWaitSchema } from "@ostra/domain";
import { poolIdSchema } from "@ostra/protocol";

import { boxSizeText, boxWaitText, ordinal, queuePlaceText, waitLine, waitReasonText, waitedFor } from "./task-waiting-words";
import type { QueuePlace, Reason, WaitContext } from "./task-waiting-words";

// F-067, F-069, F-093 (ticket 33): the waiting line, one sentence per reason, from the message file.

const pool = poolIdSchema.parse("01900000-0000-7000-8000-000000000001");
const context: WaitContext = {
  project: "test1",
  poolNames: ["build-fleet", "Default"],
  poolName: (poolId) => (poolId === pool ? "build-fleet" : ""),
  personal: { name: "sam-laptop", busy: 2, slots: 2 },
};
/** A stored reason, checked as the dispatch stores it. */
const reason = (value: object): Reason => dispatchWaitSchema.parse(value);

describe("the waiting line", () => {
  it("F-069/c1: words each milestone 5 reason, naming the pool, the project, the labels and the size", () => {
    expect(waitReasonText(reason({ code: "needs-registry", poolId: pool }), context)).toBe("build-fleet needs a registry for snapshots: an admin sets one under Registry.");
    expect(waitReasonText(reason({ code: "needs-services" }), context)).toBe("The environment has services, and no runner of test1's pools can start them.");
    expect(waitReasonText(reason({ code: "no-runner-with-labels", labels: ["gpu"] }), context)).toBe("No runner in build-fleet or Default has the label gpu.");
    expect(waitReasonText(reason({ code: "no-runner-with-labels", labels: ["gpu", "tier:fast"] }), context)).toBe("No runner in build-fleet or Default has the labels gpu, tier:fast.");
    expect(waitReasonText(reason({ code: "size-too-large", size: "large" }), context)).toBe("No runner of test1's pools offers the large box size.");
    expect(waitReasonText(reason({ code: "project-share-reached", poolId: pool, cap: 2 }), context)).toBe("test1 is at its share of build-fleet: 2 boxes.");
    expect(waitReasonText(reason({ code: "pool-full", poolId: pool }), context)).toBe("build-fleet is at its cap of boxes.");
    expect(waitReasonText(reason({ code: "personal-runner-unavailable" }), context)).toBe("sam-laptop is busy (2 of 2).");
    expect(waitReasonText(reason({ code: "personal-runner-unavailable" }), { ...context, personal: { name: "sam-laptop", busy: 0, slots: 2 } })).toBe("sam-laptop is offline: the task starts when it connects.");
  });

  it("F-148/c9: a task with files waits for a runner at protocol 1.8, and the line says the files are why", () => {
    expect(waitReasonText(reason({ code: "needs-protocol", minor: 8, reason: "message-files" }), context)).toBe("A task with files needs a runner at protocol 1.8 or later: update the runner.");
    expect(waitReasonText(reason({ code: "needs-protocol", minor: 2 }), context)).toBe("The agent profile needs a runner at protocol 1.2 or later: update the runner.");
  });

  it("F-067/c2: the place in the pool's queue comes first, and `queued` says nothing the place doesn't", () => {
    expect([1, 2, 3, 4, 11, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "22nd"]);
    const queue: QueuePlace = { poolId: pool, poolName: "build-fleet", place: 3, length: 6 };
    expect(queuePlaceText(queue)).toBe("3rd in build-fleet's queue");
    expect(waitLine({ kind: "no-runner", reason: reason({ code: "project-share-reached", poolId: pool, cap: 2 }) }, queue, context)).toBe("3rd in build-fleet's queue · test1 is at its share of build-fleet: 2 boxes.");
    expect(waitLine({ kind: "no-runner", reason: reason({ code: "queued", poolId: pool, place: 3 }) }, queue, context)).toBe("3rd in build-fleet's queue");
    expect(waitLine(null, null, context)).toBeNull();
  });

  it("F-100/c6: a follow-up's wait names the runner its task ran on, why it can't take it, and the pools; its place in a queue says no more", () => {
    const runner = { id: "01900000-0000-7000-8000-0000000000aa", name: "santi-laptop" };
    const waits = (personal: string) => reason({ code: "follow-up-waits", runner, personal });
    expect(waitReasonText(waits("busy"), context)).toBe("Waiting for santi-laptop, where its task ran, or a runner of test1's pools: none is free right now.");
    expect(waitReasonText(waits("offline"), context)).toBe("Waiting for santi-laptop, where its task ran, to connect, or for a runner of test1's pools to free up.");
    expect(waitReasonText(waits("outdated"), context)).toBe("santi-laptop, where its task ran, needs an update to run it, and no runner of test1's pools is free.");
    expect(waitReasonText(waits("not-allowed"), context)).toBe("Waiting for a runner of test1's pools: its model provider isn't allowed on personal runners, so it can't use santi-laptop.");
    const queue: QueuePlace = { poolId: pool, poolName: "default", place: 1, length: 1 };
    expect(waitLine({ kind: "no-runner", reason: waits("busy") }, queue, context)).toBe("Waiting for santi-laptop, where its task ran, or a runner of test1's pools: none is free right now.");
  });

  it("F-093: a box waiting for a node says how long, and the panel says its size", () => {
    expect(waitedFor(40_000)).toBe("40s");
    expect(waitedFor(3 * 60_000 + 5_000)).toBe("3m");
    expect(boxWaitText({ reason: "node", since: 0 }, 40_000)).toBe("Waiting for a node · 40s");
    expect(boxWaitText({ reason: "image-pull", since: 0 }, 90_000)).toBe("Pulling the snapshot image · 1m");
    expect(boxSizeText({ name: "small", cpuMillis: 2000, memoryMiB: 4096 })).toBe("small · 2 vCPU · 4 GiB");
  });
});
