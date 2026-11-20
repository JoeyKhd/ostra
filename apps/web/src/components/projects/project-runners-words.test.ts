import { describe, expect, it } from "vitest";

import { lastChangeOf, moveItem, parseShare, sizeValue } from "./project-runners-words";

// F-086, F-095 (project-runners.md): a project's pools in order and each share.

describe("a project's pools", () => {
  it("F-086: a share is empty for no cap, or a whole number up to the pool's cap", () => {
    expect(parseShare("", 6)).toBeNull();
    expect(parseShare("2", 6)).toBe(2);
    expect(parseShare("7", 6)).toBe("invalid");
    expect(parseShare("0", null)).toBe("invalid");
    expect(parseShare("999", null)).toBe(999);
    expect(parseShare("1000", null)).toBe("invalid");
    expect(parseShare("1.5", null)).toBe("invalid");
  });

  it("F-086: moving a pool keeps every other in its order", () => {
    expect(moveItem(["a", "b", "c"], 1, 0)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 0, 5)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 3, 0)).toEqual(["a", "b", "c"]);
  });

  it("F-095: a size's values and the newer of the last changes", () => {
    expect(sizeValue(2000, 4096)).toBe("2 vCPU · 4 GB");
    expect(sizeValue(1500, 1536)).toBe("1.5 vCPU · 1.5 GB");
    const pools = { at: 2, actor: { name: "Alex Kim" } };
    const size = { at: 1, actor: { name: "Sam Rivera" }, data: { defaultBoxSize: "small" } };
    expect(lastChangeOf("calculator", pools, size)?.line).toBe("Alex Kim changed calculator's pools");
    expect(lastChangeOf("calculator", undefined, size)?.line).toBe("Sam Rivera set the default size to small");
    expect(lastChangeOf("calculator", undefined, undefined)).toBeNull();
  });
});
