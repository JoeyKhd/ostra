// The root's rule set (AGENTS.md, Code), applied to this spike. The root
// config ignores `spikes/**`, so the spike lints itself. ESLint and its
// plugins are not dependencies of this package: they resolve from the root
// workspace's node_modules (`pnpm lint` runs the root's ESLint binary).

import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

const coreRules = {
  "no-debugger": "error",
  "no-empty": "error",
  "no-case-declarations": "error",
  "no-prototype-builtins": "error",
  "no-cond-assign": "error",
  "no-unsafe-finally": "error",
  "no-useless-escape": "error",
};

// Runner code: async file and process APIs, no enums, no classes, `const f = () => {}`.
const syntax = [
  { selector: "TSEnumDeclaration", message: "Use a union of literals or an `as const` object instead of an enum." },
  { selector: "VariableDeclarator > FunctionExpression", message: "Write `const name = () => {}`." },
  {
    selector: "CallExpression[callee.name=/Sync$/], CallExpression[callee.property.name=/Sync$/]",
    message: "Use the async APIs, so one slow task never stalls the others.",
  },
  { selector: "ClassDeclaration, ClassExpression", message: "Classes are for adapters only (ADR 0025)." },
];

export default defineConfig(
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  globalIgnores(["**/node_modules/**", ".runs/**"]),
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...coreRules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "separate-type-imports" }],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { allowDefaultCaseForExhaustiveSwitch: true, requireDefaultForNonUnion: true }],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true, "ts-check": false, minimumDescriptionLength: 10 },
      ],
      "func-style": ["error", "expression"],
      eqeqeq: ["error", "always"],
      "no-restricted-syntax": ["error", ...syntax],
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true } }],
    },
  },
  {
    // The hidden acceptance tests, the reference tests and the sample repo's own tests run on node:test, whose
    // describe and it return promises that the runner awaits itself. They are test fixtures, not runner code.
    files: ["src/tickets/acceptance/**/*.ts", "src/tickets/reference/**/*.ts", "sample-repo/test/**/*.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    // The sample repo is the fixture the tickets are filed against (ostra's demo repository), not ostra code:
    // its `CalcError extends Error` is what the tickets, the hidden tests and the reference solutions are written
    // against, so it keeps its class. Every other rule of the set applies to it.
    files: ["sample-repo/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...syntax.filter((rule) => !rule.selector.startsWith("ClassDeclaration"))] },
  },
  {
    // Tool configs take a default export, as the root config allows for `*.config.ts`.
    files: ["**/*.config.ts"],
    rules: { "no-restricted-exports": "off" },
  },
  {
    plugins: { unicorn },
    rules: { "unicorn/filename-case": ["error", { case: "kebabCase" }] },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { ...coreRules, "no-restricted-exports": "off" },
  },
);
