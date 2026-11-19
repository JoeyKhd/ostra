import { fakeMarker } from "@ostra/adapter-sdk/testing";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";

// Ticket 31 (F-024, ADR 0032): the runner's half of steering, on both scripted fake agents.
// "Send" steers a running turn when the agent declares mid-turn steering and advertised it (`rich`),
// and is queued for the turn's end otherwise (`plain`); "Interrupt and send" cancels the turn and
// sends the message as the next prompt on both. OpenCode's probe and the live model run are in
// `plan-mode.opencode.test.ts` and `steering.live.test.ts`.

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("steering");
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

const taskOn = (h: Harness, profile: "rich" | "plain", prompt: string) =>
  h.taskFor(prompt, { agent: { ...taskSpecFixture.agent, adapter: `fake-acp-agent-${profile}`, apiFormat: "anthropic-messages" } });

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");

const send = (h: Harness, spec: TaskSpec, text: string, delivery: "queue" | "interrupt", id: string): string =>
  h.command("steer", { sessionId: spec.sessionId, clientMessageId: id, text, delivery, intent: "message" });

describe("steering on the fake agents (F-024)", () => {
  it("F-024: \"Send\" gives an agent that declares mid-turn steering the message in the running turn", async () => {
    const h = await start();
    const { spec } = taskOn(h, "rich", fakeMarker("steerable"));
    h.dispatch(spec);
    await h.gateway.waitFor(() => messages(h, spec).includes("open to a steer"), 60_000);
    expect(await h.waitForAck(send(h, spec, "use the second approach", "queue", "steer-mid-turn"))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved");
    expect(messages(h, spec)).toContain("Steered: use the second approach");
    expect(h.ofKind(spec, "turn.started")).toHaveLength(1);
  }, 120_000);

  it("F-024: for an agent that doesn't, \"Send\" is queued and delivered as the next turn when the turn ends", async () => {
    const h = await start();
    const { spec } = taskOn(h, "plain", fakeMarker("long", "1.5"));
    h.dispatch(spec);
    await h.waitForKind(spec, "turn.started");
    expect(await h.waitForAck(send(h, spec, fakeMarker("remember", "the queued note"), "queue", "steer-queued"))).toMatchObject({ result: "accepted" });
    await h.waitForKind(spec, "session.saved", 2);
    // The running turn finished on its own, then the message was the next turn.
    expect(h.ofKind(spec, "turn.ended").map((event) => event.stopReason)).toEqual(["end_turn", "end_turn"]);
    expect(messages(h, spec)).toContain("The long step is done.");
    expect(messages(h, spec)).toContain("I'll remember the queued note.");
  }, 120_000);

  it.each(["rich", "plain"] as const)("F-024: \"Interrupt and send\" cancels the %s agent's turn and sends the message as the next prompt", async (profile) => {
    const h = await start();
    const { spec } = taskOn(h, profile, fakeMarker("long", "60"));
    h.dispatch(spec);
    await h.waitForKind(spec, "turn.started");
    const sentAt = Date.now();
    expect(await h.waitForAck(send(h, spec, fakeMarker("remember", "the interrupting note"), "interrupt", "steer-interrupt"))).toMatchObject({ result: "accepted" });
    await h.waitForKind(spec, "turn.ended");
    expect(Date.now() - sentAt).toBeLessThan(5_000);
    expect(h.ofKind(spec, "turn.ended")[0]?.stopReason).toBe("cancelled");
    await h.waitForKind(spec, "session.saved", 2);
    expect(h.ofKind(spec, "turn.started")).toHaveLength(2);
    expect(messages(h, spec)).toContain("I'll remember the interrupting note.");
    expect(messages(h, spec)).not.toContain("The long step is done.");
  }, 120_000);
});
