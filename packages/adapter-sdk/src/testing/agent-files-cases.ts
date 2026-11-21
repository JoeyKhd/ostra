import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { turnIdSchema } from "@ostra/protocol";
import type { ApiFormat, InputModality, TaskEvent } from "@ostra/protocol";
import { expect, it } from "vitest";

import { inputModalitiesOf } from "../agent/base.ts";
import type { AgentAdapter, AgentPromptImage, AgentSession, PrepareLaunchInput } from "../agent/base.ts";
import type { AgentFixture, StartedAgent } from "./agent-suite.ts";
import { startStubModelServer } from "./stub-models/server.ts";
import type { StubServer } from "./stub-models/server.ts";
import type { NormalizedMessage } from "./stub-models/types.ts";

// Milestone 9 (ADR 0070, F-148, spec section 5.2): the agent contract suite's files cases. With
// `promptImages`, a PNG in a prompt, and in a steer mid-turn, reaches the stub model as an image,
// in each API format: an Anthropic `image` block with `source.base64`, an OpenAI `image_url` with a
// data URL. Without it, or with a model whose inputs lack `image`, the image is refused before the
// turn starts, and the caller's fallback (the path in the text) reaches the model as the text
// alone. And a file the runner wrote under the workspace root's `.ostra/` opens with the agent's
// own read tool. Each case starts stub models of its own, so it runs on any agent the fixture can
// point at a base URL.

/** What the files cases need of a fixture. Absent: they're skipped. */
export type AgentFilesProbes = {
  /**
   * Put before a prompt's text so the turn calls its model once with the prompt, its text and its
   * images (the fake's `[[fake:model-turn]]`). Empty for an agent whose every turn calls its model.
   */
  readonly modelTurn: string;
  /**
   * A prompt whose turn calls its model, then waits for a steer and calls it again with the
   * steer's text and images; `waitFor` is the agent's message that says it's waiting. Absent: the
   * steer case is skipped.
   */
  readonly steerable?: { readonly prompt: string; readonly waitFor: string };
  /** A prompt that makes the agent read the file at an absolute path with its own read tool, and say its first line. */
  readonly readFile: (absolutePath: string) => string;
};

type Subject = () => { readonly adapter: AgentAdapter; readonly fixture: AgentFixture };

/** A 1×1 PNG, as a member pastes a screenshot. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PNG_SIGNATURE = PNG.subarray(0, 8);
const IMAGE: AgentPromptImage = { mimeType: "image/png", bytes: new Uint8Array(PNG), name: "mock.png" };
const STUB_KEY = "ostra-files-cases-key";
const STUB_MODEL = "stub-vision-model";
const FORMATS: readonly ApiFormat[] = ["openai-compatible", "anthropic-messages"];

type Opened = {
  readonly session: AgentSession;
  readonly events: TaskEvent[];
  readonly stub: StubServer;
  readonly started: StartedAgent;
  readonly close: () => Promise<void>;
};

let turns = 0;
const nextTurn = () => {
  turns += 1;
  return turnIdSchema.parse(`files-turn-${String(turns)}`);
};

const textOf = (events: readonly TaskEvent[]): string =>
  events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

/** Every user message the stub got, oldest first. */
const userMessages = (stub: StubServer): readonly NormalizedMessage[] => stub.calls.flatMap((call) => call.messages.filter((message) => message.role === "user"));

