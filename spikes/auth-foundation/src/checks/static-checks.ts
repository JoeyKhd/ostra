import fs from "node:fs/promises";
import path from "node:path";
import * as z from "zod";
import { nodeModulesBin, spikeRoot, toolEnv } from "../paths.ts";
import { runProcess } from "../proc.ts";

// The checks that read files and run tools, not the database: the typecheck,
// the version pin, ESLint and a scan for the type rules tsc cannot see.

/** A check that could not run for want of an input. The harness prints it SKIPPED, not PASS. */
export type Skipped = { readonly skipped: string };

const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});

const installedPackageSchema = z.object({ version: z.string() });

const versionAt = async (packageJsonPath: string): Promise<string> =>
  installedPackageSchema.parse(JSON.parse(await fs.readFile(packageJsonPath, "utf8"))).version;

export const installedVersion = (name: string): Promise<string> =>
  versionAt(path.join(spikeRoot, "node_modules", name, "package.json"));

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  );

/**
 * A tool of the repo root's install (ESLint, its own TypeScript), found by walking up from
 * this directory. The spike does not depend on them; `null` when the repo root is not installed.
 * `except` is a real path to pass over (the spike's own copy of the same tool).
 */
const findAbove = async (relative: string, except?: string): Promise<string | null> => {
  let directory = path.dirname(spikeRoot);
  for (;;) {
    const candidate = path.join(directory, "node_modules", relative);
    if (await exists(candidate) && (except === undefined || (await fs.realpath(candidate)) !== except)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
};

// ---- Typecheck -----------------------------------------------------------

const requiredFlags = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noPropertyAccessFromIndexSignature",
  "verbatimModuleSyntax",
] as const;

const tsconfigSchema = z.object({ compilerOptions: z.record(z.string(), z.unknown()) });

const compile = async (compiler: string): Promise<void> => {
  const result = await runProcess(process.execPath, [compiler, "--noEmit", "-p", "tsconfig.json"], {
    cwd: spikeRoot,
    env: toolEnv({}),
    timeoutMs: 240_000,
  });
  if (result.code !== 0 || result.timedOut) {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    throw new Error(`tsc reported errors:\n${output.split("\n").slice(0, 12).join("\n")}`);
  }
};

export const typecheck = async (): Promise<string> => {
  const config = tsconfigSchema.parse(JSON.parse(await fs.readFile(path.join(spikeRoot, "tsconfig.json"), "utf8")));
  const missing = requiredFlags.filter((flag) => config.compilerOptions[flag] !== true);
  if (missing.length > 0) {
    throw new Error(`tsconfig.json does not turn on: ${missing.join(", ")}`);
  }
  await compile(nodeModulesBin.tsc);
  const version = await installedVersion("typescript");

  // The repo root compiles its code with its own TypeScript, which can be another major version.
  // Where it is installed, the spike must be clean under it as well.
  const rootCompiler = await findAbove(path.join("typescript", "bin", "tsc"), await fs.realpath(nodeModulesBin.tsc));
  let alsoUnder = "; the repo root's TypeScript is not installed, so only this one ran";
  if (rootCompiler !== null) {
    await compile(rootCompiler);
    const rootVersion = await versionAt(path.join(path.dirname(rootCompiler), "..", "package.json"));
    alsoUnder = `; also clean under the repo root's tsc ${rootVersion}`;
  }
  return `tsc ${version} --noEmit clean with ${String(requiredFlags.length)} strict flags (generated Prisma client included)${alsoUnder}`;
};

// ---- Pinned versions -----------------------------------------------------

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const lockEntrySchema = z.object({ specifier: z.string(), version: z.string() });
const lockSectionSchema = z.record(z.string(), lockEntrySchema);

const unquote = (value: string): string => value.replace(/^'(.*)'$/, "$1");

/**
 * The direct dependencies of the root importer in a pnpm lockfile (v9): name to the specifier
 * written in package.json and the version pnpm resolved. A reader for this one block, not a YAML
 * parser: the block is two levels of fixed-indent keys, and every entry is checked with Zod.
 */
export const rootImporterOf = (lockfile: string): Record<string, z.infer<typeof lockEntrySchema>> => {
  const lines = lockfile.split("\n");
  const start = lines.findIndex((line) => line === "importers:");
  // A blank line may sit between `importers:` and the first importer.
  const first = start < 0 ? -1 : lines.findIndex((line, index) => index > start && line.trim() !== "");
  if (start < 0 || first < 0 || lines[first] !== "  .:") {
    throw new Error("pnpm-lock.yaml has no root importer");
  }
  const entries: Record<string, Record<string, string>> = {};
  let section = "";
  let name = "";
  for (const line of lines.slice(first + 1)) {
    if (line.trim() === "") {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= 2) {
      break;
    }
    const text = line.trim();
    if (indent === 4) {
      section = text.replace(/:$/, "");
    } else if (indent === 6 && (section === "dependencies" || section === "devDependencies")) {
      name = unquote(text.replace(/:$/, ""));
      entries[name] = {};
    } else if (indent === 8 && name !== "" && (section === "dependencies" || section === "devDependencies")) {
      const separator = text.indexOf(": ");
      const entry = entries[name];
      if (separator > 0 && entry !== undefined) {
        entry[text.slice(0, separator)] = text.slice(separator + 2);
      }
    }
  }
  return lockSectionSchema.parse(entries);
};

/** The packages pnpm installs beside better-auth, and that its release keeps at one version with it. */
const betterAuthFamily = ["@better-auth/core", "@better-auth/prisma-adapter"] as const;

export const pinnedVersions = async (): Promise<string> => {
  const manifest = packageJsonSchema.parse(
    JSON.parse(await fs.readFile(path.join(spikeRoot, "package.json"), "utf8")),
  );
  const all = { ...manifest.dependencies, ...manifest.devDependencies };
  const ranged = Object.entries(all).filter(([, range]) => !exactVersion.test(range));
  if (ranged.length > 0) {
    throw new Error(`not pinned exactly: ${ranged.map(([name, range]) => `${name}@${range}`).join(", ")}`);
  }

  const declared = manifest.dependencies["better-auth"];
  if (declared === undefined) {
    throw new Error("better-auth is not a dependency");
  }
  const installed = await installedVersion("better-auth");
  if (installed !== declared) {
    throw new Error(`better-auth is declared ${declared} but ${installed} is installed`);
  }

  // The lockfile, read as data: every direct dependency is locked at the version package.json names.
  const locked = rootImporterOf(await fs.readFile(path.join(spikeRoot, "pnpm-lock.yaml"), "utf8"));
  const drift: string[] = [];
  for (const [name, range] of Object.entries(all)) {
    const entry = locked[name];
    if (entry === undefined) {
      drift.push(`${name} is not in pnpm-lock.yaml`);
    } else if (entry.specifier !== range || (entry.version !== range && !entry.version.startsWith(`${range}(`))) {
      drift.push(`${name}: package.json ${range}, lockfile ${entry.specifier} resolved to ${entry.version}`);
    }
  }
  if (drift.length > 0) {
    throw new Error(`pnpm-lock.yaml does not record the pinned versions: ${drift.join("; ")}`);
  }

  // better-auth releases its packages together and pins them to one another. Installed beside it
  // (the layout pnpm gives a package's own dependencies), each of the family must be that version.
  const here = await fs.realpath(path.join(spikeRoot, "node_modules", "better-auth"));
  for (const name of betterAuthFamily) {
    let version: string;
    try {
      version = await versionAt(path.join(here, "..", name, "package.json"));
    } catch {
      throw new Error(`${name} is not installed beside better-auth`);
    }
    if (version !== declared) {
      throw new Error(`${name} is ${version} but better-auth is pinned ${declared}`);
    }
  }
  return `better-auth ${declared} declared with no range, installed, and locked; ${betterAuthFamily.join(" and ")} installed at ${declared} too; all ${String(Object.keys(all).length)} dependencies are exact and locked at that version`;
};

// ---- ESLint --------------------------------------------------------------

/**
 * The repo's own rule set (typescript-eslint's strict-type-checked and stylistic-type-checked, no `any`,
 * no assertions, exhaustive switches, async APIs), run over this spike with `eslint.config.mjs`.
 * The repo's ESLint ignores `spikes/**`, so without this nothing enforces AGENTS.md here.
 */
export const eslintCheck = async (): Promise<string | Skipped> => {
  const eslint = await findAbove(path.join("eslint", "bin", "eslint.js"));
  if (eslint === null) {
    return { skipped: "the repo root's ESLint: run pnpm install at the repo root (the spike does not install ESLint itself)" };
  }
  const result = await runProcess(
    process.execPath,
    [
      eslint,
      "-c",
      "eslint.config.mjs",
      "--max-warnings",
      "0",
      "src",
      "test",
      "auth-cli.ts",
      "prisma.config.ts",
      "vitest.config.ts",
    ],
    { cwd: spikeRoot, env: toolEnv({}), timeoutMs: 300_000 },
  );
  if (result.code !== 0 || result.timedOut) {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    throw new Error(`ESLint exit ${String(result.code)}:\n${output.split("\n").slice(0, 14).join("\n")}`);
  }
  const rootVersion = await versionAt(path.join(path.dirname(eslint), "..", "package.json")).catch(() => "unknown");
  return `ESLint ${rootVersion} (the repo root's) clean, no message at all, on src, test and the config files, with the repo's strict-type-checked rule set`;
};

// ---- Source scan ---------------------------------------------------------

type Rule = { readonly name: string; readonly pattern: RegExp };

// Run on source with comments, string literals and import/export lists blanked out. Patterns can
// span lines (a `\s` matches a newline). This is the second net behind ESLint: it runs where the
// repo root is not installed, and its blind spots are listed in `plantedViolations`.
const rules: readonly Rule[] = [
  { name: "an `any` type", pattern: /(?::|<|,|\bas|\|)\s*any\b(?!\w)/ },
  { name: "an `as` assertion other than `as const`", pattern: /\bas\s+(?!const\b)[A-Za-z_{[(]/ },
  { name: "an angle-bracket assertion", pattern: /(?:=|\breturn|\()\s*<[A-Za-z][\w.]*(?:\[\])?>\s*[\w'"`]/ },
  { name: "a non-null `!` assertion", pattern: /[\w)\]]!\s*(?=[.[;,)\]])/ },
  { name: "an `enum`", pattern: /\benum\s+[A-Za-z_]/ },
  { name: "a `namespace`", pattern: /\bnamespace\s+[A-Za-z_]/ },
];

const blankOut = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
    // `import * as z` and `export { a as b }` rename; they are not type assertions.
    .replace(/^(?:import|export\s+(?:type\s+)?[{*])[^;]*;/gm, (match) => match.replace(/[^\n]/g, " "));

const DIRECTIVE_RULE = "@ts-ignore or @ts-nocheck";

// A suppression directive lives in a comment, which `blankOut` removes. So this rule reads the raw
// lines, with quoted strings blanked first so that a string which merely mentions one does not count.
const directivePattern = /(?:\/\/|\/\*)\s*@ts-(?:ignore|nocheck)/;
const quotedString = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

/** The rule names a piece of source breaks, with the 1-based line of each. */
export const violationsIn = (source: string): { readonly rule: string; readonly line: number }[] => {
  const cleaned = blankOut(source);
  const fromRules = rules.flatMap((rule) =>
    [...cleaned.matchAll(new RegExp(rule.pattern.source, `${rule.pattern.flags}g`))].map((match) => ({
      rule: rule.name,
      line: cleaned.slice(0, match.index).split("\n").length,
    })),
  );
  const directives = source
    .split("\n")
    .flatMap((line, index) =>
      directivePattern.test(line.replace(quotedString, '""')) ? [{ rule: DIRECTIVE_RULE, line: index + 1 }] : [],
    );
  return [...fromRules, ...directives];
};

// What the scan must catch. If one of these gets through, the scan is blind to it and the row FAILS,
// so a pattern that rots cannot go on reporting a clean source.
const plantedViolations: readonly (readonly [rule: string, source: string])[] = [
  ["an `any` type", "const a: any = 1;"],
  ["an `any` type", "type M = Record<string, any>;"],
  ["an `any` type", "const m = new Map<string, any>();"],
  ["an `as` assertion other than `as const`", "const a = value as string;"],
  ["an `as` assertion other than `as const`", "const a = value\n  as\n  Foo;"],
  ["an angle-bracket assertion", "const a = <string>value;"],
  ["a non-null `!` assertion", "const a = value!.length;"],
  ["a non-null `!` assertion", "const a = value! ;"],
  [DIRECTIVE_RULE, "// @ts-ignore"],
  [DIRECTIVE_RULE, "const a = b; /* @ts-nocheck */"],
  ["an `enum`", "enum Colour { Red }"],
  ["a `namespace`", "namespace Space { }"],
];

const listSourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "generated" ? [] : listSourceFiles(full);
      }
      return entry.name.endsWith(".ts") ? [full] : [];
    }),
  );
  return nested.flat();
};

