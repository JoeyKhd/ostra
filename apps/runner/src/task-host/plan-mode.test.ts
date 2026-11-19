import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { planText } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "../testing/task-host-harness.ts";
import { porcelainPaths } from "./task-run.ts";

// Ticket 31 (F-063, ADR 0049): a plan-first task's first turn runs in plan mode. The runner sends
// the plan-mode preamble before the task's prompt, says `turn.started { mode: "plan" }`, and at the
// turn's end sends one `plan.proposed` with the turn's plan and last message. Nothing of it is
// committed or pushed, and a change it left is plan mode failing. The driver's `plan-answer`
// approves (build mode, by `session/set_mode` on `rich` and by a relaunch with `session/load` on
// `plain`) or asks for changes (plan mode again).

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("plan-mode");
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

const profiles = ["rich", "plain"] as const;

/** A plan-first task on the fake agent of `profile`. */
const planTask = (h: Harness, profile: (typeof profiles)[number], prompt: string) =>
  h.taskFor(prompt, {
    agent: { ...taskSpecFixture.agent, adapter: `fake-acp-agent-${profile}`, apiFormat: "anthropic-messages", planFirst: true },
    firstTurnMode: "plan",
  });

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");

const turnModes = (h: Harness, spec: TaskSpec): readonly (string | undefined)[] => h.ofKind(spec, "turn.started").map((event) => event.mode);

const planAnswer = (h: Harness, spec: TaskSpec, decision: "approve" | "revise", text: string): string =>
  h.command("plan-answer", { sessionId: spec.sessionId, decision, text });

describe.each(profiles)("plan mode on the %s fake agent (F-063)", (profile) => {
  it("F-063: a plan turn changes no file, pushes nothing and sends one plan.proposed with the plan and the last message", async () => {
    const h = await start();
    const { spec } = planTask(h, profile, fakeMarker("plan-turn"));
    h.dispatch(spec);
    await h.waitForKind(spec, "plan.proposed");
    const [proposed] = h.ofKind(spec, "plan.proposed");
    const [started] = h.ofKind(spec, "turn.started");
    expect(started?.mode).toBe("plan");
    expect(proposed?.turnId).toBe(started?.turnId);
    // `rich` sends a native plan; `plain` sends none, so its plan is the message alone.
    expect(proposed?.entries.map((entry) => entry.content)).toEqual(profile === "rich" ? ["Read the README", "Write CONTRIBUTING.md"] : []);
    expect(proposed?.message).toContain("I'll write CONTRIBUTING.md and link it from the README.");
    // The write was refused: by the agent's own plan mode on `rich`, by the runner on `plain`.
    expect(proposed?.message).toContain(profile === "rich" ? "write=refused" : "write=denied");
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Nothing committed, nothing pushed, no save: the session waits for the driver.
    expect(h.kinds(spec)).not.toContain("git.pushed");
    expect(h.kinds(spec)).not.toContain("session.saved");
    expect(h.ofKind(spec, "plan.proposed")).toHaveLength(1);
    expect(await shared.upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "plan-attempt.txt")).toBeNull();
    expect(h.kinds(spec)).not.toContain("session.crashed");
  }, 120_000);

  it("F-063: approve continues in build mode with the plan as approved, edited, as data", async () => {
    const h = await start();
    const { spec } = planTask(h, profile, fakeMarker("plan-turn"));
    h.dispatch(spec);
    await h.waitForKind(spec, "plan.proposed");
    const [proposed] = h.ofKind(spec, "plan.proposed");
    const shown = planText(proposed?.entries ?? [], proposed?.message ?? "");
    const approved = `${shown}\n3. Add a line to the changelog`;
    expect(await h.waitForAck(planAnswer(h, spec, "approve", approved))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved");
    expect(turnModes(h, spec)).toEqual(["plan", "build"]);
    // The approved plan reached the agent inside its marked block, edits included.
    expect(messages(h, spec)).toContain(`Read approved-plan: ${approved}`);
    // The agent is in build mode now (its own mode, by set_mode or a relaunch): it may write.
    h.steer(spec, fakeMarker("mode"));
    await h.waitForKind(spec, "session.saved", 2);
    expect(messages(h, spec)).toContain("mode: build");
    h.steer(spec, fakeMarker("write", "built.txt"));
    await h.waitForKind(spec, "session.saved", 3);
    expect(await shared.upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "built.txt")).toContain("Written by the fake agent.");
    // A plan that was answered can't be answered again.
    expect(await h.waitForAck(planAnswer(h, spec, "approve", approved))).toMatchObject({ result: "rejected", reason: "no-pending-plan" });
    expect(JSON.stringify(h.logs)).not.toContain("changelog");
  }, 120_000);

  it("F-063: revise stays in plan mode, with the request as data, and proposes again", async () => {
    const h = await start();
    const { spec } = planTask(h, profile, fakeMarker("plan-turn"));
    h.dispatch(spec);
    await h.waitForKind(spec, "plan.proposed");
    const request = "Also cover the release steps.";
    expect(await h.waitForAck(planAnswer(h, spec, "revise", request))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "plan.proposed", 2);
    expect(turnModes(h, spec)).toEqual(["plan", "plan"]);
    expect(messages(h, spec)).toContain(`Read plan-revision-request: ${request}`);
    // Still planning: the agent's own mode, and its write is still refused.
    h.steer(spec, fakeMarker("plan-turn"));
    await h.waitForKind(spec, "plan.proposed", 3);
    expect(h.ofKind(spec, "plan.proposed").at(-1)?.message).toContain(profile === "rich" ? "write=refused" : "write=denied");
    expect(h.kinds(spec)).not.toContain("git.pushed");
    expect(h.kinds(spec)).not.toContain("session.saved");
    expect(JSON.stringify(h.logs)).not.toContain(request);
  }, 120_000);
});

