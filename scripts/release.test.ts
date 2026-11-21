import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { makeReleaseAssets } from "./release-assets.ts";
import type { PackageChart } from "./release-assets.ts";
import { releaseNotes } from "./release-notes.ts";
import { builtExports, isPublishedDir, LICENSOR, linkedAssets, readWorkspace, releaseAssets, releaseProblems, releaseStamps, releaseWorkflowProblems, runtimeImports, stampRelease, versionedFiles } from "./release.ts";

// Milestone 7's ticket 30 (F-039's publishing, ADR 0045, ADR 0064): what a release publishes and
// the checks `release.yml` runs before it does. The repo's own files pass; a copy of them broken in
// one place, in a temp folder, fails with that place named. `release.yml` runs these on its tree
// after its stamp, so they read the tree's version and namespace rather than assume a clone's.

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "ostra-release-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

/** The tree's own release: `0.0.0` and `ostra` in a clone, the release's after `release.yml`'s stamp. */
const tree = z.looseObject({ version: z.string(), imageNamespace: z.string() }).parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A copy of the checkout's release files: the manifests, the LICENSE and NOTICE files, the published packages' sources, the workflows and the deploy files the release is stamped on. */
const copyCheckout = async (name: string): Promise<string> => {
  const target = path.join(temp, name);
  for (const file of ["package.json", "pnpm-workspace.yaml", "LICENSE", "NOTICE", ".github/workflows/release.yml", ".github/workflows/ci.yml", ...releaseStamps.map((stamp) => stamp.file)]) {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await cp(path.join(root, file), path.join(target, file));
  }
  for (const { dir } of await readWorkspace(root)) {
    await mkdir(path.join(target, dir), { recursive: true });
    for (const file of ["package.json", "LICENSE", "tsconfig.build.json"]) {
      await cp(path.join(root, dir, file), path.join(target, dir, file)).catch(() => undefined);
    }
    if (isPublishedDir(dir)) {
      await cp(path.join(root, dir, "src"), path.join(target, dir, "src"), { recursive: true });
    }
  }
  return target;
};

const edit = async (checkout: string, file: string, from: string | RegExp, to: string): Promise<void> => {
  const full = path.join(checkout, file);
  const text = await readFile(full, "utf8");
  const changed = text.replace(from, to);
  expect(changed, `${file} to change`).not.toBe(text);
  await writeFile(full, changed, "utf8");
};

const messages = async (checkout: string): Promise<readonly string[]> => (await releaseProblems(checkout)).map((problem) => `${problem.file}: ${problem.message}`);

let pristine = "";
beforeAll(async () => {
  pristine = await copyCheckout("pristine");
});

