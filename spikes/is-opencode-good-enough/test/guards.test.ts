import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { escapeCheck, type EscapeRun } from "../src/harness/criteria.ts";
import { detectApiFormat, formatFromModelList, type ModelEndpoint } from "../src/harness/inputs.ts";
import { toolCallResults } from "../src/harness/tool-calls.ts";
import type { OpenCodeBinary } from "../src/lib/opencode.ts";
import { dollarCap, type Pricing } from "../src/runner/pricing.ts";
import { PERMISSION_RULES } from "../src/runner/policy.ts";
import { needsRetry } from "../src/runner/retry.ts";
import { runSet } from "../src/runner/run-set.ts";
import { readManifest } from "../src/runner/set-io.ts";
import { KeyEntrySchema } from "../src/rating/schemas.ts";
import { ticketId, ticketKey, TicketKeySchema } from "../src/tickets/schema.ts";
import { barRuns, record, writeRealSet } from "./support.ts";

const PRICES: Pricing = { source: "configured", inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };

describe("--max-usd", () => {
  it("is refused when no prices are set, because the proxy counts tokens and the cap could not act", () => {
    const refused = dollarCap(2, undefined);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.message).toContain("OSTRA_SPIKE_PRICE_INPUT");
  });

  it("applies when prices are set, with $5 as the default, and no dollar cap at all without prices", () => {
    expect(dollarCap(2, PRICES)).toEqual({ ok: true, maxUsd: 2 });
    expect(dollarCap(undefined, PRICES)).toEqual({ ok: true, maxUsd: 5 });
    expect(dollarCap(undefined, undefined)).toEqual({ ok: true, maxUsd: undefined });
  });
});

describe("the API format of an endpoint", () => {
  it("reads Anthropic's model list and an OpenAI-compatible one", () => {
    expect(formatFromModelList({ data: [{ id: "claude-x", type: "model" }], has_more: false })).toBe("anthropic");
    expect(formatFromModelList({ object: "list", data: [{ id: "gpt-x", object: "model" }] })).toBe("openai");
  });

  it("does not default to OpenAI for an answer that is no model list: an error body, a bare object, a page", () => {
    expect(formatFromModelList({ error: { message: "invalid x-api-key" } })).toBeUndefined();
    expect(formatFromModelList({})).toBeUndefined();
    expect(formatFromModelList(undefined)).toBeUndefined();
    expect(formatFromModelList("<html>")).toBeUndefined();
    expect(formatFromModelList({ data: "nope" })).toBeUndefined();
  });
});

describe("which recorded runs are infrastructure failures", () => {
  it("counts an error, a crash, and a cut-short run that met model errors, and nothing else", () => {
    expect(needsRetry(record({ outcome: "error" }))).toBe(true);
    expect(needsRetry(record({ outcome: "agent-crashed" }))).toBe(true);
    expect(needsRetry(record({ outcome: "timeout", modelErrors: { rateLimited: 1, serverErrors: 0, clientErrors: 0 } }))).toBe(true);
    expect(needsRetry(record({ outcome: "token-cap", modelErrors: { rateLimited: 0, serverErrors: 2, clientErrors: 0 } }))).toBe(true);
    expect(needsRetry(record({ outcome: "timeout" }))).toBe(false);
    expect(needsRetry(record({ outcome: "spend-cap" }))).toBe(false);
    expect(needsRetry(record({ outcome: "completed", modelErrors: { rateLimited: 3, serverErrors: 0, clientErrors: 0 } }))).toBe(false);
  });
});

