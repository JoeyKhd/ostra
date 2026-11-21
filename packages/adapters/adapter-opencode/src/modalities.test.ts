import path from "node:path";
import { tmpdir } from "node:os";

import { ok } from "@ostra/adapter-sdk";
import type { PrepareLaunchInput } from "@ostra/adapter-sdk";
import { memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import type { InputModality } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OPENCODE_VERSION } from "./binary.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";

// Milestone 9 (F-148, ADR 0070): OpenCode is told what its model takes, in its catalog file and its
// config, which agree. Without it, OpenCode 2.3.2 takes every model as text only and replaces each
// image with an error line (research `attachments-for-agents.md` §1). The contract test runs it on
// the pinned binary; this covers each input cheaply.

const adapter = () =>
  new OpenCodeAdapter(
    { resolveBinary: () => Promise.resolve(ok({ path: path.join(tmpdir(), "opencode-not-run"), packageName: "@opencode/cli-test", packageVersion: OPENCODE_VERSION, sha256: "0".repeat(64) })) },
    memoryAdapterContext(),
  );

const input = (inputModalities: readonly InputModality[] | undefined): PrepareLaunchInput => ({
  taskId: fixtureIds.task,
  sessionId: fixtureIds.session,
  workspaceDir: path.join(tmpdir(), "task", "workspace"),
  agentDir: path.join(tmpdir(), "task", "agent"),
  model: {
    endpointModelId: "vision-1",
    apiFormat: "anthropic-messages",
    baseUrl: "http://127.0.0.1:8123/v1",
    placeholderKey: "ostra-fake-key-abc",
    ...(inputModalities === undefined ? {} : { inputModalities }),
  },
  mcp: { url: "http://127.0.0.1:8124/mcp" },
  instructions: null,
  extraEnv: {},
});

const strings = z.array(z.string());

/** The model's inputs as the config file and the catalog file each say them. */
const written = async (inputModalities: readonly InputModality[] | undefined) => {
  const prepared = await adapter().prepareLaunch(input(inputModalities));
  if (!prepared.ok) throw new Error(prepared.error.message);
  const file = (suffix: string): unknown => JSON.parse(prepared.value.files.find((candidate) => candidate.path.endsWith(suffix))?.content ?? "null");
  const config = z
    .looseObject({ providers: z.looseObject({ ostra: z.looseObject({ models: z.looseObject({ "vision-1": z.looseObject({ capabilities: z.looseObject({ input: strings }) }) }) }) }) })
    .parse(file("opencode.json"));
  const catalog = z
    .looseObject({ ostra: z.looseObject({ models: z.looseObject({ "vision-1": z.looseObject({ modalities: z.strictObject({ input: strings, output: strings }) }) }) }) })
    .parse(file("models.json"));
  return { config: config.providers.ostra.models["vision-1"].capabilities.input, catalog: catalog.ostra.models["vision-1"].modalities };
};

describe("OpenCode's config and catalog: the model's inputs (F-148)", () => {
  it("F-148/c5: a model that takes images is written as one in the catalog's modalities and the config's capabilities.input, which agree", async () => {
    const vision = await written(["text", "image", "pdf"]);
    expect(vision.catalog).toEqual({ input: ["text", "image", "pdf"], output: ["text"] });
    expect(vision.config).toEqual(vision.catalog.input);
  });

  it("F-148/c5: a text-only model, and one nobody named, are written as text only in both", async () => {
    for (const modalities of [["text"] as const, undefined]) {
      const textOnly = await written(modalities);
      expect(textOnly.catalog).toEqual({ input: ["text"], output: ["text"] });
      expect(textOnly.config).toEqual(["text"]);
    }
  });

  it("F-148/c5: text is always first and always there, and every other input is written once, in ostra's order", async () => {
    expect((await written(["video", "image", "audio", "image"])).catalog.input).toEqual(["text", "image", "audio", "video"]);
    expect((await written(["image"])).config).toEqual(["text", "image"]);
    expect((await written([])).config).toEqual(["text"]);
  });
});