const waitUntil = async (what: string, done: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** An image part as the stub recorded it is the PNG the case sent: its type, and a PNG's bytes. */
const expectPng = (message: NormalizedMessage | undefined, label: string): void => {
  expect(message?.images.length, label).toBe(1);
  const image = message?.images[0];
  expect(image?.mimeType, label).toBe("image/png");
  expect(Buffer.from(image?.base64 ?? "", "base64").subarray(0, 8).equals(PNG_SIGNATURE), label).toBe(true);
};

export const defineAgentFilesCases = (subject: Subject): void => {
  const filesProbe = (context: { readonly skip: () => void }): AgentFilesProbes | undefined => {
    const value = subject().fixture.files;
    if (value === undefined) context.skip();
    return value;
  };

  /** A session of the fixture's agent, its model at a stub of the format given, taking the inputs given. */
  const open = async (format: ApiFormat, inputModalities: readonly InputModality[]): Promise<Opened> => {
    const { adapter, fixture } = subject();
    const stub = await startStubModelServer({ format, realKey: STUB_KEY, models: [STUB_MODEL], brain: () => ({ text: "I can see it." }) });
    const input: PrepareLaunchInput = {
      ...fixture.launchInput,
      model: { ...fixture.launchInput.model, apiFormat: format, endpointModelId: STUB_MODEL, baseUrl: stub.baseUrl, placeholderKey: STUB_KEY, inputModalities },
    };
    const prepared = await adapter.prepareLaunch(input);
    if (!prepared.ok) {
      await stub.close();
      throw new Error(`prepareLaunch failed: ${prepared.error.message}`);
    }
    const started = await fixture.start(prepared.value);
    const events: TaskEvent[] = [];
    const result = await adapter.startSession({
      taskId: input.taskId,
      sessionId: input.sessionId,
      io: started.io,
      cwd: input.workspaceDir,
      mcpServers: [],
      onEvents: (batch) => {
        events.push(...batch);
      },
      onPermission: () => Promise.resolve({ outcome: "cancelled" }),
      onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
      modelInputModalities: inputModalitiesOf(input.model),
    });
    if (!result.ok) {
      await started.stop();
      await stub.close();
      throw new Error(`startSession failed: ${result.error.message}`);
    }
    const session = result.value;
    return {
      session,
      events,
      stub,
      started,
      close: async () => {
        await adapter.close(session);
        await started.stop();
        await stub.close();
      },
    };
  };

  it("F-148/c5: with promptImages, a PNG in a prompt reaches the stub model as an image, in each API format", async (context) => {
    const probes = filesProbe(context);
    const { adapter } = subject();
    if (probes === undefined || !adapter.capabilities.promptImages) {
      context.skip();
      return;
    }
    for (const format of FORMATS) {
      const opened = await open(format, ["text", "image"]);
      try {
        expect(adapter.promptsImages(opened.session), format).toBe(true);
        const text = `${probes.modelTurn} Make the history panel look like this.`.trim();
        const done = await adapter.prompt(opened.session, nextTurn(), { text, images: [IMAGE] });
        expect(done.ok, format).toBe(true);
        const asked = userMessages(opened.stub).find((message) => message.text.includes("Make the history panel look like this."));
        expectPng(asked, `${format}: the prompt's image`);
      } finally {
        await opened.close();
      }
    }
  });

  it("F-148/c5: with promptImages, a PNG in a steer mid-turn reaches the stub model as an image, in each API format", async (context) => {
    const probes = filesProbe(context);
    const { adapter } = subject();
    const steerable = probes?.steerable;
    if (steerable === undefined || !adapter.capabilities.promptImages || !adapter.capabilities.steerMidTurn) {
      context.skip();
      return;
    }
    for (const format of FORMATS) {
      const opened = await open(format, ["text", "image"]);
      try {
        const turn = adapter.prompt(opened.session, nextTurn(), { text: steerable.prompt, images: [] });
        await waitUntil("the agent to wait for a steer", () => textOf(opened.events).includes(steerable.waitFor));
        const steered = await adapter.steer(opened.session, { text: "Use this layout instead.", images: [IMAGE] });
        expect(steered, format).toEqual({ ok: true, value: undefined });
        expect((await turn).ok, format).toBe(true);
        const asked = userMessages(opened.stub).find((message) => message.text.includes("Use this layout instead."));
        expectPng(asked, `${format}: the steer's image`);
      } finally {
        await opened.close();
      }
    }
  });

  it("F-148/c5: without promptImages, or with a model whose inputModalities lacks image, no image part reaches the stub model and the prompt is the text alone", async (context) => {
    const probes = filesProbe(context);
    if (probes === undefined) return;
    const { adapter } = subject();
    // A model that sees no images, on every agent; and an agent that takes none, on a model that sees them.
    const cases: readonly { readonly label: string; readonly inputs: readonly InputModality[] }[] = [
      { label: "a text-only model", inputs: ["text"] },
      ...(adapter.capabilities.promptImages ? [] : [{ label: "an agent without promptImages", inputs: ["text", "image"] as const }]),
    ];
    for (const { label, inputs } of cases) {
      const opened = await open("openai-compatible", inputs);
      try {
        expect(adapter.promptsImages(opened.session), label).toBe(false);
        const before = opened.events.length;
        const refused = await adapter.prompt(opened.session, nextTurn(), { text: `${probes.modelTurn} Look at this.`.trim(), images: [IMAGE] });
        expect(refused, label).toMatchObject({ ok: false, error: { code: "unsupported" } });
        // Refused before the turn: nothing started, and nothing reached the model.
        expect(opened.events.slice(before), label).toEqual([]);
        expect(opened.stub.calls, label).toEqual([]);
        // The caller's fallback: the file's path in the text, and no image.
        const where = path.join(subject().fixture.launchInput.workspaceDir, ".ostra", "attachments", "3", "mock.png");
        const text = `${probes.modelTurn} The mock is at ${where}`.trim();
        const done = await adapter.prompt(opened.session, nextTurn(), { text, images: [] });
        expect(done.ok, label).toBe(true);
        const asked = userMessages(opened.stub);
        expect(asked.flatMap((message) => message.images), label).toEqual([]);
        expect(asked.some((message) => message.text.includes(text)), label).toBe(true);
      } finally {
        await opened.close();
      }
    }
  });

  it("F-148/c4: a file the runner wrote under the workspace root's .ostra/ is readable by the agent's own read tool", async (context) => {
    const probes = filesProbe(context);
    if (probes === undefined) return;
    const { adapter, fixture } = subject();
    const folder = path.join(fixture.launchInput.workspaceDir, ".ostra", "attachments", "7");
    const file = path.join(folder, "notes.md");
    const marker = `NOTES-${randomUUID()}`;
    await mkdir(folder, { recursive: true });
    await writeFile(file, `${marker}\nThe spec's second line.\n`);
    const opened = await open(fixture.launchInput.model.apiFormat, ["text"]);
    try {
      const done = await adapter.prompt(opened.session, nextTurn(), { text: probes.readFile(file), images: [] });
      expect(done.ok).toBe(true);
      expect(opened.events.some((event) => event.kind === "tool.called" && event.toolKind === "read")).toBe(true);
      expect(textOf(opened.events)).toContain(marker);
    } finally {
      await opened.close();
      await rm(path.join(fixture.launchInput.workspaceDir, ".ostra"), { recursive: true, force: true });
    }
  });
};
