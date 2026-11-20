import { FakeAgentAdapter, fakeMarker } from "@ostra/adapter-sdk/testing";
import type { EffortModel, PrepareLaunchInput } from "@ostra/adapter-sdk";
import { orderedEffortLevels } from "@ostra/adapter-sdk";
import { boxIdSchema, clientMessageIdSchema, gitShaSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { BlobRef, BoxId, EffortLevel, ExecutorKind, Peer, ReasoningControls, TaskEvent, TaskSpec, TaskSpecRestore } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { harnessAgents, startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { createAgentRegistry } from "./agents.ts";
import type { AgentFactory } from "./agents.ts";

// Ticket 60 (F-137, ADR 0066) with the scripted fakes: the runner sets the session's reasoning level
// after every `session/new` and `session/load`, before the first prompt; a driver's `set-effort` is
// applied once, before the next prompt (held during a turn, at once while the session waits), so
// every turn runs at one level, which its `turn.started` names. The fake's `effort` script says the
// session's level and every value set on it, and each set shows as `session.config_changed`.
// Runner parity: every case runs on `host` and through a `docker` box's sidecar, which core sends a
// box's commands to (Q129).

const MODEL_LEVELS: ReasoningControls = { supported: true, effort: ["low", "medium", "high", "max"] };

/**
 * A `none` fake whose model advertises a `thought_level` option anyway: if anything called
 * `session/set_config_option` on an agent with `none`, the fake would record it.
 */
const noneButAdvertising: AgentFactory = (driver) => {
  const agent = new FakeAgentAdapter("rich", driver);
  agent.effortLevels = (model: EffortModel): readonly EffortLevel[] =>
    model.reasoning.supported ? orderedEffortLevels(model.reasoning.effort ?? []) : ["default"];
  return agent;
};

/** Every launch's model, as the runner handed it to `prepareLaunch`. */
const launchedModels: PrepareLaunchInput["model"][] = [];

/** A `session-option` fake that records the model each launch is prepared with. */
const recordingLaunch: AgentFactory = (driver) => {
  const agent = new FakeAgentAdapter("rich", driver, undefined, "mcp", "session-option");
  const prepare = agent.prepareLaunch.bind(agent);
  agent.prepareLaunch = (input: PrepareLaunchInput) => {
    launchedModels.push(input.model);
    return prepare(input);
  };
  return agent;
};

const agents = createAgentRegistry({
  "fake-acp-agent-recording-launch": recordingLaunch,
  ...harnessAgents,
  "fake-acp-agent-rich-effort": (driver) => new FakeAgentAdapter("rich", driver, undefined, "mcp", "session-option"),
  "fake-acp-agent-plain-effort": (driver) => new FakeAgentAdapter("plain", driver, undefined, "mcp", "session-option"),
  "fake-acp-agent-none-advertising": noneButAdvertising,
});

let shared: Shared;
const harnesses: Harness[] = [];

beforeAll(async () => {
  shared = await startShared("effort");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
}, 120_000);

type Placement = { readonly name: string; readonly executorKind: ExecutorKind; readonly sidecar: boolean };
const placements: readonly Placement[] = [
  { name: "host", executorKind: "host", sidecar: false },
  { name: "a docker box's sidecar", executorKind: "docker", sidecar: true },
];

let tasks = 0;

/** A runner on `placement`, and a task for it: a sidecar connects for one task and one box. */
const runnerFor = async (placement: Placement): Promise<{ readonly h: Harness; readonly taskId: TaskSpec["taskId"]; readonly boxId: BoxId }> => {
  tasks += 1;
  const taskId = taskIdSchema.parse(`0196f1a0-effort-${String(tasks)}-${String(Date.now())}`);
  const boxId = boxIdSchema.parse(`box-effort-${String(tasks)}-${String(Date.now())}`);
  const peer: Peer | undefined = placement.sidecar ? { kind: "sidecar", taskId, boxId, leaseEpoch: taskSpecFixture.leaseEpoch } : undefined;
  const h = await startHarness(shared, { agents, host: { capacity: 2, executorKind: placement.executorKind }, ...(peer === undefined ? {} : { peer }) });
  harnesses.push(h);
  return { h, taskId, boxId };
};

const taskOn = (h: Harness, taskId: TaskSpec["taskId"], prompt: string, effort: EffortLevel, adapter = "fake-acp-agent-rich-effort", reasoning = MODEL_LEVELS): TaskSpec =>
  h.taskFor(prompt, { taskId, agent: { ...taskSpecFixture.agent, adapter, apiFormat: "anthropic-messages", effort, reasoning } }).spec;

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");

/** The levels the agent was set to, as `session.config_changed` says: the fake's option is `reasoning`. */
const levelsSet = (h: Harness, spec: TaskSpec): readonly string[] =>
  h.ofKind(spec, "session.config_changed").filter((event) => event.key === "reasoning").map((event) => event.value);

const indexOf = (events: readonly TaskEvent[], match: (event: TaskEvent) => boolean, nth = 0): number => {
  let seen = 0;
  for (const [index, event] of events.entries()) {
    if (match(event)) {
      if (seen === nth) {
        return index;
      }
      seen += 1;
    }
  }
  return -1;
};

let changes = 0;
const setEffort = (h: Harness, spec: TaskSpec, level: EffortLevel, changeId?: string): { readonly id: string; readonly changeId: string } => {
  changes += 1;
  const change = changeId ?? `0196f1a0-change-${String(changes)}`;
  return { id: h.command("set-effort", { sessionId: spec.sessionId, level, changeId: change }), changeId: change };
};

describe.each(placements)("reasoning effort over ACP on $name (F-137)", (placement) => {
  it("F-137/c5,c14: the level is set after session/new, before the first prompt, and turn.started names it", async () => {
    const { h, taskId, boxId } = await runnerFor(placement);
    const spec = taskOn(h, taskId, fakeMarker("effort"), "high");
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "session.saved");
    expect(messages(h, spec)).toContain("effort: high set: high");
    const events = h.eventsOf(spec);
    // Set once, before the turn began.
    expect(levelsSet(h, spec)).toEqual(["high"]);
    expect(indexOf(events, (event) => event.kind === "session.config_changed")).toBeLessThan(indexOf(events, (event) => event.kind === "turn.started"));
    const [started] = h.ofKind(spec, "turn.started");
    expect(started?.effort).toBe("high");
    expect(started).not.toHaveProperty("adjustedFrom");
  }, 120_000);

  it("F-137/c9,c14: a level the agent doesn't advertise is clamped, and turn.started carries the level and adjustedFrom", async () => {
    const { h, taskId, boxId } = await runnerFor(placement);
    // `xhigh` sits between `high` and `max`: the higher of two equally near.
    const spec = taskOn(h, taskId, fakeMarker("effort"), "xhigh");
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "session.saved");
    expect(messages(h, spec)).toContain("effort: max set: max");
    expect(h.ofKind(spec, "turn.started")[0]).toMatchObject({ effort: "max", adjustedFrom: "xhigh" });
  }, 120_000);

  it("F-137/c10: the launch gets the model's own controls and real limits from the spec, and none it doesn't carry", async () => {
    const { h, taskId, boxId } = await runnerFor(placement);
    const limits = { contextWindow: 1_000_000, maxOutputTokens: 128_000 };
    const spec = h.taskFor(fakeMarker("effort"), {
      taskId,
      agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-recording-launch", apiFormat: "anthropic-messages", effort: "high", reasoning: MODEL_LEVELS, limits },
    }).spec;
    const before = launchedModels.length;
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "session.saved");
    expect(launchedModels.slice(before)).toEqual([expect.objectContaining({ reasoning: MODEL_LEVELS, limits })]);

    // A spec without them (a custom model with no limits): the launch carries none, and the adapter keeps its fixed ones.
    const other = await runnerFor(placement);
    const bare = other.h.taskFor(fakeMarker("effort"), { taskId: other.taskId, agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-recording-launch", apiFormat: "anthropic-messages" } }).spec;
    const mark = launchedModels.length;
    other.h.dispatch(bare, other.boxId);
    await other.h.waitForKind(bare, "session.saved");
    const [launched] = launchedModels.slice(mark);
    expect(launched).toBeDefined();
    expect(launched).not.toHaveProperty("limits");
  }, 120_000);

  it("F-137/c5: Default sets nothing on a new session; the turn runs at the agent's default", async () => {
    const { h, taskId, boxId } = await runnerFor(placement);
    const spec = taskOn(h, taskId, fakeMarker("effort"), "default");
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "session.saved");
    expect(messages(h, spec)).toContain("effort: default set: ");
    expect(levelsSet(h, spec)).toEqual([]);
    expect(h.ofKind(spec, "turn.started")[0]?.effort).toBe("default");
  }, 120_000);

  it("F-137/c8,c14: a set-effort during a turn changes nothing of that turn; it's applied before the next prompt", async () => {
    const { h, taskId, boxId } = await runnerFor(placement);
    // `plain` has no mid-turn steering: the message waits for the next turn.
    const spec = taskOn(h, taskId, fakeMarker("long", "2"), "high", "fake-acp-agent-plain-effort");
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "turn.started");
    // During the turn: held for the next one.
    expect(await h.waitForAck(setEffort(h, spec, "low").id)).toMatchObject({ result: "accepted" });
    h.steer(spec, fakeMarker("effort"));
    await h.waitForKind(spec, "session.saved", 2);
    const events = h.eventsOf(spec);
    const lowSet = indexOf(events, (event) => event.kind === "session.config_changed" && event.value === "low");
    // Applied after the running turn ended, and before the next began.
    expect(lowSet).toBeGreaterThan(indexOf(events, (event) => event.kind === "turn.ended"));
    expect(lowSet).toBeLessThan(indexOf(events, (event) => event.kind === "turn.started", 1));
    expect(h.ofKind(spec, "turn.started").map((event) => event.effort)).toEqual(["high", "low"]);
    expect(messages(h, spec)).toContain("effort: low set: high,low");
  }, 120_000);

  it("F-137/c8,c14: a set-effort while the session waits is applied at once, and reaches the next prompt", async () => {
    const { h, taskId, boxId } = await runnerFor(placement);
    const spec = taskOn(h, taskId, fakeMarker("say"), "high");
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "session.saved");
    expect(await h.waitForAck(setEffort(h, spec, "medium").id)).toMatchObject({ result: "done" });
    // Set before any turn asked for it.
    expect(levelsSet(h, spec)).toEqual(["high", "medium"]);
    expect(h.ofKind(spec, "turn.started")).toHaveLength(1);
    h.steer(spec, fakeMarker("effort"));
    await h.waitForKind(spec, "session.saved", 2);
    expect(messages(h, spec)).toContain("effort: medium set: high,medium");
    expect(h.ofKind(spec, "turn.started").map((event) => event.effort)).toEqual(["high", "medium"]);
  }, 120_000);

  it("F-137/c8,c14: a replayed set-effort is applied once, and never undoes a later change", async () => {
    const { h, taskId, boxId } = await runnerFor(placement);
    const spec = taskOn(h, taskId, fakeMarker("say"), "high");
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "session.saved");
    const first = setEffort(h, spec, "low");
    expect(await h.waitForAck(first.id)).toMatchObject({ result: "done" });
    // The same change again, as a resend after a reconnect: a new command, the same changeId.
    expect(await h.waitForAck(setEffort(h, spec, "low", first.changeId).id)).toMatchObject({ result: "done" });
    expect(await h.waitForAck(setEffort(h, spec, "medium").id)).toMatchObject({ result: "done" });
    expect(await h.waitForAck(setEffort(h, spec, "low", first.changeId).id)).toMatchObject({ result: "done" });
    h.steer(spec, fakeMarker("effort"));
    await h.waitForKind(spec, "session.saved", 2);
    expect(levelsSet(h, spec)).toEqual(["high", "low", "medium"]);
    expect(messages(h, spec)).toContain("effort: medium set: high,low,medium");
  }, 120_000);

  it("F-137/c13,c14: an agent with none gets no call, and its turns run at its default", async () => {
    const { h, taskId, boxId } = await runnerFor(placement);
    const spec = taskOn(h, taskId, fakeMarker("effort"), "high", "fake-acp-agent-none-advertising");
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "session.saved");
    expect(await h.waitForAck(setEffort(h, spec, "low").id)).toMatchObject({ result: "done" });
    h.steer(spec, fakeMarker("effort"));
    await h.waitForKind(spec, "session.saved", 2);
    // The fake advertised the option, and nothing set it.
    expect(messages(h, spec)).toContain("effort: default set: ");
    expect(messages(h, spec)).not.toMatch(/set: \w/);
    expect(levelsSet(h, spec)).toEqual([]);
    expect(h.ofKind(spec, "turn.started").map((event) => event.effort)).toEqual(["default", "default"]);
  }, 120_000);
});

