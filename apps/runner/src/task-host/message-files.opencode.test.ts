import { createHash } from "node:crypto";
import path from "node:path";
import { conversationText, createScenarioBrain, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import { blobIdSchema, messageFileIdSchema } from "@ostra/protocol";
import type { ApiFormat, MessageFileKind, TaskSpec, TaskSpecMessageFile } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// Milestone 9's ticket 13 (F-148, ADR 0070) on the agent the runner ships: the real, pinned
// OpenCode on the host executor, with the stub model behind the real key proxy, once per API
// format. A new task's first message carries a screenshot and a notes file: the runner writes both
// under the workspace root's `.ostra/`, sends the screenshot in the prompt as an image (OpenCode
// declares `promptImages`, and the spec's model takes images), and names both paths in the
// prompt's block; the agent then opens the notes at the absolute path it was given, with its own
// read tool and no person asked.

/** An 8×8 PNG made for this test: a real picture, which OpenCode decodes and sends on. */
const SCREENSHOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAaklEQVR4nAXB0QAAAAhDwZnMJJNM+ngemcwkm+4kYVGixYgVESckY1OmzZg1MWekwkUVXUyxRYorpMZNNd1Ms02aa6TBQw09zLBDhhukxUstvcyyS5ZbpOBQocOEDQkXpMNHHX3MsUeOOx47W1ZB6aL23gAAAABJRU5ErkJggg==",
  "base64",
);
const NOTES = "The member's notes: the history panel is two columns wide.\n";

/** Reads the file the marker names with OpenCode's read tool, then says what it answered. */
const readFile: Scenario = ({ step, args, lastToolResults }) => {
  if (step === 0) {
    return { toolCalls: [{ name: "read", arguments: { path: args } }] };
  }
  return step === 1 ? { text: `read answered: ${lastToolResults.map((result) => (result.isError ? `error: ${result.text}` : result.text)).join(" | ")}` } : undefined;
};

/** How many PNGs a request's body holds as this format's image part, anywhere. */
const anthropicImage = z.looseObject({ type: z.literal("image"), source: z.looseObject({ type: z.literal("base64"), media_type: z.literal("image/png") }) });
const openAiImage = z.looseObject({ type: z.literal("image_url"), image_url: z.looseObject({ url: z.string().startsWith("data:image/png;base64,") }) });
const imagePartsIn = (body: unknown, format: ApiFormat): number => {
  const part = format === "anthropic-messages" ? anthropicImage : openAiImage;
  const walk = (node: unknown): number => {
    if (Array.isArray(node)) return node.reduce((sum: number, item: unknown) => sum + walk(item), 0);
    const object = z.record(z.string(), z.unknown()).safeParse(node);
    if (!object.success) return 0;
    return (part.safeParse(node).success ? 1 : 0) + Object.values(object.data).reduce((sum: number, value: unknown) => sum + walk(value), 0);
  };
  return walk(body);
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

describe.each(["anthropic-messages", "openai-compatible"] as const)("a message's files on OpenCode, %s stub model", (format) => {
  let shared: Shared | undefined;
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    await shared?.close();
    shared = undefined;
  }, 60_000);

  it(`F-148/c5: a marked screenshot reaches the stub model in the prompt as ${format === "anthropic-messages" ? "an image block" : "an image_url"}, and the agent reads a file of the message at the absolute path the block names`, async () => {
    shared = await startShared(`message-files-${format}`, { format, brain: createScenarioBrain({ "read-file": readFile }) });
    harness = await startHarness(shared, { agents: defaultAgents() });
    const h = harness;
    const { spec, credentials } = h.taskFor("", {
      agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: format, endpointModelId: "stub-model", inputModalities: ["text", "image"] },
      environment: { ...taskSpecFixture.environment, setupScript: null },
    });
    const fileOf = (id: string, place: string, bytes: Buffer, kind: MessageFileKind, contentType: string): TaskSpecMessageFile => ({
      fileId: messageFileIdSchema.parse(id),
      blobId: blobIdSchema.parse(h.server.putBlob(spec.taskId, bytes, contentType)),
      size: bytes.length,
      sha256: sha256(bytes),
      kind,
      contentType,
      path: place,
      text: null,
    });
    const screenshot = fileOf("message-file-shot", "attachments/3/history panel.png", SCREENSHOT, "image", "image/png");
    const notes = fileOf("message-file-notes", "attachments/3/notes.txt", Buffer.from(NOTES), "text", "text/plain");
    const root = path.join(h.dataDir, "tasks", spec.taskId, "workspace").replaceAll("\\", "/");
    const task: TaskSpec = {
      ...spec,
      prompt: `${stubMarker("read-file", `${root}/.ostra/attachments/3/notes.txt`)} Make the history panel match the screenshot.`,
      files: [screenshot, notes],
      promptFiles: { fileIds: [screenshot.fileId, notes.fileId], images: [screenshot.fileId] },
    };
    h.server.tasks.set(spec.taskId, { spec: task, credentials });
    h.dispatch(task);
    await h.waitForKind(task, "session.saved", 1, 150_000);

    const calls = shared.models.calls.filter((call) => call.toolNames.length > 0);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // The first call: the member's words, the block with both absolute paths, and the screenshot as an image.
    const first = calls[0];
    expect(imagePartsIn(first?.body, format)).toBe(1);
    const prompt = conversationText(first?.messages ?? []);
    expect(prompt).toContain("Make the history panel match the screenshot.");
    expect(prompt).toContain(`\`${root}/.ostra/attachments/3/history panel.png\`: PNG image`);
    expect(prompt).toContain("You can also see it as an image in this message.");
    expect(prompt).toContain(`\`${root}/.ostra/attachments/3/notes.txt\`: text file`);
    // The agent's read tool opened the notes where the block said, with no person asked.
    expect(conversationText(calls.at(-1)?.messages ?? [])).toContain("the history panel is two columns wide");
    expect(h.kinds(task)).not.toContain("approval.requested");
    expect(h.ofKind(task, "files.written").at(-1)).toEqual({
      kind: "files.written",
      files: [
        { fileId: screenshot.fileId, textWritten: false },
        { fileId: notes.fileId, textWritten: false },
      ],
      skipped: [],
      imagesSent: 1,
      imagesAsFiles: null,
    });
  }, 300_000);
});
