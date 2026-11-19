import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { cliPaths, cliSessionMessages, cliTaskBranchesResponseSchema } from "@ostra/protocol";
import type { CliTaskBranchRepo } from "@ostra/protocol";
import { cliRequest } from "./cli-http.ts";
import { cliSessionPath, loadCliSession } from "./cli-session.ts";
import type { CliCommandDeps, CliOutcome } from "./login.ts";

// `ostra checkout <ref> [--dir <folder>]` (F-103, F-028, ADR 0051): a task's branches into the
// member's own clones. ostra hands out no token: git runs as the member, with their credentials.
// Every git call is the async child-process API with an argument list, never a shell line, and
// with `GIT_CEILING_DIRECTORIES` above the clone, so git never acts on a repo that holds it.

type GitResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

export type CheckoutDeps = CliCommandDeps & {
  /** Where the search starts without `--dir`. Default: the process's folder. */
  readonly cwd?: string;
};

const runGit = (args: readonly string[], cwd: string, env: CliCommandDeps["env"], ceiling: string): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd, env: { ...env, GIT_CEILING_DIRECTORIES: ceiling }, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });

/** A remote URL as `host/owner/repo`, lower case, whatever its form (https, ssh, with `.git` or credentials). */
export const remoteKey = (url: string): string | null => {
  const trimmed = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed);
  let host: string;
  let pathname: string;
  if (scp !== null) {
    host = scp[1] ?? "";
    pathname = scp[2] ?? "";
  } else {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  }
  const repo = pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return host === "" || repo === "" ? null : `${host}/${repo}`.toLowerCase();
};

const isDir = async (dir: string): Promise<boolean> => {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
};

