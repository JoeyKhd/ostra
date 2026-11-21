import { FAKE_SUBAGENT_TREE, fakeMarker } from "@ostra/adapter-sdk/testing";
import { approvalRuleIdSchema } from "@ostra/protocol";
import type { ApprovalRule, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "../testing/task-host-harness.ts";

// F-138 (milestone 7, ticket 39): an agent's subagents on the wire. A minor-6 runner sends each
// subagent's start and states, and names the subagent on its calls, its words and its approvals; a
// minor-5 server (inside ADR 0034's window) gets none of it, and the subagents' calls arrive flat,
// with the session's numbers gap-free. On the scripted fake agent that plays OpenCode's subagents.

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("subagents");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (options: HarnessOptions = {}): Promise<Harness> => {
  harness = await startHarness(shared, options);
  return harness;
};

const TESTS_RULE: ApprovalRule = {
  ruleId: approvalRuleIdSchema.parse("rule-tests"),
  name: "Running the tests",
  tool: "execute",
  match: { kind: "command-prefix", prefixes: ["pnpm test"] },
};

const taskOn = (h: Harness, prompt: string, approvalRules: readonly ApprovalRule[] = []): { readonly spec: TaskSpec } =>
  h.taskFor(prompt, { agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-rich", apiFormat: "anthropic-messages", approvalRules: [...approvalRules] } });

describe("subagents on the wire (F-138)", () => {
  it("F-138/c4: a subagent's start, states, calls and words reach the server as its own, and an approval inside it names it", async () => {
    const h = await start();
    const { spec } = taskOn(h, fakeMarker("subagent-tree", "ask"), [TESTS_RULE]);
    h.dispatch(spec);
    await h.waitForKind(spec, "approval.requested");
    const general = h.ofKind(spec, "subagent.started").find((event) => event.description === FAKE_SUBAGENT_TREE.general.description);
    const [requested] = h.ofKind(spec, "approval.requested");
    expect(general).toBeDefined();
    expect(requested).toMatchObject({ subagentId: general?.subagentId, subject: { kind: "command", value: FAKE_SUBAGENT_TREE.command }, rule: { ruleId: TESTS_RULE.ruleId } });
    expect(await h.waitForAck(h.command("approval-answer", { sessionId: spec.sessionId, approvalId: requested?.approvalId, decision: "allow_once" }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved");
    const started = h.ofKind(spec, "subagent.started");
    expect(started.map((event) => [event.description, event.depth, event.parentSubagentId === undefined])).toEqual([
      [FAKE_SUBAGENT_TREE.explore.description, 1, true],
      [FAKE_SUBAGENT_TREE.general.description, 1, true],
      [FAKE_SUBAGENT_TREE.nested.description, 2, false],
    ]);
    expect(started[2]?.parentSubagentId).toBe(general?.subagentId);
    expect(h.ofKind(spec, "subagent.status").filter((event) => event.status === "completed")).toHaveLength(3);
    // Each child's answer is its own message; the main agent's words are its own.
    const said = h.ofKind(spec, "agent.message").map((event) => [event.text, event.subagentId ?? null]);
    expect(said).toContainEqual([FAKE_SUBAGENT_TREE.general.answer, general?.subagentId ?? ""]);
    expect(said).toContainEqual([FAKE_SUBAGENT_TREE.mainAnswer, null]);
    expect(h.ofKind(spec, "tool.called").filter((event) => event.subagentId !== undefined).length).toBeGreaterThanOrEqual(5);
    expect(h.gateway.protocolErrors).toEqual([]);
  }, 120_000);

  it("F-138/c7: a minor-5 server gets no subagent's start or state and no subagent field: the calls arrive flat, and the session's numbers have no gap", async () => {
    // A minor-6 runner, as the window has moved on (milestone 8's minor 7 is outside a minor-5 server's).
    const h = await start({ serverMinor: 5, runnerMinor: 6 });
    const { spec } = taskOn(h, fakeMarker("subagent-tree"));
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(h.gateway.protocolErrors).toEqual([]);
    const kinds = h.kinds(spec);
    expect(kinds).not.toContain("subagent.started");
    expect(kinds).not.toContain("subagent.status");
    expect(h.eventsOf(spec).some((event) => "subagentId" in event)).toBe(false);
    // Every call is there, the children's too, as the agent's own.
    expect(h.ofKind(spec, "tool.called").length).toBeGreaterThanOrEqual(7);
    expect(h.ofKind(spec, "agent.message").map((event) => event.text)).toContain(FAKE_SUBAGENT_TREE.general.answer);
    const numbers = [...(h.gateway.stored.get(spec.sessionId)?.keys() ?? [])].sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  }, 120_000);
});
