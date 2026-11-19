import { conversationText, createScenarioBrain, stubMarker, wireReasoningOf } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import type { EffortLevel, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// Ticket 60 (F-137, ADR 0066) on the agent the runner ships: the real, pinned OpenCode (2.3.2) on
// the host executor, with the stub Anthropic endpoint behind the real key proxy, recording each
// request's body. The level set after `session/new` reaches every request of the first turn; a
// `set-effort` during a turn changes none of that turn's requests and every request of the next;
// one while the session waits reaches the next prompt. `stub-model` isn't a Claude, so OpenCode
// sends its effort list as adaptive thinking with `output_config.effort` (research section 1.4).

const scenarios: Readonly<Record<string, Scenario>> = {
  /** A slow shell step, so a change lands mid-turn, then the message: two model calls in one turn. */
  "slow-step": ({ step }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "shell", arguments: { command: `node -e "setTimeout(() => console.log('slept'), 6000)"`, description: "sleep a while" } }] };
    }
    return step === 1 ? { text: "Slept." } : undefined;
  },
  /** One model call: a message. */
  quick: ({ step }) => (step === 0 ? { text: "Quick answer." } : undefined),
};

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("effort-opencode", { brain: createScenarioBrain(scenarios) });
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const taskOn = (h: Harness, prompt: string, effort: EffortLevel): TaskSpec =>
  h.taskFor(prompt, {
    agent: {
      ...taskSpecFixture.agent,
      adapter: "opencode",
      apiFormat: "anthropic-messages",
      endpointModelId: "stub-model",
      effort,
      reasoning: { supported: true, effort: ["low", "medium", "high"] },
    },
    environment: { ...taskSpecFixture.environment, setupScript: null },
  }).spec;

/** The level each main model request carried (title calls aside) whose conversation holds `mark` last among the marks given. */
const levelsOf = (mark: string, later: readonly string[]): readonly (string | null)[] =>
  shared.models.calls
    .filter((call) => call.toolNames.length > 0)
    .filter((call) => {
      const text = conversationText(call.messages);
      return text.includes(mark) && later.every((other) => !text.includes(other));
    })
    .map((call) => wireReasoningOf(call.body).effort);

describe("reasoning effort on OpenCode, with the stub models (F-137)", () => {
  it("F-137: OpenCode's requests carry the session's level; a change mid-turn waits for the next turn, one while idle reaches the next prompt", async () => {
    harness = await startHarness(shared, { agents: defaultAgents() });
    const h = harness;
    const first = `first-turn-${String(Date.now())}`;
    const second = `second-turn-${String(Date.now())}`;
    const third = `third-turn-${String(Date.now())}`;
    const spec = taskOn(h, `${stubMarker("slow-step")} Sleep, then answer. ${first}`, "high");
    h.dispatch(spec);
    await h.waitForKind(spec, "tool.called", 1, 150_000);
    // Mid-turn: held.
    expect(await h.waitForAck(h.command("set-effort", { sessionId: spec.sessionId, level: "low", changeId: "0196f1a0-oc-change-1" }))).toMatchObject({ result: "accepted" });
    // OpenCode steers a message into the running turn: the next one goes once this turn has ended.
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    h.steer(spec, `${stubMarker("quick")} ${second}`);
    await h.waitForKind(spec, "session.saved", 2, 150_000);
    // Waiting between turns: applied at once.
    expect(await h.waitForAck(h.command("set-effort", { sessionId: spec.sessionId, level: "medium", changeId: "0196f1a0-oc-change-2" }), 60_000)).toMatchObject({
      result: "done",
    });
    h.steer(spec, `${stubMarker("quick")} ${third}`);
    await h.waitForKind(spec, "session.saved", 3, 150_000);

    // Every request of the first turn, the one after the change included, at the session's first level.
    const firstTurn = levelsOf(first, [second, third]);
    expect(firstTurn.length).toBeGreaterThanOrEqual(2);
    expect(firstTurn.every((level) => level === "high")).toBe(true);
    const secondTurn = levelsOf(second, [third]);
    expect(secondTurn.length).toBeGreaterThanOrEqual(1);
    expect(secondTurn.every((level) => level === "low")).toBe(true);
    const thirdTurn = levelsOf(third, []);
    expect(thirdTurn.length).toBeGreaterThanOrEqual(1);
    expect(thirdTurn.every((level) => level === "medium")).toBe(true);
    expect(h.ofKind(spec, "turn.started").map((event) => event.effort)).toEqual(["high", "low", "medium"]);
    expect(h.kinds(spec)).not.toContain("session.crashed");
  }, 400_000);
});
