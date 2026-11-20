import { conversationText, createScenarioBrain, stubMarker } from "@ostra/adapter-sdk/testing";
import type { NormalizedMessage, Scenario } from "@ostra/adapter-sdk/testing";
import { PLAN_MODE_PREAMBLE, planText } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// Ticket 31 (F-063, F-024) on the agent the runner ships: the real, pinned OpenCode on the host
// executor, with a scripted stub model behind the real key proxy, as milestone 1's demo runs it.
// A plan turn changes nothing and proposes one plan (OpenCode's `todowrite`, ADR 0032); approve
// goes on in build mode; revise plans again. And the steer probe (ADR 0032): the pinned OpenCode
// advertises `_session/steering`, and a message sent mid-turn reaches its next model call, so a
// bump that drops it fails here.

/** Whether the last tool step failed, as OpenCode reports a refused or failed call to the model. */
const failedStep = (results: readonly NormalizedMessage[]): boolean =>
  results.some((result) => result.isError || /reject|denied|not allowed/i.test(result.text));

const PREAMBLE_FIRST_LINE = PLAN_MODE_PREAMBLE.split("\n")[0] ?? "";

const STEER_MARK = "steer-mark-5d1c";

const scenarios: Readonly<Record<string, Scenario>> = {
  /** A plan as OpenCode writes one (`todowrite`), an edit plan mode must refuse, then the message. */
  "plan-turn": ({ step, request, lastToolResults }) => {
    if (step === 0) {
      return {
        toolCalls: [
          {
            name: "todowrite",
            arguments: {
              todos: [
                { content: "Read notes.txt", status: "pending" },
                { content: "Edit notes.txt", status: "pending" },
              ],
            },
          },
        ],
      };
    }
    if (step === 1) {
      return { toolCalls: [{ name: "edit", arguments: { path: "notes.txt", oldString: "notes", newString: "notes, while planning" } }] };
    }
    if (step === 2) {
      const preamble = conversationText(request.messages).includes(PREAMBLE_FIRST_LINE);
      return { text: `Plan ready. preamble=${String(preamble)} edit=${failedStep(lastToolResults) ? "refused" : "made"}. I'll edit notes.txt.` };
    }
    return undefined;
  },

  /** The approved plan's turn: the edit, which build mode lets through. */
  "build-edit": ({ step, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "edit", arguments: { path: "notes.txt", oldString: "notes", newString: "notes, as planned" } }] };
    }
    return step === 1 ? { text: failedStep(lastToolResults) ? "The edit failed." : "Built: notes.txt edited." } : undefined;
  },

  /** The revision's turn: still planning, so the edit is refused again. */
  "plan-again": ({ step, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "edit", arguments: { path: "notes.txt", oldString: "notes", newString: "notes, revised" } }] };
    }
    return step === 1 ? { text: `Revised plan. edit=${failedStep(lastToolResults) ? "refused" : "made"}.` } : undefined;
  },

  /** A slow shell step, then whether the steer reached this call (the steer probe). */
  "slow-step": ({ step, since }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "shell", arguments: { command: `node -e "setTimeout(() => console.log('slept'), 6000)"`, description: "sleep a while" } }] };
    }
    return step === 1 ? { text: `steer seen: ${String(conversationText(since).includes(STEER_MARK))}` } : undefined;
  },
};

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("plan-mode-opencode", { brain: createScenarioBrain(scenarios) });
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (): Promise<Harness> => {
  harness = await startHarness(shared, { agents: defaultAgents() });
  return harness;
};

const taskOn = (h: Harness, prompt: string, planFirst: boolean) =>
  h.taskFor(prompt, {
    agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: "stub-model", planFirst },
    environment: { ...taskSpecFixture.environment, setupScript: null },
    ...(planFirst ? { firstTurnMode: "plan" as const } : {}),
  });

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");

const planAnswer = (h: Harness, spec: TaskSpec, decision: "approve" | "revise", text: string): string =>
  h.command("plan-answer", { sessionId: spec.sessionId, decision, text });

