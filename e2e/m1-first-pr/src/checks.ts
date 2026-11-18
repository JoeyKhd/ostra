import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { devDatabaseUrl, devPgPort } from "@ostra/db/dev";
import pg from "pg";

import type { DemoGitHub } from "./github.ts";
import type { DemoSettings } from "./settings.ts";

// The checks after the run (spec section 3). Each returns a line for demo.md and whether it held.
// A secret is searched for by value and never printed.

export type CheckResult = { readonly name: string; readonly ok: boolean; readonly detail: string };

type GitRun = { readonly code: number; readonly output: string };

/** git with no config of the member's: only what the task's checkout holds. */
const runGit = (args: readonly string[], cwd: string, home: string): Promise<GitRun> =>
  new Promise((resolve) => {
    const env: Record<string, string> = { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
    for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    execFile("git", [...args], { cwd, env, windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      const code: unknown = error === null ? 0 : Reflect.get(error, "code");
      resolve({ code: typeof code === "number" ? code : 1, output: `${stdout}${stderr}` });
    });
  });

/** The task's checkout of the demo repo, while the task runs on the host executor. */
export const taskCheckout = (settings: DemoSettings, taskId: string): string =>
  path.join(settings.runnerDataDir, "tasks", taskId, "workspace", settings.githubRepo);

/** From the task's checkout, pushes to `main` and to another repo must be refused by the git proxy. */
export const checkGitProxy = async (settings: DemoSettings, taskId: string): Promise<readonly CheckResult[]> => {
  const checkout = taskCheckout(settings, taskId);
  const home = await mkdtemp(path.join(os.tmpdir(), "ostra-e2e-git-"));
  try {
    // A new commit object (the branch and the working tree are left alone), so the push has something to send.
    const probe = await runGit(["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "ostra e2e: a push the proxy must refuse"], checkout, home);
    const sha = probe.output.trim().split("\n").at(-1) ?? "HEAD";
    const main = await runGit(["push", "origin", `${sha}:refs/heads/main`], checkout, home);
    const other = await runGit(["push", `https://github.com/${settings.githubOrg}/${settings.githubOtherRepo}.git`, `${sha}:refs/heads/ostra/e2e-probe`], checkout, home);
    const reason = (run: GitRun): string => run.output.split("\n").find((line) => /ostra|refus|denied|not allowed|forbidden/i.test(line))?.trim() ?? `exit ${String(run.code)}`;
    return [
      { name: "git proxy refuses a push to main", ok: main.code !== 0, detail: reason(main) },
      { name: "git proxy refuses a push to another repo", ok: other.code !== 0, detail: reason(other) },
    ];
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

const withDatabase = async <T,>(run: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: process.env["DATABASE_URL"] ?? devDatabaseUrl(devPgPort(process.env)) });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
};

const countRows = (result: pg.QueryResult): number => Number(Reflect.get(Object(result.rows[0]), "n"));

const branchOf = async (taskId: string): Promise<string> => {
  const result = await withDatabase((client) => client.query(`SELECT "branchName" AS name FROM task WHERE id = $1`, [taskId]));
  const name: unknown = Reflect.get(Object(result.rows[0]), "name");
  if (typeof name !== "string") throw new Error("no such task");
  return name;
};

/** The real model token and any GitHub token or key appear in no event, no log line and no task folder left behind. */
export const checkNoCredential = async (settings: DemoSettings, logFiles: readonly string[]): Promise<CheckResult> => {
  const privateKey = await readFile(settings.githubPrivateKeyPath, "utf8");
  const keyLine = privateKey.split("\n").find((line) => line.length > 40 && !line.startsWith("-----")) ?? privateKey;
  const needles = [settings.modelApiKey, keyLine];
  // GitHub's installation tokens start with ghs_, its other tokens with gh*_ (a pattern, not a value).
  const tokenPattern = /\bgh[pousr]_[A-Za-z0-9]{30,}/;
  const found: string[] = [];
  const events = await withDatabase((client) =>
    client.query("SELECT count(*)::int AS n FROM event WHERE strpos(payload::text, $1) > 0 OR strpos(payload::text, $2) > 0 OR payload::text ~ 'gh[pousr]_[A-Za-z0-9]{30,}'", needles),
  );
  if (countRows(events) > 0) found.push("the event log");
  for (const file of logFiles) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (needles.some((needle) => text.includes(needle)) || tokenPattern.test(text)) found.push(path.basename(file));
  }
  const leftover = await readdir(path.join(settings.runnerDataDir, "tasks")).catch(() => []);
  return {
    name: "no credential reached the agent, the event log or a log line",
    ok: found.length === 0 && leftover.length === 0,
    detail: found.length === 0 ? `searched the event log and ${String(logFiles.length)} logs by value; ${String(leftover.length)} task folders left` : `found in: ${found.join(", ")}`,
  };
};

/** The key proxy's counts are stored with the session, and equal the sum of its usage events. */
export const checkTokens = async (taskId: string): Promise<CheckResult> =>
  withDatabase(async (client) => {
    const result = await client.query(
      `SELECT s."inputTokens" AS "in", s."outputTokens" AS "out", s."cacheReadTokens" AS "cache",
              coalesce(sum((e.payload->>'inputTokens')::int), 0)::int AS "eventsIn",
              coalesce(sum((e.payload->>'outputTokens')::int), 0)::int AS "eventsOut",
              count(e.*)::int AS calls
         FROM session s LEFT JOIN event e ON e."sessionId" = s.id AND e.kind = 'usage.recorded'
        WHERE s."taskId" = $1 GROUP BY s.id`,
      [taskId],
    );
    const row: unknown = result.rows[0];
    const field = (name: string): number => Number(Reflect.get(Object(row), name));
    const ok = row !== undefined && field("calls") > 0 && field("in") === field("eventsIn") && field("out") === field("eventsOut") && field("out") > 0;
    return {
      name: "tokens counted by the key proxy and stored with the session",
      ok,
      detail: `${String(field("calls"))} model calls; input ${String(field("in"))}, output ${String(field("out"))}, cache read ${String(field("cache"))}`,
    };
  });

/** A task that ended without changes opened no PR and has an open needs-you item with the agent's summary. */
export const checkNoEmptyPr = async (github: DemoGitHub, taskId: string): Promise<CheckResult> => {
  const item = await withDatabase((client) =>
    client.query(`SELECT count(*)::int AS n FROM needs_you_item WHERE "taskId" = $1 AND state = 'open' AND coalesce(summary, '') <> ''`, [taskId]),
  );
  const branch = await branchOf(taskId);
  const pulls = await github.octokit.rest.pulls.list({ owner: github.owner, repo: github.repo, state: "all", per_page: 100 });
  const opened = pulls.data.filter((pull) => pull.head.ref === branch).length;
  return {
    name: "no empty PR: the task without changes is in needs you",
    ok: countRows(item) === 1 && opened === 0,
    detail: `${String(countRows(item))} needs-you item with a summary, ${String(opened)} PRs`,
  };
};

/** A stopped task left its branch and its hidden ref on GitHub. */
export const checkStoppedRefs = async (github: DemoGitHub, taskId: string): Promise<CheckResult> => {
  const branch = await branchOf(taskId);
  const branches = await github.octokit.rest.git.listMatchingRefs({ owner: github.owner, repo: github.repo, ref: `heads/${branch}` });
  const hidden = await github.octokit.rest.git.listMatchingRefs({ owner: github.owner, repo: github.repo, ref: `ostra/wip/${taskId}` });
  return {
    name: "stop left the branch and the hidden ref on GitHub",
    ok: branches.data.length === 1 && hidden.data.length === 1,
    detail: `branch ${branch}: ${branches.data.length === 1 ? "on GitHub" : "missing"}; hidden ref refs/ostra/wip/${taskId}: ${hidden.data.length === 1 ? "on GitHub" : "missing"}`,
  };
};
