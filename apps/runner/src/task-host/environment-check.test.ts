import { taskCredentialsSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";
import { checkLaunchEnvironment, checkLaunchFiles } from "./environment-check.ts";

// Ticket 29 (ADR 0030): an MCP server's headers are credentials like the others. The agent's
// environment and the files its launch writes hold none of them, or the agent doesn't start.

const credentials = taskCredentialsSchema.parse({
  taskId: "0196f1a0-m3-env-check",
  leaseEpoch: 1,
  model: { baseUrl: "https://models.example.test", apiFormat: "anthropic-messages", authScheme: "x-api-key", token: "model-token-1234567890" },
  repos: [],
  secrets: [],
  mcpToken: "runner-mcp-token-1234567890",
  mcpServers: [{ name: "docs", url: "https://mcp.example.test/mcp", headers: { authorization: "Bearer docs-header-token-abcdef" } }],
});

describe("the launch's credential check (F-021)", () => {
  it("F-021/c4: an MCP server's header in the agent's environment or in a file its launch writes refuses the launch", () => {
    expect(checkLaunchEnvironment({ DOCS: "Bearer docs-header-token-abcdef" }, credentials)).toEqual({ ok: false, variable: "DOCS", holds: "an MCP server's header" });
    expect(checkLaunchFiles([{ path: "/agent/config.json", content: '{"headers":{"authorization":"Bearer docs-header-token-abcdef"}}' }], credentials)).toEqual({
      ok: false,
      variable: "/agent/config.json",
      holds: "an MCP server's header",
    });
    expect(checkLaunchFiles([{ path: "/agent/config.json", content: '{"model":"model-token-1234567890"}' }], credentials)).toMatchObject({ ok: false, holds: "the model provider's token" });
    expect(checkLaunchFiles([{ path: "/agent/config.json", content: '{"url":"http://127.0.0.1:4000/abc/mcp/docs"}' }], credentials)).toEqual({ ok: true });
    expect(checkLaunchEnvironment({ PROXY: "http://127.0.0.1:4000/abc/mcp/docs" }, credentials)).toEqual({ ok: true });
  });
});
