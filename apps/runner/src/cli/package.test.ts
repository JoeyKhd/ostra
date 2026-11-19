import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

// F-013 and ADR 0046: the runner is one program, `ostra`, from the npm package or the runner image.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

const packageSchema = z.looseObject({
  bin: z.record(z.string(), z.string()),
  engines: z.looseObject({ node: z.string() }),
});

const readPackage = async () => packageSchema.parse(JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")));

const run = promisify(execFile);

/** `>=24.5` → [24, 5]. */
const minimumOf = (range: string): readonly [number, number] => {
  const match = /^>=(\d+)\.(\d+)(?:\.\d+)?$/.exec(range.trim());
  if (match === null) throw new Error(`not a plain minimum: ${range}`);
  return [Number(match[1]), Number(match[2])];
};

const atLeast = (version: readonly [number, number], minimum: readonly [number, number]): boolean =>
  version[0] > minimum[0] || (version[0] === minimum[0] && version[1] >= minimum[1]);

describe("the ostra program", () => {
  it("F-013: the npm package's one command is ostra, whose runner command is the runner, and the runner image runs the same program", async () => {
    const pkg = await readPackage();
    expect(pkg.bin).toEqual({ ostra: "./src/main.ts" });

    // The program the bin names, run as npm's shim runs it.
    const main = path.join(packageRoot, pkg.bin["ostra"] ?? "");
    const { stdout } = await run(process.execPath, [main, "--help"], { cwd: packageRoot });
    expect(stdout).toMatch(/^\s+ostra runner \[flags\]\s+Start a runner/m);

    // The runner image's entry point is that file, and its command is `runner`.
    const dockerfile = await readFile(path.join(repoRoot, "deploy", "Dockerfile.runner"), "utf8");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/apps/runner/src/main.ts"]');
    expect(dockerfile).toContain('CMD ["runner"]');
  });

  it("F-013: the CLI needs Node 24.5 or later: its engines say so, and the runner image's Node meets it", async () => {
    const pkg = await readPackage();
    const minimum = minimumOf(pkg.engines.node);
    expect(minimum).toEqual([24, 5]);
    expect(atLeast([24, 4], minimum)).toBe(false);
    expect(atLeast([24, 5], minimum)).toBe(true);

    const dockerfile = await readFile(path.join(repoRoot, "deploy", "Dockerfile.runner"), "utf8");
    const images = [...dockerfile.matchAll(/^FROM node:(\d+)\.(\d+)\.\d+/gm)].map((match) => [Number(match[1]), Number(match[2])] as const);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(atLeast(image, minimum)).toBe(true);
  });
});
