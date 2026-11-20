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
  it("F-013/c1: the npm package's one command is ostra, whose runner command is the runner, and the runner image runs the same program", async () => {
    const pkg = await readPackage();
    expect(pkg.bin).toEqual({ ostra: "./src/main.ts" });

    // The program the bin names, run as npm's shim runs it.
    const main = path.join(packageRoot, pkg.bin["ostra"] ?? "");
    const { stdout } = await run(process.execPath, [main, "--help"], { cwd: packageRoot });
    expect(stdout).toMatch(/^\s+ostra runner \[flags\]\s+Start a runner/m);

    // The runner image's entry point is `ostra`, a shim on the PATH that runs that same file, and
    // its command is `runner` (milestone 5's images, ticket 22: the sidecar runs `ostra sidecar`).
    const dockerfile = await readFile(path.join(repoRoot, "deploy", "Dockerfile.runner"), "utf8");
    const imageMain = `/app/apps/runner/${(pkg.bin["ostra"] ?? "").replace(/^\.\//, "")}`;
    expect(dockerfile).toContain(`exec node ${imageMain} "$@"`);
    expect(dockerfile).toContain('ENTRYPOINT ["ostra"]');
    expect(dockerfile).toContain('CMD ["runner"]');
    // Ticket 19: it says it's the image, so the pin installs nothing there (ADR 0034).
    expect(dockerfile).toContain("ENV OSTRA_INSTALL=image");
    // It starts the real program cold, which takes several seconds on a busy CI machine.
  }, 30_000);

  it("F-013/c8: the CLI needs Node 24.5 or later: its engines say so, and the runner image's Node meets it", async () => {
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
