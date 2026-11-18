import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeViolation,
  findViolations,
  loadWorkspacePackages,
  parseWorkspaceGlobs,
} from "./check-licenses.ts";
import type { WorkspacePackage } from "./check-licenses.ts";

const pkg = (
  name: string,
  license: string | undefined,
  dependencies: string[] = [],
): WorkspacePackage => ({ name, dir: `packages/${name}`, license, dependencies });

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

  it("lets an AGPL-3.0 package depend on anything", () => {
    expect(
      findViolations([
        pkg("protocol", "Apache-2.0"),
        pkg("db", "AGPL-3.0-only"),
        pkg("domain", "AGPL-3.0-only", ["db", "protocol"]),
      ]),
    ).toEqual([]);
  });

  it("fails when an Apache-2.0 package depends on an AGPL-3.0 one", () => {
    const violations = findViolations([
      pkg("db", "AGPL-3.0-only"),
      pkg("runner", "Apache-2.0", ["db"]),
    ]);
    expect(violations).toEqual([
      {
        kind: "apache-depends-on-agpl",
        name: "runner",
        dir: "packages/runner",
        path: ["runner", "db"],
      },
    ]);
  });

  it("fails when the dependency is only a devDependency or a peer", () => {
    // Every kind of dependency reaches the loader as one list, so the shape is the same.
    const violations = findViolations([
      pkg("api", "AGPL-3.0-only"),
      pkg("sdk", "Apache-2.0", ["api"]),
    ]);
    expect(violations).toHaveLength(1);
  });

  it("fails when the AGPL-3.0 package is reached through another package", () => {
    const violations = findViolations([
      pkg("db", "AGPL-3.0-only"),
      pkg("shared", "Apache-2.0", ["db"]),
      pkg("runner", "Apache-2.0", ["shared"]),
    ]);
    expect(violations.map((violation) => describeViolation(violation))).toEqual([
      "shared (packages/shared) is Apache-2.0 but reaches an AGPL-3.0 package: shared -> db",
      "runner (packages/runner) is Apache-2.0 but reaches an AGPL-3.0 package: runner -> shared -> db",
    ]);
  });

  it("reports the shortest chain, and stops at an AGPL-3.0 package", () => {
    const violations = findViolations([
      pkg("db", "AGPL-3.0-only"),
      pkg("domain", "AGPL-3.0-only", ["db"]),
      pkg("sdk", "Apache-2.0", ["domain"]),
    ]);
    expect(violations).toEqual([
      {
        kind: "apache-depends-on-agpl",
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
      pkg("d", "AGPL-3.0-only"),
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

  it("fails a license it does not know", () => {
    const [violation] = findViolations([pkg("a", "MIT")]);
    expect(violation).toEqual({
      kind: "unknown-license",
      name: "a",
      dir: "packages/a",
      license: "MIT",
    });
    expect(violation && describeViolation(violation)).toContain('declares "MIT"');
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

  const write = async (dir: string, json: unknown): Promise<void> => {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, "package.json"), JSON.stringify(json));
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
      license: "AGPL-3.0-only",
      dependencies: { db: "workspace:*" },
    });
    await write("packages/db", { name: "db", license: "AGPL-3.0-only" });
    await write("packages/protocol", {
      name: "protocol",
      license: "Apache-2.0",
      dependencies: { zod: "4.6.7" },
    });
    await write("packages/adapters/linear", {
      name: "adapter-linear",
      license: "Apache-2.0",
      devDependencies: { protocol: "workspace:*", db: "workspace:*" },
    });
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
      "adapter-linear (packages/adapters/linear) is Apache-2.0 but reaches an AGPL-3.0 package: adapter-linear -> db",
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
