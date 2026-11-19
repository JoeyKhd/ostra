import { conversationText, createScenarioBrain, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import { approvalRuleIdSchema, readMarkedBlocks, taskApprovalRuleIdSchema } from "@ostra/protocol";
import type { ApprovalRule, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { manualTimers, startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// Ticket 30 (F-026, F-024) on the agent the runner ships: the real, pinned OpenCode on the host
// executor, with a scripted stub model behind the real key proxy, as milestone 1's demo runs it.
// OpenCode asks the runner before each call of a tool a rule watches (`runner-only`), and the
// runner holds what a profile rule covers for a person's answer.

const MINUTE = 60_000;

/** The text of the last deny-reason block the model was shown, if any. */
const denyReasonSeen = (text: string): string | undefined => readMarkedBlocks(text).findLast((block) => block.label === "deny-reason")?.text;

/** Whether the last tool step failed, as OpenCode reports a refused or failed call to the model. */
const failedStep = (results: readonly { readonly isError?: boolean; readonly text: string }[]): boolean =>
  results.some((result) => result.isError === true || /reject|denied|not allowed/i.test(result.text));

const scenarios: Readonly<Record<string, Scenario>> = {
  /** One edit of notes.txt, then a line that says whether it went through, or what a deny said. */
  "edit-notes": ({ step, since, lastToolResults }) => {
    const reason = denyReasonSeen(conversationText(since));
    if (reason !== undefined) {
      return { text: `Read deny-reason: ${reason}` };
    }
    if (step === 0) {
      return { toolCalls: [{ name: "edit", arguments: { path: "notes.txt", oldString: "notes", newString: "notes, from OpenCode" } }] };
    }
    return step === 1 ? { text: failedStep(lastToolResults) ? "The edit failed." : "Edited notes.txt." } : undefined;
  },

  /** Two edits in one step: two requests held at once. */
  "edit-pair": ({ step, since }) => {
    const reason = denyReasonSeen(conversationText(since));
    if (reason !== undefined) {
      return { text: `Read deny-reason: ${reason}` };
    }
    if (step === 0) {
      return {
        toolCalls: [
          { name: "edit", arguments: { path: "notes.txt", oldString: "notes", newString: "notes, a" } },
          { name: "edit", arguments: { path: "README.md", oldString: "# test1", newString: "# test1, b" } },
        ],
      };
    }
    return step === 1 ? { text: "Both edits are done." } : undefined;
  },

  /** Two commands, one step after the other, then a third on the next turn's marker. */
  "two-commands": ({ step, lastToolResults }) => {
    if (step === 0 || step === 1) {
      const which = step === 0 ? "one" : "two";
      return { toolCalls: [{ name: "shell", arguments: { command: `node -e "console.log('ran-${which}')"`, description: `run ${which}` } }] };
    }
    return step === 2 ? { text: `Commands done: ${lastToolResults.some((result) => result.text.includes("ran-two")) ? "both ran" : "the second didn't run"}.` } : undefined;
  },

  /** One more command, for the turn after a task rule was added. */
  "one-command": ({ step, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "shell", arguments: { command: `node -e "console.log('ran-three')"`, description: "run three" } }] };
    }
    return step === 1 ? { text: lastToolResults.some((result) => result.text.includes("ran-three")) ? "The third ran." : "The third didn't run." } : undefined;
  },

  /** OpenCode's question tool, then a line that quotes the tool's result. */
  question: ({ step, lastToolResults }) => {
    if (step === 0) {
      return {
        toolCalls: [
          {
            name: "question",
            arguments: {
              questions: [
                {
                  question: "Which colour should the button be?",
                  header: "Colour",
                  options: [
                    { label: "red", description: "A red button" },
                    { label: "blue", description: "A blue button" },
                  ],
                },
              ],
            },
          },
        ],
      };
    }
    return step === 1 ? { text: `answer seen: ${lastToolResults.map((result) => result.text).join(" ").slice(0, 300)}` } : undefined;
  },
};

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("approvals-opencode", { brain: createScenarioBrain(scenarios) });
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (options: HarnessOptions = {}): Promise<Harness> => {
  harness = await startHarness(shared, { agents: defaultAgents(), ...options });
  return harness;
};

const rule = (id: string, tool: ApprovalRule["tool"], match: ApprovalRule["match"]): ApprovalRule => ({
  ruleId: approvalRuleIdSchema.parse(id),
  name: `Rule ${id}`,
  tool,
  match,
});

const NOTES_RULE = rule("rule-notes", "edit", { kind: "path-glob", glob: "notes*.txt" });
const README_RULE = rule("rule-readme", "edit", { kind: "path-glob", glob: "README.md" });
const NODE_RULE = rule("rule-node", "execute", { kind: "command-prefix", prefixes: ["node -e"] });

const taskOn = (h: Harness, prompt: string, approvalRules: readonly ApprovalRule[]) =>
  h.taskFor(prompt, {
    agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: "stub-model", approvalRules: [...approvalRules] },
    environment: { ...taskSpecFixture.environment, setupScript: null },
  });

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");
const answer = (h: Harness, spec: TaskSpec, body: Record<string, unknown>): string => h.command("approval-answer", { sessionId: spec.sessionId, ...body });

