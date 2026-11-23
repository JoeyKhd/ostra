// The runner's native downloads (F-085, ticket 01; ADR 0075): the pinned Bun the job downloads and
// verifies, the three platforms it cross-compiles for, and the rules `pnpm check:binaries` holds the
// release's names and `release.yml` to. One source, so the compiler the build runs is the release
// archive the check pins and the installer downloads; nothing here names Bun as a package.
import { z } from "zod";

/** A Bun version, as `bun --version` prints it: the release a build is made with. */
export const BUN_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** A SHA-256, lowercase hex: Bun's own SHASUMS256.txt line for the archive. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The Bun release the binaries are built with. */
export const BUN_VERSION = "1.4.3";

/**
 * The archive the job downloads: Bun's Linux x64 build, which cross-compiles every target (Bun's
 * `--target`), so one cheap Linux job builds what two expensive signing jobs sign.
 */
export const BUN_LINUX_X64_URL = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`;

/** That archive's SHA-256, from `bun-v1.4.3`'s own SHASUMS256.txt: the installer checks the bytes against this, never against the download. */
export const BUN_LINUX_X64_SHA256 = "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18";

/** A pin: the Bun version, the URL its Linux x64 archive downloads from, and the hash those bytes must have. */
export const bunPinSchema = z.object({
  version: z.string().regex(BUN_VERSION_PATTERN, "a Bun version, as bun --version prints it"),
  url: z.url(),
  sha256: z.string().regex(SHA256_PATTERN, "a SHA-256, 64 lowercase hex characters"),
});
export type BunPin = z.infer<typeof bunPinSchema>;

/** The pin, validated: a malformed one fails here rather than in a release. */
export const bunPin: BunPin = bunPinSchema.parse({ version: BUN_VERSION, url: BUN_LINUX_X64_URL, sha256: BUN_LINUX_X64_SHA256 });

/** The archive a pin names: Bun's Linux x64 zip of the pin's own version. */
export const bunArchiveUrl = (version: string): string => `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-x64.zip`;

/**
 * One platform the release ships (ADR 0075): the Bun target that compiles it, the folder in the
 * build's output, the executable's name, and the `releaseFiles` key its zip downloads as. Windows
 * arm64 and Linux stay out until a machine in the matrix runs them.
 */
const targetSchema = z.object({
  name: z.enum(["darwin-arm64", "darwin-x64", "windows-x64"]),
  bunTarget: z.enum(["bun-darwin-arm64", "bun-darwin-x64", "bun-windows-x64"]),
  folder: z.enum(["darwin-arm64", "darwin-x64", "windows-x64"]),
  executable: z.enum(["ostra", "ostra.exe"]),
  asset: z.enum(["darwinArm64", "darwinX64", "windowsX64"]),
});
export type BinaryTarget = z.infer<typeof targetSchema>;

/** The three platforms, in the order the build makes them, validated. */
export const binaryTargets: readonly BinaryTarget[] = z.array(targetSchema).length(3).parse([
  { name: "darwin-arm64", bunTarget: "bun-darwin-arm64", folder: "darwin-arm64", executable: "ostra", asset: "darwinArm64" },
  { name: "darwin-x64", bunTarget: "bun-darwin-x64", folder: "darwin-x64", executable: "ostra", asset: "darwinX64" },
  { name: "windows-x64", bunTarget: "bun-windows-x64", folder: "windows-x64", executable: "ostra.exe", asset: "windowsX64" },
]);

/** A zip's name: versionless, so `releases/latest/download/<name>` is the newest (ADR 0075). */
export const binaryZipName = (target: BinaryTarget): string => `ostra-${target.folder}.zip`;

/** The names the runner's downloads add to `releaseFiles`: one zip per target and `SHA256SUMS`. */
export const binaryFileNames = (targets: readonly BinaryTarget[] = binaryTargets): readonly string[] => [...targets.map(binaryZipName), "SHA256SUMS"];

/** A name another platform would add, so a fourth zip fails the check instead of being attached unbuilt. */
const FOREIGN_BINARY_NAME = /^ostra-(?:linux|freebsd|openbsd|android|windows-arm|darwin-universal)[^/]*\.zip$|^SHA256SUMS\.txt$/i;

/** The files the check reads: the release's names, as `protocol` has them. */
export type BinaryFiles = { readonly releaseFiles: Readonly<Record<string, string>> };

/** One problem, named as `check:images`' are: the file, the rule and what is wrong. */
export type BinaryProblem = { readonly file: string; readonly rule: string; readonly message: string };

const PIN_FILE = "packages/deploy-checks/src/binaries.ts";
const WORKFLOW = ".github/workflows/release.yml";

/** The text of a job of a workflow: its `  <name>:` line and the lines indented under it. */
export const jobBlock = (workflow: string, job: string): string | null => {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) {
    return null;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return [lines[start] ?? "", ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
};

/** The `needs:` line of a job block, if it has one. */
const needsLine = (job: string): string => /^ {4}needs:\s*(.+)$/m.exec(job)?.[1] ?? "";

/** The pin's problems: a Bun version, a 64-character hash, and the archive of that same version. */
const pinProblems = (pin: BunPin): readonly BinaryProblem[] => {
  const parsed = bunPinSchema.safeParse(pin);
  if (!parsed.success) {
    return [{ file: PIN_FILE, rule: "pin", message: `the Bun pin is ${JSON.stringify(pin)}, not a version, the archive's URL and a 64-character SHA-256 (${parsed.error.issues.map((issue) => issue.message).join("; ")})` }];
  }
  if (parsed.data.url !== bunArchiveUrl(parsed.data.version)) {
    return [{ file: PIN_FILE, rule: "pin", message: `the pin's URL is ${parsed.data.url}, not the bun-linux-x64 archive of its own version, ${parsed.data.version}` }];
  }
  return [];
};

