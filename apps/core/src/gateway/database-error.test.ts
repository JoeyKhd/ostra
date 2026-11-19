import { describe, expect, it } from "vitest";

import { databaseErrorCodes } from "./database-error.ts";

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
