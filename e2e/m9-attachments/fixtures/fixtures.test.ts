import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { documentFixtures } from "@ostra/core/testing/document-fixtures";
import { afterAll, describe, expect, it } from "vitest";

import { writeFixtures } from "./make-fixtures.ts";

// The fixtures the repo keeps are the builders' own bytes, the README names each one, and the script
// writes the large ones the repo ignores.

const here = import.meta.dirname;
const temp = await mkdtemp(path.join(tmpdir(), "ostra-m9-fixtures-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

describe("milestone 9's fixtures", () => {
  it("keeps each small fixture as its builder makes it, and none over 1 MiB", async () => {
    for (const fixture of documentFixtures.filter((item) => !item.large)) {
      const kept = await readFile(path.join(here, fixture.file));
      expect(Buffer.compare(kept, Buffer.from(await fixture.make())), fixture.file).toBe(0);
      expect(kept.byteLength, fixture.file).toBeLessThan(1024 * 1024);
    }
  });

  it("names every fixture in the README", async () => {
    const readme = await readFile(path.join(here, "README.md"), "utf8");
    for (const fixture of documentFixtures) {
      expect(readme, fixture.file).toContain(`\`${fixture.file}\``);
    }
  });

  it("writes the large ones, which the repo ignores, from the script", async () => {
    const written = await writeFixtures(temp, "large");
    expect(written.map((file) => path.basename(file)).sort()).toEqual(documentFixtures.filter((item) => item.large).map((item) => item.file).sort());
    const ignored = await readFile(path.join(here, ".gitignore"), "utf8");
    for (const file of written) {
      expect((await stat(file)).size).toBeGreaterThan(0);
      expect(ignored.split("\n")).toContain(path.basename(file));
    }
  });
});
