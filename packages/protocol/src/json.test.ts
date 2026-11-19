import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { errnoCode } from "./json.ts";

describe("errnoCode", () => {
  it("reads the code of a Node errno error", async () => {
    const error = await readFile(path.join(import.meta.dirname, "does-not-exist")).catch((thrown: unknown) => thrown);
    expect(errnoCode(error)).toBe("ENOENT");
  });

  it("reads the code of a plain object", () => {
    expect(errnoCode({ code: "P2002", message: "never read" })).toBe("P2002");
  });

  it("is undefined for anything without a string code", () => {
    for (const value of [undefined, null, "ENOENT", 7, {}, { code: 7 }, { code: null }, new Error("no code")]) {
      expect(errnoCode(value)).toBeUndefined();
    }
  });
});
