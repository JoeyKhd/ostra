import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultKindOf, parseConfigurationReference, settingsOf, splitRow } from "./configuration-reference";

const configurationPath = path.join(import.meta.dirname, "..", "..", "..", "..", "docs", "configuration.md");

/** Every name in the first column of a table of the file, before "Removed settings": as the settings test reads it. */
const namesInFile = (text: string): string[] => {
  const read = text.replace(/\r\n/g, "\n").split("\n## Removed settings\n")[0] ?? "";
  return [...read.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
};

describe("the configuration reference's parser", () => {
  it("F-058: reads every setting of docs/configuration.md, in the file's order, each with its default", async () => {
    const text = await readFile(configurationPath, "utf8");
    const rows = settingsOf(parseConfigurationReference(text));
    expect(rows.map((row) => row.name)).toEqual(namesInFile(text));
    for (const row of rows) {
      expect(row.defaultValue, row.name).not.toBe("");
      expect(row.description, row.name).not.toBe("");
    }
  });

  it("F-058: keeps the file's groups, and says which process reads each", async () => {
    const reference = parseConfigurationReference(await readFile(configurationPath, "utf8"));
    expect(reference.groups.map((group) => [group.heading, group.readBy])).toEqual([
      ["The server", "server"],
      ["Code hosts and Git LFS", null],
      ["The runner", "runner"],
      ["Development and tests only", "dev"],
      ["Removed settings", null],
    ]);
    const runner = settingsOf(reference).filter((row) => row.readBy === "runner");
    expect(runner.find((row) => row.name === "OSTRA_RUNNER_EXECUTOR")).toMatchObject({ flag: "--executor", defaultValue: "`host`" });
    expect(reference.lede).toMatch(/^Every setting ostra reads/);
  });

  it("F-058: refuses a settings table whose columns it doesn't know, so a changed header can't drop rows", () => {
    const changed = "# Configuration reference\n\nIntro.\n\n## The server\n\n| Setting | Value | Notes |\n|---|---|---|\n| `OSTRA_WEB_PORT` | `3000` | The port. |\n";
    expect(() => parseConfigurationReference(changed)).toThrow(/columns this parser doesn't know/);
  });

  it("splits cells, keeping a pipe inside code or escaped", () => {
    expect(splitRow("| `a|b` | c \\| d | e |")).toEqual(["`a|b`", "c | d", "e"]);
    expect(defaultKindOf("(required)")).toBe("required");
    expect(defaultKindOf("(none)")).toBe("none");
    expect(defaultKindOf("(none: live model cases are skipped)")).toBe("value");
  });
});