describe("the published packages", () => {
  it("F-039/c2: every published package has its license, only its build and LICENSE as its files, npm's provenance and the repository", async () => {
    expect(await releaseProblems(root)).toEqual([]);
    const published = (await readWorkspace(root)).filter((item) => isPublishedDir(item.dir));
    expect(published.map((item) => item.manifest.name)).toEqual(expect.arrayContaining(["@ostra/protocol", "@ostra/adapter-sdk", "@ostra/adapter-opencode", "@ostra/adapter-github", "@ostra/adapter-linear"]));
    expect(published).toHaveLength(16);
    for (const { manifest, dir } of published) {
      expect(manifest.private, dir).toBeUndefined();
      expect(manifest.files, dir).toEqual(["dist", "LICENSE"]);
      expect(manifest.publishConfig, dir).toMatchObject({ access: "public", provenance: true, exports: builtExports(manifest.exports ?? {}) });
      expect(await readFile(path.join(root, dir, "LICENSE"), "utf8"), dir).toContain("Apache License");
    }
    // The CLI's own package, which `pack:cli` writes beside its bundle, is checked in apps/runner (pack-cli.test.ts).
  });

  it("F-039/c2: no server package is publishable: one made public fails, and a published one without provenance or with its source fails", async () => {
    expect(await messages(pristine)).toEqual([]);
    const core = await copyCheckout("core-public");
    await edit(core, "apps/core/package.json", /\n\s*"private": true,/, "");
    expect(await messages(core)).toEqual(['apps/core/package.json: isn\'t published, so it must be "private": true (the server\'s packages never are)']);

    const provenance = await copyCheckout("no-provenance");
    await edit(provenance, "packages/protocol/package.json", '"provenance": true', '"provenance": false');
    expect(await messages(provenance)).toEqual(['packages/protocol/package.json: needs "publishConfig": { "access": "public", "provenance": true }']);

    const source = await copyCheckout("with-source");
    await edit(source, "packages/adapters/adapter-github/package.json", /"files": \[\n\s*"dist",/, '"files": [\n    "src",\n    "dist",');
    expect(await messages(source)).toEqual(['packages/adapters/adapter-github/package.json: must publish only its build and its LICENSE: "files": ["dist", "LICENSE"]']);
  });

  it("F-039/c2: a published package imports at run time only what it declares", async () => {
    expect(runtimeImports('import { z } from "zod";\nimport type { X } from "vitest";\nexport { a } from "./a.ts";\nimport "@scope/side/effect";\nconst m = await import("node:fs");')).toEqual(["zod", "@scope/side"]);
    const undeclared = await copyCheckout("undeclared");
    await edit(undeclared, "packages/adapters/adapter-email-smtp/package.json", /,\n\s*"zod": "4\.6\.7"/, "");
    expect(await messages(undeclared)).toEqual(["packages/adapters/adapter-email-smtp/src/smtp-email-adapter.ts: imports zod, which @ostra/adapter-email-smtp doesn't declare in its dependencies"]);
  });
});

/** A release unlike the tree's own (read above, so it differs on a stamped tree too), so a file the stamp left alone shows. */
const SAMPLE = {
  version: tree.version === "1.2.3-rc.1" ? "1.2.4-rc.1" : "1.2.3-rc.1",
  imageNamespace: tree.imageNamespace === "registry.example:5000/team" ? "registry.example:5000/other" : "registry.example:5000/team",
};

describe("one version", () => {
  it("F-039/c2: the stamp sets the release's version on every package.json, the root's (the images' tags) and the CLI's included, its image namespace on the root's, and both on the compose file's images and on each chart, and refuses a version or a namespace that isn't one", async () => {
    const checkout = await copyCheckout("version");
    const read = (file: string): Promise<string> => readFile(path.join(checkout, file), "utf8");
    const before = await read("packages/protocol/package.json");
    const rootBefore = await read("package.json");
    const compose = await read("deploy/compose.yaml");
    const charts = await Promise.all(["ostra-server", "ostra-runner"].map((chart) => read(`deploy/helm/${chart}/Chart.yaml`)));
    const values = await Promise.all(["ostra-server", "ostra-runner"].map((chart) => read(`deploy/helm/${chart}/values.yaml`)));
    const files = await stampRelease(checkout, SAMPLE);
    expect(files).toEqual([
      ...(await versionedFiles(checkout)),
      "deploy/compose.yaml",
      "deploy/helm/ostra-server/Chart.yaml",
      "deploy/helm/ostra-runner/Chart.yaml",
      "deploy/helm/ostra-server/values.yaml",
      "deploy/helm/ostra-runner/values.yaml",
    ]);
    expect(files).toEqual(expect.arrayContaining(["package.json", "apps/runner/package.json", "apps/core/package.json", "packages/protocol/package.json"]));
    for (const file of await versionedFiles(checkout)) {
      const manifest: unknown = JSON.parse(await read(file));
      expect(Reflect.get(Object(manifest), "version"), file).toBe(SAMPLE.version);
    }
    // Only the release changed: a package.json's version line, the root's imageNamespace, the
    // compose file's three images and two box images, each chart's version and appVersion, and its
    // images' repositories. One version line holds after it.
    const version = `"version": "${tree.version}"`;
    expect(await read("packages/protocol/package.json")).toBe(before.replace(version, `"version": "${SAMPLE.version}"`));
    expect(await read("package.json")).toBe(rootBefore.replace(version, `"version": "${SAMPLE.version}"`).replace(`"imageNamespace": "${tree.imageNamespace}"`, `"imageNamespace": "${SAMPLE.imageNamespace}"`));
    const image = new RegExp(`(: )${escaped(tree.imageNamespace)}/(server|runner|base):${escaped(tree.version)}$`, "gm");
    expect(compose.match(image)).toHaveLength(5);
    expect(await read("deploy/compose.yaml")).toBe(compose.replaceAll(image, `$1${SAMPLE.imageNamespace}/$2:${SAMPLE.version}`));
    for (const [index, chart] of ["ostra-server", "ostra-runner"].entries()) {
      expect(await read(`deploy/helm/${chart}/Chart.yaml`), chart).toBe((charts[index] ?? "").replace(`\nversion: ${tree.version}\n`, `\nversion: ${SAMPLE.version}\n`).replace(`\nappVersion: "${tree.version}"\n`, `\nappVersion: "${SAMPLE.version}"\n`));
    }
    const repository = new RegExp(`^( {2}repository: )${escaped(tree.imageNamespace)}/(server|runner|base)$`, "gm");
    expect(values.map((text) => text.match(repository)?.length)).toEqual([1, 2]);
    for (const [index, chart] of ["ostra-server", "ostra-runner"].entries()) {
      expect(await read(`deploy/helm/${chart}/values.yaml`), chart).toBe((values[index] ?? "").replaceAll(repository, `$1${SAMPLE.imageNamespace}/$2`));
    }
    expect(await messages(checkout)).toEqual([]);
    for (const bad of ["v1.0.0", "1.0", "", "1.0.0 ; rm -rf /"]) {
      await expect(stampRelease(checkout, { ...SAMPLE, version: bad }), bad).rejects.toThrow(/isn't a release version/);
    }
    // Docker refuses an uppercase or trailing-slash name; a `$` would be read by the replacement.
    for (const bad of ["ghcr.io/JoeyKhd", "ghcr.io/joeykhd/", "", "ghcr.io/x; rm -rf /", "$1/x", "ghcr.io/x\nimage: evil", "https://ghcr.io/x"]) {
      await expect(stampRelease(checkout, { ...SAMPLE, imageNamespace: bad }), bad).rejects.toThrow(/isn't an image namespace/);
    }
    // Stamped twice, the second release wins: each spot matches any namespace and version.
    await stampRelease(checkout, { version: "2.0.0", imageNamespace: "ghcr.io/joeykhd" });
    expect(await read("deploy/compose.yaml")).toContain("    image: ghcr.io/joeykhd/server:2.0.0\n");
    expect(await read("deploy/helm/ostra-runner/values.yaml")).toContain("  repository: ghcr.io/joeykhd/base\n");
  });

  it("F-039/c2: a version line the stamp doesn't find where it expects fails the stamp, which then writes nothing", async () => {
    const checkout = await copyCheckout("version-moved");
    await edit(checkout, "deploy/compose.yaml", "      OSTRA_BOX_BASE_IMAGE: ", "      OSTRA_BOX_IMAGE: ");
    const root = await readFile(path.join(checkout, "package.json"), "utf8");
    await expect(stampRelease(checkout, SAMPLE)).rejects.toThrow(/^deploy\/compose\.yaml: the release stamp expects 5 line\(s\) .* and found 4$/);
    expect(await readFile(path.join(checkout, "package.json"), "utf8")).toBe(root);
    await edit(checkout, "deploy/compose.yaml", "      OSTRA_BOX_IMAGE: ", "      OSTRA_BOX_BASE_IMAGE: ");
    await edit(checkout, "deploy/helm/ostra-runner/Chart.yaml", /^appVersion: .*$/m, "appVersion: 0.0.0");
    await expect(stampRelease(checkout, SAMPLE)).rejects.toThrow(/^deploy\/helm\/ostra-runner\/Chart\.yaml: the release stamp expects 1 line\(s\) .* and found 0$/);
    await edit(checkout, "deploy/helm/ostra-runner/Chart.yaml", /^appVersion: .*$/m, `appVersion: "${tree.version}"`);
    await edit(checkout, "deploy/helm/ostra-runner/values.yaml", /^ {2}repository: (\S+)\/base$/m, "  repository: base");
    await expect(stampRelease(checkout, SAMPLE)).rejects.toThrow(/^deploy\/helm\/ostra-runner\/values\.yaml: the release stamp expects 2 line\(s\) .* and found 1$/);
    await edit(checkout, "package.json", /\n\s*"imageNamespace": "[^"]*",/, "");
    await expect(stampRelease(checkout, SAMPLE)).rejects.toThrow(/^package\.json: the release stamp expects 1 line\(s\) .*imageNamespace.* and found 0$/);
    expect(await messages(checkout)).toEqual(["package.json: its imageNamespace is missing, not an image namespace: where the images are published, which node scripts/version.ts sets (\"ostra\" in a clone)"]);
  });

  it("F-039/c2: every package.json carries the root's version: one bumped by hand fails check:release", async () => {
    const checkout = await copyCheckout("version-line");
    await edit(checkout, "apps/core/package.json", `"version": "${tree.version}"`, '"version": "0.9.0"');
    expect(await messages(checkout)).toEqual([`apps/core/package.json: its version is 0.9.0, not the root's ${tree.version}: one version line, which node scripts/version.ts sets`]);
  });
});

/** Helm's `helm package` as far as the release's files need it: `<chart>-<Chart.yaml's version>.tgz`, holding the chart's values. */
const fakePackage: PackageChart = async (chartDir, destination) => {
  const version = /^version: (\S+)$/m.exec(await readFile(path.join(chartDir, "Chart.yaml"), "utf8"))?.[1] ?? "";
  await writeFile(path.join(destination, `${path.basename(chartDir)}-${version}.tgz`), await readFile(path.join(chartDir, "values.yaml")));
};

/** Every page the docs site renders, and the repo's own docs it reads: their text by path. */
const docsPages = async (): Promise<readonly { readonly file: string; readonly text: string }[]> => {
  const pages: { file: string; text: string }[] = [];
  for (const dir of ["apps/docs/content", "docs"]) {
    for (const entry of await readdir(path.join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
        const file = path.join(entry.parentPath, entry.name);
        pages.push({ file: path.relative(root, file).replaceAll("\\", "/"), text: await readFile(file, "utf8") });
      }
    }
  }
  return pages;
};

describe("the release's files", () => {
  it("F-039/c2: every file the docs download from a release is one the release attaches: the compose file and both charts", async () => {
    const linked = (await docsPages()).flatMap((page) => linkedAssets(page.text).map((name) => ({ page: page.file, name })));
    const names = releaseAssets.map((asset) => asset.name);
    expect(linked.map((link) => link.page)).toEqual(expect.arrayContaining(["apps/docs/content/install/docker-compose.mdx", "apps/docs/content/install/helm.mdx", "apps/docs/content/install/upgrading.mdx"]));
    expect(linked.filter((link) => !names.includes(link.name))).toEqual([]);
    expect(names).toEqual(["compose.yaml", "ostra-server.tgz", "ostra-runner.tgz"]);
    expect([...new Set(linked.map((link) => link.name))].sort()).toEqual([...names].sort());
    // The link reads the download's name, a release's or the newest one's, and nothing after it.
    expect(linkedAssets("curl -fsSLO https://github.com/JoeyKhd/ostra/releases/download/v1.0.0/compose.yaml\nsee `https://github.com/JoeyKhd/ostra/releases/latest/download/ostra-runner.tgz`.")).toEqual(["compose.yaml", "ostra-runner.tgz"]);
    expect(linkedAssets("https://github.com/someone/else/releases/latest/download/x.yaml")).toEqual([]);
  });

  it("F-039/c2: the release's files are the stamped compose file and both charts at the release's version; a chart left at another version fails", async () => {
    const checkout = await copyCheckout("assets");
    await stampRelease(checkout, SAMPLE);
    const out = path.join(temp, "assets-out");
    const made = await makeReleaseAssets(checkout, out, fakePackage);
    expect(made.map((asset) => asset.name)).toEqual(releaseAssets.map((asset) => asset.name));
    expect(made.every((asset) => asset.bytes > 0 && /^[0-9a-f]{64}$/.test(asset.sha256))).toBe(true);
    const compose = await readFile(path.join(out, "compose.yaml"), "utf8");
    expect(compose).toBe(await readFile(path.join(checkout, "deploy", "compose.yaml"), "utf8"));
    expect(compose).toContain(`    image: ${SAMPLE.imageNamespace}/server:${SAMPLE.version}\n`);
    expect(compose).not.toMatch(new RegExp(`: ${escaped(tree.imageNamespace)}/(server|runner|base):`));
    expect(await readFile(path.join(out, "ostra-runner.tgz"), "utf8")).toContain(`  repository: ${SAMPLE.imageNamespace}/runner\n`);
    // Into a folder that holds anything already, or from a chart the stamp missed, nothing ships.
    await expect(makeReleaseAssets(checkout, out, fakePackage)).rejects.toThrow(/already holds/);
    await edit(checkout, "deploy/helm/ostra-server/Chart.yaml", /^version: .*$/m, "version: 0.0.0");
    await expect(makeReleaseAssets(checkout, path.join(temp, "assets-stale"), fakePackage)).rejects.toThrow(new RegExp(`^helm package made ostra-server-0\\.0\\.0\\.tgz of ostra-server, not ostra-server-${escaped(SAMPLE.version)}\\.tgz`));
  });
});

describe("the licensor line", () => {
  it("F-039/c2: every licensor line matches and NOTICE is current: a changed LICENSE, NOTICE or published author fails", async () => {
    const license = await copyCheckout("licensor-license");
    await edit(license, "LICENSE", `Licensor and copyright holder: ${LICENSOR}`, "Licensor and copyright holder: Someone Else");
    expect(await messages(license)).toEqual([`LICENSE: must say "Licensor and copyright holder: ${LICENSOR}"`, 'LICENSE: names "Someone Else" as the licensor, not "' + LICENSOR + '"']);

    const notice = await copyCheckout("licensor-notice");
    await edit(notice, "NOTICE", `Copyright (c) 2026 ${LICENSOR}`, "Copyright (c) 2026 Ostra Inc.");
    expect(await messages(notice)).toEqual([`NOTICE: must say "Copyright (c) 2026 ${LICENSOR}"`, `NOTICE: names "Ostra Inc." as the licensor, not "${LICENSOR}"`]);

    const apache = await copyCheckout("licensor-apache");
    await edit(apache, "packages/protocol/LICENSE", "   Copyright [yyyy] [name of copyright owner]", "Copyright (c) 2026 Ostra Inc.");
    expect(await messages(apache)).toEqual([`packages/protocol/LICENSE: names "Ostra Inc." as the licensor, not "${LICENSOR}"`]);

    // NOTICE is current: an Apache-2.0 package it leaves out of its list fails.
    const notice2 = await copyCheckout("notice-list");
    await edit(notice2, "NOTICE", "  apps/docs\n", "");
    expect(await messages(notice2)).toEqual(["NOTICE: doesn't list apps/docs, which is Apache-2.0, among the Apache-2.0 directories"]);
    await edit(notice2, "NOTICE", "  apps/web\n", "  apps/web\n  apps/runner\n");
    expect(await messages(notice2)).toContain("NOTICE: lists apps/runner under the Sustainable Use License, but it's Apache-2.0");

    const author = await copyCheckout("licensor-author");
    await edit(author, "packages/adapter-sdk/package.json", LICENSOR, "JoeyKhd");
    expect(await messages(author)).toEqual(["packages/adapter-sdk/package.json: its author must be the licensor line (scripts/licensor.ts, LICENSOR)"]);
  });
});

/** The ticked-box pattern of contributor-agreement.yml, as the workflow's `grep -Ei` reads it. */
const agreementPattern = async (): Promise<RegExp> => {
  const workflow = await readFile(path.join(root, ".github", "workflows", "contributor-agreement.yml"), "utf8");
  const pattern = /^\s*ticked='([^']+)'$/m.exec(workflow)?.[1];
  expect(pattern, "the workflow's ticked='...' pattern").toBeDefined();
  expect(workflow).toContain('grep -Eiq "$ticked"');
  // POSIX ERE to JavaScript: the only class it uses is [[:space:]].
  return new RegExp((pattern ?? "").replaceAll("[[:space:]]", String.raw`\s`), "im");
};

describe("the contributor agreement's box", () => {
  it("F-039/c2: the pull request template's box, ticked, matches the agreement check's pattern; a reworded or unticked box fails", async () => {
    const ticked = await agreementPattern();
    const template = await readFile(path.join(root, ".github", "pull_request_template.md"), "utf8");
    const box = template.split(/\r?\n/).find((line) => line.startsWith("- [ ] I agree"));
    expect(box).toBeDefined();
    const tick = (line: string): string => line.replace("- [ ]", "- [x]");
    expect(ticked.test(tick(box ?? ""))).toBe(true);
    expect(ticked.test(`## What\n\nA change.\n\n${tick(box ?? "")}\n`)).toBe(true);
    expect(ticked.test(box ?? "")).toBe(false);
    expect(ticked.test(tick((box ?? "").replace("I agree to the", "I accept the")))).toBe(false);
    expect(ticked.test(tick((box ?? "").replace("ostra contributor agreement", "contributor agreement")))).toBe(false);
  });
});

describe("the release workflow", () => {
  it("F-039/c2: release.yml runs by hand only, pins every action by SHA, holds three permissions and no npm token, stamps the namespace, attaches its files to the real release only, and its dry run publishes nothing", async () => {
    const workflow = await readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
    const ci = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(releaseWorkflowProblems(workflow, ci)).toEqual([]);
    const broken = (from: string | RegExp, to: string): readonly string[] => {
      const changed = workflow.replace(from, to);
      expect(changed).not.toBe(workflow);
      return releaseWorkflowProblems(changed, ci).map((problem) => problem.message);
    };
    expect(broken("on:\n  workflow_dispatch:", "on:\n  push:\n    tags: ['v*']\n  workflow_dispatch:")).toEqual([expect.stringMatching(/^starts by hand only/)]);
    expect(broken("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/checkout@v7")).toEqual(["pins every action by its commit's SHA: actions/checkout@v7"]);
    expect(broken("  id-token: write\n", "  id-token: write\n  actions: write\n")).toEqual(["its permissions are contents, packages and id-token write, and nothing else"]);
    expect(broken("      VERSION: ${{ inputs.version }}", "      VERSION: ${{ inputs.version }}\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}")).toEqual(["holds no npm token: npm's trusted publishing trusts the workflow itself"]);
    expect(broken('npm publish "$tarball" --tag "$tag" --dry-run', 'npm publish "$tarball" --tag "$tag"')).toEqual(["publishes each tarball with --provenance, or with --dry-run in the dry run"]);
    expect(broken(/(dry-run:\n(?: {8}.*\n)*? {8}default:) true/, "$1 false")).toEqual(["its dry run is the default"]);
    // The stamp names the namespace the images are pushed to, and the release attaches its files.
    expect(broken('node scripts/version.ts "$VERSION" "$IMAGE_NAMESPACE"', 'node scripts/version.ts "$VERSION"')).toEqual([expect.stringMatching(/^stamps its tree with the version and the image namespace/)]);
    const assets = /^makes the release's files in every run/;
    expect(broken(' $prerelease "$OUT"/assets/*', " $prerelease")).toEqual([expect.stringMatching(assets)]);
    expect(broken("      - name: Make the release's files\n", "      - if: ${{ !inputs.dry-run }}\n        name: Make the release's files\n")).toEqual([expect.stringMatching(assets)]);
    expect(broken("      - if: ${{ !inputs.dry-run }}\n        name: Create the GitHub release\n", "      - name: Create the GitHub release\n")).toEqual([expect.stringMatching(assets)]);
    expect(releaseWorkflowProblems(workflow, `${ci}\n      - run: pnpm images:build\n`).map((problem) => problem.message)).toEqual(["ci.yml never runs the release, a publish or an image build (the maintainer's CI scope)"]);
  });

  it("F-039/c2: the release notes carry the changelog, each image by its digest and each package at the release's version", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const notes = releaseNotes({ version: "1.0.0", commits: ["✨ add the release workflow", "🐛 fix a thing"], digests: [`ghcr.io/x/server@${digest}`], packages: ["@ostra/protocol@1.0.0", "ostra@1.0.0"] });
    expect(notes).toContain(`- \`ghcr.io/x/server@${digest}\``);
    expect(notes).toContain("- `@ostra/protocol@1.0.0`");
    expect(notes).toContain("- ✨ add the release workflow\n- 🐛 fix a thing");
    expect(() => releaseNotes({ version: "1.0.0", commits: [], digests: ["ghcr.io/x/server:1.0.0"], packages: ["ostra@1.0.0"] })).toThrow(/by its digest/);
    expect(() => releaseNotes({ version: "1.0.0", commits: [], digests: [`ghcr.io/x/server@${digest}`], packages: ["ostra@0.9.0"] })).toThrow(/at 1\.0\.0/);
  });
});
