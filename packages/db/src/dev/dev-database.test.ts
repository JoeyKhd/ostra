import { describe, expect, it } from "vitest";

import { longPathHint, WINDOWS_LONG_CHECKOUT_PATH } from "./dev-database.ts";

describe("the long-path hint for the embedded Postgres", () => {
  const long = `C:\\${"a-long-folder-name\\".repeat(8)}ostra`;
  const short = "C:\\src\\ostra";

  it("names the path, its length and a shorter folder, for a long Windows checkout path", () => {
    expect(long.length).toBeGreaterThan(WINDOWS_LONG_CHECKOUT_PATH);
    const hint = longPathHint(long, "win32");
    expect(hint).toContain(long);
    expect(hint).toContain(`${String(long.length)} characters`);
    expect(hint).toContain("260");
    expect(hint).toContain("C:\\src\\ostra");
  });

  it("says nothing for a short Windows path, or for any path on another system", () => {
    expect(longPathHint(short, "win32")).toBeNull();
    expect(longPathHint(long, "linux")).toBeNull();
    expect(longPathHint(long, "darwin")).toBeNull();
  });
});
