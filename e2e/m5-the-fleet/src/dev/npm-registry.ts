// `pnpm dev:npm-registry`: ticket 06's fake npm registry on loopback until Ctrl-C, for the runner's
// pin (F-061, ticket 19): `OSTRA_RUNNER_NPM_REGISTRY=<its url>`. It serves the CLI at the checkout's
// version and one patch above, each with its integrity. Until the CLI is published (ticket 22) the
// packages are a stand-in named `ostra` whose `ostra` prints its version. Development and test only.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { packFakeCli, startFakeNpmRegistry } from "@ostra/adapter-sdk/testing/net";
import { z } from "zod";

import { devToolAllowed, nextPatch, portFrom, refuseOutsideDev, repoRoot, say, serveUntilStopped } from "./common.ts";

const main = async (): Promise<number> => {
  if (!devToolAllowed(process.env)) return refuseOutsideDev("The fake npm registry");
  const port = portFrom(process.env, "OSTRA_DEV_NPM_REGISTRY_PORT", 14_873);
  if (port === null) {
    process.stderr.write("OSTRA_DEV_NPM_REGISTRY_PORT is a port number.\n");
    return 2;
  }
  const runner = z.looseObject({ version: z.string() }).parse(JSON.parse(await readFile(path.join(repoRoot, "apps", "runner", "package.json"), "utf8")));
  const versions = [runner.version, nextPatch(runner.version)];
  const registry = await startFakeNpmRegistry(await Promise.all(versions.map((version) => packFakeCli(version))));
  say(`Fake npm registry on ${registry.url} (loopback only), serving ostra ${versions.join(" and ")}.`);
  say(`  For the pin: OSTRA_RUNNER_NPM_REGISTRY=${registry.url}`);
  return serveUntilStopped({ url: registry.url, versions }, () => registry.close());
};

process.exitCode = await main();
