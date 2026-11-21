import { createScenarioBrain, memoryNoteFixtures, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import type { TaskSpecMemory } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// `memory_read` of several notes on the agent the runner ships (F-110/c9, ADR 0044's 2026-11-21
// note, borrowed from claude-mem's batched `get_observations`): the real, pinned OpenCode on the
// host executor, with a scripted stub model behind the real key proxy. The model calls
// `ostra_memory_read` once with three IDs; the sidecar reads each from the fake core, and the
// model gets both notes and the one not found in that one answer.

const [pnpmNote, branchNote] = memoryNoteFixtures;
if (pnpmNote === undefined || branchNote === undefined) {
  throw new Error("the fixture has two notes");
}

const scenarios: Readonly<Record<string, Scenario>> = {
  /** Reads the marker's comma-separated note IDs in one `memory_read`, then says what it answered. */
  "read-notes": ({ step, args, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "ostra_memory_read", arguments: { noteIds: args.split(",") } }] };
    }
    return step === 1 ? { text: `memory_read answered: ${lastToolResults.map((result) => (result.isError ? `error: ${result.text}` : result.text)).join(" | ")}` } : undefined;
  },
};

const memory: TaskSpecMemory = {
  block: ["## Memory", "", `- [command] ${pnpmNote.title} (id: ${pnpmNote.noteId})`, `- [convention] ${branchNote.title} (id: ${branchNote.noteId})`].join("\n"),
  indexNoteIds: [pnpmNote.noteId, branchNote.noteId],
  alwaysNoteIds: [],
  omitted: 0,
  tools: true,
};

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("memory-read-opencode", { brain: createScenarioBrain(scenarios) });
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

describe("memory_read of several notes on OpenCode, with the stub model (F-110/c9)", () => {
  it("F-110/c9: OpenCode's one memory_read call with three IDs brings back both notes and names the one not found, and each read is reported", async () => {
    harness = await startHarness(shared, { agents: defaultAgents() });
    const h = harness;
    h.server.memory.notes.push(pnpmNote, branchNote);
    const ids = [pnpmNote.noteId, branchNote.noteId, "note-gone"].join(",");
    const { spec } = h.taskFor(`${stubMarker("read-notes", ids)} Read them.`, {
      agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: "stub-model" },
      memory,
      tools: ["pr-text", "memory"],
    });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    const said = h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");
    expect(said).toContain("memory_read answered: Read 2 of the 3 memory notes asked for.");
    expect(said).toContain(pnpmNote.body);
    expect(said).toContain(branchNote.body);
    expect(said).toContain("Not found: note-gone.");
    expect(said).not.toContain("error:");
    // One tool call from the model; one read of core's endpoint per ID.
    const calls = h.ofKind(spec, "tool.called").filter((event) => `${event.title} ${JSON.stringify(event.input)}`.includes("memory_read"));
    expect(calls).toHaveLength(1);
    expect(h.server.memory.calls.filter((call) => call.endpoint === "read")).toHaveLength(3);
    expect(h.ofKind(spec, "memory.used").filter((event) => event.via === "read")).toEqual([
      { kind: "memory.used", noteIds: [pnpmNote.noteId, branchNote.noteId], via: "read" },
    ]);
  }, 300_000);
});
