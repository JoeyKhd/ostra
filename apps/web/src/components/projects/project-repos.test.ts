import { describe, expect, it } from "vitest";

import { dropRepo, moveRepo } from "./project-repos";

// F-098 (ticket 39): the order the repos page saves after a key press or a drop.

describe("the repos' order (F-098)", () => {
  it("F-098: ↑ and ↓ on a handle move its repo one place, and never past either end", () => {
    expect(moveRepo(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveRepo(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    expect(moveRepo(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveRepo(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });

  it("F-098: a drop puts the dragged repo where the one it's dropped on was", () => {
    expect(dropRepo(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(dropRepo(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(dropRepo(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
  });
});
