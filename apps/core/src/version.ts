import coreManifest from "../package.json" with { type: "json" };
import releaseManifest from "../../../package.json" with { type: "json" };

/**
 * Core's version: the version `ostra runner` installs to match it (ADR 0046). Its package.json's,
 * which the release sets (`node scripts/version.ts`), so it can't drift from the images' tags.
 */
export const CORE_VERSION: string = coreManifest.version;

/**
 * The npm name the release published the CLI under, as the same stamp writes it on the root
 * package.json's `cliPackage` (ADR 0064): the placeholder `ostra` in a clone. Read the same way as
 * the version: the server image runs core's source beside the root package.json, which
 * `turbo prune` keeps as it is.
 */
export const CLI_PACKAGE: string = releaseManifest.cliPackage;
