import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { spikeRoot } from "./infra.ts";
import { verdict, type Criterion } from "./report.ts";

const execFileAsync = promisify(execFile);
const BAR = "Strict typecheck and lint pass with only documented suppressions. The page calls no third party.";

type Run = { code: number; output: string };

const runNode = async (args: readonly string[]): Promise<Run> => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...args], { cwd: spikeRoot, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = z.object({ code: z.number().optional(), stdout: z.string().optional(), stderr: z.string().optional() }).safeParse(error);
    return failure.success
      ? { code: failure.data.code ?? 1, output: `${failure.data.stdout ?? ""}${failure.data.stderr ?? ""}` }
      : { code: 1, output: "did not run" };
  }
};

const bin = (...parts: string[]): string => path.join(spikeRoot, "node_modules", ...parts);

// Every .ts, .tsx and .js file in the spike, except what is installed or generated.
const skipDirs = new Set(["node_modules", "dist", ".pgdata", "results"]);
const listSource = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) out.push(...(await listSource(full)));
    } else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
};

// The markers are built from pieces, so this file does not contain them (and is scanned like any other).
const expectError = ["@ts-", "expect-error"].join("");
const suppression = new RegExp(`(${["@ts-", "ignore"].join("")}|${["@ts-", "nocheck"].join("")}|${expectError})`);
// a documented one has a reason after it, at least nine characters
const documentedPattern = new RegExp(`${expectError}\\s+\\S.{8,}`);

export const buildWeb = async (): Promise<Run> => runNode([bin("vite", "bin", "vite.js"), "build"]);

export const staticChecks = async (): Promise<Criterion[]> => {
  const out: Criterion[] = [];

  const tsc = await runNode([bin("typescript", "bin", "tsc"), "--noEmit", "-p", "tsconfig.json"]);
  out.push(
    verdict(
      BAR,
      "Strict typecheck (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noImplicitReturns, noFallthroughCasesInSwitch, noPropertyAccessFromIndexSignature, verbatimModuleSyntax, erasableSyntaxOnly)",
      tsc.code === 0,
      tsc.code === 0 ? "tsc --noEmit: 0 errors over the server, the producer, the shared fold, the page and the harness" : tsc.output.split("\n").slice(0, 6).join(" | "),
    ),
  );

  const lint = await runNode([bin("eslint", "bin", "eslint.js"), ".", "--format", "json"]);
  let errors = -1;
  let warnings = -1;
  const lintJson = z
    .string()
    .transform((text): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })
    .pipe(z.array(z.object({ errorCount: z.number(), warningCount: z.number() })))
    .safeParse(lint.output);
  if (lintJson.success) {
    errors = lintJson.data.reduce((n, f) => n + f.errorCount, 0);
    warnings = lintJson.data.reduce((n, f) => n + f.warningCount, 0);
  }
  out.push(
    verdict(
      BAR,
      "Lint: typescript-eslint strict-type-checked and stylistic-type-checked, exhaustive switches, no any, no non-null assertions, `as` only as `as const`, no deprecated API (assistant-ui's included)",
      lint.code === 0 && errors === 0 && warnings === 0,
      lintJson.success ? `eslint: ${String(errors)} errors, ${String(warnings)} warnings` : `eslint did not produce a report: ${lint.output.slice(0, 200)}`,
    ),
  );

  // Suppressions. ESLint runs with noInlineConfig, so an inline eslint-disable comment is itself reported (and
  // counted above as a warning). For TypeScript, ban-ts-comment allows only a described expect-error. This scan
  // is a second look over every .ts, .tsx and .js file in the folder, config files included, with no skip rules.
  const files = await listSource(spikeRoot);
  const found: string[] = [];
  const bad: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    text.split("\n").forEach((line, i) => {
      const hit = suppression.exec(line);
      if (hit === null) return;
      const where = `${path.relative(spikeRoot, file)}:${String(i + 1)}`;
      found.push(`${where} ${hit[1] ?? ""}`);
      const documented = hit[1] === expectError && documentedPattern.test(line);
      if (!documented) bad.push(where);
    });
  }
  out.push(
    verdict(
      BAR,
      "Only documented suppressions (a described expect-error; never ts-ignore, ts-nocheck or an eslint-disable), in every source and config file",
      bad.length === 0,
      found.length === 0 ? `0 suppressions in ${String(files.length)} files` : `${String(found.length)} suppressions: ${found.join(", ")}; undocumented: ${bad.join(", ") || "none"}`,
    ),
  );

  const tests = await runNode([bin("vitest", "vitest.mjs"), "run", "--reporter", "dot"]);
  const summary = /Tests\s+(.*)/.exec(tests.output)?.[1]?.trim() ?? "";
  out.push(
    verdict(
      BAR,
      "Unit tests of the shared fold and the ACP mapper (vitest)",
      tests.code === 0,
      tests.code === 0 ? `vitest: ${summary}` : tests.output.split("\n").slice(-12).join(" | "),
    ),
  );
  return out;
};
