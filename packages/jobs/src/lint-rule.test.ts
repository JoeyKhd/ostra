import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// ADR 0037, Q78: only packages/jobs imports pg-boss. The repo's own ESLint config refuses it in a
// test file of another package, and allows it here.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = 'import { PgBoss } from "pg-boss";\n\nexport const boss = PgBoss;\n';

const restrictedImports = async (relativePath: string): Promise<readonly string[]> => {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(source, { filePath: path.join(repoRoot, relativePath) });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
};

describe("the pg-boss import rule", () => {
  it("fails a test file that imports pg-boss outside packages/jobs", async () => {
    const messages = await restrictedImports("packages/domain/src/seams.test.ts");
    expect(messages).toEqual([expect.stringContaining("Only packages/jobs imports pg-boss")]);
  });

  it("fails it in apps/core too", async () => {
    const messages = await restrictedImports("apps/core/src/index.ts");
    expect(messages).toHaveLength(1);
  });

  it("allows it in packages/jobs", async () => {
    expect(await restrictedImports("packages/jobs/src/jobs.ts")).toEqual([]);
  });
});