describe("plan answers and plan mode failing (F-063)", () => {
  it("F-063: a plan answer with no plan waiting is refused", async () => {
    const h = await start();
    const { spec } = h.taskFor(fakeMarker("say"), { agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-rich", apiFormat: "anthropic-messages" } });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(turnModes(h, spec)).toEqual(["build"]);
    expect(await h.waitForAck(planAnswer(h, spec, "approve", "1. Do it"))).toMatchObject({ result: "rejected", reason: "no-pending-plan" });
    expect(await h.waitForAck(h.command("plan-answer", { sessionId: "session-unknown", decision: "revise", text: "x" }))).toMatchObject({
      result: "rejected",
      reason: "no-pending-plan",
    });
  }, 120_000);

  it("F-063: an agent that ends its turn on a refused request is told why and finishes its plan: one plan.proposed", async () => {
    const h = await start();
    // `plain` has no reject-and-continue: the runner's refusal of the edit ends its turn.
    const { spec } = planTask(h, "plain", fakeMarker("ask-path", "notes.txt"));
    h.dispatch(spec);
    await h.waitForKind(spec, "plan.proposed");
    expect(turnModes(h, spec)).toEqual(["plan", "plan"]);
    expect(h.ofKind(spec, "turn.ended").map((event) => event.stopReason)).toEqual(["cancelled", "end_turn"]);
    expect(h.ofKind(spec, "plan.proposed")).toHaveLength(1);
    expect(h.ofKind(spec, "plan.proposed")[0]?.message).toContain("The work is done.");
    expect(h.kinds(spec)).not.toContain("approval.requested");
    expect(await shared.upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "notes.txt")).toBeNull();
  }, 120_000);

  it("F-063: a plan turn that changes a file is plan mode failing: turn.failed names the path, and nothing is committed", async () => {
    const h = await start();
    // The fake's `write` writes without asking anyone: an agent whose plan mode let a write through.
    const { spec } = planTask(h, "plain", fakeMarker("write", "leaked.txt"));
    h.dispatch(spec);
    await h.waitForKind(spec, "session.crashed");
    const failed = h.ofKind(spec, "turn.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain("test1/leaked.txt");
    expect(h.kinds(spec)).not.toContain("plan.proposed");
    expect(h.kinds(spec)).not.toContain("git.pushed");
    expect(h.kinds(spec)).not.toContain("session.saved");
    expect(await shared.upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "leaked.txt")).toBeNull();
  }, 120_000);

  it("F-063: reads every path of git's porcelain status, a rename's both sides", () => {
    expect(porcelainPaths(" M README.md\0?? docs/new file.md\0R  b.txt\0a.txt\0")).toEqual(["README.md", "docs/new file.md", "b.txt", "a.txt"]);
    expect(porcelainPaths("")).toEqual([]);
  });
});
