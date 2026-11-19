import { describe, expect, expectTypeOf, it } from "vitest";

import { environmentConfigSchema } from "../config/environment.ts";
import { addModelProviderInputSchema, modelProviderConfigSchema } from "../config/model-provider.ts";
import { fixtureIds as ids, taskCredentialsFixture, taskSpecFixture } from "../testing/fixtures.ts";
import { taskCredentialsSchema } from "./credentials.ts";
import type { TaskCredentials } from "./credentials.ts";
import { repoRelativePathSchema, taskSpecSchema } from "./spec.ts";

describe("the task credentials' MCP headers (F-021)", () => {
  const server = (value: string) => ({ ...taskCredentialsFixture, mcpServers: [{ name: "docs", url: "https://mcp.example.com/mcp", headers: { Authorization: value } }] });

  it("F-021: a header value holding CR, LF or another control character is refused, and a plain token or text with a tab or accents is kept", () => {
    for (const bad of [`Bearer a\nb`, `Bearer a\rb`, `Bearer a\u0000b`, `Bearer a\u007fb`, `Bearer a\u0100b`]) {
      expect(taskCredentialsSchema.safeParse(server(bad)).success).toBe(false);
    }
    for (const good of ["Bearer sk-0123456789", `a\tb`, "caf\u00e9"]) {
      expect(taskCredentialsSchema.safeParse(server(good)).success).toBe(true);
    }
  });
});

describe("the task spec", () => {
  it("parses a full example", () => {
    expect(taskSpecSchema.parse(JSON.parse(JSON.stringify(taskSpecFixture)))).toEqual(taskSpecFixture);
  });

  it("refuses an unknown field at every level", () => {
    expect(taskSpecSchema.safeParse({ ...taskSpecFixture, token: "x" }).success).toBe(false);
    const repo = { ...taskSpecFixture.repos[0], token: "x" };
    expect(taskSpecSchema.safeParse({ ...taskSpecFixture, repos: [repo] }).success).toBe(false);
    expect(taskSpecSchema.safeParse({ ...taskSpecFixture, agent: { ...taskSpecFixture.agent, key: "x" } }).success).toBe(false);
  });

  it("refuses a checkout folder or a file path that leaves the workspace", () => {
    for (const checkoutDir of ["..", "a/b", "", "."]) {
      const repo = { ...taskSpecFixture.repos[0], checkoutDir };
      expect(taskSpecSchema.safeParse({ ...taskSpecFixture, repos: [repo] }).success).toBe(false);
    }
    for (const path of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b"]) {
      expect(repoRelativePathSchema.safeParse(path).success).toBe(false);
    }
    for (const path of [".env", "config/app.json", "a..b/c"]) {
      expect(repoRelativePathSchema.safeParse(path).success).toBe(true);
    }
  });

  it("needs at least one repo and an https clone URL", () => {
    expect(taskSpecSchema.safeParse({ ...taskSpecFixture, repos: [] }).success).toBe(false);
    const repo = { ...taskSpecFixture.repos[0], cloneUrl: "git@github.com:ostra-test/test1.git" };
    expect(taskSpecSchema.safeParse({ ...taskSpecFixture, repos: [repo] }).success).toBe(false);
  });
});

describe("the task credentials", () => {
  it("parses a full example and refuses an unknown field", () => {
    expect(taskCredentialsSchema.parse(JSON.parse(JSON.stringify(taskCredentialsFixture)))).toEqual(taskCredentialsFixture);
    expect(taskCredentialsSchema.safeParse({ ...taskCredentialsFixture, extra: 1 }).success).toBe(false);
  });

  it("says in its description that it is never logged", () => {
    expect(taskCredentialsSchema.description).toContain("never logged");
  });

  it("is a branded type: a plain object of the same shape is not TaskCredentials", () => {
    const plain = { ...taskCredentialsFixture };
    const needs = (value: TaskCredentials): TaskCredentials => value;
    expect(needs(taskCredentialsFixture)).toBe(taskCredentialsFixture);
    expectTypeOf(plain).not.toEqualTypeOf<TaskCredentials>();
  });
});

describe("config", () => {
  it("parses a model provider and keeps personal runners off by default", () => {
    const provider = modelProviderConfigSchema.parse({
      name: "Dev endpoint",
      baseUrl: "https://models.example.com/v1",
      apiFormat: "anthropic-messages",
      authScheme: "x-api-key",
      sessionsAtOnce: null,
    });
    expect(provider.allowOnPersonalRunners).toBe(false);
    expect(addModelProviderInputSchema.safeParse({ ...provider, token: "" }).success).toBe(false);
    expect(modelProviderConfigSchema.safeParse({ ...provider, apiFormat: "grpc" }).success).toBe(false);
  });

  it("parses an environment whose every entry names one repo", () => {
    const environment = environmentConfigSchema.parse({
      baseImage: null,
      setupScript: "pnpm install",
      entries: [
        { kind: "variable", repoId: ids.repo, name: "NODE_ENV", value: "test" },
        { kind: "secret", repoId: ids.repo, name: "API_KEY", value: "s3cret", availableDuringSetup: true },
        { kind: "file", repoId: ids.repo, path: "config/local.json", content: "{}" },
      ],
    });
    expect(environment.entries).toHaveLength(3);
    expect(environment.envFiles).toEqual([]);
    expect(
      environmentConfigSchema.safeParse({ ...environment, entries: [{ kind: "variable", name: "X", value: "1" }] }).success,
    ).toBe(false);
  });
});
