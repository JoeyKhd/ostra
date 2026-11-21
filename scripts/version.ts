// `node scripts/version.ts <version> <image-namespace>`: stamps the release on its tree (milestone
// 7's ticket 30, ADR 0045, ADR 0064): the version on every package.json, the root's (which tags
// the three images) and every workspace package's, the namespace the images are published under on
// the root's `imageNamespace`, and both on the files Docker Compose and Helm read as they are: the
// compose file's images, and each chart's version, appVersion and image repositories
// (`releaseStamps`). The release workflow runs it with its `version` input and its image
// namespace before it checks, builds and publishes.
// Changesets (ADR 0007's milestone 7 entry) waits for the maintainer's own yes (ticket 34, step
// 2); this script is its fallback, and the release's version is the workflow's input either way.

import path from "node:path";

import { releaseStamps, stampRelease } from "./release.ts";

const [version = "", imageNamespace = ""] = process.argv.slice(2);
const files = await stampRelease(path.resolve(import.meta.dirname, ".."), { version, imageNamespace });
const deploy = releaseStamps.map((stamp) => stamp.file);
process.stdout.write(`release: ${version}, images under ${imageNamespace}, in ${String(files.length - deploy.length)} package.json files and ${deploy.join(", ")}\n`);