describe("plan mode on OpenCode, with the stub models (F-063)", () => {
  it("F-063/c1,c2,c4: a plan turn changes no file and sends one plan.proposed; approve goes on in build mode", async () => {
    const h = await start();
    const { spec } = taskOn(h, `${stubMarker("plan-turn")} Plan the notes change.`, true);
    h.dispatch(spec);
    await h.waitForKind(spec, "plan.proposed", 1, 150_000);
    const [proposed] = h.ofKind(spec, "plan.proposed");
    expect(h.ofKind(spec, "turn.started")[0]?.mode).toBe("plan");
    // OpenCode's `todowrite` is the plan (ADR 0032), and the preamble came before the task's prompt.
    expect(proposed?.entries.map((entry) => entry.content)).toEqual(["Read notes.txt", "Edit notes.txt"]);
    expect(proposed?.message).toContain("preamble=true");
    expect(proposed?.message).toContain("edit=refused");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(h.kinds(spec)).not.toContain("git.pushed");
    expect(h.kinds(spec)).not.toContain("session.saved");
    expect(h.kinds(spec)).not.toContain("session.crashed");
    // Approve, edited: the member's plan carries the next step's script.
    const approved = `${planText(proposed?.entries ?? [], proposed?.message ?? "")}\n3. ${stubMarker("build-edit")}`;
    expect(await h.waitForAck(planAnswer(h, spec, "approve", approved))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    // OpenCode ends its turn on a refused request, so the plan may take a re-prompt: plan turns, one plan, then build.
    const modes = h.ofKind(spec, "turn.started").map((event) => event.mode);
    expect(modes.at(-1)).toBe("build");
    expect(modes.slice(0, -1).every((each) => each === "plan")).toBe(true);
    expect(h.ofKind(spec, "plan.proposed")).toHaveLength(1);
    expect(messages(h, spec)).toContain("Built: notes.txt edited.");
    expect(await shared.upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "notes.txt")).toContain("notes, as planned");
  }, 300_000);

  it("F-063/c2: revise stays in plan mode on OpenCode, and proposes again", async () => {
    const h = await start();
    const { spec } = taskOn(h, `${stubMarker("plan-turn")} Plan the notes change.`, true);
    h.dispatch(spec);
    await h.waitForKind(spec, "plan.proposed", 1, 150_000);
    expect(await h.waitForAck(planAnswer(h, spec, "revise", `Change the plan. ${stubMarker("plan-again")}`))).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "plan.proposed", 2, 150_000);
    expect(h.ofKind(spec, "turn.started").every((event) => event.mode === "plan")).toBe(true);
    expect(h.ofKind(spec, "plan.proposed")[1]?.message).toContain("Revised plan. edit=refused.");
    expect(h.kinds(spec)).not.toContain("git.pushed");
    expect(await shared.upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "notes.txt")).toBeNull();
  }, 300_000);
});

describe("the steer probe on the pinned OpenCode (F-024, ADR 0032)", () => {
  it("F-024/c2: OpenCode advertises mid-turn steering, and a message sent during a tool step reaches its next model call", async () => {
    const h = await start();
    const { spec } = taskOn(h, `${stubMarker("slow-step")} Sleep, then answer.`, false);
    h.dispatch(spec);
    await h.waitForKind(spec, "tool.called", 1, 150_000);
    // "Send" mid-turn: steered into the turn (`done`), not queued for after it (`accepted`).
    const sent = h.command("steer", { sessionId: spec.sessionId, clientMessageId: "probe-steer", text: `Also note ${STEER_MARK}.`, delivery: "queue" });
    expect(await h.waitForAck(sent)).toMatchObject({ result: "done" });
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    expect(messages(h, spec)).toContain("steer seen: true");
    // One turn: the steer went into it, not after it.
    expect(h.kinds(spec).filter((kind) => kind === "turn.started")).toHaveLength(1);
  }, 300_000);
});
