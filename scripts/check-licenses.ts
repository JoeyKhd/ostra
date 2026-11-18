// The license line of ADR 0009 and ADR 0045, checked by a machine.
//
// - Every workspace package declares its license in the `license` field of its package.json.
// - An Apache-2.0 package never depends on an AGPL-3.0 package, directly or through another one.
//
// Run with `pnpm check:licenses`.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const knownLicenses = ["AGPL-3.0-only", "Apache-2.0"] as const;
export type KnownLicense = (typeof knownLicenses)[number];

export type WorkspacePackage = {
  name: string;
  /** The package's folder, relative to the repo root, with forward slashes. */
  dir: string;
  /** The `license` field as written, or `undefined` when the package has none. */
  license: string | undefined;
  /** Every dependency name, of any kind: dependencies, dev, peer and optional. */
  dependencies: readonly string[];
};

export type Violation =
  | { kind: "missing-license"; name: string; dir: string }
  | { kind: "unknown-license"; name: string; dir: string; license: string }
  | {
      kind: "apache-depends-on-agpl";
      name: string;
      dir: string;
      /** From the Apache-2.0 package to the AGPL-3.0 one it reaches, both ends included. */
      path: readonly string[];
    };

const isKnownLicense = (license: string): license is KnownLicense =>
  knownLicenses.some((known) => known === license);

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
        // An AGPL package ends the chain: what it depends on is not ours to report.
        if (dependency.license !== "AGPL-3.0-only") {
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
    const { name, dir, license } = workspacePackage;
    if (license === undefined || license.trim() === "") {
      violations.push({ kind: "missing-license", name, dir });
      continue;
    }
    if (!isKnownLicense(license)) {
      violations.push({ kind: "unknown-license", name, dir, license });
      continue;
    }
    switch (license) {
      case "AGPL-3.0-only":
        break;
      case "Apache-2.0":
        for (const chain of shortestPathTo(
          workspacePackage,
          byName,
          (candidate) => candidate.license === "AGPL-3.0-only",
        )) {
          violations.push({ kind: "apache-depends-on-agpl", name, dir, path: chain });
        }
        break;
      default:
        license satisfies never;
    }
  }
  return violations;
};

export const describeViolation = (violation: Violation): string => {
  switch (violation.kind) {
    case "missing-license":
      return `${violation.name} (${violation.dir}) has no "license" field in its package.json`;
    case "unknown-license":
      return `${violation.name} (${violation.dir}) declares "${violation.license}", expected ${knownLicenses.join(" or ")}`;
    case "apache-depends-on-agpl":
      return `${violation.name} (${violation.dir}) is Apache-2.0 but reaches an AGPL-3.0 package: ${violation.path.join(" -> ")}`;
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
      `license check: ${String(violations.length)} problem(s), see ADR 0009 and ADR 0045`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`license check: ${String(packages.length)} packages, the license line holds`);
};

if (import.meta.main) {
  await main();
}