// ---------- session/load: a reopen, and a runner restarted mid-task ----------

let pending = 0;
const pendingMessage = (text: string): TaskSpecRestore["pendingMessages"][number] => {
  pending += 1;
  return { clientMessageId: clientMessageIdSchema.parse(`effort-pending-${String(pending)}`), text };
};

/** The task's next session, as core's reopen writes it: at the task's level now (ticket 59). */
const reopened = (first: TaskSpec, restore: TaskSpecRestore, effort: EffortLevel): TaskSpec => ({
  ...first,
  sessionId: sessionIdSchema.parse(`${first.sessionId}-reopen-${restore.origin}`),
  leaseEpoch: leaseEpochSchema.parse(first.leaseEpoch + 1),
  agent: { ...first.agent, effort },
  restore,
});

const serve = (h: Harness, spec: TaskSpec, from: Harness): void => {
  const task = from.server.tasks.get(spec.taskId);
  if (task === undefined) throw new Error("no such task");
  h.server.tasks.set(spec.taskId, { spec, credentials: { ...task.credentials, leaseEpoch: spec.leaseEpoch } });
};

describe("reasoning effort after session/load (F-137)", () => {
  it("F-137/c5: a reopen in the kept box loads the session and sets the task's level before the first prompt", async () => {
    const { h, taskId, boxId } = await runnerFor(placements[0] ?? { name: "host", executorKind: "host", sidecar: false });
    const spec = taskOn(h, taskId, fakeMarker("say"), "high");
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "session.saved");
    // The driver changed the level since: the next session's spec carries it.
    const next = reopened(spec, { origin: "resumed", archive: null, hiddenRefs: [], pendingMessages: [pendingMessage(fakeMarker("effort"))] }, "low");
    serve(h, next, h);
    h.dispatch(next, boxId);
    await h.waitForKind(next, "session.saved");
    expect(h.ofKind(next, "session.restored")[0]).toMatchObject({ origin: "resumed" });
    expect(levelsSet(h, next)).toEqual(["low"]);
    const events = h.eventsOf(next);
    expect(indexOf(events, (event) => event.kind === "session.config_changed")).toBeLessThan(indexOf(events, (event) => event.kind === "turn.started"));
    expect(messages(h, next)).toContain("effort: low set: low");
    expect(h.ofKind(next, "turn.started").map((event) => event.effort)).toEqual(["low"]);
  }, 180_000);

  it("F-137/c5: a loaded session that holds another level is set back to Default when the task's level is Default", async () => {
    const { h, taskId, boxId } = await runnerFor(placements[0] ?? { name: "host", executorKind: "host", sidecar: false });
    const spec = taskOn(h, taskId, fakeMarker("say"), "high");
    h.dispatch(spec, boxId);
    await h.waitForKind(spec, "session.saved");
    const next = reopened(spec, { origin: "resumed", archive: null, hiddenRefs: [], pendingMessages: [pendingMessage(fakeMarker("effort"))] }, "default");
    serve(h, next, h);
    h.dispatch(next, boxId);
    await h.waitForKind(next, "session.saved");
    expect(levelsSet(h, next)).toEqual(["default"]);
    expect(messages(h, next)).toContain("effort: default set: default");
    expect(h.ofKind(next, "turn.started").map((event) => event.effort)).toEqual(["default"]);
  }, 180_000);

  it("F-137/c5,c8: a runner restarted mid-task resumes at the task's level, on a fresh box from the archive", async () => {
    const first = await runnerFor(placements[0] ?? { name: "host", executorKind: "host", sidecar: false });
    const spec = taskOn(first.h, first.taskId, fakeMarker("say"), "high");
    first.h.dispatch(spec, first.boxId);
    await first.h.waitForKind(spec, "session.saved");
    expect(await first.h.waitForAck(setEffort(first.h, spec, "medium").id)).toMatchObject({ result: "done" });
    first.h.steer(spec, fakeMarker("remember", "fig"));
    await first.h.waitForKind(spec, "session.saved", 2);
    const saved = first.h.ofKind(spec, "session.saved")[1];
    const archive: BlobRef | null = saved?.archive ?? null;
    if (saved === undefined || archive === null) throw new Error("no archive");
    // The runner goes; its session crashed. Another runner, its own data folder, takes the reopen.
    const second = await startHarness(shared, { agents });
    harnesses.push(second);
    const blob = first.h.server.blobs.get(archive.blobId);
    if (blob === undefined) throw new Error("no such blob");
    second.server.putBlob(spec.taskId, blob.bytes, blob.contentType, archive.blobId);
    const hiddenRefs = saved.repos.flatMap((repo) =>
      repo.hiddenRefSha === null || repo.headSha === null ? [] : [{ repoId: repo.repoId, sha: gitShaSchema.parse(repo.hiddenRefSha), baseSha: gitShaSchema.parse(repo.headSha) }],
    );
    const next = reopened(spec, { origin: "restored", archive, hiddenRefs, pendingMessages: [pendingMessage(fakeMarker("effort"))] }, "medium");
    serve(second, next, first.h);
    second.dispatch(next);
    await second.waitForKind(next, "session.saved");
    expect(second.ofKind(next, "session.restored")[0]).toMatchObject({ origin: "restored" });
    expect(second.ofKind(next, "turn.started").map((event) => event.effort)).toEqual(["medium"]);
    expect(messages(second, next)).toContain("effort: medium");
  }, 240_000);
});
