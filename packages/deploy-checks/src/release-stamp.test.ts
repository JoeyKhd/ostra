import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { readWorkspace, setVersion, versionStamps } from "../../../scripts/release.ts";
import { readDeployFiles } from "./deploy-files.ts";
import { checkChartYaml } from "./helm/schema-checks.ts";
import { chartNames } from "./helm/values.ts";
import { checkImages } from "./image-checks.ts";
import { dockerfileOf, imageNames } from "./images.ts";
import { repoRoot } from "./repo.ts";

// The release's stamp (`node scripts/version.ts`, milestone 7's ticket 30) against the checks that
// read the version back: release.yml stamps its tree, then runs `pnpm test`, `check:images` and
// `check:helm` on it. Here a copy of the checkout, stamped with a sample version, passes every
// check that reads it (the compose file's images, each chart's version, the CLI's), and a stamp
// that leaves one file out fails that file's check.

const temp = await mkdtemp(path.join(tmpdir(), "ostra-release-stamp-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

const SAMPLE = "1.2.3-rc.1";

/** A copy of what the stamp writes and the checks read: every package.json, the Dockerfiles, the compose file and each Chart.yaml. */
const copyCheckout = async (name: string): Promise<string> => {
  const target = path.join(temp, name);
  const files = [
    "package.json",
    "pnpm-workspace.yaml",
    ...(await readWorkspace(repoRoot)).map((item) => `${item.dir}/package.json`),
    ...imageNames.map((image) => dockerfileOf(image)),
    "deploy/server-entrypoint.sh",
    "deploy/compose.yaml",
    ...chartNames.map((chart) => `deploy/helm/${chart}/Chart.yaml`),
  ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await cp(path.join(repoRoot, file), path.join(target, file));
  }
  return target;
};

/** Each check that reads the release's version, over a checkout: its problems as `file: rule`. */
const versionChecks = async (checkout: string): Promise<readonly string[]> => [
  ...checkImages(await readDeployFiles(checkout)).map((problem) => `${problem.file}: ${problem.rule}`),
  ...(await Promise.all(chartNames.map((chart) => checkChartYaml(chart, checkout)))).flat().map((problem) => `deploy/helm/${problem.chart}/Chart.yaml: ${problem.rule}`),
];

describe("the release's version stamp", () => {
  it("F-039/c2: a stamp of a sample version leaves the compose file, both charts and the CLI's version passing their checks", async () => {
    const checkout = await copyCheckout("stamped");
    expect(await versionChecks(checkout)).toEqual([]);
    await setVersion(checkout, SAMPLE);
    const files = await readDeployFiles(checkout);
    // The checks read the stamped version, the root's, which tags the images.
    expect(files.releaseVersion).toBe(SAMPLE);
    expect(files.runnerVersion).toBe(SAMPLE);
    expect(await versionChecks(checkout)).toEqual([]);
    // Pinned to the release's tag, never `latest` (ADR 0046).
    expect(files.compose).not.toMatch(/ostra\/(?:server|runner|base):(?!1\.2\.3-rc\.1$)/m);
  });

  it("F-039/c2: a stamp that leaves one file out fails that file's check, and only it", async () => {
    expect(versionStamps.map((stamp) => stamp.file).sort()).toEqual(["deploy/compose.yaml", ...chartNames.map((chart) => `deploy/helm/${chart}/Chart.yaml`)].sort());
    for (const left of versionStamps) {
      const checkout = await copyCheckout(`without-${left.file.replaceAll("/", "-")}`);
      await setVersion(checkout, SAMPLE, versionStamps.filter((stamp) => stamp !== left));
      const failed = await versionChecks(checkout);
      expect(failed.length, left.file).toBeGreaterThan(0);
      expect([...new Set(failed.map((problem) => problem.split(": ")[0]))], left.file).toEqual([left.file]);
    }
  });
});
