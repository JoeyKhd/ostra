// The files a release's GitHub release carries beside its packages and images (ADR 0064, amended
// 2026-11-21), by the name each downloads as, and where one release's are downloaded from. Written
// once, here, since every side imports `protocol`: `scripts/release.ts` makes and attaches them
// (`releaseAssets`), the docs link them, and the panel's Helm join command installs the runner's
// chart from its server's own release. Beside them, where a release's CLI is installed from.

/** The version of a build from a clone, before a release's stamp writes one (ADR 0045's one version line): no release publishes it. */
export const DEVELOPMENT_VERSION = "0.0.0";

/**
 * npm's public registry, where a release publishes the CLI under the root package.json's
 * `cliPackage` (ADR 0045, ADR 0064): where a released server tells its runners to pin from, and
 * the default of the runner's `OSTRA_RUNNER_NPM_REGISTRY`, which names a mirror instead.
 */
export const NPM_REGISTRY = "https://registry.npmjs.org";

/** The repository's releases on GitHub: the repository's pages (`REPOSITORY_URL`) and `/releases`. */
export const RELEASES_URL = "https://github.com/JoeyKhd/ostra/releases";

/**
 * The files every release attaches, by the name each downloads as. The runner's downloads are
 * versionless, so `releases/latest/download/<name>` is always the newest release's; the version is
 * inside each one (`ostra --version`, and the zip's own bytes), as ADR 0075 has it.
 */
export const releaseFiles = {
  /** The compose file, stamped with the release's images. */
  compose: "compose.yaml",
  /** The server's chart, packaged by Helm. */
  serverChart: "ostra-server.tgz",
  /** The pool runner's chart, packaged by Helm. */
  runnerChart: "ostra-runner.tgz",
  /** The macOS arm64 runner: `ostra` and `LICENSE`, zipped; the version is inside, not in the name. */
  darwinArm64: "ostra-darwin-arm64.zip",
  /** The macOS x64 runner: the same, for Intel Macs. */
  darwinX64: "ostra-darwin-x64.zip",
  /** The Windows x64 runner: `ostra.exe` and `LICENSE`, zipped. */
  windowsX64: "ostra-windows-x64.zip",
  /** The runner zips' SHA-256 in `sha256sum` format, written from the files a release attaches. */
  checksums: "SHA256SUMS",
} as const;

export type ReleaseFile = (typeof releaseFiles)[keyof typeof releaseFiles];

/** One release's download of one of its files: `releases/download/v<version>/<name>`. */
export const releaseDownload = (version: string, file: ReleaseFile): string => `${RELEASES_URL}/download/v${version}/${file}`;
