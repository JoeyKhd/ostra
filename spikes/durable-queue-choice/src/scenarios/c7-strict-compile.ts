// C7. It compiles under ostra's strict flags.
//
// Three checks over the whole spike:
//   1. tsconfig.json still carries every flag AGENTS.md requires, and `tsc --noEmit` exits 0 over the
//      spike, the generated Prisma 7 client and pg-boss's types (this is the pass bar's own bullet).
//   2. A scan of the spike's own source (not the generated client) for what tsc does not check and
//      AGENTS.md forbids: `as` other than `as const`, `!` non-null assertions, `any`, enum,
//      interface, classes, default exports, sync file and process APIs, a ts-ignore or ts-nocheck,
//      and any import of pg-boss outside the seam (src/jobs.ts). It reads the syntax tree, so a
//      comment or a string cannot trip it or hide a hit.
//   3. The repo root's ESLint rule set (strict-type-checked, stylistic-type-checked and the repo's own
//      rules), run through eslint.config.mjs in this directory, because the root config ignores
//      spikes/**. It needs the root's `pnpm install`: without it this part says so and the verdict
//      rests on checks 1 and 2.

import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { z } from "zod";
import { baseChildEnv } from "../child-env.ts";
import { prismaGenerate } from "../cluster.ts";
import type { CriterionResult, StaticContext } from "../kit.ts";

const execFileAsync = promisify(execFile);

export const id = "C7";
export const criterion = "It compiles under ostra's strict flags.";

const REQUIRED_FLAGS = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noPropertyAccessFromIndexSignature",
  "verbatimModuleSyntax",
] as const;

// Built from parts so that this file does not match its own scan.
const AT = "@";
const FORBIDDEN_DIRECTIVES = new RegExp(`${AT}ts-(ignore|nocheck)`);
const EXPECT_ERROR = new RegExp(`${AT}ts-expect-error`, "g");

/** The one sync call AGENTS.md allows: an `exit` handler cannot await (see proc.ts). */
const ALLOWED_SYNC_CALLS = new Set(["killTrackedSync"]);

const tsconfigSchema = z.object({ compilerOptions: z.record(z.string(), z.unknown()) });
const packageSchema = z.object({ version: z.string() });

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const sourceFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "generated") {
        out.push(...(await sourceFiles(path)));
      }
    } else if (entry.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
};

export type Finding = { readonly line: number; readonly what: string };

const isConstTypeReference = (type: ts.TypeNode): boolean =>
  ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "const";

