import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { readWorkspace, releaseStamps, stampRelease } from "../../../scripts/release.ts";
import { readDeployFiles } from "./deploy-files.ts";
import { checkChartImages, checkChartYaml } from "./helm/schema-checks.ts";
import type { SchemaProblem } from "./helm/schema-checks.ts";
import { chartNames } from "./helm/values.ts";
import { checkImages } from "./image-checks.ts";
import { buildPlan, dockerfileOf, imageNames } from "./images.ts";
import { imageNamespace, releaseVersion, repoRoot } from "./repo.ts";

// The release's stamp (`node scripts/version.ts`, milestone 7's ticket 30) against the checks that
// read it back: release.yml stamps its tree with the version and the image namespace it pushes
// to, then runs `pnpm test`, `check:images` and `check:helm` on it and builds the images. Here a
// copy of the checkout, stamped with a sample release, passes every check that reads it (the
// compose file's images, each chart's version and images, the CLI's version), and a stamp that
// leaves one file out fails that file's check.

const temp = await mkdtemp(path.join(tmpdir(), "ostra-release-stamp-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

/** A release unlike the checkout's own, a clone's or the one release.yml stamped on it, which is read first. */
const own = { version: await releaseVersion(), imageNamespace: await imageNamespace() };
const SAMPLE = {
  version: own.version === "1.2.3-rc.1" ? "1.2.4-rc.1" : "1.2.3-rc.1",
  imageNamespace: own.imageNamespace === "registry.example:5000/team" ? "registry.example:5000/other" : "registry.example:5000/team",
};

/** A copy of what the stamp writes and the checks read: every package.json, the Dockerfiles, the compose file and each chart's Chart.yaml and values.yaml. */
const copyCheckout = async (name: string): Promise<string> => {
  const target = path.join(temp, name);
  const files = [
    "package.json",
    "pnpm-workspace.yaml",
    ...(await readWorkspace(repoRoot)).map((item) => `${item.dir}/package.json`),
    ...imageNames.map((image) => dockerfileOf(image)),
    "deploy/server-entrypoint.sh",
    "deploy/compose.yaml",
    ...chartNames.flatMap((chart) => [`deploy/helm/${chart}/Chart.yaml`, `deploy/helm/${chart}/values.yaml`]),
  ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await cp(path.join(repoRoot, file), path.join(target, file));
  }
  return target;
};

/** The file a chart's problem is in: its Chart.yaml for its version, its values.yaml for its images. */
const chartFile = (problem: SchemaProblem): string => `deploy/helm/${problem.chart}/${problem.rule === "chart-images" ? "values.yaml" : "Chart.yaml"}`;

/** Each check that reads the release, over a checkout: its problems as `file: rule`. */
const releaseChecks = async (checkout: string): Promise<readonly string[]> => [
  ...checkImages(await readDeployFiles(checkout)).map((problem) => `${problem.file}: ${problem.rule}`),
  ...(await Promise.all(chartNames.flatMap((chart) => [checkChartYaml(chart, checkout), checkChartImages(chart, checkout)]))).flat().map((problem) => `${chartFile(problem)}: ${problem.rule}`),
];

describe("the release's stamp", () => {
  it("F-039/c2: a stamp of a sample release leaves the compose file, both charts and the CLI's version passing their checks, naming the images the build tags", async () => {
    const checkout = await copyCheckout("stamped");
    expect(await releaseChecks(checkout)).toEqual([]);
    await stampRelease(checkout, SAMPLE);
    const files = await readDeployFiles(checkout);
    // The checks read the stamped release, the root's, which tags the images.
    expect(files.releaseVersion).toBe(SAMPLE.version);
    expect(files.imageNamespace).toBe(SAMPLE.imageNamespace);
    expect(await imageNamespace(checkout)).toBe(SAMPLE.imageNamespace);
    expect(files.runnerVersion).toBe(SAMPLE.version);
    expect(await releaseChecks(checkout)).toEqual([]);
    // The compose file names exactly what the build tags and release.yml pushes, pinned to the
    // release's tag, never `latest` (ADR 0046), and no image under another namespace.
    const tags = buildPlan(SAMPLE.version, SAMPLE.imageNamespace).map((build) => build.tag);
    expect(tags).toEqual(imageNames.map((name) => `${SAMPLE.imageNamespace}/${name}:${SAMPLE.version}`));
    expect(SAMPLE).not.toEqual(own);
    const named = [...files.compose.matchAll(/^\s+(?:image|OSTRA_BOX_BASE_IMAGE|OSTRA_BOX_RUNNER_IMAGE): (\S+\/(?:server|runner|base):\S+)$/gm)].map((match) => match[1]);
    expect(named).toHaveLength(5);
    expect(named.every((image) => tags.includes(image ?? ""))).toBe(true);
    // A chart's image pinned to a tag of its own isn't the release's either.
    const values = path.join(checkout, "deploy", "helm", "ostra-runner", "values.yaml");
    const text = await readFile(values, "utf8");
    const pinned = text.replace(/^(boxImage:\n {2}repository: \S+\n {2}tag: )""$/m, '$1"latest"');
    expect(pinned).not.toBe(text);
    await writeFile(values, pinned);
    expect(await releaseChecks(checkout)).toEqual(["deploy/helm/ostra-runner/values.yaml: chart-images"]);
  });

  it("F-039/c2: a stamp that leaves one file out fails that file's check, and only it", async () => {
    expect(releaseStamps.map((stamp) => stamp.file).sort()).toEqual(["deploy/compose.yaml", ...chartNames.flatMap((chart) => [`deploy/helm/${chart}/Chart.yaml`, `deploy/helm/${chart}/values.yaml`])].sort());
    for (const left of releaseStamps) {
      const checkout = await copyCheckout(`without-${left.file.replaceAll("/", "-")}`);
      await stampRelease(checkout, SAMPLE, releaseStamps.filter((stamp) => stamp !== left));
      const failed = await releaseChecks(checkout);
      expect(failed.length, left.file).toBeGreaterThan(0);
      expect([...new Set(failed.map((problem) => problem.split(": ")[0]))], left.file).toEqual([left.file]);
    }
  });
});
