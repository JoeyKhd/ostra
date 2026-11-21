import { readFile } from "node:fs/promises";

import { DEVELOPMENT_VERSION, infoNpmSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DEV_RUNNER_NPM, runnerNpm, runnerNpmFor } from "./runner-npm.ts";

// F-061: what `/runner/v1/info` tells a runner installed from npm to pin from, by the build core
// is: a release's (the stamp's version and CLI name), a clone's (`0.0.0`) or development's.

const manifestSchema = z.looseObject({ version: z.string(), cliPackage: z.string().optional() });
const manifest = async (relative: string) => manifestSchema.parse(JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8")));

describe("where an npm runner pins from (F-061)", () => {
  it("F-061/c2: a release's build, stamped 1.0.0-rc.0 with its CLI's name, pins npm runners to that package on npm's registry", () => {
    const pin = runnerNpmFor({ mode: "production", serverVersion: "1.0.0-rc.0", cliPackage: "@acme/ostra-cli" });
    expect(pin).toEqual({ package: "@acme/ostra-cli", registry: "https://registry.npmjs.org" });
    expect(infoNpmSchema.safeParse(pin).success).toBe(true);
  });

  it("F-061/c2: a clone's build (0.0.0) names no package, so no runner pins", () => {
    expect(runnerNpmFor({ mode: "production", serverVersion: DEVELOPMENT_VERSION, cliPackage: "ostra" })).toBeNull();
    expect(runnerNpmFor({ mode: "test", serverVersion: DEVELOPMENT_VERSION, cliPackage: "ostra" })).toBeNull();
  });

  it("F-061/c2: development pins from `pnpm dev:npm-registry`'s CLI, at any version", () => {
    expect(runnerNpmFor({ mode: "development", serverVersion: DEVELOPMENT_VERSION, cliPackage: "ostra" })).toEqual(DEV_RUNNER_NPM);
    expect(runnerNpmFor({ mode: "development", serverVersion: "1.0.0-rc.0", cliPackage: "@acme/ostra-cli" })).toEqual(DEV_RUNNER_NPM);
  });

  it("F-061/c2: this tree's build pins as its stamp says: core's version, and the root package.json's CLI name", async () => {
    const [core, root] = await Promise.all([manifest("../../package.json"), manifest("../../../../package.json")]);
    expect(root.cliPackage).toBeDefined();
    expect(runnerNpm("production")).toEqual(core.version === DEVELOPMENT_VERSION ? null : { package: root.cliPackage, registry: "https://registry.npmjs.org" });
  });
});
