import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import type { TaskSpec, TokenPrices } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SPEND_CAP_MESSAGE } from "../sidecar/key-proxy.ts";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";

// Ticket 25's "done when", in the task host with the stub models and the fake agent: the spend cap
// ends the turn, saves its work, sends `session.limit_reached` once and ends the session; a
// `runaway` stop from core ends the session with the hidden ref pushed.

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("limits");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (): Promise<Harness> => {
  harness = await startHarness(shared);
  return harness;
};

const prices: TokenPrices = { inputPerMTok: 3_000_000, outputPerMTok: 15_000_000, cacheReadPerMTok: 300_000, cacheWritePerMTok: 3_750_000 };

/** A model call as the agent makes it: through the key proxy, with the launch's fake key. */
const agentCall = async (h: Harness): Promise<{ readonly status: number; readonly text: string }> => {
  const env = h.launches.at(-1)?.env ?? {};
  const baseUrl = env["FAKE_AGENT_BASE_URL"];
  const key = env["FAKE_AGENT_API_KEY"];
  if (baseUrl === undefined || key === undefined) {
    throw new Error("the agent's launch has no model endpoint");
  }
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "stub-model", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: response.status, text: await response.text() };
};

const silentTask = (h: Harness, limits: TaskSpec["limits"]): TaskSpec => h.taskFor(fakeMarker("silent"), { limits }).spec;

describe("the spend cap (F-068)", () => {
  it("ends the turn at the cap, saves its work, sends session.limit_reached once, and ends the session", async () => {
    const h = await start();
    // Earlier sessions spent nearly all of it: the agent's first call reaches the cap.
    const spec = silentTask(h, { turnMaxMinutes: 30, idleMinutes: 60, spendCap: { capMicroUsd: 5_000, spentMicroUsd: 4_999, prices } });
    h.dispatch(spec);
    await h.waitForKind(spec, "turn.started");
    const checkout = path.join(h.dataDir, "tasks", spec.taskId, "workspace", "test1");
    await writeFile(path.join(checkout, "half-done.txt"), "before the cap\n");
    expect((await agentCall(h)).status).toBe(200);
    await h.waitForKind(spec, "session.limit_reached");
    await h.idle();
    const reached = h.ofKind(spec, "session.limit_reached");
    expect(reached).toHaveLength(1);
    expect(reached[0]?.limit).toBe("spend-cap");
    expect(reached[0]?.observed).toBeGreaterThanOrEqual(5_000);
    const order = h.kinds(spec);
    expect(order.indexOf("turn.ended")).toBeLessThan(order.indexOf("session.saved"));
    expect(order.indexOf("session.saved")).toBeLessThan(order.indexOf("session.limit_reached"));
    expect(order).not.toContain("session.ended");
    expect(h.ofKind(spec, "turn.ended")[0]).toMatchObject({ stopReason: "cancelled" });
    expect(await shared.upstream.treeFiles("ostra-test/test1", `refs/ostra/wip/${spec.taskId}`)).toContain("half-done.txt");
    // The box is kept for a reopen once the cap is raised.
    expect(h.host.kept().map((kept) => kept.box.taskId)).toEqual([spec.taskId]);
  }, 120_000);

  it("refuses the agent's next call in the model API's own shape once the cap is reached", async () => {
    const h = await start();
    const spec = silentTask(h, { turnMaxMinutes: 30, idleMinutes: 60, spendCap: { capTokens: 10, spentTokens: 10 } });
    h.dispatch(spec);
    await h.waitForKind(spec, "turn.started");
    const calls = shared.models.calls.length;
    const refused = await agentCall(h);
    expect(refused.status).toBe(400);
    expect(refused.text).toContain(SPEND_CAP_MESSAGE);
    expect(shared.models.calls.length).toBe(calls);
    await h.waitForKind(spec, "session.limit_reached");
    expect(h.ofKind(spec, "session.limit_reached")).toEqual([{ kind: "session.limit_reached", limit: "spend-cap", observed: 10 }]);
  }, 120_000);

  it("keeps milestone 1's behaviour for a spec with no spend cap", async () => {
    const h = await start();
    const spec = silentTask(h, { turnMaxMinutes: 30, idleMinutes: 60 });
    h.dispatch(spec);
    await h.waitForKind(spec, "turn.started");
    for (let call = 0; call < 3; call += 1) {
      expect((await agentCall(h)).status).toBe(200);
    }
    await h.waitForKind(spec, "usage.recorded", 3);
    expect(h.kinds(spec)).not.toContain("session.limit_reached");
  }, 120_000);
});

describe("a runaway stop from core (F-068)", () => {
  it("cancels the turn, pushes the hidden ref, and ends the session without session.ended", async () => {
    const h = await start();
    const spec = silentTask(h, { turnMaxMinutes: 30, idleMinutes: 60 });
    h.dispatch(spec);
    await h.waitForKind(spec, "turn.started");
    const checkout = path.join(h.dataDir, "tasks", spec.taskId, "workspace", "test1");
    await writeFile(path.join(checkout, "runaway.txt"), "work before the stop\n");
    const stop = h.stop(spec, "runaway");
    expect(await h.waitForAck(stop, 120_000)).toMatchObject({ result: "done" });
    await h.idle();
    const saved = h.ofKind(spec, "session.saved");
    expect(saved).toHaveLength(1);
    const hiddenRef = `refs/ostra/wip/${spec.taskId}`;
    expect(saved[0]?.repos[0]?.hiddenRefSha).toBe(await shared.upstream.refSha("ostra-test/test1", hiddenRef));
    expect(await shared.upstream.treeFiles("ostra-test/test1", hiddenRef)).toContain("runaway.txt");
    expect(h.kinds(spec)).not.toContain("session.ended");
    // Core records the maximum duration and the stall as its own events: the runner sends none.
    expect(h.kinds(spec)).not.toContain("session.limit_reached");
  }, 120_000);
});