/** The names' problems: each target's zip and the checksums, and no name another platform would take. */
const nameProblems = (files: BinaryFiles, targets: readonly BinaryTarget[]): readonly BinaryProblem[] => {
  const problems: BinaryProblem[] = [];
  const values = Object.values(files.releaseFiles);
  for (const target of targets) {
    const expected = binaryZipName(target);
    const named = files.releaseFiles[target.asset];
    if (named !== expected) {
      problems.push({ file: "packages/protocol/src/release.ts", rule: "names", message: named === undefined ? `releaseFiles names no ${target.name} zip: it is ${expected}` : `releaseFiles.${target.asset} is ${named}, not ${expected}` });
    }
  }
  const checksums = files.releaseFiles["checksums"];
  if (checksums !== "SHA256SUMS") {
    problems.push({ file: "packages/protocol/src/release.ts", rule: "names", message: checksums === undefined ? "releaseFiles names no checksums file: it is SHA256SUMS" : `releaseFiles.checksums is ${checksums}, not SHA256SUMS` });
  }
  const expectedNames = binaryFileNames(targets);
  for (const name of values) {
    if (FOREIGN_BINARY_NAME.test(name) && !expectedNames.includes(name)) {
      problems.push({ file: "packages/protocol/src/release.ts", rule: "names", message: `releaseFiles names ${name}, which no target builds: the release's downloads are exactly ${expectedNames.join(", ")}` });
    }
  }
  return problems;
};

/** The workflow's problems: the build job's commands, that it reads no secret, and that nothing unsigned is attached. */
const workflowProblems = (workflow: string): readonly BinaryProblem[] => {
  const problems: BinaryProblem[] = [];
  const build = jobBlock(workflow, "runner-binaries");
  if (build === null) {
    return [{ file: WORKFLOW, rule: "build-job", message: "has no runner-binaries job: the three binaries are built, zipped and hashed there (ADR 0075)" }];
  }
  const problem = (message: string, rule = "build-job"): BinaryProblem => ({ file: WORKFLOW, rule, message });
  if (!/node packages\/deploy-checks\/src\/install-bun\.ts --out \S+/.test(build)) {
    problems.push(problem("its runner-binaries job downloads the pinned Bun: node packages/deploy-checks/src/install-bun.ts --out <dir>"));
  }
  if (!build.includes('node scripts/build-runner-binaries.ts "$OUT/binaries"')) {
    problems.push(problem('its runner-binaries job builds the three binaries: node scripts/build-runner-binaries.ts "$OUT/binaries"'));
  }
  if (!/uses: actions\/upload-artifact@[0-9a-f]{40}\b/.test(build) || !/^\s+name: runner-binaries$/m.test(build) || !/^\s+path: .*binaries$/m.test(build)) {
    problems.push(problem("its runner-binaries job uploads its folder as the runner-binaries artifact, for the signing jobs (tickets 02 and 03)"));
  }
  if (/\bsecrets\./.test(build)) {
    problems.push(problem("its runner-binaries job reads no secret: it only compiles and hashes what the checkout holds", "build-secrets"));
  }
  const release = jobBlock(workflow, "release");
  const create = /^\s+gh release create .*$/m.exec(release ?? "")?.[0] ?? "";
  if (create.includes("binaries")) {
    const needs = needsLine(release ?? "");
    const missing = ["sign-macos", "sign-windows"].filter((job) => !needs.includes(job));
    if (missing.length > 0) {
      problems.push(problem(`attaches the binaries without ${missing.join(" and ")}: the release carries no binary until both signatures exist (ADR 0075)`, "attach-before-signing"));
    }
  }
  return problems;
};

/**
 * The runner's downloads, checked on a checkout: the pin, the release's names and `release.yml`'s
 * build job and attach step. Empty when a release can build them and publish nothing unsigned.
 */
export const binaryProblems = (files: BinaryFiles, workflow: string, pin: BunPin = bunPin, targets: readonly BinaryTarget[] = binaryTargets): readonly BinaryProblem[] => [
  ...pinProblems(pin),
  ...nameProblems(files, targets),
  ...workflowProblems(workflow),
];
