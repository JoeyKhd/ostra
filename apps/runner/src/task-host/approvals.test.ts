import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { approvalRuleIdSchema, boxIdSchema, taskApprovalRuleIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ApprovalRule, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { manualTimers, startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, HarnessOptions, ManualTimers, Shared } from "../testing/task-host-harness.ts";

// Ticket 30 (F-026, ADR 0049, ADR 0036, ADR 0032): the runner holds what a rule says needs a
// person, answers it with the panel's answer, answers a task rule's matches itself, re-prompts after
// a deny with the reason as data, cancels a turn whose request waited 15 minutes, and hands the
// driver's answers to a question to the agent. On both scripted fake agents: `rich` writes the rules
// into its own settings (`native`), `plain` asks for every request (`runner-only`). And on the
// sidecar's connection, which core's outbox sends a `docker` box's answers to (Q129).

const MINUTE = 60_000;

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("approvals");
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

const rule = (id: string, tool: ApprovalRule["tool"], match: ApprovalRule["match"]): ApprovalRule => ({
  ruleId: approvalRuleIdSchema.parse(id),
  name: `Rule ${id}`,
  tool,
  match,
});

const NOTES_RULE = rule("rule-notes", "edit", { kind: "path-glob", glob: "notes*.txt" });
const DEPENDENCY_RULE = rule("rule-dependency", "execute", { kind: "command-prefix", prefixes: ["pnpm add"] });
const PAIR_RULE = rule("rule-pair", "edit", { kind: "path-glob", glob: "pair-*.txt" });

const profiles = ["rich", "plain"] as const;

/** A task on the fake agent of `profile`, with the profile's rules. */
const taskOn = (h: Harness, profile: (typeof profiles)[number], prompt: string, approvalRules: readonly ApprovalRule[], patch: Partial<TaskSpec> = {}) =>
  h.taskFor(prompt, {
    agent: { ...taskSpecFixture.agent, adapter: `fake-acp-agent-${profile}`, apiFormat: "anthropic-messages", approvalRules: [...approvalRules] },
    ...patch,
  });

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");

const answer = (h: Harness, spec: TaskSpec, body: Record<string, unknown>): string => h.command("approval-answer", { sessionId: spec.sessionId, ...body });

describe.each(profiles)("approvals on the %s fake agent (F-026)", (profile) => {
  it("F-026/c3,c4: a rule asks, the request is held with its rule and subject, and a person's answer goes through", async () => {
    const h = await start();
    const { spec } = taskOn(h, profile, fakeMarker("ask-path", "notes.txt"), [NOTES_RULE]);
    h.dispatch(spec);
    await h.waitForKind(spec, "approval.requested");
    const [requested] = h.ofKind(spec, "approval.requested");
    expect(requested).toMatchObject({ rule: { source: "profile", ruleId: NOTES_RULE.ruleId, name: NOTES_RULE.name }, subject: { kind: "path", value: "notes.txt" } });
    // Held: nothing is written, and the turn waits.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.kinds(spec)).not.toContain("turn.ended");
    expect(await h.waitForAck(answer(h, spec, { approvalId: requested?.approvalId, decision: "allow_once" }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved");
    expect(messages(h, spec)).toContain("Wrote notes.txt.");
    expect(await shared.upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "notes.txt")).toContain("Written by the fake agent.");
    expect(h.kinds(spec)).not.toContain("approval.auto_answered");
  }, 120_000);

  it("F-026/c2: without a rule that covers it, the agent works freely: no person is asked", async () => {
    const h = await start();
    const { spec } = taskOn(h, profile, fakeMarker("ask-path", "free.txt"), [NOTES_RULE]);
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(h.kinds(spec)).not.toContain("approval.requested");
    expect(messages(h, spec)).toContain("Wrote free.txt.");
  }, 120_000);

  it("F-026/c4,c6: \"for this task\" answers the agent once, the task rule answers the other held request and the next one", async () => {
    const h = await start();
    const { spec } = taskOn(h, profile, fakeMarker("ask-commands", "pnpm add zod; pnpm add vitest"), [DEPENDENCY_RULE]);
    h.dispatch(spec);
    await h.waitForKind(spec, "approval.requested", 2);
    const [first, second] = h.ofKind(spec, "approval.requested");
    const taskRule = { ruleId: taskApprovalRuleIdSchema.parse("task-rule-pnpm-add"), tool: "execute", pattern: "pnpm add" };
    expect(await h.waitForAck(answer(h, spec, { approvalId: first?.approvalId, decision: "allow_task", taskRule }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved");
    // The second held request was answered by the new rule, at once.
    expect(h.ofKind(spec, "approval.auto_answered")).toEqual([{ kind: "approval.auto_answered", approvalId: second?.approvalId, ruleId: taskRule.ruleId }]);
    expect(messages(h, spec)).toContain("commands: pnpm add zod=allowed, pnpm add vitest=allowed");
    // The next request the rule covers is answered by it, with no person.
    h.steer(spec, fakeMarker("ask-command", "pnpm add tsx"));
    await h.waitForKind(spec, "session.saved", 2);
    const requests = h.ofKind(spec, "approval.requested");
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({ rule: { source: "task", ruleId: taskRule.ruleId }, subject: { kind: "command", value: "pnpm add tsx" } });
    expect(h.ofKind(spec, "approval.auto_answered").map((event) => event.approvalId)).toEqual([second?.approvalId, requests[2]?.approvalId]);
    expect(messages(h, spec)).toContain("Ran pnpm add tsx.");
  }, 120_000);

  it("F-026/c8: a deny ends the turn, closes the other held requests as cancelled, and re-prompts with the member's reason", async () => {
    const h = await start();
    const { spec } = taskOn(h, profile, fakeMarker("ask-pair"), [PAIR_RULE]);
    h.dispatch(spec);
    await h.waitForKind(spec, "approval.requested", 2);
    const [denied, other] = h.ofKind(spec, "approval.requested");
    const reason = "Keep the notes in docs/ instead.";
    expect(await h.waitForAck(answer(h, spec, { approvalId: denied?.approvalId, decision: "deny", reason }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved", 2);
    expect(h.ofKind(spec, "approval.closed")).toEqual([{ kind: "approval.closed", approvalId: other?.approvalId, reason: "cancelled" }]);
    // Two turns: the denied one, then the re-prompt, whose reason reached the agent as a marked block.
    const kinds = h.kinds(spec);
    expect(kinds.filter((kind) => kind === "turn.started")).toHaveLength(2);
    expect(kinds.indexOf("approval.closed")).toBeLessThan(kinds.lastIndexOf("turn.started"));
    expect(messages(h, spec)).toContain(`Read deny-reason: ${reason}`);
    // Neither edit was made: no turn left a change to push.
    expect(h.ofKind(spec, "session.saved").flatMap((saved) => saved.repos.map((repo) => repo.ahead))).toEqual([false, false]);
    // Nothing of the reason is in a log line.
    expect(JSON.stringify(h.logs)).not.toContain(reason);
  }, 120_000);

  it("F-026/c4: an answer for a request that's gone is refused", async () => {
    const h = await start();
    const { spec } = taskOn(h, profile, fakeMarker("say"), []);
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(await h.waitForAck(answer(h, spec, { approvalId: "approval-gone", decision: "allow_once" }))).toMatchObject({ result: "rejected", reason: "no-pending-approval" });
  }, 120_000);

  it("F-024: the driver's answers to a question reach the agent, and an unknown question is refused", async () => {
    const h = await start();
    const { spec } = taskOn(h, profile, fakeMarker("elicit"), []);
    h.dispatch(spec);
    await h.waitForKind(spec, "question.asked");
    const [asked] = h.ofKind(spec, "question.asked");
    expect(
      await h.waitForAck(h.command("question-answer", { sessionId: spec.sessionId, questionId: "question-unknown", answers: { name: "orders" } })),
    ).toMatchObject({ result: "rejected", reason: "no-pending-question" });
    const answers = { name: "orders", engine: "postgres", replicas: "2" };
    expect(await h.waitForAck(h.command("question-answer", { sessionId: spec.sessionId, questionId: asked?.questionId, answers }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved");
    expect(messages(h, spec)).toContain('answered: {"name":"orders","engine":"postgres","replicas":2}');
    expect(h.kinds(spec)).not.toContain("question.closed");
    expect(JSON.stringify(h.logs)).not.toContain("orders");
  }, 120_000);
});

describe("a held request's wait (F-026)", () => {
  let timers: ManualTimers;

  it.each(profiles)("F-026: an approval no one answers in 15 minutes cancels the turn on the %s fake agent, and the session goes on", async (profile) => {
    timers = manualTimers();
    const h = await start({ host: { timers } });
    const { spec } = taskOn(h, profile, fakeMarker("ask-path", "notes.txt"), [NOTES_RULE]);
    h.dispatch(spec);
    await h.waitForKind(spec, "approval.requested");
    const [requested] = h.ofKind(spec, "approval.requested");
    timers.advance(15 * MINUTE - 1_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.kinds(spec)).not.toContain("approval.closed");
    timers.advance(1_000);
    await h.waitForKind(spec, "session.saved");
    expect(h.ofKind(spec, "approval.closed")).toEqual([{ kind: "approval.closed", approvalId: requested?.approvalId, reason: "expired" }]);
    expect(h.ofKind(spec, "turn.ended")[0]).toMatchObject({ stopReason: "cancelled" });
    expect(h.kinds(spec)).not.toContain("session.ended");
    // The item stays open on the server; the runner has nothing to answer any more.
    expect(await h.waitForAck(answer(h, spec, { approvalId: requested?.approvalId, decision: "allow_once" }))).toMatchObject({ result: "rejected", reason: "no-pending-approval" });
    // The session still takes a turn.
    h.steer(spec, fakeMarker("say"));
    await h.waitForKind(spec, "session.saved", 2);
  }, 120_000);

  it("F-024: a question no one answers in 15 minutes cancels the turn", async () => {
    timers = manualTimers();
    const h = await start({ host: { timers } });
    const { spec } = taskOn(h, "rich", fakeMarker("elicit"), []);
    h.dispatch(spec);
    await h.waitForKind(spec, "question.asked");
    timers.advance(15 * MINUTE);
    await h.waitForKind(spec, "session.saved");
    expect(h.ofKind(spec, "question.closed")[0]).toMatchObject({ reason: "expired" });
    expect(messages(h, spec)).toContain("no answer: cancel");
  }, 120_000);
});

describe("approvals through a box's sidecar (F-026, Q129)", () => {
  it("F-026: the sidecar's connection holds the request and takes the answer, as the runner's does on host", async () => {
    // As `ostra sidecar` connects: one task, one box, its own peer.
    const taskId = taskIdSchema.parse(`0196f1a0-m2-sidecar-${String(Date.now())}`);
    const boxId = boxIdSchema.parse(`box-sidecar-${String(Date.now())}`);
    const h = await start({ peer: { kind: "sidecar", taskId, boxId, leaseEpoch: taskSpecFixture.leaseEpoch }, host: { capacity: 1, executorKind: "docker" } });
    const { spec } = taskOn(h, "plain", fakeMarker("ask-path", "notes.txt"), [NOTES_RULE], { taskId });
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "approval.requested");
    const [requested] = h.ofKind(spec, "approval.requested");
    expect(h.gateway.hellos.at(-1)?.peer).toMatchObject({ kind: "sidecar", taskId, boxId });
    expect(await h.waitForAck(answer(h, spec, { approvalId: requested?.approvalId, decision: "allow_once" }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved");
    expect(messages(h, spec)).toContain("Wrote notes.txt.");
  }, 120_000);
});
