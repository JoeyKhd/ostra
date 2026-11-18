import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

// The repo's own rules (../../eslint.config.js), restated for this standalone
// spike: the root config ignores spikes/**, and a spike is its own workspace.
// Two differences, both because this is one package and not the monorepo:
//  - no "import another package by name" rule: the tests import ../src/;
//  - the server rules (async APIs only, no classes) apply to every file, since
//    all of this spike is server or runner code.

const coreRules = {
  "no-debugger": "error",
  "no-empty": "error",
  "no-case-declarations": "error",
  "no-prototype-builtins": "error",
  "no-cond-assign": "error",
  "no-unsafe-finally": "error",
  "no-useless-escape": "error",
};

const serverSyntax = [
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
];

export default defineConfig(
  { linterOptions: { reportUnusedDisableDirectives: "error" } },

  globalIgnores(["node_modules/**", ".data/**"]),

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
      "no-restricted-syntax": ["error", ...serverSyntax],
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true } }],
    },
  },

  { files: ["eslint.config.js"], rules: { "no-restricted-exports": "off" } },

  {
    plugins: { unicorn },
    rules: {
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
    },
  },

  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: coreRules,
  },
);
