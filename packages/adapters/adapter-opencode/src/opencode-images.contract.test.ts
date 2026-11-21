import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { PrepareLaunchInput } from "@ostra/adapter-sdk";
import { conversationText, createScenarioBrain, memoryNoteFixtures, spawnAgentProcess, startFakeMemoryCore, startStubModelServer, stubMarker } from "@ostra/adapter-sdk/testing";
import type { FakeMemoryCore, StubCallRecord, StubServer } from "@ostra/adapter-sdk/testing";
import { turnIdSchema } from "@ostra/protocol";
import type { ApiFormat, InputModality, TaskEvent } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { OpenCodeAdapter } from "./opencode-adapter.ts";
import { scenarios } from "./stub-scenarios.ts";

// Milestone 9's ticket 09 (F-148, ADR 0070) on the pinned OpenCode (2.3.2), once per API format,
// with the stub model recording each request's body. OpenCode replaces an image with
// `ERROR: Cannot read "<name>" (this model does not support image input)` unless the model's
// inputs name images, and took every model ostra ran as text only, since ostra's catalog entry
// had no `modalities` (research `attachments-for-agents.md` §1 and §3). The runner writes a
// message's files under the workspace root's `.ostra/`, outside every repo, and the agent, which
// starts in the repo's checkout, opens one with its own read tool, as a person would ask it to.

const TASK_KEY = "ostra-fake-key-for-this-task";
const MODEL = "stub-model";
const REPO = "test1";
const run = promisify(execFile);

/** An 8×8 PNG made for this test: a real picture, which OpenCode decodes and sends on as it is. */
const MOCK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAaklEQVR4nAXB0QAAAAhDwZnMJJNM+ngemcwkm+4kYVGixYgVESckY1OmzZg1MWekwkUVXUyxRYorpMZNNd1Ms02aa6TBQw09zLBDhhukxUstvcyyS5ZbpOBQocOEDQkXpMNHHX3MsUeOOx47W1ZB6aL23gAAAABJRU5ErkJggg==",
  "base64",
);

/** Where the runner puts a message's first file: the workspace root's `.ostra/attachments/<n>/`. */
const ATTACHED = [".ostra", "attachments", "1", "history-panel.png"] as const;

/** What OpenCode says for an image a model can't take (`core/src/session/model-request.ts`, 2.3.2). */
const NO_IMAGE_INPUT = "(this model does not support image input)";