export const scanSource = async (): Promise<string> => {
  const blind = plantedViolations.filter(
    ([rule, source]) => !violationsIn(source).some((violation) => violation.rule === rule),
  );
  if (blind.length > 0) {
    throw new Error(`the scan is blind to: ${blind.map(([rule, source]) => `${rule} in ${JSON.stringify(source)}`).join("; ")}`);
  }
  const files = [
    ...(await listSourceFiles(path.join(spikeRoot, "src"))),
    ...(await listSourceFiles(path.join(spikeRoot, "test"))),
    path.join(spikeRoot, "prisma.config.ts"),
    path.join(spikeRoot, "auth-cli.ts"),
    path.join(spikeRoot, "vitest.config.ts"),
  ];
  const findings: string[] = [];
  for (const file of files) {
    const original = await fs.readFile(file, "utf8");
    const rawLines = original.split("\n");
    for (const violation of violationsIn(original)) {
      const rawLine = rawLines[violation.line - 1] ?? "";
      findings.push(`${path.relative(spikeRoot, file)}:${String(violation.line)} ${violation.rule}: ${rawLine.trim().slice(0, 80)}`);
    }
  }
  if (findings.length > 0) {
    throw new Error(`${String(findings.length)} finding(s):\n${findings.slice(0, 10).join("\n")}`);
  }
  return `${String(files.length)} source files scanned: no any, no as (other than as const), no angle-bracket assertion, no !, no enum, no namespace, no @ts-ignore; the scan catches all ${String(plantedViolations.length)} planted violations`;
};
