// The repo root's lint rules, applied to this spike. The root config ignores `spikes/**`, so nothing
// there is linted by `pnpm lint`; this config reuses every rule of the root one (strict-type-checked,
// stylistic-type-checked, the repo's own) and drops only its global ignores. C7 runs it with the root's
// ESLint: `node ../../node_modules/eslint/bin/eslint.js --config eslint.config.mjs src prisma.config.ts`.
//
// `eslint` and `typescript-eslint` are resolved from the repo root's node_modules (Node looks upward),
// so the spike adds no lint dependency of its own.

import { defineConfig } from "eslint/config";
import rootConfig from "../../eslint.config.js";

// The root config's global ignores (a config object with `ignores` and nothing else) include spikes/**.
const withoutGlobalIgnores = rootConfig.filter((entry) => !(Object.keys(entry).length === 1 && "ignores" in entry));

const ENUM_SELECTOR = {
  selector: "TSEnumDeclaration",
  message: "Use a union of literals or an `as const` object instead of an enum.",
};

// The root applies the server-code rules to apps/** and packages/**; this spike's code becomes
// packages/jobs, so it follows them: async APIs only, and no classes.
const spikeSyntax = [
  ENUM_SELECTOR,
  { selector: "VariableDeclarator > FunctionExpression", message: "Write `const name = () => {}`." },
  {
    selector: "CallExpression[callee.name=/Sync$/], CallExpression[callee.property.name=/Sync$/]",
    message: "Use the async APIs, so one slow task never stalls the others.",
  },
  { selector: "ClassDeclaration, ClassExpression", message: "Classes are for adapters only (ADR 0025)." },
];

export default defineConfig(
  withoutGlobalIgnores,
  { ignores: ["src/generated/**", "node_modules/**", ".data/**", ".runs/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { "no-restricted-syntax": ["error", ...spikeSyntax] },
  },
  // src/jobs.ts is the seam: the one file that imports pg-boss (ADR 0037, Q78).
  {
    files: ["src/jobs.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [{ group: ["**/src/**"], message: "Import by name, not by path." }] }] },
  },
);
