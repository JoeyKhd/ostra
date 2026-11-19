import { describe, expect, it } from "vitest";

import { estimateComplexity, LINEAR_MAX_COMPLEXITY } from "./complexity.ts";
import { documents, worstCaseVariables } from "./queries.ts";
import type { DocumentName } from "./queries.ts";

// Linear refuses a query over 10,000 points (linear.app/developers/rate-limiting). Every document
// the adapter sends is scored here with the largest variables it sends, by Linear's published rules.

const names = Object.keys(documents).filter((name): name is DocumentName => name in documents);

describe("the complexity score", () => {
  it("scores properties, objects and connections by Linear's rules", () => {
    expect(estimateComplexity("{ viewer { id } }")).toBe(2);
    // A connection with no `first` multiplies by 50: 1 + 50 * (1 + 0.1).
    expect(estimateComplexity("{ teams { nodes { id } } }")).toBe(56);
    expect(estimateComplexity("query ($n: Int) { teams(first: $n) { nodes { id } } }", { n: 10 })).toBe(12);
    expect(estimateComplexity('{ issues(filter: { team: { id: { eq: "x" } } }, first: 2, sort: [{ updatedAt: { order: Ascending } }]) { nodes { id title } } }')).toBe(4);
  });

  it("refuses fragments, so a score is never a guess", () => {
    expect(() => estimateComplexity("{ viewer { ...F } }")).toThrow();
  });

  it.each(names)("keeps %s under Linear's 10,000 points", (name) => {
    const score = estimateComplexity(documents[name], worstCaseVariables[name]);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(LINEAR_MAX_COMPLEXITY);
  });
});
