// The files a release's GitHub release carries beside its packages and images (ADR 0064, amended
// 2026-11-21), by the name each downloads as, and where one release's are downloaded from. Written
// once, here, since every side imports `protocol`: `scripts/release.ts` makes and attaches them
// (`releaseAssets`), the docs link them, and the panel's Helm join command installs the runner's
// chart from its server's own release.

/** The repository's releases on GitHub: the repository's pages (`REPOSITORY_URL`) and `/releases`. */
export const RELEASES_URL = "https://github.com/JoeyKhd/ostra/releases";

/** The files every release attaches, by the name each downloads as. */
export const releaseFiles = {
  /** The compose file, stamped with the release's images. */
  compose: "compose.yaml",
  /** The server's chart, packaged by Helm. */
  serverChart: "ostra-server.tgz",
  /** The pool runner's chart, packaged by Helm. */
  runnerChart: "ostra-runner.tgz",
} as const;

export type ReleaseFile = (typeof releaseFiles)[keyof typeof releaseFiles];

/** One release's download of one of its files: `releases/download/v<version>/<name>`. */
export const releaseDownload = (version: string, file: ReleaseFile): string => `${RELEASES_URL}/download/v${version}/${file}`;
