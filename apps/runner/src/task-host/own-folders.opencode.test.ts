import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { conversationText, createScenarioBrain, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// The agent's own folders outside its repo (the maintainer's task of 2026-11-21, on a personal
// `host` runner on Windows): the real, pinned OpenCode on the host executor, with a scripted stub
// model behind the real key proxy. OpenCode tells the model to prefer its temp folder ("approved
// for external access"), and the model writes a preview there and runs a command in it, as the
// live task did; it runs one at the workspace's root, which holds the repos (F-098); and a write
// outside the task is still refused, with no person asked.

const MARK = "own-folders-5e2a";
const PREVIEW = `<!doctype html><title>${MARK}</title>`;

/** A line of OpenCode's environment block (`instructions/builtins.ts` at v2.3.2), as the model reads it. */
const envValue = (text: string, pattern: RegExp): string | undefined =>
  pattern.exec(text)?.[1]?.trim();

/** The folders a model finds in OpenCode's prompt, and the calls it makes in and outside them. */
const ownFolders: Scenario = ({ step, request }) => {
  const prompt = conversationText(request.messages);
  const tmp = envValue(prompt, /Prefer (.+?) over generic system temporary directories/);
  const cwd = envValue(prompt, /Working directory: ([^\n]+)/);
  if (tmp === undefined || cwd === undefined) {
    return step === 0 ? { text: "OpenCode's environment block is missing." } : undefined;
  }
  const preview = path.join(tmp, "badge-preview");
  // One repo: the agent starts in its checkout, one folder inside the workspace's root.
  const root = path.dirname(cwd);
  const outside = path.join(path.dirname(path.dirname(root)), `escape-${MARK}.txt`);
  switch (step) {
    case 0:
      return {
        toolCalls: [
          {
            name: "write",
            arguments: { path: path.join(preview, "index.html"), content: PREVIEW },
          },
        ],
      };
    case 1:
      return {
        toolCalls: [
          {
            name: "shell",
            arguments: {
              command: "node --version",
              workdir: preview,
              description: "node in the preview folder",
            },
          },
        ],
      };
    case 2:
      return {
        toolCalls: [
          {
            name: "shell",
            arguments: {
              command: `node -p "process.cwd()"`,
              workdir: root,
              description: "node at the workspace root",
            },
          },
        ],
      };
    case 3:
      return { toolCalls: [{ name: "write", arguments: { path: outside, content: "escaped\n" } }] };
    case 4:
      return { text: `tmp=${tmp} root=${root} outside=${outside}` };
    default:
      return undefined;
  }
};

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("own-folders-opencode", {
    brain: createScenarioBrain({ "own-folders": ownFolders }),
  });
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

/** Each tool call of the task, in order: how it ended, and a command's output. */
const outcomes = (h: Harness, spec: TaskSpec) => {
  const completed = new Map(
    h.ofKind(spec, "tool.completed").map((event) => [event.toolCallId, event.output]),
  );
  const failed = new Map(
    h.ofKind(spec, "tool.failed").map((event) => [event.toolCallId, event.error]),
  );
  return h.ofKind(spec, "tool.called").map((call) => {
    const output: unknown = completed.get(call.toolCallId);
    const printed: unknown =
      typeof output === "object" && output !== null ? Reflect.get(output, "output") : undefined;
    return {
      outcome: completed.has(call.toolCallId)
        ? "completed"
        : (failed.get(call.toolCallId) ?? "unfinished"),
      printed: typeof printed === "string" ? printed.trim() : "",
    };
  });
};

const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

describe("the agent's own folders on OpenCode, with the stub model", () => {
  it("F-026/c2: the agent writes in its temp folder and runs a command there and at the workspace root with no denial, and a write outside the task is still refused", async () => {
    harness = await startHarness(shared, { agents: defaultAgents() });
    const h = harness;
    const { spec } = h.taskFor(`${stubMarker("own-folders")} Preview the badge.`, {
      agent: {
        ...taskSpecFixture.agent,
        adapter: "opencode",
        apiFormat: "anthropic-messages",
        endpointModelId: "stub-model",
      },
      environment: { ...taskSpecFixture.environment, setupScript: null },
    });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    const calls = outcomes(h, spec);
    const said = /tmp=(.+) root=(.+) outside=(.+)$/.exec(
      h
        .ofKind(spec, "agent.message")
        .map((event) => event.text)
        .join(""),
    );
    expect(said, JSON.stringify(calls)).not.toBeNull();
    const [, tmp = "", root = "", outside = ""] = said ?? [];
    // OpenCode's temp folder is the task's own, under its agent folder: never the machine's.
    expect(path.relative(h.dataDir, tmp).startsWith(".."), tmp).toBe(false);
    expect(calls.map((call) => call.outcome)).toEqual([
      "completed",
      "completed",
      "completed",
      expect.stringMatching(/external_directory/),
    ]);
    expect(await readFile(path.join(tmp, "badge-preview", "index.html"), "utf8")).toBe(PREVIEW);
    // An ordinary command in the temp folder, and one that ran at the workspace's root, the repo's parent.
    expect(calls[1]?.printed).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(path.relative(root, calls[2]?.printed ?? ""), calls[2]?.printed).toBe("");
    // Outside the task: refused by the config's deny, and no person was asked.
    expect(await exists(outside)).toBe(false);
    expect(h.kinds(spec)).not.toContain("approval.requested");
  }, 300_000);
});
