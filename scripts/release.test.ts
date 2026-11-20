import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { releaseNotes } from "./release-notes.ts";
import { builtExports, isPublishedDir, LICENSOR, readWorkspace, releaseProblems, releaseWorkflowProblems, runtimeImports, setVersion, versionedFiles } from "./release.ts";

// Milestone 7's ticket 30 (F-039's publishing, ADR 0045, ADR 0064): what a release publishes and
// the checks `release.yml` runs before it does. The repo's own files pass; a copy of them broken in
// one place, in a temp folder, fails with that place named.

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "ostra-release-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

/** A copy of the checkout's release files: the manifests, the LICENSE and NOTICE files, the published packages' sources and the workflows. */
const copyCheckout = async (name: string): Promise<string> => {
  const target = path.join(temp, name);
  for (const file of ["package.json", "pnpm-workspace.yaml", "LICENSE", "NOTICE", ".github/workflows/release.yml", ".github/workflows/ci.yml"]) {
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

describe("one version", () => {
  it("F-039/c2: the version script sets one version on every package.json, the root's (the images' tags) and the CLI's included, and refuses one that isn't a version", async () => {
    const checkout = await copyCheckout("version");
    const before = await readFile(path.join(checkout, "packages/protocol/package.json"), "utf8");
    const files = await setVersion(checkout, "1.2.3-rc.1");
    expect(files).toEqual(await versionedFiles(checkout));
    expect(files).toEqual(expect.arrayContaining(["package.json", "apps/runner/package.json", "apps/core/package.json", "packages/protocol/package.json"]));
    for (const file of files) {
      const manifest: unknown = JSON.parse(await readFile(path.join(checkout, file), "utf8"));
      expect(Reflect.get(Object(manifest), "version"), file).toBe("1.2.3-rc.1");
    }
    // Only the version line changed.
    expect(await readFile(path.join(checkout, "packages/protocol/package.json"), "utf8")).toBe(before.replace('"version": "0.0.0"', '"version": "1.2.3-rc.1"'));
    for (const bad of ["v1.0.0", "1.0", "", "1.0.0 ; rm -rf /"]) {
      await expect(setVersion(checkout, bad), bad).rejects.toThrow(/isn't a release version/);
    }
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
  it("F-039/c2: release.yml runs by hand only, pins every action by SHA, holds three permissions and no npm token, and its dry run publishes nothing", async () => {
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