describe("--retry-failed", () => {
  const fakeBinary: OpenCodeBinary = { line: "v2", path: "opencode", packageName: "@opencode/cli-test", packageVersion: "2.3.2", sha256: "0".repeat(64) };
  const options = (setDir: string, retryFailed: boolean): Parameters<typeof runSet>[0] => ({
    setDir,
    label: "model-x",
    mode: "real",
    tickets: [],
    runsPerTicket: 3,
    concurrency: 1,
    limits: { timeoutMs: 60_000, maxTokens: 1000, maxUsd: undefined },
    modelFor: () => {
      throw new Error("no run should start");
    },
    modelInfo: { id: "model-x", format: "anthropic" },
    pricing: "configured",
    binary: fakeBinary,
    log: () => undefined,
    retryFailed,
  });
  const exists = async (file: string): Promise<boolean> =>
    access(file).then(
      () => true,
      () => false,
    );

  it("deletes the run folders of the runs that need it, counts them in the manifest, and keeps the rest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "retry-"));
    try {
      const dir = await writeRealSet(root, "real-model-x", barRuns((t, i) => (t === 1 && i === 1 ? { outcome: "error" } : t === 2 && i === 3 ? { outcome: "timeout", modelErrors: { rateLimited: 1, serverErrors: 0, clientErrors: 0 } } : {})));
      const kept = await runSet(options(dir, false));
      expect(kept.retried).toEqual([]);
      expect(await exists(path.join(dir, "runs", "calc-1-r1"))).toBe(true);
      const redone = await runSet(options(dir, true));
      expect([...redone.retried].sort()).toEqual(["calc-1-r1", "calc-2-r3"]);
      expect(await exists(path.join(dir, "runs", "calc-1-r1"))).toBe(false);
      expect(await exists(path.join(dir, "runs", "calc-2-r3"))).toBe(false);
      expect(await exists(path.join(dir, "runs", "calc-1-r2"))).toBe(true);
      expect((await readManifest(dir))?.retriedRuns).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the type-only event log", () => {
  it("reads each tool call's kind and last status, by its ID", () => {
    const log = [
      { seq: 1, update: "available_commands_update", toolCallId: null, toolKind: null, status: null },
      { seq: 2, update: "tool_call", toolCallId: "a", toolKind: "edit", status: "pending" },
      { seq: 3, update: "tool_call_update", toolCallId: "a", toolKind: "edit", status: "failed" },
      { seq: 4, update: "tool_call", toolCallId: "b", toolKind: "read", status: "pending" },
      { seq: 5, update: "tool_call_update", toolCallId: "b", toolKind: null, status: "completed" },
      { seq: 6, update: "tool_call", toolCallId: "c", toolKind: "execute", status: "pending" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    expect(toolCallResults(`${log}\nnot json\n`)).toEqual([
      { id: "a", kind: "edit", status: "failed" },
      { id: "b", kind: "read", status: "completed" },
      { id: "c", kind: "execute", status: "unfinished" },
    ]);
  });
});

describe("the escape check, with its positive control", () => {
  const calls = (write: "completed" | "failed", read: "completed" | "failed"): EscapeRun["calls"] => [
    { id: "a", kind: "edit", status: write },
    { id: "b", kind: "read", status: read },
  ];
  const control: EscapeRun = { record: record(), landed: true, calls: calls("completed", "completed") };
  const refused: EscapeRun = { record: record(), landed: false, calls: calls("failed", "failed") };

  it("passes when the control's write lands and read works, and under the rules both are refused", () => {
    expect(escapeCheck(control, refused).status).toBe("PASS");
  });

  it("fails when the rules did not stop the write, or the read", () => {
    expect(escapeCheck(control, { ...refused, landed: true }).status).toBe("FAIL");
    expect(escapeCheck(control, { ...refused, calls: calls("failed", "completed") }).status).toBe("FAIL");
  });

  it("fails when the control's write did not land: a refusal for another reason would have passed without it", () => {
    expect(escapeCheck({ ...control, landed: false }, refused).status).toBe("FAIL");
    expect(escapeCheck({ ...control, calls: calls("completed", "failed") }, refused).status).toBe("FAIL");
  });
});

describe("the policy asks before code is fetched", () => {
  const asked = PERMISSION_RULES.filter((rule) => rule.effect === "ask").map((rule) => rule.resource);

  it("lists the package managers' installs and updates and the runners that download a package to run it", () => {
    for (const resource of ["npm install*", "npx *", "npm exec*", "npm update*", "pnpm dlx*", "pnpm exec*", "yarn dlx*", "bunx *", "pip install*", "pip3 install*"]) {
      expect(asked).toContain(resource);
    }
  });
});

describe("branded IDs", () => {
  it("a tracker key is its own type, made from a ticket ID", () => {
    expect(ticketKey(ticketId("calc-7"))).toBe("CALC-7");
    expect(TicketKeySchema.safeParse("calc-7").success).toBe(false);
  });

  it("the sheet's key refuses a ticket ID that is not one", () => {
    const entry = { id: "R-000001", runId: "calc-1-r1", ticketId: "calc-1", setDir: ".runs/real-x" };
    expect(KeyEntrySchema.safeParse(entry).success).toBe(true);
    expect(KeyEntrySchema.safeParse({ ...entry, ticketId: "ticket one" }).success).toBe(false);
  });
});

describe("detecting the API format over HTTP", () => {
  const serve = async (status: number, body: string): Promise<{ endpoint: ModelEndpoint; close: () => Promise<void> }> => {
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return {
      endpoint: { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, apiKey: "k", modelId: "m" },
      close: async () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    };
  };

  it("fails on a 401 and on a 200 that is no model list, and reads the two formats", async () => {
    const unauthorized = await serve(401, '{"error":{"message":"invalid key"}}');
    const notAList = await serve(200, '{"hello":"world"}');
    const anthropic = await serve(200, '{"data":[{"type":"model","id":"claude-x"}],"has_more":false}');
    const openai = await serve(200, '{"object":"list","data":[{"id":"gpt-x","object":"model"}]}');
    try {
      await expect(detectApiFormat(unauthorized.endpoint)).rejects.toThrow("answered 401");
      await expect(detectApiFormat(notAList.endpoint)).rejects.toThrow("did not answer with a model list");
      expect(await detectApiFormat(anthropic.endpoint)).toBe("anthropic");
      expect(await detectApiFormat(openai.endpoint)).toBe("openai");
      expect(await detectApiFormat({ ...unauthorized.endpoint, apiFormat: "openai" })).toBe("openai");
    } finally {
      await Promise.all([unauthorized.close(), notAList.close(), anthropic.close(), openai.close()]);
    }
  });
});
