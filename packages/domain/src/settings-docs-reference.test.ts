import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseConfigurationReference, settingsOf } from "@ostra/docs/configuration-reference";
import { repoRoot } from "@ostra/db/dev";
import { runnerEnvNames } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { devOnlyEnvNames, settingNames } from "./settings.ts";

// The docs site renders `docs/configuration.md` with this parser (ADR 0063). This test holds the page
// to the code: a setting the code reads and the page doesn't list, or lists without a default, fails.
describe("the docs site's configuration reference", () => {
  it("F-058: the configuration reference page lists every setting the settings test knows, with its default", async () => {
    const reference = parseConfigurationReference(
      await readFile(path.join(repoRoot, "docs", "configuration.md"), "utf8"),
    );
    const rows = new Map(settingsOf(reference).map((row) => [row.name, row]));
    const expectedReadBy = [
      ...settingNames.map((name) => [name, "server"] as const),
      ...runnerEnvNames.map((name) => [name, "runner"] as const),
      ...devOnlyEnvNames.map((name) => [name, "dev"] as const),
    ];
    for (const [name, readBy] of expectedReadBy) {
      const row = rows.get(name);
      expect(row, `${name} is missing from the configuration reference page`).toBeDefined();
      expect(row?.defaultValue.trim(), `${name} has no default on the page`).not.toBe("");
      expect(row?.readBy, `${name} is listed under the wrong process`).toBe(readBy);
    }
    expect(rows.size).toBe(expectedReadBy.length);
  });
});
