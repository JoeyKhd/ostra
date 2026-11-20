import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { gitShaSchema, leaseEpochSchema, repoFullNameSchema, repoIdSchema, sessionIdSchema, taskCredentialsSchema } from "@ostra/protocol";
import type { TaskEventOf, TaskSpec, TaskSpecRestore } from "@ostra/protocol";
import { expect } from "vitest";
import { GIT_TOKEN, manualTimers, startHarness, startShared } from "./task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "./task-host-harness.ts";

// Milestone 4's ticket 21 (F-098): a task across several repos, side by side in one workspace, on
// one executor. The same cases run on `host` (`several-repos.host.test.ts`) and on `docker` as a
// box's sidecar drives it (`several-repos.docker.test.ts`); each file names its tests, so the proof
// cites each executor's run. Two bare repos (and a third for a reopen) behind the real git proxy,
// the scripted fake agent, the fake server and gateway.

const run = promisify(execFile);

/** test2's own git token: a clone or push of test2 with test1's token is a bug the code host would refuse. */
export const GIT_TOKEN_B = "ghs_realGitTokenForTheSecondRepoOfTicket21_0123456789";

export type SeveralReposMode = {
  readonly name: "host" | "docker";
  readonly makeExecutor?: HarnessOptions["makeExecutor"];
};

type Repo = TaskSpec["repos"][number];

const repoOf = (base: Repo, name: string): Repo => ({
  ...base,
  repoId: repoIdSchema.parse(`repo-${name}`),
  fullName: repoFullNameSchema.parse(`ostra-test/${name}`),
  cloneUrl: `https://github.com/ostra-test/${name}.git`,
  checkoutDir: name,
});

/** What core appends to the agent's instructions for several repos (the domain's `renderReposForAgent`). */
export const reposSection = (repos: readonly Repo[], branchName: string): string =>
  [
    "## Repositories",
    "",
    `This task's workspace holds ${String(repos.length)} repositories side by side; you start at the workspace root. Each is its own git repository, on the branch \`${branchName}\`:`,
    "",
    ...repos.map((repo) => `- \`${repo.checkoutDir}/\`: ${repo.fullName} (base: ${repo.defaultBranch})`),
    "",
    "Change only the repositories the task needs. Commit in each one you change; each changed repository gets its own pull request.",
  ].join("\n");

const credentialsFor = (h: Harness, spec: TaskSpec, tokens: Readonly<Record<string, string>> = {}): void => {
  const held = h.server.tasks.get(spec.taskId);
  if (held === undefined) {
    throw new Error("no such task");
  }
  const credentials = taskCredentialsSchema.parse({
    ...held.credentials,
    leaseEpoch: spec.leaseEpoch,
    repos: spec.repos.map((repo) => ({
      repoId: repo.repoId,
      gitToken: tokens[repo.checkoutDir] ?? (repo.checkoutDir === "test2" ? GIT_TOKEN_B : GIT_TOKEN),
      expiresAt: Date.now() + 3_600_000,
    })),
  });
  h.server.tasks.set(spec.taskId, { spec, credentials });
};

const gitIn = async (cwd: string, ...args: readonly string[]): Promise<string> => (await run("git", [...args], { cwd, windowsHide: true })).stdout.trim();

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

