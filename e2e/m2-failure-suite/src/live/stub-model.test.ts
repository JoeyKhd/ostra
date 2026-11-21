import type { NormalizedMessage, StubReply, StubRequest } from "@ostra/adapter-sdk/testing";
import { describe, expect, it } from "vitest";

import { forgotWords, marker, rememberWords, suiteBrain, unescapeMarkers } from "./stub-model.ts";

// Linear keeps a description's square brackets escaped, so a ticket's marker reaches the prompt as
// `\[\[stub:…\]\]`. The suite's stub reads it unescaped, or every ticket task would play no script.

describe("the stub model's markers", () => {
  it("reads a marker Linear escaped", () => {
    const stored = String.raw`\[\[stub:slow failure-suite/a-1.md 8 2500\]\]` + "\n\ntext";
    expect(unescapeMarkers(stored)).toBe(`${marker("slow", "failure-suite/a-1.md 8 2500")}\n\ntext`);
  });

  it("leaves a plain marker and other brackets as they are", () => {
    expect(unescapeMarkers(marker("write", "a.md"))).toBe("[[stub:write a.md]]");
    expect(unescapeMarkers(String.raw`a \[link\](x)`)).toBe(String.raw`a \[link\](x)`);
  });
});

// Ticket 41's case: the reopen on a second runner must bring the session's context back. The
// `recall` script answers from the conversation it was shown before its own message, so a restored
// session says it remembers the first turn's file, and a session that lost it says it doesn't.

const message = (role: NormalizedMessage["role"], text: string, toolCalls: NormalizedMessage["toolCalls"] = []): NormalizedMessage => ({
  role,
  text,
  images: [],
  toolCalls,
  toolCallId: undefined,
  isError: false,
});

const request = (messages: readonly NormalizedMessage[]): StubRequest => ({
  requestId: "r",
  format: "anthropic-messages",
  path: "/v1/messages",
  model: "claude-haiku-4-5",
  stream: true,
  includeUsage: false,
  messages,
  toolNames: ["read", "write"],
  tools: [],
  signal: new AbortController().signal,
});

const ask = async (messages: readonly NormalizedMessage[]): Promise<StubReply> => suiteBrain()(request(messages));

const FIRST = "failure-suite/revoke-runner-ab12-1.md";
const SECOND = "failure-suite/revoke-runner-cd34-2.md";
const firstTurn: readonly NormalizedMessage[] = [
  message("user", marker("write", FIRST)),
  message("assistant", "", [{ id: "c1", name: "write", arguments: { path: FIRST, content: "x" } }]),
  message("tool", "ok"),
  message("assistant", `Wrote ${FIRST}.`),
];
const recallMessage = message("user", `${marker("recall", `${SECOND} ${FIRST} 2 10`)} Then add the second file.`);
const read = (id: string): NormalizedMessage => message("assistant", "", [{ id, name: "read", arguments: { path: "README.md" } }]);
const twoReads: readonly NormalizedMessage[] = [read("r1"), message("tool", "readme"), read("r2"), message("tool", "readme")];
const writeOfSecond: readonly NormalizedMessage[] = [message("assistant", "", [{ id: "c2", name: "write", arguments: { path: SECOND, content: "x" } }]), message("tool", "ok")];

describe("the recall script", () => {
  it("reads first, then writes its file", async () => {
    expect((await ask([...firstTurn, recallMessage])).toolCalls?.[0]?.name).toBe("read");
    expect((await ask([...firstTurn, recallMessage, ...twoReads])).toolCalls?.[0]?.arguments).toMatchObject({ path: SECOND });
  });

  it("says it remembers the first turn's file when the conversation before its message holds it", async () => {
    const reply = await ask([...firstTurn, recallMessage, ...twoReads, ...writeOfSecond]);
    expect(reply.text).toBe(`Wrote ${SECOND}. ${rememberWords(FIRST)}`);
  });

  it("says it doesn't when only its own message names the file: a session that lost its context", async () => {
    const reply = await ask([recallMessage, ...twoReads, ...writeOfSecond]);
    expect(reply.text).toBe(`Wrote ${SECOND}. ${forgotWords(FIRST)}`);
  });
});
