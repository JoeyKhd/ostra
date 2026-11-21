import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { imagesOf } from "./run-runner.ts";
import { CLI_PACKAGE, IMAGE_NAMESPACE, releaseImage, RUNNER_VERSION } from "./version.ts";

// Milestone 7's ticket 30 (F-039's publishing, ADR 0064): a released runner's boxes run its own
// release's images, the ones `release.yml` pushed under its namespace, never a clone's `ostra/`
// names. The runner reads them from the root package.json the release's stamp wrote, so on a
// stamped tree (release.yml runs the tests after its stamp) this reads the release's own.

const root = z
  .looseObject({ version: z.string(), imageNamespace: z.string(), cliPackage: z.string() })
  .parse(JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")));

describe("the runner's release names", () => {
  it("F-039/c2: a box's images default to the runner's own release, under the namespace and at the version the stamp wrote on the root package.json, and a setting wins", () => {
    expect({ version: RUNNER_VERSION, imageNamespace: IMAGE_NAMESPACE, cliPackage: CLI_PACKAGE }).toEqual({ version: root.version, imageNamespace: root.imageNamespace, cliPackage: root.cliPackage });
    expect(imagesOf({})).toEqual({ base: `${root.imageNamespace}/base:${root.version}`, runner: `${root.imageNamespace}/runner:${root.version}` });
    expect(releaseImage("runner")).toBe(`${root.imageNamespace}/runner:${root.version}`);
    expect(imagesOf({ boxBaseImage: "registry.example/team/base:9", boxRunnerImage: "registry.example/team/runner:9" })).toEqual({ base: "registry.example/team/base:9", runner: "registry.example/team/runner:9" });
    expect(imagesOf({ boxRunnerImage: "registry.example/team/runner:9" }).base).toBe(`${root.imageNamespace}/base:${root.version}`);
  });
});
