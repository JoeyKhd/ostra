// The images' THIRD_PARTY_NOTICES (F-039, milestone 7's ticket 29, ADR 0045): every third-party
// package an image bundles, each with its license and the license and notice files it ships, read
// from `pnpm licenses list --json` (and, for the base image's OpenCode, from its npm install).
//
// This module runs inside each image's build (`notices-main.ts`), where only Node is there, so it
// imports nothing but Node and `scripts/known-licenses.ts`. That's why the vendor formats it reads
// (pnpm's JSON, a package.json) are narrowed by hand here rather than with a Zod schema; like any
// vendor format they tolerate unknown fields. The one format ostra owns, an extra notice, rejects them.

import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { isKnownBundledLicense } from "../../../scripts/known-licenses.ts";

/** Where each image carries its notices. */
export const NOTICES_PATH = "/usr/share/doc/ostra/THIRD_PARTY_NOTICES";

export type PackageRef = { readonly name: string; readonly version: string };
export type LicenseText = { readonly file: string; readonly text: string };
export type BundledPackage = PackageRef & {
  /** The license expression as the package declares it; `null` when it declares none. */
  readonly license: string | null;
  readonly homepage: string | null;
  readonly texts: readonly LicenseText[];
};

const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const strings = (value: unknown): readonly string[] | null => (Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map(String) : null);

export const refOf = (item: PackageRef): string => `${item.name}@${item.version}`;

const exists = (target: string): Promise<boolean> => lstat(target).then(
  () => true,
  () => false,
);

/** A license and notice file a package ships: LICENSE, LICENCE, COPYING or NOTICE, with any suffix. */
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.\-_].*)?$/i;

/** The license and notice files in a package's folder, in name order. */
export const readLicenseTexts = async (dir: string): Promise<readonly LicenseText[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name)).map((entry) => entry.name).sort();
  const texts: LicenseText[] = [];
  for (const file of files) {
    const body = (await readFile(path.join(dir, file), "utf8")).trim();
    if (body !== "") {
      texts.push({ file, text: body });
    }
  }
  return texts;
};

/** A package.json's license: the SPDX string, or npm's old `{ type }` form. pnpm writes "Unknown" for none. */
const licenseOf = (value: unknown): string | null => {
  const license = text(value) ?? text(field(value, "type"));
  return license === null || license.toLowerCase() === "unknown" ? null : license;
};

type PnpmLicenseEntry = PackageRef & { readonly path: string; readonly license: string | null; readonly homepage: string | null };

/**
 * `pnpm licenses list --json`: an object from each license to its packages, each with parallel
 * `versions` and `paths`. One entry per installed version.
 */
export const parsePnpmLicenses = (raw: unknown): readonly PnpmLicenseEntry[] => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("pnpm licenses list --json didn't give an object");
  }
  const entries: PnpmLicenseEntry[] = [];
  for (const [group, items] of Object.entries(raw)) {
    if (!Array.isArray(items)) {
      throw new Error(`pnpm licenses list --json: "${group}" isn't a list`);
    }
    for (const item of items) {
      const name = text(field(item, "name"));
      const versions = strings(field(item, "versions"));
      const paths = strings(field(item, "paths"));
      if (name === null || versions === null || versions.length !== paths?.length) {
        throw new Error(`pnpm licenses list --json: an entry under "${group}" has no name, versions and paths`);
      }
      for (const [index, version] of versions.entries()) {
        entries.push({
          name,
          version,
          path: paths[index] ?? "",
          license: licenseOf(field(item, "license")) ?? licenseOf(group),
          homepage: text(field(item, "homepage")),
        });
      }
    }
  }
  return entries;
};

/**
 * The packages `pnpm licenses list --json` names, with their license files. One whose folder isn't
 * there isn't bundled (the runner image removes the agent after its install), and `exclude` drops
 * any other the caller names.
 */
