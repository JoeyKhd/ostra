// `pnpm images:build`: builds the three images from source (ADR 0046's milestone 5 section), tagged
// `<namespace>/<name>:<version>` from the root package.json (`ostra/<name>:0.0.0` in a clone, the
// registry's at a release), and prints each one's size. Linux with Docker only: it runs in
// milestone 5's Linux proof job (ticket 35), on the maintainer's machine and in release.yml, which
// pushes what it tags. Nothing is pushed from here. `--plan` prints the builds without running them, anywhere.
//
// Every docker call takes its arguments as an array; nothing is put through a shell.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { buildPlan } from "./images.ts";
import type { ImageBuild } from "./images.ts";
import { imageNamespace, releaseVersion, repoRoot } from "./repo.ts";

const run = promisify(execFile);

const build = (image: ImageBuild): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", [...image.args], { cwd: repoRoot, stdio: "inherit", env: { ...process.env, DOCKER_BUILDKIT: "1" } });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker build of ${image.tag} exited ${String(code)}`));
      }
    });
  });

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

const main = async (): Promise<number> => {
  const plan = buildPlan(await releaseVersion(), await imageNamespace());
  if (process.argv.includes("--plan")) {
    for (const image of plan) {
      process.stdout.write(`${image.tag}: docker ${image.args.join(" ")}\n`);
    }
    return 0;
  }
  if (process.platform !== "linux") {
    process.stderr.write("images:build runs on Linux with Docker (ticket 35's job). Here, `pnpm check:images` checks the Dockerfiles, and `--plan` prints the builds.\n");
    return 1;
  }
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch {
    process.stderr.write("images:build needs Docker: `docker version` didn't answer.\n");
    return 1;
  }
  const sizes: string[] = [];
  for (const image of plan) {
    process.stdout.write(`building ${image.tag} from ${image.dockerfile}\n`);
    await build(image);
    const { stdout } = await run("docker", ["image", "inspect", "--format", "{{.Size}}", image.tag]);
    sizes.push(`${image.tag}  ${megabytes(Number(stdout.trim()))}`);
  }
  process.stdout.write(`\n${sizes.join("\n")}\n`);
  return 0;
};

process.exitCode = await main();
