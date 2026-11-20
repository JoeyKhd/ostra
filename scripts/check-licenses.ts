// The license line, checked by a machine.
//
// - Every workspace package declares its license in the `license` field of its package.json.
// - That license is on one of two lists: permissive (Apache-2.0 and its kin) or restricted (today
//   only the Sustainable Use License, written as LicenseRef-Sustainable-Use-1.0). Any other string
//   is an unknown-license violation, so a typo such as "Apache2.0" or a stale id can't quietly move
//   a package to the other side of the line.
// - A package under a permissive license never depends on a restricted package, directly or
//   through another one. In this walk an unlisted license counts as restricted too, so a later
//   license change can't open a hole by accident.
// - A package under a permissive license has a LICENSE file in its folder, with the license text.
//
// Run with `pnpm check:licenses`.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { permissiveLicenses, restrictedLicenses } from "./known-licenses.ts";
import type { PermissiveLicense } from "./known-licenses.ts";

// The lists live in known-licenses.ts, which the images' notices generator reads too (F-039).
export { permissiveLicenses, restrictedLicenses, sustainableUseLicense } from "./known-licenses.ts";
export type { PermissiveLicense } from "./known-licenses.ts";

export type LicenseClass = "permissive" | "restricted";

export type WorkspacePackage = {
  name: string;
  /** The package's folder, relative to the repo root, with forward slashes. */
  dir: string;
  /** The `license` field as written, or `undefined` when the package has none. */
  license: string | undefined;
  /** Every dependency name, of any kind: dependencies, dev, peer and optional. */
  dependencies: readonly string[];
  /** Whether the package's folder has a LICENSE file with text in it. */
  hasLicenseFile: boolean;
};

export type Violation =
  | { kind: "missing-license"; name: string; dir: string }
  | {
      kind: "unknown-license";
      name: string;
      dir: string;
      /** The `license` field as written: on neither the permissive nor the restricted list. */
      license: string;
    }
  | {
      kind: "permissive-package-missing-license-file";
      name: string;
      dir: string;
      /** The package's own license, as written. */
      license: string;
    }
  | {
      kind: "permissive-depends-on-restricted";
      name: string;
      dir: string;
      /** The permissive package's own license, as written. */
      license: string;
      /** The restricted package that the chain ends at, and its license as written. */
      reachedLicense: string;
      /** From the permissive package to the restricted one it reaches, both ends included. */
      path: readonly string[];
    };

const isPermissiveLicense = (license: string): license is PermissiveLicense =>
  permissiveLicenses.some(
    (permissive) => permissive.toLowerCase() === license.trim().toLowerCase(),
  );

const isRestrictedLicense = (license: string): boolean =>
  restrictedLicenses.some(
    (restricted) => restricted.toLowerCase() === license.trim().toLowerCase(),
  );

/**
 * SPDX ids are case-insensitive. A missing license, an expression such as "MIT OR GPL-3.0-only"
 * and an id that is not listed all count as restricted, so the dependency walk never lets one
 * through. `findViolations` reports an unlisted id by itself, as `unknown-license`.
 */
export const classifyLicense = (license: string | undefined): LicenseClass =>
  license !== undefined && isPermissiveLicense(license) ? "permissive" : "restricted";

const dependencyMapSchema = z.record(z.string(), z.string()).optional();

// package.json is npm's format, not ostra's, so unknown fields are tolerated.
const packageJsonSchema = z.looseObject({
  name: z.string().min(1),
  license: z.string().optional(),
  dependencies: dependencyMapSchema,
  devDependencies: dependencyMapSchema,
  peerDependencies: dependencyMapSchema,
  optionalDependencies: dependencyMapSchema,
});

