import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

// The repo's ESLint rule set (eslint.config.js at the repo root), applied to this spike.
// The root config ignores `spikes/**`, so without this file nothing enforces AGENTS.md
// here. It is the root config's rules, restated, minus what only makes sense across
// packages (the pg-boss and "import another package by name" restrictions).
//
// ESLint itself is not a dependency of this spike: `pnpm spike` runs the repo root's
// copy (found by walking up from this directory) and reports the row SKIPPED when the
// repo root has not been installed. Its plugins resolve the same way, from the root.

const coreRules = {
  "no-debugger": "error",
  "no-empty": "error",
  "no-case-declarations": "error",
  "no-prototype-builtins": "error",
  "no-cond-assign": "error",
  "no-unsafe-finally": "error",
  "no-useless-escape": "error",
};

export default defineConfig(
  { linterOptions: { reportUnusedDisableDirectives: "error" } },

  globalIgnores(["**/node_modules/**", "src/generated/**", ".data/**"]),

  {
    files: ["**/*.{ts,tsx,mts,cts}"],
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
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          allowDefaultCaseForExhaustiveSwitch: true,
          requireDefaultForNonUnion: true,
        },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 10,
        },
      ],
      "func-style": ["error", "expression"],
      eqeqeq: ["error", "always"],
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true } }],
      // Server and runner code: async APIs only, no enums, classes only for adapters (ADR 0025).
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use a union of literals or an `as const` object instead of an enum.",
        },
        {
          selector: "VariableDeclarator > FunctionExpression",
          message: "Write `const name = () => {}`.",
        },
        {
          selector: "CallExpression[callee.name=/Sync$/], CallExpression[callee.property.name=/Sync$/]",
          message: "Use the async APIs, so one slow task never stalls the others.",
        },
        {
          selector: "ClassDeclaration, ClassExpression",
          message: "Classes are for adapters only (ADR 0025).",
        },
      ],
    },
  },

  // Tool configs require a default export.
  {
    files: ["**/*.config.{js,mjs,ts}"],
    rules: { "no-restricted-exports": "off" },
  },

  // Files and folders are kebab-case.
  {
    plugins: { unicorn },
    rules: {
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
    },
  },

  // Plain JavaScript (this file) gets no type information.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: coreRules,
  },
);
