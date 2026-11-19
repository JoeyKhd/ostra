import type { DeployFiles } from "./image-checks.ts";
import { dockerfileOf } from "./images.ts";
import { readRepoFile, releaseVersion } from "./repo.ts";

/** The deploy files as the repo has them. */
export const readDeployFiles = async (): Promise<DeployFiles> => {
  const runner: unknown = JSON.parse(await readRepoFile("apps/runner/package.json"));
  const runnerVersion: unknown = Reflect.get(Object(runner), "version");
  return {
    dockerfiles: {
      server: await readRepoFile(dockerfileOf("server")),
      runner: await readRepoFile(dockerfileOf("runner")),
      base: await readRepoFile(dockerfileOf("base")),
    },
    compose: await readRepoFile("deploy/compose.yaml"),
    entrypoint: await readRepoFile("deploy/server-entrypoint.sh"),
    releaseVersion: await releaseVersion(),
    runnerVersion: typeof runnerVersion === "string" ? runnerVersion : "",
  };
};
