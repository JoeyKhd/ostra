// The licenses the license check knows (`scripts/check-licenses.ts`), in one module with no
// dependency, so the images' notices generator (`packages/deploy-checks/src/notices.ts`) can import
// it inside an image's build, where only Node is there (F-039, milestone 7's ticket 29).
//
// - ostra's own packages are under a permissive license or a restricted one (the license check).
// - A third-party package an image bundles may also be under one of `bundledLicenses`: licenses
//   that allow redistributing the package unmodified with its license text and notices, which the
//   image's THIRD_PARTY_NOTICES carries. Strong copyleft (GPL, AGPL), SSPL, a missing license and
//   any id not listed here are unknown, and the notices generator fails on them.

/** The SPDX id of the Sustainable Use License, version 1.0. It has no SPDX entry, so it is a custom reference. */
export const sustainableUseLicense = "LicenseRef-Sustainable-Use-1.0";

/** Licenses that put no limit on who may run, change or share the code. */
export const permissiveLicenses = ["Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"] as const;
export type PermissiveLicense = (typeof permissiveLicenses)[number];

/** Licenses that limit who may run or share the code. Today that is only the Sustainable Use License. */
export const restrictedLicenses = [sustainableUseLicense] as const;

/**
 * The further licenses a bundled third-party package may carry. The permissive ones, then the weak
 * copyleft ones (MPL-2.0, EPL-2.0, LGPL-3.0-or-later), whose files the images carry unmodified with
 * their license text, and the data licenses (CC-BY-4.0, CC0-1.0) of packages that are data.
 */
export const bundledLicenses = [
  "MIT-0",
  "BlueOak-1.0.0",
  "Unlicense",
  "PSF-2.0",
  "Python-2.0",
  "AFL-2.1",
  "Zlib",
  "CC0-1.0",
  "CC-BY-4.0",
  "MPL-2.0",
  "EPL-2.0",
  "LGPL-3.0-or-later",
] as const;

/** Every license id the license check knows, for ostra's packages and the packages its images bundle. */
export const knownLicenseIds: readonly string[] = [...permissiveLicenses, ...restrictedLicenses, ...bundledLicenses];

/**
 * The ids an SPDX expression names: `(MIT OR CC0-1.0)` names MIT and CC0-1.0, `MIT and ISC` names
 * MIT and ISC. Parentheses and the operators AND, OR and WITH (in any case) are dropped.
 */
export const licenseIds = (expression: string): readonly string[] =>
  expression
    .replaceAll(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+/i)
    .map((id) => id.trim())
    .filter((id) => id !== "");

/** Whether every id of a bundled package's license expression is known. A missing license isn't. */
export const isKnownBundledLicense = (expression: string | null): boolean => {
  if (expression === null) {
    return false;
  }
  const ids = licenseIds(expression);
  return ids.length > 0 && ids.every((id) => knownLicenseIds.some((known) => known.toLowerCase() === id.toLowerCase()));
};
