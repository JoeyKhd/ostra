import runnerManifest from "../package.json" with { type: "json" };
import releaseManifest from "../../../package.json" with { type: "json" };

/**
 * The `ostra` CLI's version: its package.json's, which the release sets (`node scripts/version.ts`,
 * ADR 0045's one version line). Read from it, so `ostra --version` can't drift from the release:
 * the runner image runs this source beside its package.json, and the npm pack's bundle inlines it.
 */
export const RUNNER_VERSION: string = runnerManifest.version;

/**
 * Where the CLI's release is published, as the same stamp writes it on the root package.json
 * (ADR 0064): the namespace its images are pushed under (`ostra` in a clone, which
 * `pnpm images:build` tags local builds with) and the CLI's npm name (the placeholder `ostra` in a
 * clone). Read the same way as the version: the runner image runs this source beside the root
 * package.json, which `turbo prune` keeps as it is, and the npm pack's bundle inlines these
 * fields of it (`pack-cli.ts`).
 */
export const IMAGE_NAMESPACE: string = releaseManifest.imageNamespace;
export const CLI_PACKAGE: string = releaseManifest.cliPackage;

/** One of the images of this CLI's own release, `<namespace>/<name>:<version>`: what the release pushed. */
export const releaseImage = (name: "base" | "runner"): string => `${IMAGE_NAMESPACE}/${name}:${RUNNER_VERSION}`;

/** Sent on every request the CLI makes, so the server and GitHub can tell it from a browser. */
export const userAgent = (): string => `ostra-runner/${RUNNER_VERSION} (${process.platform}; node ${process.versions.node})`;
