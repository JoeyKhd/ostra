import { blobIdSchema, ticketFileNameFor } from "@ostra/protocol";
import type { ApiFormat, InputModality, TaskSpecContextFile } from "@ostra/protocol";
import { conversationText, createScenarioBrain, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// Milestone 9's ticket 09 (F-148, ADR 0070) on the agent the runner ships: the real, pinned
// OpenCode on the host executor, with the stub model behind the real key proxy, once per API
// format. A ticket's screenshot, written by the runner under `.ostra/ticket/` as F-064 has written
// it since milestone 2, is opened by the agent with its read tool. With the spec's model taking
// images, the picture reaches the model; with nothing said of the model, the model gets OpenCode's
// error line instead, as every ticket image did before (research `attachments-for-agents.md` §1).

/** An 8×8 PNG made for this test: a real picture, which OpenCode decodes and sends on. */
const SCREENSHOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAaklEQVR4nAXB0QAAAAhDwZnMJJNM+ngemcwkm+4kYVGixYgVESckY1OmzZg1MWekwkUVXUyxRYorpMZNNd1Ms02aa6TBQw09zLBDhhukxUstvcyyS5ZbpOBQocOEDQkXpMNHHX3MsUeOOx47W1ZB6aL23gAAAABJRU5ErkJggg==",
  "base64",
);

const NO_IMAGE_INPUT = "(this model does not support image input)";

/** Reads the file the marker names with OpenCode's read tool, then says what it answered. */
const readFile: Scenario = ({ step, args, lastToolResults }) => {
  if (step === 0) {
    return { toolCalls: [{ name: "read", arguments: { path: args } }] };
  }
  return step === 1 ? { text: `read answered: ${lastToolResults.map((result) => result.text).join(" | ")}` } : undefined;
};

/** Whether a request's body holds a PNG as this format's image part, anywhere (a tool's result included). */
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

describe.each(["anthropic-messages", "openai-compatible"] as const)("a ticket's screenshot on OpenCode, %s stub model", (format) => {
  let shared: Shared | undefined;
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    await shared?.close();
    shared = undefined;
  }, 60_000);

  /** Runs a ticket task whose screenshot the agent reads, its model taking what the case says; answers the request after the read. */
  const readTheScreenshot = async (inputModalities: readonly InputModality[] | undefined) => {
    shared = await startShared(`ticket-images-${format}`, { format, brain: createScenarioBrain({ "read-file": readFile }) });
    harness = await startHarness(shared, { agents: defaultAgents() });
    const h = harness;
    const { spec, credentials } = h.taskFor("", {
      agent: {
        ...taskSpecFixture.agent,
        adapter: "opencode",
        apiFormat: format,
        endpointModelId: "stub-model",
        ...(inputModalities === undefined ? {} : { inputModalities: [...inputModalities] }),
      },
      environment: { ...taskSpecFixture.environment, setupScript: null },
    });
    const blobId = blobIdSchema.parse(h.server.putBlob(spec.taskId, SCREENSHOT, "image/png"));
    const screenshot: TaskSpecContextFile = { blobId, path: "Screenshot 1.png", contentType: "image/png", size: SCREENSHOT.length };
    const name = ticketFileNameFor(blobId, "image/png") ?? "";
    // F-064's prompt names the file by its path from the folder the session opens on.
    const withScreenshot = { ...spec, prompt: `${stubMarker("read-file", `.ostra/ticket/${name}`)} Match the screenshot.`, contextFiles: [screenshot] };
    h.server.tasks.set(spec.taskId, { spec: withScreenshot, credentials });
    h.dispatch(withScreenshot);
    await h.waitForKind(withScreenshot, "session.saved", 1, 150_000);
    const calls = shared.models.calls.filter((call) => call.toolNames.length > 0);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const afterRead = calls.at(-1);
    expect(h.ofKind(withScreenshot, "ticket.files_ready")[0]?.files.map((file) => file.blobId)).toEqual([blobId]);
    expect(h.kinds(withScreenshot)).not.toContain("approval.requested");
    return { body: afterRead?.body, text: conversationText(afterRead?.messages ?? []) };
  };

  it(`F-148/c5: with the spec's model taking images, the runner tells OpenCode so, and the ticket's screenshot the agent reads reaches the model as an ${format === "anthropic-messages" ? "image block" : "image_url"}, not the error line`, async () => {
    const { body, text } = await readTheScreenshot(["text", "image"]);
    expect(imagePartsIn(body, format)).toBe(1);
    expect(text).toContain("Image read successfully");
    expect(text).not.toContain(NO_IMAGE_INPUT);
  }, 300_000);

  it("F-148/c5: with nothing said of the spec's model, the same screenshot reaches it as OpenCode's error line, as every ticket image did before", async () => {
    const { body, text } = await readTheScreenshot(undefined);
    expect(imagePartsIn(body, format)).toBe(0);
    expect(text).toContain(NO_IMAGE_INPUT);
  }, 300_000);
});
