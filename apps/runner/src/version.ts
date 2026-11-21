import runnerManifest from "../package.json" with { type: "json" };

/**
 * The `ostra` CLI's version: its package.json's, which the release sets (`node scripts/version.ts`,
 * ADR 0045's one version line). Read from it, so `ostra --version` can't drift from the release:
 * the runner image runs this source beside its package.json, and the npm pack's bundle inlines it.
 */
export const RUNNER_VERSION: string = runnerManifest.version;

/** Sent on every request the CLI makes, so the server and GitHub can tell it from a browser. */
export const userAgent = (): string => `ostra-runner/${RUNNER_VERSION} (${process.platform}; node ${process.versions.node})`;
