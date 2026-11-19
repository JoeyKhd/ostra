import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { allowedEnvNames, selfSetEnv } from "@ostra/adapter-opencode";
import { devPgDir } from "@ostra/db/dev";
import type { TaskId } from "@ostra/protocol";
import pg from "pg";
import { z } from "zod";

import { agentLaunches, descendantsOf, listProcesses, namesOutside, readEnvironments } from "./agent-process.ts";
import type { ProcessEnvironment } from "./agent-process.ts";
import { demoDatabase, judgeTaskInDatabase } from "./database.ts";
import type { DemoDatabase } from "./database.ts";
import { agentDatabasePath, readAgentTotals, TOKEN_TOLERANCE, withinTolerance } from "./agent-tokens.ts";
import type { TokenTotals } from "./agent-tokens.ts";
import type { DemoGitHub } from "./github.ts";
import { scanFolder, secretNeedles, textHoldsSecret } from "./scan.ts";
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

/** The task's root on the runner: its checkout, its agent's folders and its git config (host executor). */
export const taskRoot = (settings: DemoSettings, taskId: TaskId): string => path.join(settings.runnerDataDir, "tasks", taskId);

/** The task's checkout of the demo repo, while the task runs on the host executor. */
export const taskCheckout = (settings: DemoSettings, taskId: TaskId): string => path.join(taskRoot(settings, taskId), "workspace", settings.githubRepo);

/** The proxy's own words for a push to a ref that isn't the task's (`policy.ts`), and for one to another repo. */
export const MAIN_REFUSAL = "ostra: only the task";
export const OTHER_REPO_REFUSAL = "ostra: this task";

/** The branch the other-repo probe would create: it must not exist afterwards. */
const PROBE_BRANCH = "ostra/e2e-probe";

/** A push the proxy itself refused: a non-zero exit alone could be a network error, or GitHub's own refusal. */
export const refusedBy = (run: GitRun, words: string): boolean => run.code !== 0 && run.output.includes(words);

const refusalDetail = (run: GitRun, words: string): string =>
  run.output
    .split(/\r?\n/)
    .find((line) => line.includes(words))
    ?.trim() ?? `exit ${String(run.code)}, and no refusal from the proxy`;

const refSchema = z.looseObject({ object: z.looseObject({ sha: z.string() }) });
const refsSchema = z.array(z.looseObject({ ref: z.string(), object: z.looseObject({ sha: z.string() }) }));

const mainSha = async (github: DemoGitHub): Promise<string> =>
  refSchema.parse((await github.octokit.rest.git.getRef({ owner: github.owner, repo: github.repo, ref: "heads/main" })).data).object.sha;

/**
 * From the task's checkout, pushes to `main` and to another repo must be refused by the git proxy,
 * with its own words, and GitHub must show nothing changed: `main` is the same commit, and the
 * other repo has no probe branch.
 */
