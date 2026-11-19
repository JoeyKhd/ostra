import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// The docs site's adapter guide (ADR 0063, F-058) shows how to write an adapter. This test takes
// every `ts` sample out of the page and compiles it against this package, with the package's own
// strict settings, so a sample can't drift from the SDK it teaches.

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const guide = path.join(packageRoot, "..", "..", "apps", "docs", "content", "contributing", "adapters.mdx");

type Sample = { readonly fileName: string; readonly code: string };

/** Each ```ts block, named by its `title="…"` (so samples can import each other), or by its place. */
const samplesOf = (markdown: string): readonly Sample[] => {
  const samples: Sample[] = [];
  const fence = /^```ts(?<meta>[^\n]*)\n(?<code>[\s\S]*?)^```$/gm;
  for (const match of markdown.matchAll(fence)) {
    const title = /title="(?<name>[^"]+)"/.exec(match.groups?.["meta"] ?? "")?.groups?.["name"];
    samples.push({ fileName: title ?? `sample-${String(samples.length + 1)}.ts`, code: match.groups?.["code"] ?? "" });
  }
  return samples;
};

/** Compiles the samples as files of this package that exist only in memory, and returns the errors. */
const compile = (samples: readonly Sample[]): readonly string[] => {
  const configPath = path.join(packageRoot, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (parsed === undefined) {
    return ["the package's tsconfig.json can't be read"];
  }
  const folder = path.join(packageRoot, "src", "docs-samples");
  const virtual = new Map(samples.map((sample) => [path.join(folder, sample.fileName).replaceAll("\\", "/"), sample.code]));
  const host = ts.createCompilerHost(parsed.options);
  const fromHost = { fileExists: host.fileExists.bind(host), readFile: host.readFile.bind(host), getSourceFile: host.getSourceFile.bind(host) };
  const normal = (fileName: string): string => path.resolve(fileName).replaceAll("\\", "/");
  const virtualFolder = folder.replaceAll("\\", "/");
  host.directoryExists = (directory) => normal(directory) === virtualFolder || ts.sys.directoryExists(directory);
  host.fileExists = (fileName) => virtual.has(normal(fileName)) || fromHost.fileExists(fileName);
  host.readFile = (fileName) => virtual.get(normal(fileName)) ?? fromHost.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const code = virtual.get(normal(fileName));
    return code === undefined
      ? fromHost.getSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, code, languageVersion, true);
  };
  const program = ts.createProgram({ rootNames: [...virtual.keys()], options: { ...parsed.options, noEmit: true }, host });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where = diagnostic.file === undefined ? "" : `${path.basename(diagnostic.file.fileName)}: `;
    return `${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
};

describe("the docs site's adapter guide", () => {
  it("F-058: the adapter guide's code samples typecheck against @ostra/adapter-sdk", async () => {
    const samples = samplesOf(await readFile(guide, "utf8"));
    expect(samples.map((sample) => sample.fileName)).toEqual(
      expect.arrayContaining(["memory-secret-store.ts", "memory-secret-store.test.ts"]),
    );
    expect(compile(samples)).toEqual([]);
  });

  it("F-058: a sample that misuses the SDK fails to compile, so the check is real", () => {
    const broken = samplesOf(
      [
        "```ts",
        'import { SecretStoreAdapter } from "@ostra/adapter-sdk";',
        "export class Half extends SecretStoreAdapter {",
        '  readonly name = "half";',
        "  readonly capabilities = { rotation: false };",
        "}",
        "```",
      ].join("\n"),
    );
    expect(broken).toHaveLength(1);
    expect(compile(broken).join("\n")).toMatch(/Half/);
  });
});
