// Writes an image's THIRD_PARTY_NOTICES, in its Docker build (F-039, milestone 7's ticket 29), and
// fails the build when a bundled package's license isn't one the license check knows, when the
// notices miss a package the install put on disk, or (`--without-agent`) when OpenCode is in its
// pnpm install: the runner's removes it, since in a box the agent runs in the base image.
//
//   node notices-main.ts --image runner --pnpm-licenses /tmp/licenses.json \
//     --pnpm-store /app/node_modules/.pnpm --without-agent --out /opt/notices/out/THIRD_PARTY_NOTICES
//
// `--pnpm-licenses` is `pnpm licenses list --json --recursive`'s output for the image's install,
// `--pnpm-store` that install's `node_modules/.pnpm`, `--npm-modules` an npm install's
// `node_modules` (the base image's OpenCode) and `--extra` an extra notice's JSON (the catalog).
// Only Node and this folder's notices.ts are needed (`scripts/known-licenses.ts` beside it).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  installedInPnpmStore,
  isAgentPackage,
  missingFromNotices,
  packagesFromNodeModules,
  packagesFromPnpmLicenses,
  readExtraNotice,
  refOf,
  renderNotices,
  unknownLicenses,
} from "./notices.ts";
import type { BundledPackage, PackageRef } from "./notices.ts";

/** pnpm prints this line instead of JSON when an install has no third-party package. */
const NONE = "No licenses in packages found";

const readPnpmLicenses = async (file: string): Promise<unknown> => {
  const body = (await readFile(file, "utf8")).trim();
  return body === NONE ? {} : JSON.parse(body);
};

export const runNotices = async (argv: readonly string[]): Promise<{ readonly code: number; readonly lines: readonly string[] }> => {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      image: { type: "string" },
      "pnpm-licenses": { type: "string", multiple: true, default: [] },
      "pnpm-store": { type: "string", multiple: true, default: [] },
      "npm-modules": { type: "string", multiple: true, default: [] },
      extra: { type: "string", multiple: true, default: [] },
      "without-agent": { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const { image, out } = values;
  if (image === undefined || out === undefined) {
    return { code: 2, lines: ["notices: --image and --out are required"] };
  }
  const packages: BundledPackage[] = [];
  for (const file of values["pnpm-licenses"]) {
    packages.push(...(await packagesFromPnpmLicenses(await readPnpmLicenses(file))));
  }
  const npm: BundledPackage[] = [];
  for (const dir of values["npm-modules"]) {
    npm.push(...(await packagesFromNodeModules(dir)));
  }
  packages.push(...npm);
  for (const file of values.extra) {
    packages.push(await readExtraNotice(file));
  }

  const lines: string[] = [];
  for (const item of unknownLicenses(packages)) {
    lines.push(`notices: ${refOf(item)} is under ${item.license ?? "no declared license"}, which the license check doesn't know (scripts/known-licenses.ts)`);
  }
  const notices = renderNotices(image, packages);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, notices, "utf8");

  const installed: PackageRef[] = [];
  for (const store of values["pnpm-store"]) {
    installed.push(...(await installedInPnpmStore(store)));
  }
  const bundled: readonly PackageRef[] = [...npm, ...installed];
  for (const item of missingFromNotices(await readFile(out, "utf8"), bundled)) {
    lines.push(`notices: ${refOf(item)} is bundled but missing from the notices`);
  }
  if (values["without-agent"]) {
    for (const item of installed.filter(isAgentPackage)) {
      lines.push(`notices: ${refOf(item)} is in the pnpm install, but the ${image} image carries no agent`);
    }
  }
  if (lines.length > 0) {
    return { code: 1, lines };
  }
  return { code: 0, lines: [`notices: the ${image} image's ${String(new Set(packages.map(refOf)).size)} third-party packages, each with its license, in ${out}`] };
};

if (import.meta.main) {
  const result = await runNotices(process.argv.slice(2));
  for (const line of result.lines) {
    (result.code === 0 ? process.stdout : process.stderr).write(`${line}\n`);
  }
  process.exitCode = result.code;
}