export const checkGitProxy = async (github: DemoGitHub, settings: DemoSettings, taskId: TaskId): Promise<readonly CheckResult[]> => {
  const checkout = taskCheckout(settings, taskId);
  const home = await mkdtemp(path.join(os.tmpdir(), "ostra-e2e-git-"));
  try {
    const before = await mainSha(github);
    // A new commit object (the branch and the working tree are left alone), so the push has something to send.
    const probe = await runGit(["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "ostra e2e: a push the proxy must refuse"], checkout, home);
    const sha = probe.output.trim().split("\n").at(-1) ?? "";
    if (!/^[0-9a-f]{40,64}$/.test(sha)) {
      const detail = `the probe commit couldn't be made (exit ${String(probe.code)})`;
      return [
        { name: "git proxy refuses a push to main", ok: false, detail },
        { name: "git proxy refuses a push to another repo", ok: false, detail },
      ];
    }
    const main = await runGit(["push", "origin", `${sha}:refs/heads/main`], checkout, home);
    const other = await runGit(["push", `https://github.com/${github.owner}/${settings.githubOtherRepo}.git`, `${sha}:refs/heads/${PROBE_BRANCH}`], checkout, home);
    const after = await mainSha(github);
    const probeRefs = await github.octokit.rest.git.listMatchingRefs({ owner: github.owner, repo: settings.githubOtherRepo, ref: `heads/${PROBE_BRANCH}` });
    return [
      { name: "git proxy refuses a push to main", ok: refusedBy(main, MAIN_REFUSAL), detail: refusalDetail(main, MAIN_REFUSAL) },
      { name: "git proxy refuses a push to another repo", ok: refusedBy(other, OTHER_REPO_REFUSAL), detail: refusalDetail(other, OTHER_REPO_REFUSAL) },
      {
        name: "nothing the proxy refused reached GitHub",
        ok: before === after && probeRefs.data.length === 0,
        detail: `${github.repo}/main ${before === after ? "is the same commit" : "moved"}; ${settings.githubOtherRepo} has ${probeRefs.data.length === 0 ? "no" : "a"} ${PROBE_BRANCH} branch`,
      },
    ];
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

/** `TOKEN_PATTERN` in Postgres's regex dialect (\b there is a backspace). */
const SQL_TOKEN_PATTERN = "gh[pousr]_[A-Za-z0-9]{30,}";

/** The stack's database, found once (`demoDatabase`). */
let database: Promise<DemoDatabase> | undefined;
const stackDatabase = (): Promise<DemoDatabase> => (database ??= demoDatabase(process.env, devPgDir));

const withDatabase = async <T,>(run: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: (await stackDatabase()).url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
};

// What a query returns is external data: each row is parsed with a schema, never claimed.
const countRowSchema = z.object({ n: z.coerce.number() });

/** The `n` of a `SELECT count(*) AS n` result: a row that isn't a number fails, it doesn't become NaN. */
export const countRows = (result: pg.QueryResult): number => countRowSchema.parse(result.rows[0]).n;

/** Throws unless the database the checks read holds the task the panel started (`judgeTaskInDatabase`). */
export const assertTaskInDatabase = async (taskId: TaskId): Promise<void> => {
  const rows = await withDatabase(async (client) => countRows(await client.query("SELECT count(*)::int AS n FROM task WHERE id = $1", [taskId])));
  judgeTaskInDatabase(taskId, rows, await stackDatabase());
};

const branchRowSchema = z.object({ name: z.string() });

const branchOf = async (taskId: TaskId): Promise<string> => {
  const result = await withDatabase((client) => client.query(`SELECT "branchName" AS name FROM task WHERE id = $1`, [taskId]));
  const row = branchRowSchema.safeParse(result.rows[0]);
  if (!row.success) throw new Error("no such task");
  return row.data.name;
};

/**
 * No event payload and no log line holds the real model token, a line of the App's key, or a GitHub
 * token. `extraNeedles`: other values a later demo adds, such as the Linear key (milestone 2).
 */
export const checkNoCredential = async (settings: DemoSettings, logFiles: readonly string[], extraNeedles: readonly string[] = []): Promise<CheckResult> => {
  const needles = [...(await secretNeedles(settings)), ...extraNeedles];
  const found: string[] = [];
  let events = 0;
  for (const needle of needles) {
    const result = await withDatabase((client) => client.query("SELECT count(*)::int AS n FROM event WHERE strpos(payload::text, $1) > 0", [needle]));
    events += countRows(result);
  }
  const tokens = await withDatabase((client) => client.query(`SELECT count(*)::int AS n FROM event WHERE payload::text ~ '${SQL_TOKEN_PATTERN}'`));
  if (events + countRows(tokens) > 0) found.push("the event log");
  for (const file of logFiles) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (textHoldsSecret(text, needles)) found.push(path.basename(file));
  }
  return {
    name: "no credential reached the event log or a log line",
    ok: found.length === 0,
    detail: found.length === 0 ? `searched the event log and ${String(logFiles.length)} logs for ${String(needles.length)} values and the GitHub token pattern` : `found in: ${found.join(", ")}`,
  };
};

/** A session that still holds its task's lease, and its runner's slot: one whose box is warm or busy. */
const OPEN_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

/** How many of these tasks' sessions haven't ended, stopped or crashed yet. */
export const openSessions = async (taskIds: readonly TaskId[]): Promise<number> =>
  withDatabase(async (client) =>
    countRows(await client.query(`SELECT count(*)::int AS n FROM session WHERE "taskId" = ANY($1::text[]) AND state::text = ANY($2::text[])`, [taskIds, OPEN_SESSION_STATES])),
  );

/**
 * Waits until every session of these tasks is over. Since milestone 2 a turn's box stays warm, on
 * its runner's slot, for the idle timer (F-096): the demo's capacity-1 runner takes its next task
 * only once the last one's box has stopped. Throws, naming the timer, when one is still open.
 */
export const waitForSessionsEnded = async (taskIds: readonly TaskId[], idleMinutes: number): Promise<void> => {
  // The timer, plus the stop and the after-turn work.
  const timeoutMs = (idleMinutes + 3) * 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await openSessions(taskIds);
    if (open === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${String(open)} session(s) still open ${String(idleMinutes + 3)} minutes on: the idle timer (OSTRA_BOX_IDLE_MINUTES=${String(idleMinutes)}, as the demo was told) didn't end them. ` +
          "Start the stack and the demo with the same OSTRA_BOX_IDLE_MINUTES",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
};

export type LeftoverFacts = {
  /** The task folders in the runner's data folder, each with its task's box states on this stack. */
  readonly folders: readonly { readonly name: string; readonly boxStates: readonly string[] }[];
  /** Sessions of the demo's tasks that haven't ended. */
  readonly openSessions: number;
  /** Agent processes still running below the runner, or `null` when the runner's process isn't known. */
  readonly agents: number | null;
};

/**
 * Once every session ended: no agent process is left below the runner, and each task folder left
 * is a kept box's. On `host` a box's worktree stays after its session, so the task can resume in
 * place, until the box is released (its last PR merged or closed, or 14 idle days: ticket 23,
 * F-079). A folder of a released or failed box, or of no task on this stack, is left behind.
 */
export const judgeLeftovers = (facts: LeftoverFacts): CheckResult => {
  const stray = facts.folders.filter((folder) => !folder.boxStates.includes("stopped")).map((folder) => folder.name);
  return {
    name: "no agent left once the sessions ended, and no task folder but a kept box's",
    ok: facts.openSessions === 0 && facts.agents === 0 && stray.length === 0,
    detail:
      `${String(facts.openSessions)} sessions open; ` +
      (facts.agents === null ? "the runner's process unknown, so its agents weren't counted" : `${String(facts.agents)} agent processes below the runner`) +
      `; ${String(facts.folders.length)} task folders left, ${String(facts.folders.length - stray.length)} of kept (stopped) boxes` +
      (stray.length === 0 ? "" : `; not kept: ${stray.join(", ")}`),
  };
};

/** After the run, once `waitForSessionsEnded`: the agents below the runner, and each task folder's box. */
export const checkLeftovers = async (settings: DemoSettings, taskIds: readonly TaskId[], runnerPid: number | null): Promise<CheckResult> => {
  const names = await readdir(path.join(settings.runnerDataDir, "tasks")).catch(() => []);
  const folders = await withDatabase(async (client) => {
    const rows: { readonly name: string; readonly boxStates: readonly string[] }[] = [];
    for (const name of names) {
      const result = /^[0-9a-f-]{36}$/i.test(name) ? await client.query(`SELECT state::text AS state FROM box WHERE "taskId" = $1`, [name]) : { rows: [] };
      rows.push({ name, boxStates: boxStatesSchema.parse(result.rows).map((row) => row.state) });
    }
    return rows;
  });
  let agents: number | null = null;
  if (runnerPid !== null) {
    const below = descendantsOf(await listProcesses(), runnerPid);
    agents = agentLaunches(below, await readEnvironments(below.map((item) => item.pid))).length;
  }
  return judgeLeftovers({ folders, openSessions: await openSessions(taskIds), agents });
};

const boxStatesSchema = z.array(z.object({ state: z.string() }));

/** Names a process gets from Windows itself, whatever it is launched with: not the runner's doing. */
const WINDOWS_BASELINE = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME", "WINDIR", "USERPROFILE", "TEMP"];

/** What the task run adds to the launch (`agentVariables`): the bot as the agent's git identity. */
const GIT_IDENTITY_NAMES = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

/**
 * The names outside the allowlist that the runner can't account for. A name OpenCode sets in its
 * own environment once it runs (`selfSetEnv`) is accounted for only with exactly OpenCode's value:
 * the same name with another value came from the launch. Windows names are not case-sensitive.
 */
export const unexplainedNames = (
  environment: ProcessEnvironment,
  allowed: readonly string[],
  selfSet: Readonly<Record<string, string>>,
): readonly string[] => {
  const fold = (name: string): string => (process.platform === "win32" ? name.toUpperCase() : name);
  const expected = new Map(Object.entries(selfSet).map(([name, value]) => [fold(name), value]));
  return namesOutside(environment, allowed).filter((name) => expected.get(fold(name)) !== environment.get(name));
};

export type AgentEnvironmentFacts = {
  /** Agent processes found below the runner. */
  readonly launches: number;
  /** Names outside the allowlist, over all of them. */
  readonly outside: readonly string[];
  /** Launches with a value that holds a secret. */
  readonly leaking: number;
};

/** The agent's environment holds only the allowlist (the fake key and the proxy URLs among it) and no secret value. */
export const judgeAgentEnvironment = (facts: AgentEnvironmentFacts): CheckResult => ({
  name: "the agent's environment holds only the allowlist, the fake key and the proxy URLs",
  ok: facts.launches > 0 && facts.outside.length === 0 && facts.leaking === 0,
  detail:
    facts.launches === 0
      ? "no agent process found below the runner, or its environment couldn't be read on this system"
      : `${String(facts.launches)} agent process: ${facts.outside.length === 0 ? "every name is allowed" : `names outside the allowlist: ${facts.outside.join(", ")}`}; ${String(facts.leaking)} values hold a secret`,
});

/**
 * While the task runs: its whole folder (the worktree, OpenCode's home, data, config and temp
 * folders), and OpenCode's tool outputs in the machine's temp folder, searched by value for the
 * model token and the App's key; and the live agent's environment.
 */
export const checkTaskFolder = async (settings: DemoSettings, taskId: TaskId, runnerPid: number | null): Promise<readonly CheckResult[]> => {
  const needles = await secretNeedles(settings);
  const folders = [taskRoot(settings, taskId), path.join(os.tmpdir(), "opencode", "tool-outputs", taskId)];
  const scans = await Promise.all(folders.map((folder) => scanFolder(folder, needles)));
  const [root, outputs] = scans;
  const holding = scans.flatMap((scan, index) => scan.holding.map((file) => `${index === 0 ? "task folder" : "tool outputs"}/${file}`));
  const unreadable = scans.reduce((sum, scan) => sum + scan.unreadable, 0);
  const folder: CheckResult = {
    name: "no credential in the task's folders: worktree, OpenCode's directories, tool outputs",
    ok: root?.exists === true && root.files > 0 && holding.length === 0 && unreadable === 0,
    detail:
      root?.exists !== true
        ? "the task's folder wasn't there to search"
        : holding.length > 0
          ? `found in: ${holding.join(", ")}`
          : `searched ${String(root.files)} files in the task folder and ${String(outputs?.files ?? 0)} tool-output files by value; ${String(unreadable)} unreadable${unreadable === 0 ? "" : ` (${scans.flatMap((scan) => scan.unreadablePaths).join(", ")})`}`,
  };
  if (runnerPid === null) {
    return [folder, judgeAgentEnvironment({ launches: 0, outside: [], leaking: 0 })];
  }
  const below = descendantsOf(await listProcesses(), runnerPid);
  const environments = await readEnvironments(below.map((item) => item.pid));
  const launches = agentLaunches(below, environments);
  const allowed = [...allowedEnvNames, ...GIT_IDENTITY_NAMES, ...(process.platform === "win32" ? WINDOWS_BASELINE : [])];
  const outside = new Set<string>();
  let leaking = 0;
  for (const launch of launches) {
    const environment = environments.get(launch.pid);
    if (environment === undefined) continue;
    for (const name of unexplainedNames(environment, allowed, selfSetEnv)) outside.add(name);
    if ([...environment.values()].some((value) => textHoldsSecret(value, needles))) leaking += 1;
  }
  return [folder, judgeAgentEnvironment({ launches: launches.length, outside: [...outside].sort(), leaking })];
};

const tokensRowSchema = z.object({
  in: z.coerce.number(),
  out: z.coerce.number(),
  cache: z.coerce.number(),
  eventsIn: z.coerce.number(),
  eventsOut: z.coerce.number(),
  calls: z.coerce.number(),
});
const zeroTokens: z.infer<typeof tokensRowSchema> = { in: 0, out: 0, cache: 0, eventsIn: 0, eventsOut: 0, calls: 0 };

/**
 * The session's stored counts equal the sum of its `usage.recorded` events. Both come from the key
 * proxy, so this shows the counts reached the database whole, not that they are right: the check
 * against the agent's own count is `checkAgentTokenCount`.
 */
export const checkTokens = async (taskId: TaskId): Promise<CheckResult> =>
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
    // No session row is a failed check with zero counts; a row of the wrong shape throws.
    const found = result.rows[0] !== undefined;
    const row = found ? tokensRowSchema.parse(result.rows[0]) : zeroTokens;
    const ok = found && row.calls > 0 && row.in === row.eventsIn && row.out === row.eventsOut && row.out > 0;
    return {
      name: "the session's stored token counts equal the sum of the key proxy's usage events",
      ok,
      detail: found
        ? `${String(row.calls)} model calls; input ${String(row.in)}, output ${String(row.out)}, cache read ${String(row.cache)}`
        : `no session for the task in the database at ${(await stackDatabase()).address}`,
    };
  });

/** The key proxy's totals (stored with the session) against OpenCode's own, within ADR 0042's 2%. */
export const judgeTokenCounts = (stored: TokenTotals, agent: TokenTotals | null): CheckResult => {
  const name = `the session's token counts are within ${String(TOKEN_TOLERANCE * 100)}% of the agent's own`;
  if (agent === null) return { name, ok: false, detail: "OpenCode's own token counts couldn't be read from its database" };
  const ok = stored.output > 0 && agent.output > 0 && withinTolerance(stored.input, agent.input) && withinTolerance(stored.output, agent.output);
  return { name, ok, detail: `key proxy: input ${String(stored.input)}, output ${String(stored.output)}; OpenCode: input ${String(agent.input)}, output ${String(agent.output)}` };
};

const usageCallsSchema = z.array(z.object({ input: z.coerce.number(), output: z.coerce.number() }));

/**
 * The key proxy's totals over the model calls OpenCode has closed: every call but the last. OpenCode
 * records a call's usage when its step finishes, and a step finishes only once the tool calls it
 * made return; while the agent waits on its command, the call that asked for the command is still
 * open, so OpenCode has not counted it yet. `null` when no call is closed.
 */
export const closedCallTotals = (calls: readonly TokenTotals[]): TokenTotals | null => {
  const closed = calls.slice(0, -1);
  if (closed.length === 0) return null;
  return closed.reduce((sum, call) => ({ input: sum.input + call.input, output: sum.output + call.output }), { input: 0, output: 0 });
};

/** The task's `usage.recorded` events, in the order the key proxy emitted them. */
const usageCalls = async (taskId: TaskId): Promise<readonly TokenTotals[]> => {
  const result = await withDatabase((client) =>
    client.query(
      `SELECT (payload->>'inputTokens')::int AS input, (payload->>'outputTokens')::int AS output
         FROM event WHERE "taskId" = $1 AND kind = 'usage.recorded' ORDER BY seq`,
      [taskId],
    ),
  );
  return usageCallsSchema.parse(result.rows);
};

/**
 * While the task runs and its agent waits on a command: the key proxy's count of the calls OpenCode
 * has closed (`closedCallTotals`) against OpenCode's own per-task figures. The tool call shows in
 * the panel only after the usage event of the call that made it, so every call is stored by then;
 * the check still polls until they agree or `timeoutMs` passes, as OpenCode writes its database on
 * its own schedule.
 */
export const checkAgentTokenCount = async (settings: DemoSettings, taskId: TaskId, timeoutMs = 60_000): Promise<CheckResult> => {
  const databaseFile = agentDatabasePath(path.join(taskRoot(settings, taskId), "agent"));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const agent = await readAgentTotals(databaseFile).catch(() => null);
    const calls = await usageCalls(taskId);
    const result = judgeTokenCounts(closedCallTotals(calls) ?? { input: 0, output: 0 }, agent);
    const counted = { ...result, detail: `${String(Math.max(0, calls.length - 1))} of ${String(calls.length)} model calls closed; ${result.detail}` };
    if (counted.ok || Date.now() > deadline) return counted;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
};

/** What the checks read of a PR: its author, title and body, and its commits' authors and messages. */
const pullSchema = z.looseObject({
  title: z.string(),
  body: z.string().nullable(),
  user: z.looseObject({ login: z.string() }).nullable(),
});
const personSchema = z.looseObject({ name: z.string(), email: z.string() });
const commitsSchema = z.array(z.looseObject({ commit: z.looseObject({ message: z.string(), author: personSchema.nullable(), committer: personSchema.nullable() }) }));

export type PullRequestExpectation = {
  /** `<slug>[bot]`. */
  readonly botLogin: string;
  /** The admin who prompted: the commits' co-author. */
  readonly adminUsername: string;
  /** OSTRA_PUBLIC_URL: the PR's body links `<it>/tasks/<taskId>`. */
  readonly publicUrl: string;
  readonly taskId: TaskId;
  readonly prompt: string;
};

/** The task's title as ostra makes it from a prompt: its first non-empty line, kept to 120 characters (`titleFromPrompt`). */
export const titleFromPrompt = (prompt: string): string => {
  const first = prompt.split(/\r?\n/).find((line) => line.trim() !== "") ?? prompt;
  const trimmed = first.trim().replace(/\s+/g, " ");
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117).trimEnd()}...`;
};

/** Spec step 10 and ticket 39: the App's bot opened it, authored every commit, the admin co-authored, the prompt is the title, the body links the task. */
export const judgePullRequest = (pull: unknown, commits: unknown, expected: PullRequestExpectation): CheckResult => {
  const name = "the PR is the bot's, with the admin as co-author, the prompt as title and a link to the task";
  const parsedPull = pullSchema.safeParse(pull);
  const parsedCommits = commitsSchema.safeParse(commits);
  if (!parsedPull.success || !parsedCommits.success) return { name, ok: false, detail: "GitHub's answer for the PR or its commits wasn't what was expected" };
  const problems: string[] = [];
  if (parsedPull.data.user?.login !== expected.botLogin) problems.push(`opened by ${parsedPull.data.user?.login ?? "no one"}, not ${expected.botLogin}`);
  if (parsedPull.data.title !== titleFromPrompt(expected.prompt)) problems.push("the title isn't the prompt");
  const link = `${expected.publicUrl.replace(/\/+$/, "")}/tasks/${expected.taskId}`;
  if (parsedPull.data.body?.includes(link) !== true) problems.push("the body doesn't link the task");
  if (parsedCommits.data.length === 0) problems.push("the PR has no commits");
  const noreply = `${expected.botLogin}@users.noreply.github.com`;
  const byBot = (person: z.infer<typeof personSchema> | null): boolean => person !== null && person.name === expected.botLogin && person.email.endsWith(noreply);
  const trailer = `Co-authored-by: ${expected.adminUsername} <`;
  parsedCommits.data.forEach((item, index) => {
    const number = `commit ${String(index + 1)}`;
    if (!byBot(item.commit.author)) problems.push(`${number}: the author isn't the bot`);
    if (!byBot(item.commit.committer)) problems.push(`${number}: the committer isn't the bot`);
    if (!item.commit.message.split(/\r?\n/).some((line) => line.startsWith(trailer))) problems.push(`${number}: no Co-authored-by ${expected.adminUsername}`);
  });
  return {
    name,
    ok: problems.length === 0,
    detail: problems.length === 0 ? `opened by ${expected.botLogin}; ${String(parsedCommits.data.length)} commits by the bot, each with Co-authored-by ${expected.adminUsername}` : problems.join("; "),
  };
};

