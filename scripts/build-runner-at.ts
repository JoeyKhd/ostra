// Builds the runner as an earlier milestone shipped it (F-061; milestone 5's ticket 16), for the
// end-to-end demo's step 10: milestone 4's runner (protocol 1.3) joins a milestone 5 server and
// works, one minor behind; milestone 3's (protocol 1.2) is refused with the fix and shows as
// outdated. Real builds of those commits, not a flag on today's runner.
//
// - Each ref is checked out as a detached worktree under `.ostra-dev/runner-builds/<name>/`
//   (gitignored), and its dependencies installed from its own lockfile. The runner runs from its
//   source, as it does in development: `node <dir>/apps/runner/src/main.ts runner ...`.
// - The refs are the tags `milestone-4` and `milestone-3` unless `--ref <name>=<commit>` names
//   another. A tag that doesn't exist yet is refused with how to name the commit instead.
// - Each build says the protocol minor its source speaks, read from its `version.ts`, so the demo
//   knows which one is which before it starts them.
// - Every command is an argument array, never a shell string: a ref is data.
//
// Run with `node scripts/build-runner-at.ts [--ref milestone-4=<commit>] [--ref milestone-3=<commit>] [--dry-run]`.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A build to make: a name for its folder, and the git ref to build. */
export type RunnerBuild = { readonly name: string; readonly ref: string };

/** One command of a build: what runs, with its arguments, where. */
export type BuildStep = { readonly command: string; readonly args: readonly string[]; readonly cwd: string };

/** The demo's two builds, by their milestone tags. */
export const defaultBuilds: readonly RunnerBuild[] = [
  { name: "milestone-4", ref: "milestone-4" },
  { name: "milestone-3", ref: "milestone-3" },
];

const refPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * The builds from the command line: the defaults, each replaced by a `--ref <name>=<ref>`. A ref
 * that isn't a plain name or commit (a leading dash, a space, `..`) is refused, so it can never be
 * read as an option by git.
 */
export const parseBuildArgs = (
  argv: readonly string[],
): { readonly ok: true; readonly builds: readonly RunnerBuild[]; readonly dryRun: boolean } | { readonly ok: false; readonly reason: string } => {
  const refs = new Map(defaultBuilds.map((build) => [build.name, build.ref]));
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg !== "--ref") {
      return { ok: false, reason: `unknown argument ${JSON.stringify(arg)}` };
    }
    const value = argv[index + 1] ?? "";
    index += 1;
    const [name = "", ref = ""] = value.split("=", 2);
    if (!refs.has(name)) {
      return { ok: false, reason: `--ref names a build: ${[...refs.keys()].join(" or ")}` };
    }
    if (!refPattern.test(ref) || ref.includes("..")) {
      return { ok: false, reason: `--ref ${name}= needs a tag, a branch or a commit` };
    }
    refs.set(name, ref);
  }
  return { ok: true, builds: [...refs].map(([name, ref]) => ({ name, ref })), dryRun };
};

/** The commands that make one build in `root`'s `.ostra-dev/runner-builds/<name>/`. */
export const buildSteps = (root: string, build: RunnerBuild): readonly BuildStep[] => {
  const dir = path.join(root, ".ostra-dev", "runner-builds", build.name);
  return [
    { command: "git", args: ["rev-parse", "--verify", "--quiet", `${build.ref}^{commit}`], cwd: root },
    { command: "git", args: ["worktree", "add", "--force", "--detach", dir, `${build.ref}^{commit}`], cwd: root },
    { command: "pnpm", args: ["install", "--frozen-lockfile"], cwd: dir },
  ];
};

/** The protocol minor a build's source speaks, from its `packages/protocol/src/runner/version.ts`. */
export const protocolMinorOf = (versionSource: string): number | null => {
  const match = /export const PROTOCOL_MINOR = (\d+);/.exec(versionSource);
  return match?.[1] === undefined ? null : Number(match[1]);
};

/**
 * Windows starts `pnpm` through its `.cmd` shim, which Node runs only through `cmd.exe`: the
 * arguments there are this script's own constants, never a ref.
 */
const spawnArgs = (step: BuildStep): readonly [string, readonly string[]] =>
  process.platform === "win32" && step.command === "pnpm" ? ["cmd.exe", ["/d", "/s", "/c", "pnpm", ...step.args]] : [step.command, step.args];

const run = (step: BuildStep): Promise<number> =>
  new Promise((resolve, reject) => {
    const [command, args] = spawnArgs(step);
    const child = spawn(command, [...args], { cwd: step.cwd, stdio: "inherit", shell: false, windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });

const main = async (): Promise<number> => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parsed = parseBuildArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`build-runner-at: ${parsed.reason}\n`);
    return 2;
  }
  for (const build of parsed.builds) {
    const steps = buildSteps(root, build);
    if (parsed.dryRun) {
      for (const step of steps) {
        process.stdout.write(`${build.name}: (${step.cwd}) ${step.command} ${step.args.join(" ")}\n`);
      }
      continue;
    }
    for (const [index, step] of steps.entries()) {
      const code = await run(step);
      if (code !== 0) {
        process.stderr.write(
          index === 0
            ? `build-runner-at: ${build.ref} isn't a commit here. Tag the milestone (git tag ${build.name} <commit>) or name it: --ref ${build.name}=<commit>\n`
            : `build-runner-at: ${step.command} ${step.args.join(" ")} failed in ${step.cwd}\n`,
        );
        return 1;
      }
    }
    const dir = path.join(root, ".ostra-dev", "runner-builds", build.name);
    const minor = protocolMinorOf(await readFile(path.join(dir, "packages", "protocol", "src", "runner", "version.ts"), "utf8"));
    process.stdout.write(
      `build-runner-at: ${build.name} (${build.ref}) speaks protocol 1.${minor === null ? "?" : String(minor)}: node ${path.join(dir, "apps", "runner", "src", "main.ts")} runner --server <core>\n`,
    );
  }
  return 0;
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
