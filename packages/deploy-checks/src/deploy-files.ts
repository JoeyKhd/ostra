import type { DeployFiles } from "./image-checks.ts";
import { dockerfileOf } from "./images.ts";
import { readRepoFile, releaseVersion, repoRoot } from "./repo.ts";

/** The deploy files as the repo has them, or as another checkout (`root`) has them, in a test. */
export const readDeployFiles = async (root: string = repoRoot): Promise<DeployFiles> => {
  const runner: unknown = JSON.parse(await readRepoFile("apps/runner/package.json", root));
  const runnerVersion: unknown = Reflect.get(Object(runner), "version");
  return {
    dockerfiles: {
      server: await readRepoFile(dockerfileOf("server"), root),
      runner: await readRepoFile(dockerfileOf("runner"), root),
      base: await readRepoFile(dockerfileOf("base"), root),
    },
    compose: await readRepoFile("deploy/compose.yaml", root),
    entrypoint: await readRepoFile("deploy/server-entrypoint.sh", root),
    releaseVersion: await releaseVersion(root),
    runnerVersion: typeof runnerVersion === "string" ? runnerVersion : "",
  };
};
