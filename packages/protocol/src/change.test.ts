import { describe, expect, it } from "vitest";

import { changeEntities, changeEntitySchema } from "./change.ts";

describe("changeEntitySchema", () => {
  it("accepts every kind of change notice and nothing else", () => {
    for (const entity of changeEntities) {
      expect(changeEntitySchema.parse(entity)).toBe(entity);
    }
    expect(changeEntitySchema.safeParse("join-token").success).toBe(false);
    expect(changeEntitySchema.safeParse("").success).toBe(false);
  });
});