export const packagesFromPnpmLicenses = async (raw: unknown, exclude: (item: PackageRef) => boolean = () => false): Promise<readonly BundledPackage[]> => {
  const found: BundledPackage[] = [];
  for (const entry of parsePnpmLicenses(raw)) {
    if (exclude(entry) || !(await exists(entry.path))) {
      continue;
    }
    found.push({ name: entry.name, version: entry.version, license: entry.license, homepage: entry.homepage, texts: await readLicenseTexts(entry.path) });
  }
  return found;
};

const readManifest = async (dir: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
};

/** The real package folders directly in a `node_modules` folder, scoped ones included; links skipped. */
const packageDirs = async (modules: string): Promise<readonly string[]> => {
  const dirs: string[] = [];
  for (const entry of await readdir(modules, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) {
      continue;
    }
    const full = path.join(modules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of await readdir(full, { withFileTypes: true }).catch(() => [])) {
        if (scoped.isDirectory()) {
          dirs.push(path.join(full, scoped.name));
        }
      }
    } else {
      dirs.push(full);
    }
  }
  return dirs.sort();
};

/** Every package of an npm install's `node_modules` (the base image's OpenCode), nested ones included. */
export const packagesFromNodeModules = async (modules: string): Promise<readonly BundledPackage[]> => {
  const found: BundledPackage[] = [];
  for (const dir of await packageDirs(modules)) {
    const manifest = await readManifest(dir);
    const name = text(field(manifest, "name"));
    const version = text(field(manifest, "version"));
    if (name !== null && version !== null) {
      found.push({ name, version, license: licenseOf(field(manifest, "license")), homepage: text(field(manifest, "homepage")), texts: await readLicenseTexts(dir) });
    }
    found.push(...(await packagesFromNodeModules(path.join(dir, "node_modules"))));
  }
  return found;
};

/**
 * What a pnpm install put on disk, read from its store folder (`node_modules/.pnpm`) and not from
 * pnpm's report: in each `<package>@<version>` folder, the one real package folder (the rest are
 * links to its dependencies). The check that the notices miss nothing compares against this.
 */
export const installedInPnpmStore = async (store: string): Promise<readonly PackageRef[]> => {
  const found = new Map<string, PackageRef>();
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") {
      continue;
    }
    for (const dir of await packageDirs(path.join(store, entry.name, "node_modules"))) {
      if ((await lstat(dir)).isSymbolicLink()) {
        continue;
      }
      const manifest = await readManifest(dir);
      const name = text(field(manifest, "name"));
      const version = text(field(manifest, "version"));
      if (name !== null && version !== null) {
        found.set(`${name}@${version}`, { name, version });
      }
    }
  }
  return [...found.values()];
};

/**
 * What a checkout's install holds for some workspace packages, read from `pnpm list --json --depth
 * Infinity`: every non-workspace package of the tree whose folder is there (an optional package for
 * another platform is in the tree but not installed).
 */
export const installedInPnpmList = async (raw: unknown, exclude: (item: PackageRef) => boolean = () => false): Promise<readonly PackageRef[]> => {
  if (!Array.isArray(raw)) {
    throw new Error("pnpm list --json didn't give a list");
  }
  const candidates = new Map<string, PackageRef & { readonly path: string }>();
  const walk = (dependencies: unknown): void => {
    if (typeof dependencies !== "object" || dependencies === null) {
      return;
    }
    for (const [name, node] of Object.entries(dependencies)) {
      const version = text(field(node, "version"));
      const where = text(field(node, "path"));
      if (version !== null && where !== null && !version.startsWith("link:") && !version.startsWith("file:")) {
        candidates.set(`${name}@${version}`, { name, version, path: where });
      }
      walk(field(node, "dependencies"));
      walk(field(node, "optionalDependencies"));
    }
  };
  for (const project of raw) {
    walk(field(project, "dependencies"));
    walk(field(project, "optionalDependencies"));
    walk(field(project, "devDependencies"));
  }
  const found: PackageRef[] = [];
  for (const candidate of candidates.values()) {
    if (!exclude(candidate) && (await exists(candidate.path))) {
      found.push({ name: candidate.name, version: candidate.version });
    }
  }
  return found;
};

