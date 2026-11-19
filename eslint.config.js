import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

// ESLint's core recommended rules that the typescript-eslint presets leave out.
const coreRules = {
  "no-debugger": "error",
  "no-empty": "error",
  "no-case-declarations": "error",
  "no-prototype-builtins": "error",
  "no-cond-assign": "error",
  "no-unsafe-finally": "error",
  "no-useless-escape": "error",
};

const ENUM_SELECTOR = {
  selector: "TSEnumDeclaration",
  message: "Use a union of literals or an `as const` object instead of an enum.",
};

// Options of a rule replace each other between blocks, so each block restates its whole list.
const baseSyntax = [
  ENUM_SELECTOR,
  {
    selector: "VariableDeclarator > FunctionExpression",
    message: "Write `const name = () => {}`.",
  },
];

// Server and runner code uses the async file and child-process APIs (AGENTS.md, Code).
const serverSyntax = [
  ...baseSyntax,
  {
    selector: "CallExpression[callee.name=/Sync$/], CallExpression[callee.property.name=/Sync$/]",
    message: "Use the async APIs, so one slow task never stalls the others.",
  },
];

const CLASS_SELECTOR = {
  selector: "ClassDeclaration, ClassExpression",
  message: "Classes are for adapters only (ADR 0025).",
};

// A package is imported by its name, never by a path into another package's source. A relative
// import would get around the license line of ADR 0009 and ADR 0045.
const srcPathPattern = {
  group: ["**/src/**"],
  message: "Import another package by its name, not by path.",
};

export default defineConfig(
  { linterOptions: { reportUnusedDisableDirectives: "error" } },

  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/.turbo/**",
    "**/coverage/**",
    // The docs site's generated collections (fumadocs-mdx) and its static export.
    "apps/docs/.source/**",
    "apps/docs/out/**",
    // Prisma's generated client (packages/db), rebuilt by `pnpm db:generate`.
    "**/src/generated/**",
    "spikes/**",
    "context/**",
    ".agents/**",
    ".claude/**",
  ]),

  // Type-checked rules for every TypeScript file (AGENTS.md, Code).
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
      // Only `as const` is allowed. Use `satisfies`, or narrow an `unknown`.
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      // `type` over `interface` (stylistic-type-checked defaults to interface).
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // Every switch over a union is exhaustive, with `satisfies never` in its default branch.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          allowDefaultCaseForExhaustiveSwitch: true,
          requireDefaultForNonUnion: true,
        },
      ],
      // `@ts-expect-error` with a reason is the only allowed suppression.
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
      // Functions are `const helloWorld = () => {}`.
      "func-style": ["error", "expression"],
      eqeqeq: ["error", "always"],
      "no-restricted-syntax": ["error", ...baseSyntax],
      // Named exports, except where a framework requires a default export (see below).
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true } }],
      // Only packages/jobs imports pg-boss (ADR 0037).
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "pg-boss", message: "Only packages/jobs imports pg-boss (ADR 0037)." }],
          patterns: [srcPathPattern],
        },
      ],
    },
  },

  // Tool configs and Next.js routes require a default export.
  {
    files: [
      "**/*.config.{js,mjs,ts}",
      "apps/web/src/app/**/{page,layout,loading,error,not-found,route,template,default}.tsx",
      "apps/docs/src/app/**/{page,layout,not-found}.tsx",
    ],
    rules: { "no-restricted-exports": "off" },
  },

  // The job queue lives behind packages/jobs.
  {
    files: ["packages/jobs/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [srcPathPattern] }],
    },
  },

  // Server and runner code: async APIs only, and classes only for adapters (ADR 0025).
  {
    files: ["apps/**/*.{ts,tsx,mts,cts}", "packages/**/*.{ts,tsx,mts,cts}"],
    rules: { "no-restricted-syntax": ["error", ...serverSyntax, CLASS_SELECTOR] },
  },
  {
    files: ["packages/adapters/**/*.ts", "packages/adapter-sdk/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...serverSyntax] },
  },
  // `@kubernetes/client-node`'s models (`V1Pod`, `V1Container`, ...) are classes of data fields only,
  // which its own docs fill from object literals; the rules' prototype worry doesn't apply to them.
  {
    files: ["packages/adapters/adapter-executor-kubernetes/**/*.ts"],
    rules: { "@typescript-eslint/no-unsafe-class-instance-assignment": "off", "@typescript-eslint/no-misused-spread": "off" },
  },
  // The fake adapters the API's tests run against are adapters, so they are classes too (ADR 0025).
  {
    files: ["packages/api/src/testing/**/*.ts", "apps/core/src/testing/fake-adapters.ts", "apps/core/src/testing/notify.ts"],
    rules: { "no-restricted-syntax": ["error", ...serverSyntax] },
  },

  // Files and folders are kebab-case.
  {
    plugins: { unicorn },
    rules: {
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
    },
  },

  // Plain JavaScript (the root config files) gets no type information.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: coreRules,
  },
);
