import type pg from "pg";
import { describe, expect, it } from "vitest";

import { countRows } from "./checks.ts";

// A query result as `pg` returns it: only the rows matter to `countRows`.
const result = (rows: readonly unknown[]): pg.QueryResult => ({ rows: [...rows], command: "SELECT", rowCount: rows.length, oid: 0, fields: [] });

describe("countRows", () => {
  it("reads the count of a row", () => {
    expect(countRows(result([{ n: 3 }]))).toBe(3);
    expect(countRows(result([{ n: "0" }]))).toBe(0);
  });

  it("fails on a row that isn't a count, instead of returning NaN", () => {
    expect(() => countRows(result([]))).toThrow();
    expect(() => countRows(result([{ n: "many" }]))).toThrow();
    expect(() => countRows(result([{ other: 1 }]))).toThrow();
  });
});
