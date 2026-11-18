import { describe, expect, it } from "vitest";
import { csvLine, parseCsv } from "../src/rating/csv.ts";

describe("parseCsv", () => {
  it("reads rows and fields", () => {
    expect(parseCsv("id,rating,notes\nR-1,reject,no test\n")).toEqual([
      ["id", "rating", "notes"],
      ["R-1", "reject", "no test"],
    ]);
  });

  it("reads quoted fields with commas, doubled quotes and line breaks", () => {
    expect(parseCsv('a,"b, ""c""",d\n"line one\nline two",x,y\n')).toEqual([
      ["a", 'b, "c"', "d"],
      ["line one\nline two", "x", "y"],
    ]);
  });

  it("copes with CRLF, a missing final newline, blank lines and a byte order mark", () => {
    expect(parseCsv("﻿id,rating\r\nR-1,merge-as-is\r\n\r\nR-2,reject")).toEqual([
      ["id", "rating"],
      ["R-1", "merge-as-is"],
      ["R-2", "reject"],
    ]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv("R-1,,\n")).toEqual([["R-1", "", ""]]);
  });
});

describe("csvLine", () => {
  it("quotes only what needs it, and survives a round trip", () => {
    const fields = ["R-1", 'says "hi", twice', "two\nlines", " padded ", ""];
    const line = csvLine(fields);
    expect(line.startsWith("R-1,")).toBe(true);
    expect(parseCsv(`${line}\n`)).toEqual([fields]);
  });
});
