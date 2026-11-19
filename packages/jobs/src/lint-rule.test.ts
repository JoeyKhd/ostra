import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// ADR 0037, Q78: only packages/jobs imports pg-boss. The repo's own ESLint config refuses it in a
// test file of another package, and allows it here.
//
// It lints with the repo's real config and runs only the rule it covers, without type information.
// With it, the parser builds the whole TypeScript program of the package each path falls in
// (apps/core's is over 2,000 files with the Prisma client), which took seconds here and timed out
// on CI. `no-restricted-imports` reads only the file's syntax.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = 'import { PgBoss } from "pg-boss";\n\nexport const boss = PgBoss;\n';

const eslint = new ESLint({
  cwd: repoRoot,
  ruleFilter: ({ ruleId }) => ruleId === "no-restricted-imports",
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
});

const restrictedImports = async (relativePath: string): Promise<readonly string[]> => {
  const [result] = await eslint.lintText(source, { filePath: path.join(repoRoot, relativePath) });
  const messages = result?.messages ?? [];
  // A parse error or an ignored file has no rule ID, and would let the last test pass for nothing.
  expect(messages.filter((message) => message.ruleId === null)).toEqual([]);
  return messages
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