/** What AGENTS.md forbids that tsc accepts, found in one file's syntax tree. */
export const scanSource = (fileName: string, text: string): Finding[] => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const found: Finding[] = [];
  const add = (node: ts.Node, what: string): void => {
    found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, what });
  };
  const isSeam = basename(fileName) === "jobs.ts";

  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && !isConstTypeReference(node.type)) {
      add(node, "an `as` assertion (only `as const` is allowed)");
    } else if (ts.isTypeAssertionExpression(node) && !isConstTypeReference(node.type)) {
      add(node, "an angle-bracket type assertion");
    } else if (ts.isNonNullExpression(node)) {
      add(node, "a `!` non-null assertion");
    } else if (node.kind === ts.SyntaxKind.AnyKeyword) {
      add(node, "an explicit `any`");
    } else if (ts.isEnumDeclaration(node)) {
      add(node, "an enum (use a union of literals or an `as const` object)");
    } else if (ts.isInterfaceDeclaration(node)) {
      add(node, "an interface (use `type`)");
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      add(node, "a class (classes are for adapters only)");
    } else if (ts.isExportAssignment(node)) {
      add(node, "a default export (named exports only)");
    } else if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
      if (callee.endsWith("Sync") && !ALLOWED_SYNC_CALLS.has(callee)) {
        add(node, `a sync API call, ${callee} (use the async APIs)`);
      }
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === "pg-boss" && !isSeam) {
        add(node, "an import of pg-boss outside the seam (src/jobs.ts)");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

export const run = async (ctx: StaticContext): Promise<CriterionResult> => {
  const evidence: string[] = [];
  const failures: string[] = [];

  const tsconfigRaw: unknown = JSON.parse(await readFile(join(ctx.projectRoot, "tsconfig.json"), "utf8"));
  const options = tsconfigSchema.parse(tsconfigRaw).compilerOptions;
  const missing = REQUIRED_FLAGS.filter((flag) => options[flag] !== true);
  if (missing.length > 0) {
    failures.push(`tsconfig.json is missing ${missing.join(", ")}`);
  } else {
    evidence.push(`tsconfig.json sets all ${String(REQUIRED_FLAGS.length)} required flags: ${REQUIRED_FLAGS.join(", ")}`);
  }

  const tsVersionRaw: unknown = JSON.parse(await readFile(join(ctx.projectRoot, "node_modules", "typescript", "package.json"), "utf8"));
  const tsVersion = packageSchema.parse(tsVersionRaw).version;

  await prismaGenerate(ctx.projectRoot);

  const tscEntry = join(ctx.projectRoot, "node_modules", "typescript", "bin", "tsc");
  const started = Date.now();
  let exitCode = 0;
  let output = "";
  try {
    await execFileAsync(process.execPath, [tscEntry, "--noEmit", "-p", "tsconfig.json"], {
      cwd: ctx.projectRoot,
      env: baseChildEnv(),
      timeout: 300_000,
    });
  } catch (error) {
    exitCode = 1;
    if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") {
      output = error.stdout;
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (exitCode === 0) {
    evidence.push(`tsc ${tsVersion} --noEmit exited 0 in ${seconds} s, over the spike and the generated Prisma client`);
  } else {
    failures.push("tsc reported errors");
    evidence.push(...output.split("\n").filter((line) => line.length > 0).slice(0, 15));
  }

  // The rules in AGENTS.md that tsc does not check, over the spike's own code (not generated code).
  const files = await sourceFiles(join(ctx.projectRoot, "src"));
  const offenders: string[] = [];
  let suppressions = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const shown = relative(ctx.projectRoot, file).replaceAll("\\", "/");
    if (FORBIDDEN_DIRECTIVES.test(text)) {
      offenders.push(`${shown}: a forbidden ts directive`);
    }
    for (const finding of scanSource(file, text)) {
      offenders.push(`${shown}:${String(finding.line)}: ${finding.what}`);
    }
    suppressions += (text.match(EXPECT_ERROR) ?? []).length;
  }
  if (offenders.length > 0) {
    failures.push(`forbidden constructs: ${offenders.slice(0, 8).join("; ")}`);
  }
  evidence.push(
    `${String(files.length)} source files scanned on their syntax trees: no \`as\` but \`as const\`, no \`!\`, no any, no enum, interface, class or default export, no sync API, no ts-ignore or ts-nocheck, pg-boss imported only by the seam; ${String(suppressions)} ts-expect-error`,
  );

  // The repo's own lint rules, through this directory's config (the root config ignores spikes/**).
  const eslintEntry = join(ctx.projectRoot, "..", "..", "node_modules", "eslint", "bin", "eslint.js");
  if (await exists(eslintEntry)) {
    const lintStarted = Date.now();
    try {
      await execFileAsync(
        process.execPath,
        [eslintEntry, "--config", "eslint.config.mjs", "--max-warnings", "0", "src", "prisma.config.ts"],
        { cwd: ctx.projectRoot, env: baseChildEnv(), timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      );
      evidence.push(
        `the repo root's ESLint rules (typescript-eslint strict-type-checked and stylistic-type-checked, the repo's own rules) report 0 problems over src and prisma.config.ts (${((Date.now() - lintStarted) / 1000).toFixed(1)} s)`,
      );
    } catch (error) {
      const stdout = typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      failures.push("ESLint (the repo's rules) reported problems");
      evidence.push(...`${stdout}\n${stderr}`.split("\n").filter((line) => line.trim().length > 0).slice(0, 20));
    }
  } else {
    evidence.push(
      "the repo root's ESLint rules were not run: the repo root has no node_modules/eslint (run `pnpm install` at the root); the verdict rests on tsc and the syntax scan",
    );
  }

  return {
    id,
    criterion,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    summary: failures.length === 0 ? "Strict typecheck is clean with pg-boss and the generated Prisma 7 client in the program." : failures.join("; "),
    evidence,
  };
};
