import { describe, expect, it } from "vitest";

import { parseSearchQuery } from "./parse-query.ts";

// F-080 (ticket 26): the search box's parser, alone. Every filter token, a value it can't read, and an
// unknown token, which all stay text.

const none = { repo: null, project: null, ticket: null, status: null, by: null, after: null, before: null };

describe("parseSearchQuery", () => {
  it("F-080/c1: each filter token becomes its filter, and the rest is text", () => {
    expect(parseSearchQuery("repo:test1 migration")).toEqual({ ...none, text: "migration", repo: "test1" });
    expect(parseSearchQuery("project:shop")).toEqual({ ...none, text: "", project: "shop" });
    expect(parseSearchQuery("ticket:OST-12 flaky test")).toEqual({ ...none, text: "flaky test", ticket: "OST-12" });
    expect(parseSearchQuery("status:in-review")).toEqual({ ...none, text: "", status: "in_review" });
    expect(parseSearchQuery("status:needs_you")).toEqual({ ...none, text: "", status: "needs_you" });
    expect(parseSearchQuery("Status:MERGED")).toEqual({ ...none, text: "", status: "merged" });
    expect(parseSearchQuery("by:sam")).toEqual({ ...none, text: "", by: "sam" });
    expect(parseSearchQuery("after:2026-11-01 before:2026-11-19 apiVersion")).toEqual({
      ...none,
      text: "apiVersion",
      after: Date.UTC(2026, 10, 2),
      before: Date.UTC(2026, 10, 19),
    });
  });

  it("F-080/c1: an unknown token, or a known one with a value it can't read, stays text", () => {
    expect(parseSearchQuery("lang:ts https://example.com")).toEqual({ ...none, text: "lang:ts https://example.com" });
    expect(parseSearchQuery("status:sleeping repo:")).toEqual({ ...none, text: "status:sleeping repo:" });
    expect(parseSearchQuery("after:2026-02-31 before:yesterday")).toEqual({ ...none, text: "after:2026-02-31 before:yesterday" });
    expect(parseSearchQuery(':leading "quoted words"')).toEqual({ ...none, text: ':leading "quoted words"' });
    expect(parseSearchQuery("   ")).toEqual({ ...none, text: "" });
  });
});
