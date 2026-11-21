// `node scripts/version.ts <version>`: sets one version everywhere a release carries it (milestone
// 7's ticket 30, ADR 0045): every package.json, the root's (which tags the three images) and every
// workspace package's, and the files Docker Compose and Helm read as they are, the compose file's
// image tags and each chart's version and appVersion (`versionStamps`). The release workflow runs
// it with its `version` input before it checks, builds and publishes.
// Changesets (ADR 0007's milestone 7 entry) waits for the maintainer's own yes (ticket 34, step
// 2); this script is its fallback, and the release's version is the workflow's input either way.

import path from "node:path";

import { setVersion, versionStamps } from "./release.ts";

const version = process.argv[2] ?? "";
const files = await setVersion(path.resolve(import.meta.dirname, ".."), version);
const deploy = versionStamps.map((stamp) => stamp.file);
process.stdout.write(`version: ${version} in ${String(files.length - deploy.length)} package.json files and ${deploy.join(", ")}\n`);