/**
 * An extra notice, for a file the build adds that isn't a package (the base image's models.dev
 * catalog): a JSON file with these keys, `licenseFile` relative to it.
 */
const EXTRA_KEYS = ["name", "version", "license", "homepage", "licenseFile"] as const;

/** Reads an extra notice: a JSON file of ostra's own, so an unknown or missing field fails. */
export const readExtraNotice = async (file: string): Promise<BundledPackage> => {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} isn't an object`);
  }
  const unknown = Object.keys(raw).filter((key) => !EXTRA_KEYS.some((known) => known === key));
  const name = text(field(raw, "name"));
  const version = text(field(raw, "version"));
  const license = text(field(raw, "license"));
  const homepage = text(field(raw, "homepage"));
  const licenseFile = text(field(raw, "licenseFile"));
  if (unknown.length > 0 || name === null || version === null || license === null || homepage === null || licenseFile === null) {
    throw new Error(`${file} must have exactly ${EXTRA_KEYS.join(", ")}, each a string`);
  }
  const body = (await readFile(path.resolve(path.dirname(file), licenseFile), "utf8")).trim();
  return { name, version, license, homepage, texts: [{ file: path.basename(licenseFile), text: body }] };
};

/** The bundled packages whose license the license check doesn't know (`scripts/known-licenses.ts`). */
export const unknownLicenses = (packages: readonly BundledPackage[]): readonly BundledPackage[] => packages.filter((item) => !isKnownBundledLicense(item.license));

/** One entry per name and version, in name order. */
const unique = (packages: readonly BundledPackage[]): readonly BundledPackage[] => {
  const byRef = new Map<string, BundledPackage>();
  for (const item of packages) {
    if (!byRef.has(refOf(item))) {
      byRef.set(refOf(item), item);
    }
  }
  return [...byRef.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1));
};

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

/** The notices file's text: a header, then each package with its license and its files' text. */
export const renderNotices = (image: string, packages: readonly BundledPackage[]): string => {
  const listed = unique(packages);
  const lines = [
    `THIRD_PARTY_NOTICES: the ostra ${image} image`,
    "",
    "ostra's own code in this image is under the licenses its packages' LICENSE files name (the",
    "repository's README.md, \"License\"). The image also carries the third-party packages below, each",
    "under its own license, with the license and notice files the package ships. The operating",
    "system's packages, from the Debian base image, carry their copyright files in /usr/share/doc.",
    "",
    `${String(listed.length)} packages.`,
  ];
  for (const item of listed) {
    lines.push("", RULE, `Package: ${refOf(item)}`, `License: ${item.license ?? "(none declared)"}`);
    if (item.homepage !== null) {
      lines.push(`Homepage: ${item.homepage}`);
    }
    lines.push(THIN);
    if (item.texts.length === 0) {
      lines.push(`The package ships no license file; its package.json names ${item.license ?? "no license"}.`);
    }
    for (const licenseText of item.texts) {
      lines.push(`--- ${licenseText.file} ---`, licenseText.text);
    }
  }
  return `${lines.join("\n")}\n`;
};

/** The packages a notices file lists, from its `Package:` lines. */
export const listedInNotices = (notices: string): readonly PackageRef[] =>
  [...notices.matchAll(/^Package: (\S+)$/gm)].flatMap((match) => {
    const ref = match[1] ?? "";
    const at = ref.lastIndexOf("@");
    return at > 0 ? [{ name: ref.slice(0, at), version: ref.slice(at + 1) }] : [];
  });

/** The bundled packages a notices file doesn't list. Empty when it lists them all. */
export const missingFromNotices = (notices: string, bundled: readonly PackageRef[]): readonly PackageRef[] => {
  const listed = new Set(listedInNotices(notices).map(refOf));
  return bundled.filter((item) => !listed.has(refOf(item)));
};

/** OpenCode's packages: the wrapper and its platform binaries. The runner image carries none. */
export const isAgentPackage = (item: PackageRef): boolean => item.name === "@opencode/cli" || item.name.startsWith("@opencode/cli-");
