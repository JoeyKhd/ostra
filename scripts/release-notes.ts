// The GitHub release's text (milestone 7's ticket 30, ADR 0064): the changelog, the images'
// digests and the packages' versions. `release.yml` runs it after the images are pushed and the
// packages published (or, in its dry run, pushed to the job's own registry and packed):
//
//   node scripts/release-notes.ts --version 1.0.0 --digests digests.txt --packages packages.txt [--since v0.9.0]
//
// `--digests` holds one `<image>@sha256:<digest>` per line, `--packages` one `<name>@<version>` per
// line. The changelog is the commits since `--since` (the previous tag; every commit when there's
// none), each commit's subject as written, its gitmoji included.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);

export type ReleaseNotesInput = {
  readonly version: string;
  /** Commit subjects, newest first. */
  readonly commits: readonly string[];
  /** `<image>@sha256:<64 hex>` each. */
  readonly digests: readonly string[];
  /** `<name>@<version>` each. */
  readonly packages: readonly string[];
};

const DIGEST = /^\S+@sha256:[0-9a-f]{64}$/;

const lines = (text: string): readonly string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The release's Markdown. Fails when an image has no digest or a package isn't at the release's version. */
export const releaseNotes = (input: ReleaseNotesInput): string => {
  const badDigest = input.digests.find((digest) => !DIGEST.test(digest));
  if (badDigest !== undefined || input.digests.length === 0) {
    throw new Error(`every image is named by its digest (<image>@sha256:<digest>): ${badDigest ?? "none given"}`);
  }
  const offVersion = input.packages.find((item) => !item.endsWith(`@${input.version}`));
  if (offVersion !== undefined || input.packages.length === 0) {
    throw new Error(`every package is at ${input.version}: ${offVersion ?? "none given"}`);
  }
  return [
    `# ostra ${input.version}`,
    "",
    "## Images",
    "",
    "Pull each by its digest:",
    "",
    ...input.digests.map((digest) => `- \`${digest}\``),
    "",
    "## Packages",
    "",
    ...input.packages.map((item) => `- \`${item}\``),
    "",
    "## Changes",
    "",
    ...(input.commits.length === 0 ? ["- No commits since the previous release."] : input.commits.map((subject) => `- ${subject}`)),
    "",
  ].join("\n");
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    strict: true,
    options: { version: { type: "string" }, digests: { type: "string" }, packages: { type: "string" }, since: { type: "string" } },
  });
  if (values.version === undefined || values.digests === undefined || values.packages === undefined) {
    throw new Error("--version, --digests and --packages are required");
  }
  const range = values.since === undefined || values.since === "" ? ["HEAD"] : [`${values.since}..HEAD`];
  const { stdout } = await run("git", ["log", "--format=%s", ...range], { maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(
    releaseNotes({
      version: values.version,
      commits: lines(stdout),
      digests: lines(await readFile(values.digests, "utf8")),
      packages: lines(await readFile(values.packages, "utf8")),
    }),
  );
};

if (import.meta.main) {
  await main();
}