describe("approvals on OpenCode, with the stub models (F-026)", () => {
  it("F-026: a rule asks, OpenCode's request is held with the rule and its path, and the answer lets the edit through", async () => {
    const h = await start();
    const { spec } = taskOn(h, `${stubMarker("edit-notes")} Edit the notes.`, [NOTES_RULE]);
    h.dispatch(spec);
    await h.waitForKind(spec, "approval.requested", 1, 150_000);
    const [requested] = h.ofKind(spec, "approval.requested");
    expect(requested).toMatchObject({ rule: { source: "profile", ruleId: NOTES_RULE.ruleId }, subject: { kind: "path", value: "notes.txt" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(h.kinds(spec)).not.toContain("turn.ended");
    expect(await h.waitForAck(answer(h, spec, { approvalId: requested?.approvalId, decision: "allow_once" }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    expect(messages(h, spec)).toContain("Edited notes.txt.");
    expect(await shared.upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "notes.txt")).toContain("notes, from OpenCode");
  }, 240_000);

  it("F-026: \"for this task\" answers the request, and its task rule answers the next two with no person", async () => {
    const h = await start();
    const { spec } = taskOn(h, `${stubMarker("two-commands")} Run two commands.`, [NODE_RULE]);
    h.dispatch(spec);
    await h.waitForKind(spec, "approval.requested", 1, 150_000);
    const [first] = h.ofKind(spec, "approval.requested");
    expect(first).toMatchObject({ rule: { source: "profile", ruleId: NODE_RULE.ruleId }, subject: { kind: "command" } });
    const taskRule = { ruleId: taskApprovalRuleIdSchema.parse("task-rule-node-e"), tool: "execute", pattern: "node -e" };
    expect(await h.waitForAck(answer(h, spec, { approvalId: first?.approvalId, decision: "allow_task", taskRule }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    expect(messages(h, spec)).toContain("Commands done: both ran.");
    const second = h.ofKind(spec, "approval.requested")[1];
    expect(second).toMatchObject({ rule: { source: "task", ruleId: taskRule.ruleId } });
    expect(h.ofKind(spec, "approval.auto_answered")).toEqual([{ kind: "approval.auto_answered", approvalId: second?.approvalId, ruleId: taskRule.ruleId }]);
    // The next turn's command is answered by the rule too.
    h.steer(spec, `${stubMarker("one-command")} One more.`);
    await h.waitForKind(spec, "session.saved", 2, 150_000);
    expect(messages(h, spec)).toContain("The third ran.");
    expect(h.ofKind(spec, "approval.auto_answered")).toHaveLength(2);
  }, 240_000);

  it("F-026: a deny ends OpenCode's turn before its next request, and re-prompts with the member's reason", async () => {
    const h = await start();
    const { spec } = taskOn(h, `${stubMarker("edit-pair")} Edit both files.`, [NOTES_RULE, README_RULE]);
    h.dispatch(spec);
    // OpenCode asks one request at a time: the second edit waits behind the first.
    await h.waitForKind(spec, "approval.requested", 1, 150_000);
    const [denied] = h.ofKind(spec, "approval.requested");
    expect(denied).toMatchObject({ subject: { kind: "path", value: "notes.txt" } });
    const reason = "Keep the notes as they are.";
    expect(await h.waitForAck(answer(h, spec, { approvalId: denied?.approvalId, decision: "deny", reason }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved", 2, 150_000);
    // The second edit was never asked for: the deny ended the turn first, and nothing was left held.
    expect(h.ofKind(spec, "approval.requested")).toHaveLength(1);
    expect(h.kinds(spec)).not.toContain("approval.closed");
    expect(h.kinds(spec).filter((kind) => kind === "turn.started")).toHaveLength(2);
    expect(messages(h, spec)).toContain(`Read deny-reason: ${reason}`);
    expect(h.ofKind(spec, "session.saved").flatMap((saved) => saved.repos.map((repo) => repo.ahead))).toEqual([false, false]);
    expect(JSON.stringify(h.logs)).not.toContain(reason);
  }, 240_000);

  it("F-026: a request no one answers in 15 minutes cancels OpenCode's turn, and the session goes on", async () => {
    const timers = manualTimers();
    const h = await start({ host: { timers } });
    const { spec } = taskOn(h, `${stubMarker("edit-notes")} Edit the notes.`, [NOTES_RULE]);
    h.dispatch(spec);
    await h.waitForKind(spec, "approval.requested", 1, 150_000);
    const [requested] = h.ofKind(spec, "approval.requested");
    timers.advance(15 * MINUTE);
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    expect(h.ofKind(spec, "approval.closed")).toEqual([{ kind: "approval.closed", approvalId: requested?.approvalId, reason: "expired" }]);
    expect(h.ofKind(spec, "turn.ended")[0]).toMatchObject({ stopReason: "cancelled" });
    expect(h.kinds(spec)).not.toContain("session.ended");
    // The edit never ran: nothing to push.
    expect(h.ofKind(spec, "session.saved").flatMap((saved) => saved.repos.map((repo) => repo.ahead))).toEqual([false]);
  }, 240_000);

  it("F-024: OpenCode's question is held, and the driver's answer reaches the model", async () => {
    const h = await start();
    const { spec } = taskOn(h, `${stubMarker("question")} Pick a colour.`, []);
    h.dispatch(spec);
    await h.waitForKind(spec, "question.asked", 1, 150_000);
    const [asked] = h.ofKind(spec, "question.asked");
    // The member's own answer, in the custom field where OpenCode offers one: none of the options.
    const fields = asked?.fields ?? [];
    const custom = fields.find((field) => field.id.endsWith("_custom")) ?? fields[0];
    expect(custom).toBeDefined();
    const answers = { [custom?.id ?? "none"]: "teal-7f3a" };
    expect(await h.waitForAck(h.command("question-answer", { sessionId: spec.sessionId, questionId: asked?.questionId, answers }))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    expect(messages(h, spec)).toContain("teal-7f3a");
    expect(JSON.stringify(h.logs)).not.toContain("teal-7f3a");
  }, 240_000);
});
