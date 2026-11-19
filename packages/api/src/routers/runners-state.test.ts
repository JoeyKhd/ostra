import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerId } from "@ostra/protocol";

import { createApiHarness, seedPersonalRunner } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-013: the panel shows each runner's state, and what it reported, as core last wrote them. The
// Runners page and the "run on" picker read these two procedures; their words for each state are
// apps/web's `runner-words.ts`.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

describe("runners.list and runners.mine", () => {
  it("F-013: give each runner's own state, executor, capacity, labels and version, as core stored them", async () => {
    const { a } = harness.fixture;
    const states = ["joining", "online", "offline", "draining"] as const;
    const ids: RunnerId[] = [];
    for (const state of states) {
      const id = await seedPersonalRunner(harness, a.admin.id, `runner ${state}`);
      await harness.test.db.runner.update({
        where: { id },
        data: { state, capacity: states.indexOf(state) + 1, labels: [`label-${state}`], version: `0.0.${String(states.indexOf(state))}` },
      });
      ids.push(id);
    }

    const listed = await (await harness.as(a.admin)).runners.list();
    const mine = await (await harness.as(a.admin)).runners.mine();
    for (const rows of [listed, mine]) {
      for (const [index, state] of states.entries()) {
        expect(rows.find((row) => row.id === ids[index])).toMatchObject({
          state,
          executor: "host",
          capacity: index + 1,
          labels: [`label-${state}`],
          version: `0.0.${String(index)}`,
        });
      }
    }

    // A state core changes later shows on the next read.
    const [first] = ids;
    if (first === undefined) throw new Error("no runner");
    await harness.test.db.runner.update({ where: { id: first }, data: { state: "offline" } });
    expect((await (await harness.as(a.admin)).runners.list()).find((row) => row.id === first)?.state).toBe("offline");
  });
});
