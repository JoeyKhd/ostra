import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// F-115: the needs-you mail loads its lockup from the install's own address
// (`OSTRA_PUBLIC_URL/email/…`, email-needs-you.md), so the panel serves both files from public/.

const pngSize = async (file: string): Promise<{ readonly width: number; readonly height: number; readonly colourType: number }> => {
  const bytes = await readFile(path.resolve(import.meta.dirname, "../../public/email", file));
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes.readUInt8(25) };
};

describe("the mail's lockups", () => {
  it("F-115: the Abyss lockup on Shell and its Shell twin, each 186×40 (93×20 at 2×)", async () => {
    const abyss = await pngSize("logo-abyss@2x.png");
    const shell = await pngSize("logo-shell@2x.png");
    expect(abyss).toMatchObject({ width: 186, height: 40 });
    expect(shell).toMatchObject({ width: 186, height: 40 });
    // The light one has its background baked in (no alpha); the dark one keeps transparency.
    expect(abyss.colourType).toBe(2);
    expect(shell.colourType).toBe(6);
  });
});
