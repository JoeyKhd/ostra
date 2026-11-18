import { describe, expect, it } from "vitest";
import { compactionSummary, factFromContext, isCompactionCall, scenarios, slowCheckCommand } from "../src/harness/scenarios.ts";
import { summarizeArchive } from "../src/lib/session-archive.ts";

describe("the stub's fact patterns", () => {
  it("find the run's facts, and not look-alikes from a system prompt", () => {
    const context = "see docs/development.md. codename for this task is osprey1a2b3c. The file docs/guide-abcdef.md. RESULT-4242. hello with howdyfedcba. I will use port 4321 because";
    expect(factFromContext("q1", context)).toBe("osprey1a2b3c");
    expect(factFromContext("q2", context)).toBe("docs/guide-abcdef.md");
    expect(factFromContext("q3", context)).toBe("4242");
    expect(factFromContext("q4", context)).toBe("howdyfedcba");
    expect(factFromContext("q5", context)).toBe("4321");
    expect(factFromContext("q2", "only docs/development.md")).toBeUndefined();
  });

  it("refuse scenario arguments that don't match their patterns", () => {
    const multi = scenarios["multi-step"];
    expect(multi).toBeDefined();
    const request = { requestId: "r", format: "openai", path: "/", model: "m", stream: true, includeUsage: true, messages: [], toolNames: ["write"], tools: [], signal: new AbortController().signal } as const;
    expect(multi?.({ request, step: 0, args: "widget; rm -rf / x", since: [], lastToolResults: [] })).toEqual({ text: "stub: bad args" });
    expect(() => slowCheckCommand("ostra-marker-$(whoami)")).toThrow();
  });
});

describe("the stub's compaction answer", () => {
  const message = (role: "user" | "assistant", text: string) => ({ role, text, toolCalls: [], toolCallId: undefined, isError: false }) as const;
  const request = (messages: readonly ReturnType<typeof message>[]) =>
    ({ requestId: "r", format: "openai", path: "/", model: "m", stream: true, includeUsage: true, messages, toolNames: [], tools: [], signal: new AbortController().signal }) as const;

  it("spots OpenCode's compaction prompt, and nothing else", () => {
    expect(isCompactionCall(request([message("user", "hi"), message("user", "You MUST summarize the conversation above into a structured summary that will be given to another agent.")])))
      .toBe(true);
    expect(isCompactionCall(request([message("user", "Update the existing checkpoint in the conversation above into one consolidated summary.")]))).toBe(true);
    expect(isCompactionCall(request([message("user", "Generate a title for this conversation")]))).toBe(false);
  });

  it("answers in the prompt's template and keeps the codename it saw", () => {
    const reply = compactionSummary(request([message("user", "The codename for this task is osprey1a2b3c."), message("user", "You MUST summarize the conversation above")]));
    expect(reply.text).toContain("## Important Context");
    expect(reply.text).toContain("osprey1a2b3c");
    expect(compactionSummary(request([message("user", "You MUST summarize the conversation above")])).text).toContain("- (none)");
  });
});

describe("the archive summary", () => {
  it("counts messages by type and keeps unknown fields out of the way", () => {
    const text = JSON.stringify({ info: { id: "ses_1", projectID: "p", extra: true }, messages: [{ id: "m1", type: "user" }, { id: "m2", type: "assistant" }, { id: "m3", type: "assistant", more: 1 }] });
    const summary = summarizeArchive(text);
    expect(summary.sessionId).toBe("ses_1");
    expect(summary.types).toEqual({ user: 1, assistant: 2 });
    expect(summary.bytes).toBe(Buffer.byteLength(text));
  });
});
