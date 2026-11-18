import { describe, expect, it } from "vitest";
import { createScenarioBrain } from "../src/lib/stub-models/scenario.ts";
import type { StubReply, StubRequest } from "../src/lib/stub-models/types.ts";
import { scenarios } from "../src/harness/scenarios.ts";

const brain = createScenarioBrain(scenarios);

const ask = async (prompt: string): Promise<StubReply> =>
  brain({
    requestId: "r1",
    format: "openai",
    path: "/v1/chat/completions",
    model: "stub-coder",
    stream: true,
    includeUsage: true,
    messages: [{ role: "user", text: prompt, toolCalls: [], toolCallId: undefined, isError: false }],
    toolNames: ["shell"],
    tools: [],
    signal: new AbortController().signal,
  } satisfies StubRequest);

const commandOf = (reply: StubReply): unknown => reply.toolCalls?.[0]?.arguments["command"];

describe("scenario arguments never reach a shell unchecked", () => {
  it("runs a well-formed sleep", async () => {
    const reply = await ask("[[stub:sleep 60000 ostra-marker-abc]] wait");
    expect(commandOf(reply)).toBe(`node -e "setTimeout(()=>{},Number(process.argv[1]))" 60000 ostra-marker-abc`);
  });

  it.each([
    "[[stub:sleep 60000 x;whoami]]",
    "[[stub:sleep 1$(id) m]]",
    "[[stub:sleep 10 m extra]]",
    "[[stub:bg-and-sleep a&b]]",
    "[[stub:two-calls 100 `id`]]",
    "[[stub:steer-probe 15000 m|cat]]",
    "[[stub:detached-then-sleep m'x]]",
    "[[stub:shell-probe ses_a.per_b.12;rm]]",
    "[[stub:shell-probe ses_a.per_b]]",
    "[[stub:edit-file ../../etc/passwd]]",
  ])("refuses %s", async (prompt) => {
    const reply = await ask(`${prompt} go`);
    expect(reply.text).toBe("stub: bad args");
    expect(reply.toolCalls).toBeUndefined();
  });

  it("passes shell-probe targets as separate arguments", async () => {
    const reply = await ask("[[stub:shell-probe ses_A1.per_B2.4100 ses_C3.per_none.4200]] probe");
    const command = commandOf(reply);
    expect(typeof command).toBe("string");
    expect(String(command).endsWith(`" ses_A1.per_B2.4100 ses_C3.per_none.4200`)).toBe(true);
  });
});
