import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The configuration reference's filter row (docs-reference.md, "Filter row"): the field, the "Read by"
// segmented control and the count share one line at 1440. The segments clip their overflow, so when
// they were allowed to shrink, the last one ("Development 7") was cut off at their right edge. The
// field gives way instead, and where even a narrow field doesn't fit, the row wraps.

const cssPath = path.join(import.meta.dirname, "..", "app", "globals.css");

/** The declarations of the first top-level rule whose selector is exactly `selector`. */
const declarationsOf = (css: string, selector: string): ReadonlyMap<string, string> => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of code.matchAll(/(?<=^|[{};])\s*([^{};]+?)\s*\{([^{}]*)\}/g)) {
    if (rule[1] === selector) {
      const declarations = [...(rule[2] ?? "").matchAll(/([\w-]+)\s*:\s*([^;]+);/g)];
      return new Map(declarations.flatMap(([, name, value]) => (name === undefined || value === undefined ? [] : [[name, value.trim()]])));
    }
  }
  throw new Error(`no ${selector} rule in globals.css`);
};

describe("the configuration reference's filter row", () => {
  it("F-058: the Read by segments never shrink, so no segment is cut off; the filter field gives way", async () => {
    const css = await readFile(cssPath, "utf8");
    const segments = declarationsOf(css, ".segments");
    expect(segments.get("overflow")).toBe("hidden");
    expect(segments.get("flex")).toBe("none");

    const field = declarationsOf(css, ".filter-field");
    expect(field.get("flex")).toMatch(/^\d+ [1-9]\d* \d+px$/);
    expect(field.has("width"), "a fixed width would stop the field from giving way").toBe(false);

    // Too narrow for all three: the count moves to the next line rather than out of the row.
    expect(declarationsOf(css, ".filter-row").get("flex-wrap")).toBe("wrap");
  });
});