/** The folder and its children to depth 2: where a clone may already be. */
const candidates = async (root: string): Promise<readonly string[]> => {
  const found = [root];
  const children = async (dir: string): Promise<readonly string[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules").map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  };
  for (const child of await children(root)) {
    found.push(child, ...(await children(child)));
  }
  return found;
};

/** A clone's `origin`, or `null` when the folder isn't the top of a git checkout. */
const originOf = async (dir: string, env: CliCommandDeps["env"]): Promise<string | null> => {
  if (!(await isDir(path.join(dir, ".git")))) {
    return null;
  }
  // The URL as configured: `remote get-url` would expand the member's `insteadOf` rules.
  const result = await runGit(["config", "--get", "remote.origin.url"], dir, env, path.dirname(dir));
  return result.code === 0 ? result.stdout.trim() : null;
};

/** git's own words for a failure, short: the last lines it wrote. */
const gitWords = (result: GitResult): string => {
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.slice(-3).join(" ") || `exit ${String(result.code)}`;
};

type Planned = { readonly repo: CliTaskBranchRepo; readonly dir: string; readonly clone: boolean };

export const runCheckout = async (ref: string | undefined, flags: Readonly<Record<string, string>>, deps: CheckoutDeps): Promise<CliOutcome> => {
  const { terminal, env } = deps;
  if (ref === undefined || ref.trim() === "") {
    terminal.warn("ostra checkout: name the task: `ostra checkout <ticket key, task ID or URL>`.");
    return { ok: false, usage: true };
  }
  const loaded = await loadCliSession(cliSessionPath(env, deps.platform));
  if (loaded.kind !== "found") {
    terminal.warn(loaded.kind === "broken" ? `ostra checkout: ${loaded.message}. Run \`ostra login\` again.` : cliSessionMessages["session-missing"]);
    return { ok: false };
  }
  const { session } = loaded;
  const answered = await cliRequest(
    { serverUrl: session.serverUrl, path: cliPaths.taskBranches(ref.trim()), method: "GET", token: session.token, signal: deps.signal },
    cliTaskBranchesResponseSchema,
  );
  if (!answered.ok) {
    if (answered.kind === "refused" && answered.status === 404) {
      terminal.warn(`ostra checkout: no task "${ref}" that you can open. ${answered.message}`);
    } else if (answered.kind === "refused" && answered.status === 403) {
      terminal.warn(`ostra checkout: you can't open task "${ref}". ${answered.message}`);
    } else {
      // A 401 carries the server's own message ("This CLI session was revoked. Run `ostra login` again.").
      terminal.warn(`ostra checkout: ${answered.message}`);
    }
    return { ok: false };
  }
  const root = path.resolve(flags["dir"] ?? deps.cwd ?? process.cwd());
  if (!(await isDir(root))) {
    terminal.warn(`ostra checkout: ${root} isn't a folder.`);
    return { ok: false };
  }

  // First every repo's clone and whether it's clean, so nothing changes when one is refused.
  const places = await candidates(root);
  const origins = new Map<string, string>();
  for (const place of places) {
    const origin = await originOf(place, env);
    const key = origin === null ? null : remoteKey(origin);
    if (key !== null && !origins.has(key)) {
      origins.set(key, place);
    }
  }
  const planned: Planned[] = [];
  for (const repo of answered.value.repos) {
    const key = remoteKey(repo.cloneUrl);
    const existing = key === null ? undefined : origins.get(key);
    if (existing !== undefined) {
      const status = await runGit(["status", "--porcelain"], existing, env, path.dirname(existing));
      if (status.code !== 0) {
        terminal.warn(`ostra checkout: git couldn't read ${repo.fullName}'s clone in ${existing}: ${gitWords(status)}`);
        return { ok: false };
      }
      if (status.stdout.trim() !== "") {
        terminal.warn(`ostra checkout: ${repo.fullName} has uncommitted changes in ${existing}. Commit or stash them, then run it again.`);
        return { ok: false };
      }
      planned.push({ repo, dir: existing, clone: false });
      continue;
    }
    const target = path.join(root, repo.fullName.split("/").at(-1) ?? repo.fullName);
    if (await isDir(target)) {
      terminal.warn(`ostra checkout: ${target} exists and isn't a clone of ${repo.fullName}. Move it, or pass --dir.`);
      return { ok: false };
    }
    planned.push({ repo, dir: target, clone: true });
  }

  for (const { repo, dir, clone } of planned) {
    const ceiling = path.dirname(dir);
    if (clone) {
      terminal.say(`Cloning ${repo.fullName} into ${dir}...`);
      const cloned = await runGit(["clone", "--", repo.cloneUrl, dir], ceiling, env, ceiling);
      if (cloned.code !== 0) {
        terminal.warn(`ostra checkout: git clone of ${repo.fullName} failed: ${gitWords(cloned)}`);
        return { ok: false };
      }
    }
    if (repo.headSha === null) {
      terminal.say(`${repo.fullName}  ${dir}  nothing pushed to ${repo.branch} yet`);
      continue;
    }
    const remoteRef = `refs/remotes/origin/${repo.branch}`;
    const fetched = await runGit(["fetch", "origin", `+refs/heads/${repo.branch}:${remoteRef}`], dir, env, ceiling);
    if (fetched.code !== 0) {
      terminal.warn(`ostra checkout: git fetch of ${repo.fullName}'s ${repo.branch} failed: ${gitWords(fetched)}`);
      return { ok: false };
    }
    const local = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${repo.branch}`], dir, env, ceiling);
    const steps: readonly (readonly string[])[] =
      local.code === 0
        ? [
            ["checkout", repo.branch],
            ["branch", `--set-upstream-to=origin/${repo.branch}`, repo.branch],
            // A local branch with the member's own commits on top stays as it is: git says so.
            ["merge", "--ff-only", `origin/${repo.branch}`],
          ]
        : [["checkout", "-b", repo.branch, "--track", `origin/${repo.branch}`]];
    for (const step of steps) {
      const done = await runGit(step, dir, env, ceiling);
      if (done.code !== 0) {
        terminal.warn(`ostra checkout: git ${step[0] ?? ""} in ${dir} failed: ${gitWords(done)}`);
        return { ok: false };
      }
    }
    terminal.say(`${repo.fullName}  ${dir}  on ${repo.branch}`);
  }
  return { ok: true };
};
