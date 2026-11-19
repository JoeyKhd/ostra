import { describe, expect, it } from "vitest";

import { leadTo, resultHref } from "./highlight";
import { joinQuery, pendingKey, pendingValue, periodAfter, splitQuery, tokenOf } from "./search-query";

// F-080 (ticket 35): the query as the panel draws it, and where a result opens, without a browser.

describe("the query's tokens", () => {
  it("F-080: a finished known token becomes a chip, an unknown one and the word being typed stay text", () => {
    expect(splitQuery("repo:calculator-web status:in-review history")).toEqual({ tokens: [{ key: "repo", value: "calculator-web" }, { key: "status", value: "in-review" }], text: "history" });
    expect(splitQuery("foo:bar repo:x")).toEqual({ tokens: [], text: "foo:bar repo:x" });
    expect(splitQuery("foo:bar repo:x ")).toEqual({ tokens: [{ key: "repo", value: "x" }], text: "foo:bar " });
    expect(splitQuery("repo:x", true).tokens).toEqual([{ key: "repo", value: "x" }]);
    expect(tokenOf("status:")).toBeNull();
    expect(tokenOf("REPO:Web")).toEqual({ key: "repo", value: "Web" });
    expect(joinQuery([{ key: "by", value: "me" }], " words ")).toBe("by:me words");
  });

  it("F-080: a key with no value yet offers its values", () => {
    expect(pendingKey("history status:")).toBe("status");
    expect(pendingKey("history status:in")).toBe("status");
    expect(pendingValue("history status:in")).toBe("in");
    expect(pendingKey("history foo:")).toBeNull();
    expect(pendingKey("history ")).toBeNull();
  });

  it("F-080: the page's period is after:'s day, so the last n days count", () => {
    expect(periodAfter("7d", Date.UTC(2026, 10, 19, 12))).toBe("2026-11-11");
    expect(periodAfter("any", Date.UTC(2026, 10, 19, 12))).toBeNull();
  });
});

describe("a result's link and its snippet", () => {
  it("F-080: a result opens its task at the first matched event, or at the task for a title match", () => {
    expect(resultHref("t-1", [{ kind: "title", eventSeq: null, parts: [] }, { kind: "agent_message", eventSeq: 7, parts: [] }])).toBe("/tasks/t-1?event=7");
    expect(resultHref("t-1", [{ kind: "title", eventSeq: null, parts: [] }])).toBe("/tasks/t-1");
  });

  it("F-080: a long lead before the match is cut, so the match shows on one line", () => {
    const parts = [{ text: "a very long sentence that goes on before the ", match: false }, { text: "word", match: true }, { text: " after", match: false }];
    expect(leadTo(parts, 10)).toEqual([{ text: "…efore the ", match: false }, ...parts.slice(1)]);
    expect(leadTo(parts, 100)).toBe(parts);
    expect(leadTo([{ text: "no match at all, just a long text here", match: false }], 5)).toHaveLength(1);
  });
});
