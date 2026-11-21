import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { documentFixtures } from "@ostra/core/testing/document-fixtures";

// Milestone 9's documents (ticket 07, spec section 5.5): writes every fixture into this folder, the
// small ones the repo keeps and the large ones it ignores (`.gitignore`), from the builders core's
// tests use (`apps/core/src/testing/document-fixtures.ts`), byte for byte the same each time.
//
//   pnpm --filter @ostra/e2e-m9-attachments fixtures

/** Writes the fixtures (all, or only the large ones the repo doesn't keep) into `dir`, and answers their paths. */
export const writeFixtures = async (dir: string, which: "all" | "large" = "all"): Promise<readonly string[]> => {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const fixture of documentFixtures) {
    if (which === "large" && !fixture.large) {
      continue;
    }
    const file = path.join(dir, fixture.file);
    await writeFile(file, await fixture.make());
    written.push(file);
  }
  return written;
};

if (import.meta.main) {
  const written = await writeFixtures(import.meta.dirname);
  process.stdout.write(`fixtures: wrote ${String(written.length)} documents into ${import.meta.dirname}\n`);
}
