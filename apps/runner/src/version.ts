// The `ostra` CLI's version. A test keeps it equal to package.json's, which the release bumps.
export const RUNNER_VERSION = "0.0.0";

/** Sent on every request the CLI makes, so the server and GitHub can tell it from a browser. */
export const userAgent = (): string => `ostra-runner/${RUNNER_VERSION} (${process.platform}; node ${process.versions.node})`;
