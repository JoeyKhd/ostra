import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyLicense,
  describeViolation,
  findViolations,
  loadWorkspacePackages,
  parseWorkspaceGlobs,
  restrictedLicenses,
  sustainableUseLicense,
} from "./check-licenses.ts";
import type { WorkspacePackage } from "./check-licenses.ts";

const SU = sustainableUseLicense;

const pkg = (
  name: string,
  license: string | undefined,
  dependencies: string[] = [],
  hasLicenseFile = true,
): WorkspacePackage => ({ name, dir: `packages/${name}`, license, dependencies, hasLicenseFile });

describe("findViolations", () => {
  it("passes when Apache-2.0 packages only depend on Apache-2.0 packages", () => {
    expect(
      findViolations([
        pkg("protocol", "Apache-2.0"),
        pkg("adapter-sdk", "Apache-2.0", ["protocol", "zod"]),
        pkg("runner", "Apache-2.0", ["protocol", "adapter-sdk"]),
      ]),
    ).toEqual([]);
  });

  it("lets a Sustainable Use package depend on anything", () => {
    expect(
      findViolations([
        pkg("protocol", "Apache-2.0"),
        pkg("db", SU),
        pkg("domain", SU, ["db", "protocol"]),
      ]),
    ).toEqual([]);
  });

  it("fails when an Apache-2.0 package depends on a Sustainable Use one", () => {
    const violations = findViolations([pkg("db", SU), pkg("runner", "Apache-2.0", ["db"])]);
    expect(violations).toEqual([
      {
        kind: "permissive-depends-on-restricted",
        license: "Apache-2.0",
        reachedLicense: SU,
        name: "runner",
        dir: "packages/runner",
        path: ["runner", "db"],
      },
    ]);
  });

  it("fails when the dependency is only a devDependency or a peer", () => {
    // Every kind of dependency reaches the loader as one list, so the shape is the same.
    const violations = findViolations([pkg("api", SU), pkg("sdk", "Apache-2.0", ["api"])]);
    expect(violations).toHaveLength(1);
  });

  it("fails when the Sustainable Use package is reached through another package", () => {
    const violations = findViolations([
      pkg("db", SU),
      pkg("shared", "Apache-2.0", ["db"]),
      pkg("runner", "Apache-2.0", ["shared"]),
    ]);
    expect(violations.map((violation) => describeViolation(violation))).toEqual([
      "shared (packages/shared) is Apache-2.0 but reaches a restricted package (LicenseRef-Sustainable-Use-1.0): shared -> db",
      "runner (packages/runner) is Apache-2.0 but reaches a restricted package (LicenseRef-Sustainable-Use-1.0): runner -> shared -> db",
    ]);
  });

  it("reports the shortest chain, and stops at a restricted package", () => {
    const violations = findViolations([
      pkg("db", SU),
      pkg("domain", SU, ["db"]),
      pkg("sdk", "Apache-2.0", ["domain"]),
    ]);
    expect(violations).toEqual([
      {
        kind: "permissive-depends-on-restricted",
        license: "Apache-2.0",
        reachedLicense: SU,
        name: "sdk",
        dir: "packages/sdk",
        path: ["sdk", "domain"],
      },
    ]);
  });

  it("terminates on dependency cycles", () => {
    const violations = findViolations([
      pkg("a", "Apache-2.0", ["b"]),
      pkg("b", "Apache-2.0", ["a"]),
      pkg("c", "Apache-2.0", ["a", "d"]),
      pkg("d", SU),
    ]);
    expect(violations.map((violation) => violation.name)).toEqual(["c"]);
  });

  it("ignores dependencies that are not workspace packages", () => {
    expect(findViolations([pkg("sdk", "Apache-2.0", ["zod", "ws"])])).toEqual([]);
  });

  it("fails a package without a license", () => {
    expect(findViolations([pkg("a", undefined), pkg("b", "  ")])).toEqual([
      { kind: "missing-license", name: "a", dir: "packages/a" },
      { kind: "missing-license", name: "b", dir: "packages/b" },
    ]);
  });

  it("fails a mistyped Apache-2.0, instead of letting the package quietly turn restricted", () => {
    // "Apache2.0" is on neither list. If it counted as restricted without a word, the runner would
    // stop being checked, and its import of db would pass.
    const violations = findViolations([pkg("db", SU), pkg("runner", "Apache2.0", ["db"])]);
    expect(violations).toEqual([
      { kind: "unknown-license", name: "runner", dir: "packages/runner", license: "Apache2.0" },
    ]);
    expect(violations.map((violation) => describeViolation(violation))).toEqual([
      'runner (packages/runner) declares "Apache2.0", which is on neither license list in scripts/known-licenses.ts: check the spelling, or add the license to a list',
    ]);
  });

  it("fails a stale license id, and still counts it as restricted for the walk", () => {
    // The AGPL-3.0 id is what ostra declared before ADR 0048.
    const violations = findViolations([
      pkg("stale", "AGPL-3.0-only"),
      pkg("sdk", "Apache-2.0", ["stale"]),
    ]);
    expect(violations.map((violation) => describeViolation(violation))).toEqual([
      'stale (packages/stale) declares "AGPL-3.0-only", which is on neither license list in scripts/known-licenses.ts: check the spelling, or add the license to a list',
      "sdk (packages/sdk) is Apache-2.0 but reaches a restricted package (AGPL-3.0-only): sdk -> stale",
    ]);
  });

  it("fails an expression and a pointer to a file, which name no single license", () => {
    const violations = findViolations([
      pkg("odd", "SEE LICENSE IN LICENSE.md"),
      pkg("dual", "MIT OR GPL-3.0-only"),
    ]);
    expect(violations.map((violation) => violation.kind)).toEqual([
      "unknown-license",
      "unknown-license",
    ]);
  });

  it("reads the ids on both lists in any letter case", () => {
    expect(
      findViolations([
        pkg("db", SU.toLowerCase()),
        pkg("sdk", " apache-2.0 "),
        pkg("util", "MIT", ["sdk"]),
      ]),
    ).toEqual([]);
  });

  it("fails a permissive package that has no LICENSE file", () => {
    const violations = findViolations([pkg("sdk", "Apache-2.0", [], false)]);
    expect(violations).toEqual([
      {
        kind: "permissive-package-missing-license-file",
        name: "sdk",
        dir: "packages/sdk",
        license: "Apache-2.0",
      },
    ]);
    expect(violations.map((violation) => describeViolation(violation))).toEqual([
      "sdk (packages/sdk) is Apache-2.0 but has no LICENSE file with text in its folder",
    ]);
  });

  it("does not ask a Sustainable Use package for a LICENSE file, because the repo root holds its terms", () => {
    expect(findViolations([pkg("db", SU, [], false)])).toEqual([]);
  });

  it("treats a package without a license as restricted when something permissive reaches it", () => {
    const violations = findViolations([pkg("bare", undefined), pkg("sdk", "Apache-2.0", ["bare"])]);
    expect(violations.map((violation) => describeViolation(violation))).toEqual([
      'bare (packages/bare) has no "license" field in its package.json',
      "sdk (packages/sdk) is Apache-2.0 but reaches a restricted package ((none)): sdk -> bare",
    ]);
  });

  it("lets a package under another permissive license join the Apache-2.0 side", () => {
    expect(findViolations([pkg("util", "MIT"), pkg("sdk", "Apache-2.0", ["util"])])).toEqual([]);
    const violations = findViolations([pkg("db", SU), pkg("util", "MIT", ["db"])]);
    expect(violations.map((violation) => violation.name)).toEqual(["util"]);
  });
});

