import js from "@eslint/js";
import tseslint from "typescript-eslint";

// typescript-eslint strict-type-checked and stylistic-type-checked, as AGENTS.md requires, plus the
// repo's own rules: exhaustive switches, no `any`, `as` only as `as const`, `type` over `interface`.
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "results/**", ".certs/**", "apps/next/**", "apps/wds/**"] },
  // No inline configuration at all: an eslint-disable comment cannot exist (it is ignored, and reported),
  // and an unused one is an error. ban-ts-comment below covers the TypeScript directives.
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true, minimumDescriptionLength: 10 },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: false }],
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "Use union literals or as const objects, not enums." },
        { selector: "ClassDeclaration", message: "Classes are for adapters only (ADR 0025): use a function that returns a typed record." },
        { selector: "ClassExpression", message: "Classes are for adapters only (ADR 0025): use a function that returns a typed record." },
      ],
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