const roots: string[] = [];
const servers: StubServer[] = [];
const cores: FakeMemoryCore[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(cores.map((core) => core.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

// ---------- the image parts of a request, in each API format ----------

/** Anthropic Messages: `{ type: "image", source: { type: "base64", media_type, data } }`, a tool's result's included. */
const anthropicImageSchema = z.looseObject({
  type: z.literal("image"),
  source: z.looseObject({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
});

/** OpenAI Chat: `{ type: "image_url", image_url: { url: "data:<type>;base64,<data>" } }`; a tool's image follows as a user message. */
const openAiImageSchema = z.looseObject({
  type: z.literal("image_url"),
  image_url: z.looseObject({ url: z.string() }),
});

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

type ImagePart = { readonly part: "image" | "image_url"; readonly mediaType: string; readonly bytes: Buffer };

/** Every image part anywhere in a request's body, as the endpoint received it. */
const imagePartsOf = (body: unknown): readonly ImagePart[] => {
  const found: ImagePart[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const object = z.record(z.string(), z.unknown()).safeParse(node);
    if (!object.success) return;
    const anthropic = anthropicImageSchema.safeParse(node);
    if (anthropic.success) {
      found.push({ part: "image", mediaType: anthropic.data.source.media_type, bytes: Buffer.from(anthropic.data.source.data, "base64") });
    }
    const openAi = openAiImageSchema.safeParse(node);
    const dataUrl = openAi.success ? DATA_URL.exec(openAi.data.image_url.url) : null;
    if (dataUrl !== null) {
      found.push({ part: "image_url", mediaType: dataUrl[1] ?? "", bytes: Buffer.from(dataUrl[2] ?? "", "base64") });
    }
    for (const value of Object.values(object.data)) walk(value);
  };
  walk(body);
  return found;
};

/** The part each format sends an image as. */
const PART_BY_FORMAT = { "anthropic-messages": "image", "openai-compatible": "image_url" } as const;

// ---------- a session on the pinned OpenCode, its model taking what the case says ----------

type Asked = { readonly title: string };

/**
 * OpenCode on a workspace whose root holds the repo `test1` and, under `.ostra/`, the picture the
 * runner wrote; the session starts in the repo's checkout, as the runner starts one with one repo.
 */
const openWithPicture = async (format: ApiFormat, inputModalities: readonly InputModality[] | undefined) => {
  const stub = await startStubModelServer({ format, realKey: TASK_KEY, models: [MODEL], brain: createScenarioBrain(scenarios) });
  servers.push(stub);
  const root = await mkdtemp(path.join(tmpdir(), "ostra-opencode-images-"));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  const repoDir = path.join(workspaceDir, REPO);
  await mkdir(repoDir, { recursive: true });
  await run("git", ["init", "-q"], { cwd: repoDir });
  await writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
  const picture = path.join(workspaceDir, ...ATTACHED);
  await mkdir(path.dirname(picture), { recursive: true });
  await writeFile(picture, MOCK_PNG);
  // ostra's MCP server in the config, answering as the sidecar's stand-in does.
  const core = await startFakeMemoryCore({ taskId: fixtureIds.task, taskToken: "ostra-task-fake-token", mcpBearer: "fake-mcp-bearer", notes: memoryNoteFixtures });
  cores.push(core);
  const input: PrepareLaunchInput = {
    taskId: fixtureIds.task,
    sessionId: fixtureIds.session,
    workspaceDir,
    agentDir: path.join(root, "agent"),
    model: { endpointModelId: MODEL, apiFormat: format, baseUrl: stub.baseUrl, placeholderKey: TASK_KEY, ...(inputModalities === undefined ? {} : { inputModalities }) },
    mcp: { url: core.mcpUrl, bearer: core.mcpBearer },
    instructions: null,
    extraEnv: {},
    repoDirs: [REPO],
  };
  const adapter = new OpenCodeAdapter();
  const launch = await adapter.prepareLaunch(input);
  if (!launch.ok) throw new Error(launch.error.message);
  const started = await spawnAgentProcess(launch.value);
  const events: TaskEvent[] = [];
  const asked: Asked[] = [];
  const session = await adapter.startSession({
    taskId: input.taskId,
    sessionId: input.sessionId,
    io: started.io,
    cwd: repoDir,
    mcpServers: [],
    onEvents: (batch) => {
      events.push(...batch);
    },
    // Nobody is there to answer: a request that reached a person would show here, and is refused.
    onPermission: (_agentSessionId, request) => {
      asked.push({ title: request.title });
      return Promise.resolve({ outcome: "cancelled" });
    },
    onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
  });
  if (!session.ok) {
    await started.stop();
    throw new Error(session.error.message);
  }
  let turns = 0;
  return {
    picture,
    events,
    asked,
    /** The requests that offered tools: the turn's own, title calls aside. */
    calls: (): readonly StubCallRecord[] => stub.calls.filter((call) => call.toolNames.length > 0),
    prompt: async (text: string) => {
      turns += 1;
      const done = await adapter.prompt(session.value, turnIdSchema.parse(`images-turn-${String(turns)}`), { text, images: [] });
      if (!done.ok) throw new Error(done.error.message);
      return done.value.stopReason;
    },
    stop: async () => {
      await adapter.close(session.value);
      await started.stop();
    },
  };
};

type Opened = Awaited<ReturnType<typeof openWithPicture>>;

const messageText = (events: readonly TaskEvent[]): string => events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

/** How each tool call of the turn ended. */
const toolOutcomes = (events: readonly TaskEvent[]): readonly string[] =>
  events.flatMap((event) => (event.kind === "tool.completed" ? ["completed"] : event.kind === "tool.failed" ? [`failed: ${event.error}`] : []));

/** Opens the picture with the read tool, and answers the request that carried its result. */
const readThePicture = async (opened: Opened) => {
  expect(await opened.prompt(`${stubMarker("read-file", opened.picture)} look at the mock`)).toBe("end_turn");
  // The second request of the turn is the one with the read's result in it.
  const afterRead = opened.calls().at(-1);
  expect(opened.calls().length).toBeGreaterThanOrEqual(2);
  return { body: afterRead?.body, text: conversationText(afterRead?.messages ?? []) };
};

describe.each(["anthropic-messages", "openai-compatible"] as const)("milestone 9 on the pinned OpenCode, %s stub", (format) => {
  it(`F-148/c4,c5: the agent reads a PNG under the workspace root's .ostra/ with its read tool, asking no one, and a model that takes images gets it as an ${PART_BY_FORMAT[format]} part, not the error line`, async () => {
    const opened = await openWithPicture(format, ["text", "image"]);
    try {
      const { body, text } = await readThePicture(opened);
      // The read went through, outside the repo the agent started in, with no person asked
      // (`external_directory` allows the workspace's root).
      expect(toolOutcomes(opened.events)).toEqual(["completed"]);
      expect(opened.asked).toEqual([]);
      expect(messageText(opened.events)).toContain("read answered: Image read successfully");
      // The picture itself reached the model, as this format's image part.
      const images = imagePartsOf(body);
      expect(images.map((image) => [image.part, image.mediaType])).toEqual([[PART_BY_FORMAT[format], "image/png"]]);
      expect(images[0]?.bytes.subarray(0, 8)).toEqual(MOCK_PNG.subarray(0, 8));
      expect(text).not.toContain(NO_IMAGE_INPUT);
    } finally {
      await opened.stop();
    }
  });

  it("F-148/c5: a model written as text only, or with nothing said of it, gets OpenCode's error line for the same read, and no image part", async () => {
    for (const modalities of [["text"] as const, undefined]) {
      const opened = await openWithPicture(format, modalities);
      try {
        const { body, text } = await readThePicture(opened);
        expect(toolOutcomes(opened.events)).toEqual(["completed"]);
        expect(opened.asked).toEqual([]);
        expect(imagePartsOf(body)).toEqual([]);
        expect(text).toContain(`ERROR: Cannot read "${opened.picture}" ${NO_IMAGE_INPUT}`);
        expect(messageText(opened.events)).toContain(NO_IMAGE_INPUT);
      } finally {
        await opened.stop();
      }
    }
  }, 240_000);
});