describe("classifyLicense", () => {
  it("calls Apache-2.0 and the other permissive ids permissive, in any letter case", () => {
    expect(classifyLicense("Apache-2.0")).toBe("permissive");
    expect(classifyLicense("MIT")).toBe("permissive");
    expect(classifyLicense("apache-2.0")).toBe("permissive");
    expect(classifyLicense(" BSD-3-Clause ")).toBe("permissive");
  });

  it("lists the Sustainable Use License as the one restricted license", () => {
    expect(restrictedLicenses).toEqual(["LicenseRef-Sustainable-Use-1.0"]);
  });

  it("calls everything else restricted", () => {
    expect(classifyLicense(sustainableUseLicense)).toBe("restricted");
    // The literal id, so a change to the exported constant can't pass unnoticed.
    expect(classifyLicense("LicenseRef-Sustainable-Use-1.0")).toBe("restricted");
    expect(classifyLicense("Apache-2.0 OR MIT")).toBe("restricted");
    expect(classifyLicense("UNLICENSED")).toBe("restricted");
    expect(classifyLicense("")).toBe("restricted");
    expect(classifyLicense(undefined)).toBe("restricted");
  });
});

describe("parseWorkspaceGlobs", () => {
  it("reads the globs under packages and nothing else", () => {
    expect(
      parseWorkspaceGlobs(
        [
          "# a comment",
          "packages:",
          "  - apps/*",
          '  - "packages/*"  # trailing comment',
          "  - 'packages/adapters/*'",
          "  - '!**/test/**'",
          "",
          "onlyBuiltDependencies:",
          "  - esbuild",
        ].join("\n"),
      ),
    ).toEqual(["apps/*", "packages/*", "packages/adapters/*"]);
  });

  it("handles Windows line endings", () => {
    expect(parseWorkspaceGlobs("packages:\r\n  - apps/*\r\n  - packages/*\r\n")).toEqual([
      "apps/*",
      "packages/*",
    ]);
  });
});