/** Reads PR `prNumber` of the demo repo through octokit and judges it. */
export const checkPullRequest = async (github: DemoGitHub, prNumber: number, expected: PullRequestExpectation): Promise<CheckResult> => {
  const { owner, repo } = github;
  const pull = await github.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const commits = await github.octokit.rest.pulls.listCommits({ owner, repo, pull_number: prNumber, per_page: 100 });
  return judgePullRequest(pull.data, commits.data, expected);
};

/** A task that ended without changes opened no PR and has an open needs-you item with the agent's summary. */
export const checkNoEmptyPr = async (github: DemoGitHub, taskId: TaskId): Promise<CheckResult> => {
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

/** The file the stopped task wrote before it was stopped, and the lines it must have (the prompt asks for one to ten, a line each). */
export const WIP_FILE = "docs/numbers.md";
export const WIP_LINES = 10;

/** The number of non-empty lines in the text. */
export const countLines = (text: string): number => text.split(/\r?\n/).filter((line) => line.trim() !== "").length;

export type StoppedRefsFacts = {
  readonly branch: string;
  readonly branchRefs: number;
  readonly hiddenRefs: number;
  /** The hidden ref's copy of `WIP_FILE`: its text, or `null` when the file isn't in it. */
  readonly wipFile: string | null;
};

/** F-025: the hidden ref holds the unfinished work, not only a ref's name. */
export const judgeStoppedRefs = (facts: StoppedRefsFacts): CheckResult => {
  const lines = facts.wipFile === null ? null : countLines(facts.wipFile);
  return {
    name: "stop left the branch and the hidden ref with the unfinished work on GitHub",
    ok: facts.branchRefs === 1 && facts.hiddenRefs === 1 && lines === WIP_LINES,
    detail: `branch ${facts.branch}: ${facts.branchRefs === 1 ? "on GitHub" : "missing"}; hidden ref: ${facts.hiddenRefs === 1 ? "on GitHub" : "missing"}; ${WIP_FILE} in it: ${lines === null ? "missing" : `${String(lines)} lines`}`,
  };
};

export type StoppedMidTurnFacts = {
  /** The states of the task's sessions. */
  readonly sessionStates: readonly string[];
  /** PRs opened from the task's branch. */
  readonly pullRequests: number;
};

/**
 * F-025: Stop ended the session mid-turn. A session that ended on its own (`ended`) means the
 * agent finished before the Stop, for instance by moving its long command to the background, and
 * then the refs prove nothing about a stop.
 */
export const judgeStoppedMidTurn = (facts: StoppedMidTurnFacts): CheckResult => ({
  name: "stop ended the session mid-turn, and the stopped task opened no PR",
  ok: facts.sessionStates.length === 1 && facts.sessionStates[0] === "stopped" && facts.pullRequests === 0,
  detail: `sessions: ${facts.sessionStates.length === 0 ? "none" : facts.sessionStates.join(", ")}; ${String(facts.pullRequests)} PRs`,
});

const sessionStatesSchema = z.array(z.object({ state: z.string() }));

/** The stopped task's session was stopped, not ended on its own, and its branch has no PR. */
export const checkStoppedMidTurn = async (github: DemoGitHub, taskId: TaskId): Promise<CheckResult> => {
  const sessions = await withDatabase((client) => client.query(`SELECT state::text AS state FROM session WHERE "taskId" = $1 ORDER BY "startedAt"`, [taskId]));
  const branch = await branchOf(taskId);
  const pulls = await github.octokit.rest.pulls.list({ owner: github.owner, repo: github.repo, state: "all", per_page: 100 });
  return judgeStoppedMidTurn({
    sessionStates: sessionStatesSchema.parse(sessions.rows).map((row) => row.state),
    pullRequests: pulls.data.filter((pull) => pull.head.ref === branch).length,
  });
};

/** The HTTP status of an octokit error, if it has one. */
const statusOf = (error: unknown): unknown => (typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined);

const fileSchema = z.looseObject({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string() });

/** A stopped task left its branch and its hidden ref on GitHub, and the hidden ref holds `docs/numbers.md`. */
export const checkStoppedRefs = async (github: DemoGitHub, taskId: TaskId): Promise<CheckResult> => {
  const { owner, repo } = github;
  const branch = await branchOf(taskId);
  const branches = await github.octokit.rest.git.listMatchingRefs({ owner, repo, ref: `heads/${branch}` });
  const hidden = refsSchema.parse((await github.octokit.rest.git.listMatchingRefs({ owner, repo, ref: `ostra/wip/${taskId}` })).data);
  const ref = hidden.find((item) => item.ref === `refs/ostra/wip/${taskId}`);
  let wipFile: string | null = null;
  if (ref !== undefined) {
    // The contents API reads a commit, so the hidden ref is asked for its commit first.
    try {
      const content = fileSchema.parse((await github.octokit.rest.repos.getContent({ owner, repo, path: WIP_FILE, ref: ref.object.sha })).data);
      wipFile = Buffer.from(content.content, "base64").toString("utf8");
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }
  return judgeStoppedRefs({ branch, branchRefs: branches.data.length, hiddenRefs: ref === undefined ? 0 : 1, wipFile });
};
