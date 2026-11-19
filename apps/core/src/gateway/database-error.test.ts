import { describe, expect, it } from "vitest";

import { databaseErrorCodes, isDataRefusal } from "./database-error.ts";

describe("databaseErrorCodes", () => {
  it("reads Prisma's code and the driver's SQLSTATE", () => {
    const error = Object.assign(new Error("boom"), {
      code: "P2010",
      meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: "40P01", kind: "TransactionWriteConflict" } } },
    });
    expect(databaseErrorCodes(error)).toEqual({ code: "P2010", sqlState: "40P01" });
  });

  it("keeps the code when the nested levels are missing or odd", () => {
    expect(databaseErrorCodes({ code: "P2002" })).toEqual({ code: "P2002", sqlState: undefined });
    expect(databaseErrorCodes({ code: "P2002", meta: { target: ["id"] } })).toEqual({ code: "P2002", sqlState: undefined });
    expect(databaseErrorCodes({ code: "P2002", meta: { driverAdapterError: { cause: {} } } })).toEqual({ code: "P2002", sqlState: undefined });
  });

  it("is empty for anything that is not an object with those fields", () => {
    for (const value of [undefined, null, "boom", 3, new Error("plain"), { code: 5 }, { meta: "x" }]) {
      expect(databaseErrorCodes(value).sqlState).toBeUndefined();
    }
    expect(databaseErrorCodes({ code: 5 }).code).toBeUndefined();
  });
});

describe("isDataRefusal", () => {
  it("is true for SQLSTATE class 22 and 23", () => {
    for (const sqlState of ["22P05", "22P02", "22001", "23505", "23514", "23503"]) {
      expect(isDataRefusal({ code: "P2010", sqlState })).toBe(true);
    }
  });

  it("is false for the transient classes, whatever Prisma's code says", () => {
    for (const sqlState of ["40P01", "40001", "57014", "08006", "53300", "55P03"]) {
      expect(isDataRefusal({ code: "P2002", sqlState })).toBe(false);
    }
  });

  it("falls back to Prisma's code when the driver gave no SQLSTATE", () => {
    expect(isDataRefusal({ code: "P2002", sqlState: undefined })).toBe(true);
    expect(isDataRefusal({ code: "P2000", sqlState: undefined })).toBe(true);
    expect(isDataRefusal({ code: "P2024", sqlState: undefined })).toBe(false);
    expect(isDataRefusal({ code: undefined, sqlState: undefined })).toBe(false);
  });
});