export const severalReposCases = (mode: SeveralReposMode) => {
  let shared: Shared | undefined;
  const harnesses: Harness[] = [];
  const sharedNow = (): Shared => {
    if (shared === undefined) {
      throw new Error("setup didn't run");
    }
    return shared;
  };

  /** A runner of its own: its own data folder, fake server and gateway, on the mode's executor. */
  const runner = async (): Promise<Harness> => {
    const h = await startHarness(sharedNow(), {
      host: { timers: manualTimers() },
      ...(mode.makeExecutor === undefined ? {} : { makeExecutor: mode.makeExecutor }),
    });
    harnesses.push(h);
    return h;
  };

  /** The task's workspace, where the executor keeps it (a `docker` box's task volume, or the runner's folder). */
  const workspaceOf = (h: Harness, spec: TaskSpec): string =>
    mode.name === "docker" ? path.join(h.dataDir, "task", "tasks", spec.taskId, "workspace") : path.join(h.dataDir, "tasks", spec.taskId, "workspace");

  /** A task on the given repos, with core's list of them in its instructions and a git token per repo. */
  const taskOn = (h: Harness, prompt: string, names: readonly string[] = ["test1", "test2"], tokens: Readonly<Record<string, string>> = {}): TaskSpec => {
    const made = h.taskFor(prompt);
    const [base] = made.spec.repos;
    if (base === undefined) {
      throw new Error("the fixture has a repo");
    }
    const repos = names.map((name) => repoOf(base, name));
    const spec: TaskSpec = {
      ...made.spec,
      repos,
      agent: { ...made.spec.agent, instructions: repos.length > 1 ? reposSection(repos, made.spec.branchName) : null },
    };
    credentialsFor(h, spec, tokens);
    return spec;
  };

  /** The events of one turn: from its `turn.started` to the `session.saved` after it. */
  const turnEvents = (h: Harness, spec: TaskSpec, ordinal: number) => {
    const events = h.eventsOf(spec);
    const starts = events.flatMap((event, index) => (event.kind === "turn.started" ? [index] : []));
    const start = starts[ordinal - 1];
    if (start === undefined) {
      throw new Error(`no turn ${String(ordinal)}`);
    }
    const end = events.findIndex((event, index) => index > start && event.kind === "session.saved");
    return events.slice(start, end < 0 ? undefined : end + 1);
  };

  /** The repos a turn pushed the task's branch of (not its hidden ref). */
  const branchPushes = (h: Harness, spec: TaskSpec, ordinal: number): readonly string[] =>
    turnEvents(h, spec, ordinal).flatMap((event) => (event.kind === "git.pushed" && event.ref === `refs/heads/${spec.branchName}` ? [event.repoId] : []));

  const savedOf = (h: Harness, spec: TaskSpec, nth = 1): TaskEventOf<"session.saved"> => {
    const saved = h.ofKind(spec, "session.saved")[nth - 1];
    if (saved === undefined) {
      throw new Error("no save");
    }
    return saved;
  };

  const upstream = () => sharedNow().upstream;

  /** Waits for the session's `count`th event of the kind; on a timeout, says which events came, and a crash's words. */
  const waitFor = async (h: Harness, spec: TaskSpec, kind: "session.saved" | "session.crashed" | "turn.started", count = 1): Promise<void> => {
    try {
      await h.waitForKind(spec, kind, count, 120_000);
    } catch {
      const crashed = h.ofKind(spec, "session.crashed")[0]?.error ?? "";
      throw new Error(`no ${kind} (${String(count)}): ${h.kinds(spec).join(", ")} ${crashed}`);
    }
  };

  return {
    setup: async (): Promise<void> => {
      shared = await startShared(`repos-${mode.name}`);
      await shared.upstream.createRepo("ostra-test/test2", { "README.md": "# test2\n" });
      await shared.upstream.createRepo("ostra-test/test3", { "README.md": "# test3\n" });
      shared.upstream.tokens.set(GIT_TOKEN_B, Date.now() + 3_600_000);
    },
    teardown: async (): Promise<void> => {
      await shared?.close();
    },
    cleanup: async (): Promise<void> => {
      for (const h of harnesses.splice(0)) {
        await h.close();
      }
    },

    /** Both repos in their folders under one workspace, on the task's one branch; the agent at the root, told about both. */
    sideBySide: async (): Promise<void> => {
      const h = await runner();
      const spec = taskOn(h, fakeMarker("write", "test1/one.txt test2/two.txt"));
      h.dispatch(spec);
      await waitFor(h, spec, "session.saved");
      const workspace = workspaceOf(h, spec);
      for (const name of ["test1", "test2"]) {
        const checkout = path.join(workspace, name);
        // Its own repository, not a folder of another one.
        expect(await gitIn(checkout, "rev-parse", "--git-dir")).toBe(".git");
        expect(await gitIn(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe(spec.branchName);
        expect(await gitIn(checkout, "config", "--get", "remote.origin.url")).toBe(`https://github.com/ostra-test/${name}.git`);
      }
      // The agent starts at the workspace's root, and its instructions list both folders.
      const launch = h.launches.at(-1);
      expect(launch?.cwd).toBe(workspace);
      expect(launch?.files.some((file) => file.content.includes("- `test1/`: ostra-test/test1") && file.content.includes("- `test2/`: ostra-test/test2"))).toBe(true);
      // One branch name in both repos, each with its own change.
      expect(await upstream().treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`)).toContain("one.txt");
      expect(await upstream().treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`)).not.toContain("two.txt");
      expect(await upstream().treeFiles("ostra-test/test2", `refs/heads/${spec.branchName}`)).toContain("two.txt");
      expect(savedOf(h, spec).repos.map((repo) => repo.repoId)).toEqual(["repo-test1", "repo-test2"]);
      expect(savedOf(h, spec).repos.every((repo) => repo.headSha !== null && repo.hiddenRefSha !== null)).toBe(true);
    },

    /** A turn that changes one repo pushes that repo's branch, and the other repo gets no branch at all. */
    onePushesOne: async (): Promise<void> => {
      const h = await runner();
      const spec = taskOn(h, fakeMarker("write", "test1/only.txt"));
      h.dispatch(spec);
      await waitFor(h, spec, "session.saved");
      expect(branchPushes(h, spec, 1)).toEqual(["repo-test1"]);
      expect(await upstream().treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`)).toContain("only.txt");
      expect(await upstream().refSha("ostra-test/test2", `refs/heads/${spec.branchName}`)).toBeNull();
      expect(savedOf(h, spec).repos.map((repo) => [repo.repoId, repo.ahead])).toEqual([
        ["repo-test1", true],
        ["repo-test2", false],
      ]);
    },

    /** A later turn that changes both repos pushes both, each on the same branch. */
    bothPushBoth: async (): Promise<void> => {
      const h = await runner();
      const spec = taskOn(h, fakeMarker("write", "test1/first.txt"));
      h.dispatch(spec);
      await waitFor(h, spec, "session.saved");
      h.steer(spec, fakeMarker("write", "test1/second.txt test2/second.txt"));
      await waitFor(h, spec, "session.saved", 2);
      expect([...branchPushes(h, spec, 2)].sort()).toEqual(["repo-test1", "repo-test2"]);
      for (const name of ["test1", "test2"]) {
        expect(await upstream().treeFiles(`ostra-test/${name}`, `refs/heads/${spec.branchName}`)).toContain("second.txt");
      }
      expect(savedOf(h, spec, 2).repos.every((repo) => repo.ahead)).toBe(true);
    },

    /**
     * A reopen on another runner, from another data folder: each repo's hidden ref is fetched and
     * applied in its own checkout, and a repo the project added since is cloned at its base.
     */
    reopenRestoresBoth: async (): Promise<void> => {
      const first = await runner();
      const spec = taskOn(first, fakeMarker("write", "test1/kept-1.txt test2/kept-2.txt"));
      first.dispatch(spec);
      await waitFor(first, spec, "session.saved");
      const saved = savedOf(first, spec);
      const hiddenRefs: TaskSpecRestore["hiddenRefs"] = saved.repos.flatMap((repo) =>
        repo.hiddenRefSha === null || repo.headSha === null ? [] : [{ repoId: repo.repoId, sha: gitShaSchema.parse(repo.hiddenRefSha), baseSha: gitShaSchema.parse(repo.headSha) }],
      );
      expect(hiddenRefs).toHaveLength(2);

      const second = await runner();
      expect(second.dataDir).not.toBe(first.dataDir);
      const [base] = spec.repos;
      if (base === undefined) {
        throw new Error("no repo");
      }
      const repos = [...spec.repos, repoOf(base, "test3")];
      const next: TaskSpec = {
        ...spec,
        sessionId: sessionIdSchema.parse(`${spec.sessionId}-reopen`),
        leaseEpoch: leaseEpochSchema.parse(spec.leaseEpoch + 1),
        prompt: `${fakeMarker("say")} the rebuild template`,
        repos,
        agent: { ...spec.agent, instructions: reposSection(repos, spec.branchName) },
        restore: { origin: "rebuilt", archive: null, hiddenRefs, pendingMessages: [] },
      };
      const held = first.server.tasks.get(spec.taskId);
      if (held === undefined) {
        throw new Error("no credentials");
      }
      second.server.tasks.set(next.taskId, { spec: next, credentials: held.credentials });
      credentialsFor(second, next);
      second.dispatch(next);
      await waitFor(second, next, "session.saved");
      expect(second.ofKind(next, "session.restored")[0]).toMatchObject({ origin: "rebuilt", hiddenRef: "applied" });

      const workspace = workspaceOf(second, next);
      for (const [name, file] of [
        ["test1", "kept-1.txt"],
        ["test2", "kept-2.txt"],
      ] as const) {
        const checkout = path.join(workspace, name);
        const savedSha = saved.repos.find((repo) => repo.repoId === `repo-${name}`)?.hiddenRefSha;
        // Each checkout fetched its own repo's hidden ref, the one the save reported.
        expect(await gitIn(checkout, "rev-parse", `refs/ostra/wip/${spec.taskId}`)).toBe(savedSha);
        expect(await exists(path.join(checkout, file))).toBe(true);
        expect(await gitIn(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe(spec.branchName);
      }
      // test3 is new to the task: cloned at its base, on the task's branch, with no hidden ref.
      const third = path.join(workspace, "test3");
      expect(await gitIn(third, "rev-parse", "--abbrev-ref", "HEAD")).toBe(spec.branchName);
      expect(await gitIn(third, "rev-parse", "HEAD")).toBe(await upstream().refSha("ostra-test/test3", "refs/heads/main"));
      await expect(gitIn(third, "rev-parse", "--verify", "--quiet", `refs/ostra/wip/${spec.taskId}`)).rejects.toThrow();
    },

    /** The git proxy takes the task's own branch in each repo, and refuses another task's in either. */
    proxyRefusesOtherBranch: async (): Promise<void> => {
      const h = await runner();
      const spec = taskOn(h, fakeMarker("silent"));
      h.dispatch(spec);
      await waitFor(h, spec, "turn.started");
      const workspace = workspaceOf(h, spec);
      const other = "ostra/0196f1a0-another-task-work";
      const home = await mkdtemp(path.join(os.tmpdir(), "ostra-repos-git-"));
      const globalConfig = path.join(home, "gitconfig");
      await writeFile(globalConfig, "");
      // As the agent's git would: the checkout's own config (the proxy's address), nothing of this machine's.
      const env = { PATH: process.env["PATH"] ?? "", ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}), HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
      const push = (cwd: string, ref: string): Promise<{ readonly code: number; readonly stderr: string }> =>
        new Promise((resolve) => {
          execFile("git", ["-c", "user.name=Agent", "-c", "user.email=agent@example.com", "push", "origin", `HEAD:${ref}`], { cwd, env, windowsHide: true }, (error, _stdout, stderr) => {
            resolve({ code: error === null ? 0 : 1, stderr });
          });
        });
      try {
        for (const name of ["test1", "test2"]) {
          const checkout = path.join(workspace, name);
          await writeFile(path.join(checkout, `${name}-agent.txt`), "the agent's own commit\n");
          await run("git", ["-c", "user.name=Agent", "-c", "user.email=agent@example.com", "add", "-A"], { cwd: checkout, env });
          await run("git", ["-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "--quiet", "--no-verify", "-m", "agent"], { cwd: checkout, env });
          const refused = await push(checkout, `refs/heads/${other}`);
          expect(refused.code).not.toBe(0);
          expect(refused.stderr).toContain("ostra: only the task's branch and its hidden ref can be pushed");
          expect(await upstream().refSha(`ostra-test/${name}`, `refs/heads/${other}`)).toBeNull();
          // The task's own branch goes through, in each repo, with that repo's token.
          const allowed = await push(checkout, `refs/heads/${spec.branchName}`);
          expect(allowed.stderr).not.toContain("remote rejected");
          expect(allowed.code).toBe(0);
          expect(await upstream().treeFiles(`ostra-test/${name}`, `refs/heads/${spec.branchName}`)).toContain(`${name}-agent.txt`);
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
      await h.waitForAck(h.stop(spec));
    },

    /** Each repo is cloned with its own token: a token the code host refuses for test2 fails test2's clone, by name. */
    ownTokenPerRepo: async (): Promise<void> => {
      const h = await runner();
      const spec = taskOn(h, fakeMarker("say"), ["test1", "test2"], { test2: "ghs_aTokenTheCodeHostDoesNotKnow0123456789" });
      // The upstream is the file's: this task's requests are the ones from here on.
      const from = upstream().requests.length;
      h.dispatch(spec);
      await waitFor(h, spec, "session.crashed");
      const [crashed] = h.ofKind(spec, "session.crashed");
      expect(crashed?.error).toContain("cloning ostra-test/test2 through the git proxy failed");
      // test1 came first, with its own token, and was cloned: the code host took every request of its
      // clone and sent its objects, before test2's first. Not the workspace: a box that never got
      // ready is released as the session ends, right after `session.crashed` (ADR 0039).
      const seen = upstream()
        .requests.slice(from)
        .map((request) => ({ repo: request.repo, endpoint: request.endpoint, authorized: request.authorized }));
      const firstOfTest2 = seen.findIndex((request) => request.repo === "ostra-test/test2");
      expect(firstOfTest2, JSON.stringify(seen)).toBeGreaterThan(0);
      const ofTest1 = seen.slice(0, firstOfTest2);
      expect(ofTest1).toContainEqual({ repo: "ostra-test/test1", endpoint: "git-upload-pack", authorized: true });
      expect(ofTest1.filter((request) => request.repo !== "ostra-test/test1" || !request.authorized)).toEqual([]);
      // Then test2, with its own token, which the code host refused; and nothing after it.
      expect(seen.slice(firstOfTest2).filter((request) => request.repo !== "ostra-test/test2" || request.authorized)).toEqual([]);
    },

    /** Each task's workspace holds its own repos and nothing of another task's; the agent starts at its own. */
    containment: async (): Promise<void> => {
      const h = await runner();
      const a = taskOn(h, fakeMarker("silent"));
      const b = taskOn(h, fakeMarker("silent"), ["test1"]);
      h.dispatch(a);
      h.dispatch(b);
      await waitFor(h, a, "turn.started");
      await waitFor(h, b, "turn.started");
      const listed = async (dir: string): Promise<readonly string[]> => (await readdir(dir)).filter((name) => !name.startsWith(".")).sort();
      const workspaceA = workspaceOf(h, a);
      const workspaceB = workspaceOf(h, b);
      expect(await listed(workspaceA)).toEqual(["test1", "test2"]);
      expect(await listed(workspaceB)).toEqual(["test1"]);
      expect(path.relative(workspaceA, workspaceB).startsWith("..")).toBe(true);
      expect(path.relative(workspaceB, workspaceA).startsWith("..")).toBe(true);
      // Each checkout is on its own task's branch.
      expect(await gitIn(path.join(workspaceA, "test1"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(a.branchName);
      expect(await gitIn(path.join(workspaceB, "test1"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(b.branchName);
      // Task a's agent starts at its workspace's root; task b's, with one repo, in its checkout.
      const cwds = h.launches.map((launch) => launch.cwd);
      expect(cwds).toContain(workspaceA);
      expect(cwds).toContain(path.join(workspaceB, "test1"));
      await h.waitForAck(h.stop(a));
      await h.waitForAck(h.stop(b));
    },

    /** Instructions that list other folders than the spec's repos: the session crashes before anything is cloned. */
    foldersMustMatch: async (): Promise<void> => {
      const h = await runner();
      const spec = taskOn(h, fakeMarker("say"));
      const [first, second] = spec.repos;
      if (first === undefined || second === undefined) {
        throw new Error("two repos");
      }
      const wrong: TaskSpec = { ...spec, agent: { ...spec.agent, instructions: reposSection([first, { ...second, checkoutDir: "elsewhere" }], spec.branchName) } };
      credentialsFor(h, wrong);
      h.dispatch(wrong);
      await waitFor(h, wrong, "session.crashed");
      expect(h.ofKind(wrong, "session.crashed")[0]?.error).toBe("the agent's instructions list the folders test1, elsewhere, but the task's repos are in test1, test2");
      expect(h.launches).toHaveLength(0);
      expect(await exists(path.join(workspaceOf(h, wrong), "test1"))).toBe(false);
    },
  };
};
