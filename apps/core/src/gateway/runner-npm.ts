import type { ServerSettings } from "@ostra/domain";
import { DEVELOPMENT_VERSION, NPM_REGISTRY } from "@ostra/protocol";
import type { InfoNpm } from "@ostra/protocol";

import { CLI_PACKAGE, CORE_VERSION } from "../version.ts";

// Where a runner installed from npm pins from (F-061, ADR 0034's "How a runner is pinned"):
// `/runner/v1/info`'s `npm`, the CLI's package and registry. The version it installs is the
// server's own, `serverVersion`.

/** The fake npm registry `pnpm dev:npm-registry` serves the CLI from, for the pin in development (F-061). */
export const DEV_RUNNER_NPM = { package: "ostra", registry: "http://127.0.0.1:14873" } as const satisfies InfoNpm;

export type RunnerNpmBuild = {
  readonly mode: ServerSettings["mode"];
  /** Core's version, which a pinned runner installs: the release's, or `0.0.0` in a clone. */
  readonly serverVersion: string;
  /** The npm name the release published the CLI under: the root package.json's `cliPackage`. */
  readonly cliPackage: string;
};

/**
 * In development, the CLI `pnpm dev:npm-registry` serves. A release's build names the CLI that
 * release published to npm, under its name and at the server's version (ADR 0064); a runner's
 * `OSTRA_RUNNER_NPM_REGISTRY` names a mirror instead. A clone's build (`0.0.0`) names none, since
 * no registry has that version, so its runners keep their own, inside the version window.
 */
export const runnerNpmFor = (build: RunnerNpmBuild): InfoNpm | null => {
  if (build.mode === "development") {
    return DEV_RUNNER_NPM;
  }
  return build.serverVersion === DEVELOPMENT_VERSION ? null : { package: build.cliPackage, registry: NPM_REGISTRY };
};

/** This build's: core's version and the CLI's name as the release's stamp wrote them. */
export const runnerNpm = (mode: ServerSettings["mode"]): InfoNpm | null => runnerNpmFor({ mode, serverVersion: CORE_VERSION, cliPackage: CLI_PACKAGE });