describe("loadWorkspacePackages", () => {
  let root: string;

  const write = async (dir: string, json: unknown, licenseText?: string): Promise<void> => {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, "package.json"), JSON.stringify(json));
    if (licenseText !== undefined) {
      await writeFile(path.join(root, dir, "LICENSE"), licenseText);
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ostra-licenses-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads every workspace package.json and finds a violation across kinds of dependency", async () => {
    await writeFile(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - packages/*\n  - packages/adapters/*\n",
    );
    await write("apps/web", {
      name: "web",
      license: sustainableUseLicense,
      dependencies: { db: "workspace:*" },
    });
    await write("packages/db", { name: "db", license: SU });
    await write(
      "packages/protocol",
      { name: "protocol", license: "Apache-2.0", dependencies: { zod: "4.6.7" } },
      "Apache License",
    );
    await write(
      "packages/adapters/linear",
      {
        name: "adapter-linear",
        license: "Apache-2.0",
        devDependencies: { protocol: "workspace:*", db: "workspace:*" },
      },
      "Apache License",
    );
    // Neither a workspace glob nor a package: skipped.
    await write("spikes/one", { name: "spike", dependencies: { db: "workspace:*" } });

    const packages = await loadWorkspacePackages(root);

    expect(packages.map((workspacePackage) => workspacePackage.name)).toEqual([
      "web",
      "adapter-linear",
      "db",
      "protocol",
    ]);
    expect(findViolations(packages).map((violation) => describeViolation(violation))).toEqual([
      "adapter-linear (packages/adapters/linear) is Apache-2.0 but reaches a restricted package (LicenseRef-Sustainable-Use-1.0): adapter-linear -> db",
    ]);
  });

  it("tells a LICENSE file with text from a missing one and an empty one", async () => {
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await write(
      "packages/with-text",
      { name: "with-text", license: "Apache-2.0" },
      "Apache License",
    );
    await write("packages/missing", { name: "missing", license: "Apache-2.0" });
    await write("packages/empty", { name: "empty", license: "Apache-2.0" }, " \n");

    const packages = await loadWorkspacePackages(root);

    expect(
      packages.map((workspacePackage) => [workspacePackage.name, workspacePackage.hasLicenseFile]),
    ).toEqual([
      ["empty", false],
      ["missing", false],
      ["with-text", true],
    ]);
    expect(findViolations(packages).map((violation) => describeViolation(violation))).toEqual([
      "empty (packages/empty) is Apache-2.0 but has no LICENSE file with text in its folder",
      "missing (packages/missing) is Apache-2.0 but has no LICENSE file with text in its folder",
    ]);
  });

  it("rejects a package.json without a name", async () => {
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await write("packages/x", { license: "Apache-2.0" });
    await expect(loadWorkspacePackages(root)).rejects.toThrow();
  });

  it("rejects a glob it can't expand", async () => {
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/**\n");
    await expect(loadWorkspacePackages(root)).rejects.toThrow(/not supported/);
  });
});

describe("this repo", () => {
  it("keeps the license line", async () => {
    const packages = await loadWorkspacePackages(path.resolve(import.meta.dirname, ".."));
    expect(packages.length).toBeGreaterThan(0);
    expect(findViolations(packages)).toEqual([]);
  });
});
