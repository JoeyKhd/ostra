// Each image's notices from this checkout's install (F-039, milestone 7's ticket 29): what `pnpm
// check:images` runs anywhere, with no Docker, so an unknown license or a package the notices miss
// fails before an image is built. It reads the same `pnpm licenses list --json` the image's build
// reads, for the workspace packages the image prunes to, and checks it against `pnpm list`, a
// second account of the same install. The image's build checks its own install again
// (`notices-main.ts`), since another platform's install differs in its platform packages.

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Problem } from "./image-checks.ts";
import { imageBundles } from "./images.ts";
import type { ImageName } from "./images.ts";
import { installedInPnpmList, isAgentPackage, missingFromNotices, packagesFromPnpmLicenses, refOf, renderNotices, unknownLicenses } from "./notices.ts";
import type { BundledPackage, PackageRef } from "./notices.ts";
import { repoRoot } from "./repo.ts";

const run = promisify(execFile);
const runInShell = promisify(exec);

/** pnpm, run from a script pnpm started through Node and pnpm's own entry (no shell on Windows), else from PATH. */
const pnpm = async (args: readonly string[]): Promise<string> => {
  const entry = process.env["npm_execpath"];
  const options = { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" } as const;
  const { stdout } =
    entry !== undefined && /pnpm[^/\\]*\.(?:c?js|mjs)$/i.test(entry)
      ? await run(process.execPath, [entry, ...args], options)
      : process.platform === "win32"
        ? // pnpm.cmd needs a shell on Windows; the arguments are this module's own constants.
          await runInShell(`pnpm ${args.join(" ")}`, options)
        : await run("pnpm", [...args], options);
  return stdout;
};

const json = (stdout: string): unknown => (stdout.trim() === "No licenses in packages found" ? {} : JSON.parse(stdout));

export type CheckoutNotices = {
  readonly image: ImageName;
  readonly packages: readonly BundledPackage[];
  readonly notices: string;
  /** What the install holds for the image, by `pnpm list`. */
  readonly bundled: readonly PackageRef[];
  readonly problems: readonly Problem[];
};

/**
 * One image's notices from this checkout. `generate` is how the notices are made from pnpm's
 * report; a test passes a broken one to see the check fail.
 */
export const checkoutNotices = async (
  image: ImageName,
  generate: (packages: readonly BundledPackage[]) => string = (packages) => renderNotices(image, packages),
): Promise<CheckoutNotices> => {
  const bundle = imageBundles[image];
  const scope = [...(bundle.prod ? ["--prod"] : []), ...bundle.workspaces.flatMap((workspace) => ["--filter", `${workspace}...`])];
  const exclude = bundle.agent ? () => false : isAgentPackage;
  const packages = await packagesFromPnpmLicenses(json(await pnpm(["licenses", "list", "--json", ...scope])), exclude);
  const bundled = await installedInPnpmList(json(await pnpm(["list", "--json", "--depth", "Infinity", ...scope])), exclude);
  const notices = generate(packages);
  const file = `THIRD_PARTY_NOTICES (${image})`;
  const problems: Problem[] = [
    ...unknownLicenses(packages).map((item): Problem => ({
      file,
      line: null,
      rule: "notices",
      message: `${refOf(item)} is under ${item.license ?? "no declared license"}, which the license check doesn't know (scripts/known-licenses.ts)`,
    })),
    ...missingFromNotices(notices, bundled).map((item): Problem => ({ file, line: null, rule: "notices", message: `${refOf(item)} is bundled but missing from the notices` })),
  ];
  return { image, packages, notices, bundled, problems };
};