/** The workspace globs listed under `packages:` in pnpm-workspace.yaml. */
export const parseWorkspaceGlobs = (yaml: string): string[] => {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) {
      continue;
    }
    if (/^\S/.test(line)) {
      inPackages = /^packages\s*:\s*(#.*)?$/.test(line);
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const match = /^\s*-\s+["']?([^"'#\s]+)["']?\s*(#.*)?$/.exec(line);
    const glob = match?.[1];
    if (glob !== undefined && !glob.startsWith("!")) {
      globs.push(glob);
    }
  }
  return globs;
};

const expandGlob = async (root: string, glob: string): Promise<string[]> => {
  const parts = glob.split("/");
  const last = parts.at(-1);
  if (last === "*" && parts.slice(0, -1).every((part) => !part.includes("*"))) {
    const parent = parts.slice(0, -1).join("/");
    const entries = await readdir(path.join(root, parent), { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => `${parent}/${entry.name}`)
      .sort();
  }
  if (!glob.includes("*")) {
    return [glob];
  }
  throw new Error(`pnpm-workspace.yaml: "${glob}" is not supported, use "folder/*" or a folder`);
};

const readPackage = async (root: string, dir: string): Promise<WorkspacePackage | undefined> => {
  let text: string;
  try {
    text = await readFile(path.join(root, dir, "package.json"), "utf8");
  } catch {
    // A folder without a package.json is not a package, such as `packages/adapters` itself.
    return undefined;
  }
  const parsed = packageJsonSchema.parse(JSON.parse(text));
  const hasLicenseFile = await readFile(path.join(root, dir, "LICENSE"), "utf8").then(
    (licenseText) => licenseText.trim() !== "",
    () => false,
  );
  return {
    name: parsed.name,
    dir,
    license: parsed.license,
    dependencies: [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
      ...Object.keys(parsed.optionalDependencies ?? {}),
    ],
    hasLicenseFile,
  };
};

/** Reads every package that pnpm-workspace.yaml names. */
export const loadWorkspacePackages = async (root: string): Promise<WorkspacePackage[]> => {
  const yaml = await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const dirs = new Set<string>();
  for (const glob of parseWorkspaceGlobs(yaml)) {
    for (const dir of await expandGlob(root, glob)) {
      dirs.add(dir);
    }
  }
  const found: WorkspacePackage[] = [];
  for (const dir of [...dirs].sort()) {
    const workspacePackage = await readPackage(root, dir);
    if (workspacePackage !== undefined) {
      found.push(workspacePackage);
    }
  }
  return found;
};

/** The shortest chain of workspace dependencies from `from` to a package that `isTarget` accepts. */
const shortestPathTo = (
  from: WorkspacePackage,
  byName: ReadonlyMap<string, WorkspacePackage>,
  isTarget: (candidate: WorkspacePackage) => boolean,
): string[][] => {
  const found: string[][] = [];
  const seen = new Set<string>([from.name]);
  let frontier: string[][] = [[from.name]];
  while (frontier.length > 0) {
    const next: string[][] = [];
    for (const chain of frontier) {
      const tail = chain.at(-1);
      const current = tail === undefined ? undefined : byName.get(tail);
      if (current === undefined) {
        continue;
      }
      for (const dependencyName of current.dependencies) {
        const dependency = byName.get(dependencyName);
        if (dependency === undefined || seen.has(dependency.name)) {
          continue;
        }
        seen.add(dependency.name);
        const extended = [...chain, dependency.name];
        if (isTarget(dependency)) {
          found.push(extended);
        }
        // A restricted package ends the chain: what it depends on is not ours to report.
        if (classifyLicense(dependency.license) === "permissive") {
          next.push(extended);
        }
      }
    }
    frontier = next;
  }
  return found;
};

export const findViolations = (packages: readonly WorkspacePackage[]): Violation[] => {
  const byName = new Map(
    packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  const violations: Violation[] = [];

  for (const workspacePackage of packages) {
    const { name, dir, license, hasLicenseFile } = workspacePackage;
    if (license === undefined || license.trim() === "") {
      violations.push({ kind: "missing-license", name, dir });
      continue;
    }
    if (!isPermissiveLicense(license) && !isRestrictedLicense(license)) {
      // Not walked: an unlisted license counts as restricted, so it has no side to check from.
      violations.push({ kind: "unknown-license", name, dir, license });
      continue;
    }
    const licenseClass = classifyLicense(license);
    switch (licenseClass) {
      case "restricted":
        break;
      case "permissive":
        if (!hasLicenseFile) {
          violations.push({ kind: "permissive-package-missing-license-file", name, dir, license });
        }
        for (const chain of shortestPathTo(
          workspacePackage,
          byName,
          (candidate) => classifyLicense(candidate.license) === "restricted",
        )) {
          const reached = byName.get(chain.at(-1) ?? "");
          violations.push({
            kind: "permissive-depends-on-restricted",
            name,
            dir,
            license,
            reachedLicense: reached?.license ?? "(none)",
            path: chain,
          });
        }
        break;
      default:
        licenseClass satisfies never;
    }
  }
  return violations;
};

export const describeViolation = (violation: Violation): string => {
  switch (violation.kind) {
    case "missing-license":
      return `${violation.name} (${violation.dir}) has no "license" field in its package.json`;
    case "unknown-license":
      return `${violation.name} (${violation.dir}) declares "${violation.license}", which is on neither license list in scripts/known-licenses.ts: check the spelling, or add the license to a list`;
    case "permissive-package-missing-license-file":
      return `${violation.name} (${violation.dir}) is ${violation.license} but has no LICENSE file with text in its folder`;
    case "permissive-depends-on-restricted":
      return `${violation.name} (${violation.dir}) is ${violation.license} but reaches a restricted package (${violation.reachedLicense}): ${violation.path.join(" -> ")}`;
    default:
      return violation satisfies never;
  }
};

const main = async (): Promise<void> => {
  const root = path.resolve(import.meta.dirname, "..");
  const packages = await loadWorkspacePackages(root);
  const violations = findViolations(packages);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`license check: ${describeViolation(violation)}`);
    }
    console.error(
      `license check: ${String(violations.length)} problem(s), see the license section of README.md`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`license check: ${String(packages.length)} packages, the license line holds`);
};

if (import.meta.main) {
  await main();
}
