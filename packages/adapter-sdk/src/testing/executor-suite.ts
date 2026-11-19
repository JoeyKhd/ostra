import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { boxIdSchema, checkIdSchema, projectIdSchema, runnerLimits, snapshotIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec, TaskSpecCheck } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { AgentLaunch } from "../agent/base.ts";
import type { BoxRef, BuildSnapshotInput, CreatedBox, ExecutorAdapter, PrepareCacheInput, TaskProxies } from "../executor/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The cases every executor passes (ADR 0025, ADR 0029), so a task behaves the same on every one:
// a box's lifecycle, the agent's stdio, and that stopping a task leaves no process behind.

export type ExecutorFixture = {
  /** A spec whose repos the executor can check out through `proxies.gitBaseUrl`. */
  readonly spec: TaskSpec;
  readonly proxies: TaskProxies;
  /** A spec whose setup script exits with a non-zero code. `null` skips that case. */
  readonly failingSetupSpec: TaskSpec | null;
  /** A process that writes back each line it reads on stdin. */
  readonly echoLaunch: (box: CreatedBox) => AgentLaunch;
  /**
   * ADR 0029's case: a process that starts a detached helper, writes the helper's PID to a file,
   * and exits at once, so the helper's parent is gone. The suite stops the task and checks the
   * helper is gone.
   */
  readonly detachedHelper: HelperCase;
  /**
   * Ticket 42's second case: the same, with a helper that also clears its environment, so it
   * carries no marker. The recorded gap of a `process-tree` unit; `job-object`, `cgroup` and
   * `container` pass it.
   */
  readonly cleanEnvHelper: HelperCase;
  /**
   * Cases the adapter can't pass yet on this platform, each with its reason. A listed case is
   * expected to fail, and the suite fails if it starts passing, so the gap is noticed when it closes.
   */
  readonly knownGaps?: { readonly detachedHelper?: string; readonly cleanEnvHelper?: string; readonly workInProgress?: string };
  /**
   * Milestone 2: a box's first repo's checkout, to make work in progress in and read it back.
   * Absent, the work-in-progress cases are skipped.
   */
  readonly workInProgress?: {
    readonly checkout: (box: CreatedBox) => WorkspaceFiles;
    /** Two files the repo's default branch has. */
    readonly trackedFiles: readonly [string, string];
  };
  /**
   * Milestone 3 (F-054): check commands in this executor's language (a command line on the real
   * executors, JavaScript on the tiny one). Absent: the check cases are skipped.
   */
  readonly checks?: {
    /** Exits 0. */
    readonly passing: string;
    /** Exits 3. */
    readonly failing: string;
    /** Runs for a minute. */
    readonly slow: string;
    /** Prints its environment's variables as one JSON object. */
    readonly printsEnv: string;
    /** Prints `first line`, then more than 20 KiB, then `the last line`. */
    readonly noisy: string;
  };
  /** Milestone 3 (F-051): a snapshot build for an `image` executor; absent, the case is skipped. */
  readonly snapshot?: Omit<BuildSnapshotInput, "onOutput" | "signal">;
  /** Milestone 3 (F-051): the host cache's inputs for a project, for a `host-cache` executor; absent, the case is skipped. */
  readonly cache?: (projectId: string) => PrepareCacheInput;
};

/** A checkout's files, as a person in the box would touch them. Paths are relative to the checkout. */
export type WorkspaceFiles = {
  readonly write: (file: string, content: string) => Promise<void>;
  readonly remove: (file: string) => Promise<void>;
  /** `null` when the file isn't there. */
  readonly read: (file: string) => Promise<string | null>;
  /** `git add` of one file. */
  readonly stage: (file: string) => Promise<void>;
  /** `git status --porcelain` lines, `XY path`. */
  readonly status: () => Promise<readonly string[]>;
};

/** A checkout on this machine, as the suite's `workInProgress.checkout` reads it (`host`, and a box's task volume in tests). */
export const localWorkspaceFiles = (checkout: string): WorkspaceFiles => {
  const git = (args: readonly string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile("git", [...args], { cwd: checkout, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(checkout) }, windowsHide: true }, (error, stdout) => {
        if (error === null) {
          resolve(stdout);
        } else {
          reject(new Error(`git ${args[0] ?? ""} failed`));
        }
      });
    });
  const at = (file: string): string => path.join(checkout, ...file.split("/"));
  return {
    write: async (file, content) => {
      await mkdir(path.dirname(at(file)), { recursive: true });
      await writeFile(at(file), content);
    },
    remove: async (file) => {
      await rm(at(file), { force: true });
    },
    read: async (file) => {
      try {
        return await readFile(at(file), "utf8");
      } catch {
        return null;
      }
    },
    stage: async (file) => {
      await git(["add", "--", file]);
    },
    status: async () => (await git(["status", "--porcelain=v1", "--untracked-files=all"])).split(/\r?\n/).filter((line) => line !== ""),
  };
};

/** A process that leaves a helper behind, and how the suite finds and ends that helper. */
export type HelperCase = {
  readonly launch: (box: CreatedBox) => AgentLaunch;
  /** The helper's PID, once the process has written it. */
  readonly readPid: (box: CreatedBox) => Promise<number | null>;
  readonly isAlive: (pid: number) => Promise<boolean>;
  /** Kills the helper after the case, whatever its outcome, so no test leaves one running. */
  readonly kill: (pid: number) => Promise<void>;
};

let boxCounter = 0;
const newBox = (): BoxRef => {
  boxCounter += 1;
  return {
    taskId: taskIdSchema.parse(`contract-task-${String(boxCounter)}`),
    boxId: boxIdSchema.parse(`contract-box-${String(boxCounter)}`),
  };
};

const waitFor = async (check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

const pollFor = async <T>(read: () => Promise<T | null>, timeoutMs: number): Promise<T | null> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null || Date.now() >= deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const readLine = (stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      stream.off("data", onData);
      reject(new Error("no line from the agent's stdout in time"));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end !== -1) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve(buffer.slice(0, end).replace(/\r$/, ""));
      }
    };
    stream.on("data", onData);
  });

/** Boxes start processes and wait for them: each case gets this long. */
const CASE_TIMEOUT_MS = 60_000;

export const defineExecutorContractSuite = (options: ContractSuiteOptions<ExecutorAdapter, ExecutorFixture>): void => {
  describe(`executor contract: ${options.name}`, () => {
    const subject = useSubject(options);

    defineCommonCases(subject, "executor", {
      isolation: "string",
      services: "boolean",
      boxSizes: "boolean",
      snapshots: "string",
      processContainment: "string",
    });

    /** A box, prepared. With `sameTaskAs`, a fresh box of that box's task, as a reopen gets. */
    const createAndPrepare = async (spec: TaskSpec, sameTaskAs?: BoxRef): Promise<{ readonly box: BoxRef; readonly created: CreatedBox }> => {
      const { adapter, fixture } = subject();
      const fresh = newBox();
      const box = sameTaskAs === undefined ? fresh : { taskId: sameTaskAs.taskId, boxId: fresh.boxId };
      const created = await adapter.create({ ...box, spec, proxies: fixture.proxies });
      if (!created.ok) {
        throw new Error(`create failed: ${created.error.message}`);
      }
      const prepared = await adapter.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
      if (!prepared.ok) {
        throw new Error(`prepare failed: ${prepared.error.message}`);
      }
      return { box, created: created.value };
    };

    it("takes a box through create, prepare, the agent, stop and release", async () => {
      const { adapter, fixture } = subject();
      const box = newBox();
      const created = await adapter.create({ ...box, spec: fixture.spec, proxies: fixture.proxies });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const output: string[] = [];
      const prepared = await adapter.prepare({
        box,
        spec: fixture.spec,
        secrets: [],
        onSetupOutput: (_stream, text) => {
          output.push(text);
        },
      });
      expect(prepared.ok).toBe(true);
      expect(await adapter.state(box)).toEqual({ ok: true, value: "ready" });

      const agent = await adapter.startAgent(box, fixture.echoLaunch(created.value));
      expect(agent.ok).toBe(true);
      if (agent.ok) {
        const line = readLine(agent.value.stdout, 10_000);
        agent.value.stdin.write("ping\n");
        expect(await line).toBe("ping");
      }

      expect(await adapter.stop({ box, graceMs: 1000 })).toEqual({ ok: true, value: undefined });
      expect(await adapter.state(box)).toEqual({ ok: true, value: "stopped" });
      expect(await adapter.release(box, "requested")).toEqual({ ok: true, value: undefined });
      expect(await adapter.state(box)).toEqual({ ok: true, value: "released" });
    }, CASE_TIMEOUT_MS);

    it("lists the workspace root's names, a file left beside the repos included (ticket 44)", async () => {
      const { adapter, fixture } = subject();
      const { box, created } = await createAndPrepare(fixture.spec);
      await writeFile(path.join(created.workspaceDir, "left-beside.md"), "x\n");
      const listed = await adapter.listWorkspaceRoot(box);
      expect(listed.ok).toBe(true);
      const names = listed.ok ? listed.value : [];
      expect(names).toContain("left-beside.md");
      // Names only, top level only: a file inside a folder isn't one of them.
      expect(names.some((name) => name.includes("/") || name.includes("\\"))).toBe(false);
      await adapter.release(box, "requested");
      expect((await adapter.listWorkspaceRoot(box)).ok).toBe(false);
    }, CASE_TIMEOUT_MS);

    it("refuses to start an agent in a released box", async () => {
      const { adapter, fixture } = subject();
      const { box, created } = await createAndPrepare(fixture.spec);
      await adapter.release(box, "requested");
      const agent = await adapter.startAgent(box, fixture.echoLaunch(created));
      expect(agent.ok).toBe(false);
    }, CASE_TIMEOUT_MS);

    it("reports a failing setup script by its exit code, not as an error", async (context) => {
      const { adapter, fixture } = subject();
      if (fixture.failingSetupSpec === null) {
        context.skip();
        return;
      }
      const box = newBox();
      await adapter.create({ ...box, spec: fixture.failingSetupSpec, proxies: fixture.proxies });
      const prepared = await adapter.prepare({
        box,
        spec: fixture.failingSetupSpec,
        secrets: [],
        onSetupOutput: () => undefined,
      });
      expect(prepared.ok && prepared.value.setup !== null && prepared.value.setup.exitCode !== 0, JSON.stringify(prepared)).toBe(true);
      await adapter.release(box, "requested");
    }, CASE_TIMEOUT_MS);

    const helperCase = async (pick: (fixture: ExecutorFixture) => HelperCase): Promise<void> => {
      const { adapter, fixture } = subject();
      const helper = pick(fixture);
      const { box, created } = await createAndPrepare(fixture.spec);
      const agent = await adapter.startAgent(box, helper.launch(created));
      expect(agent.ok).toBe(true);
      const pid = await pollFor(() => helper.readPid(created), 10_000);
      let gone = false;
      try {
        expect(pid, "the helper wrote its PID").not.toBeNull();
        if (pid === null) {
          return;
        }
        await adapter.stop({ box, graceMs: 500 });
        // Each check of a PID still in use may list the machine's processes (seconds under load).
        gone = await waitFor(async () => !(await helper.isAlive(pid)), 15_000);
        expect(gone, "a detached helper outlived the task's stop").toBe(true);
      } finally {
        // Only a helper still seen alive: a dead one's PID may already be another process's.
        if (pid !== null && !gone) {
          await helper.kill(pid);
        }
        await adapter.release(box, "requested");
      }
    };

    // ---------- milestone 2: work in progress (ADR 0039) ----------

    const wipCase = async (body: () => Promise<void>, context: { readonly skip: () => void; readonly annotate: (note: string) => Promise<unknown> }): Promise<void> => {
      const { fixture } = subject();
      if (fixture.workInProgress === undefined) {
        context.skip();
        return;
      }
      const reason = fixture.knownGaps?.workInProgress;
      if (reason === undefined) {
        await body();
        return;
      }
      await context.annotate(`known gap: ${reason}`);
      let failed = false;
      try {
        await body();
      } catch {
        failed = true;
      }
      expect(failed, `the known gap is closed (${reason}): remove it from knownGaps`).toBe(true);
    };

    it("saves untracked, staged, unstaged and deleted work to the hidden ref, without ignored files, and a fresh box restores it", async (context) => {
      await wipCase(async () => {
        const { adapter, fixture } = subject();
        const wip = fixture.workInProgress;
        if (wip === undefined) return;
        const [modified, deleted] = wip.trackedFiles;
        const first = await createAndPrepare(fixture.spec);
        const files = wip.checkout(first.created);
        await files.write(".gitignore", "ignored.log\n");
        await files.write("ignored.log", "not saved");
        await files.write("untracked.txt", "new and untracked");
        await files.write("staged.txt", "new and staged");
        await files.stage("staged.txt");
        await files.write(modified, "changed, not staged");
        await files.remove(deleted);
        const saved = await adapter.saveWorkInProgress({ box: first.box, turnOrdinal: 1 });
        if (!saved.ok) throw new Error(`saveWorkInProgress: ${saved.error.message}`);
        const repo = saved.value[0];
        if (repo?.sha === null || repo?.sha === undefined || repo.baseSha === null) throw new Error("no hidden ref was saved");
        await adapter.release(first.box, "requested");

        const second = await createAndPrepare(fixture.spec, first.box);
        const restored = await adapter.restoreWorkInProgress({
          box: second.box,
          refs: [{ repoId: repo.repoId, sha: repo.sha, baseSha: repo.baseSha }],
        });
        expect(restored).toEqual({ ok: true, value: [{ repoId: repo.repoId, outcome: "applied" }] });
        const back = wip.checkout(second.created);
        expect(await back.read("untracked.txt")).toBe("new and untracked");
        expect(await back.read("staged.txt")).toBe("new and staged");
        expect(await back.read(modified)).toBe("changed, not staged");
        expect(await back.read(deleted)).toBeNull();
        expect(await back.read("ignored.log")).toBeNull();
        const status = await back.status();
        expect(status).toContain("A  staged.txt");
        expect(status).toContain("?? untracked.txt");
        await adapter.release(second.box, "requested");
      }, context);
    }, CASE_TIMEOUT_MS);

    it("replaces the hidden ref with each save, so a fresh box gets the last one", async (context) => {
      await wipCase(async () => {
        const { adapter, fixture } = subject();
        const wip = fixture.workInProgress;
        if (wip === undefined) return;
        const first = await createAndPrepare(fixture.spec);
        const files = wip.checkout(first.created);
        await files.write("turn.txt", "turn 1");
        const one = await adapter.saveWorkInProgress({ box: first.box, turnOrdinal: 1 });
        await files.write("turn.txt", "turn 2");
        const two = await adapter.saveWorkInProgress({ box: first.box, turnOrdinal: 2 });
        if (!one.ok || !two.ok) throw new Error("a save failed");
        const repo = two.value[0];
        if (repo?.sha === null || repo?.sha === undefined || repo.baseSha === null) throw new Error("no hidden ref was saved");
        expect(repo.sha).not.toBe(one.value[0]?.sha);
        await adapter.release(first.box, "requested");
        const second = await createAndPrepare(fixture.spec, first.box);
        await adapter.restoreWorkInProgress({ box: second.box, refs: [{ repoId: repo.repoId, sha: repo.sha, baseSha: repo.baseSha }] });
        expect(await wip.checkout(second.created).read("turn.txt")).toBe("turn 2");
        await adapter.release(second.box, "requested");
      }, context);
    }, CASE_TIMEOUT_MS);


    /** A case that is a known gap must fail, so the gap is noticed when it closes. */
    const withGap = async (reason: string | undefined, annotate: (text: string) => Promise<unknown>, run: () => Promise<void>): Promise<void> => {
      if (reason === undefined) {
        await run();
        return;
      }
      await annotate(`known gap: ${reason}`);
      let failed = false;
      try {
        await run();
      } catch {
        failed = true;
      }
      expect(failed, `the known gap is closed (${reason}): remove it from knownGaps`).toBe(true);
    };

    // ---------- milestone 3 (F-054, F-051, F-094) ----------

    const check = (id: string, command: string, repoId: TaskSpecCheck["repoId"], timeoutSeconds = 30): TaskSpecCheck => ({
      checkId: checkIdSchema.parse(id),
      name: id,
      command,
      repoId,
      timeoutSeconds,
    });

    /** A prepared box whose spec has these checks, its repos' folders there, and a folder for the output. */
    const boxForChecks = async (checks: readonly TaskSpecCheck[]) => {
      const { fixture } = subject();
      const spec: TaskSpec = { ...fixture.spec, checks: [...checks] };
      const { box, created } = await createAndPrepare(spec);
      for (const repo of spec.repos) {
        await mkdir(path.join(created.workspaceDir, repo.checkoutDir), { recursive: true });
      }
      const outputDir = await mkdtemp(path.join(tmpdir(), "ostra-checks-"));
      return { box, spec, outputDir };
    };

    it("F-054: runs the checks in order: one passes, one fails, one times out, each with its exit and time", async (context) => {
      const { adapter, fixture } = subject();
      const commands = fixture.checks;
      if (commands === undefined) {
        context.skip();
        return;
      }
      const repoId = fixture.spec.repos[0]?.repoId ?? null;
      const { box, spec, outputDir } = await boxForChecks([
        check("passing", commands.passing, null),
        check("failing", commands.failing, repoId),
        check("slow", commands.slow, null, 1),
      ]);
      try {
        const ran = await adapter.runChecks(box, { spec, changedRepoIds: repoId === null ? [] : [repoId], env: {}, outputDir });
        if (!ran.ok) throw new Error(ran.error.message);
        expect(ran.value.map((result) => [result.checkId, result.status, result.exitCode])).toEqual([
          ["passing", "passed", 0],
          ["failing", "failed", 3],
          ["slow", "timed-out", null],
        ]);
        const slow = ran.value[2];
        expect(slow?.durationMs).toBeGreaterThanOrEqual(900);
        expect(slow?.durationMs).toBeLessThan(20_000);
        expect(ran.value.every((result) => result.outputPath !== null)).toBe(true);
      } finally {
        await adapter.release(box, "requested");
        await rm(outputDir, { recursive: true, force: true });
      }
    }, CASE_TIMEOUT_MS);

    it("F-054: a check that names a repo the turn didn't change doesn't run; one with no repo always does", async (context) => {
      const { adapter, fixture } = subject();
      const commands = fixture.checks;
      const repoId = fixture.spec.repos[0]?.repoId;
      if (commands === undefined || repoId === undefined) {
        context.skip();
        return;
      }
      const { box, spec, outputDir } = await boxForChecks([check("repo-check", commands.passing, repoId), check("root-check", commands.passing, null)]);
      try {
        const ran = await adapter.runChecks(box, { spec, changedRepoIds: [], env: {}, outputDir });
        expect(ran.ok && ran.value.map((result) => result.checkId)).toEqual(["root-check"]);
      } finally {
        await adapter.release(box, "requested");
        await rm(outputDir, { recursive: true, force: true });
      }
    }, CASE_TIMEOUT_MS);

    it("F-054: a check gets the environment's variables, and no model key, code host token or runner variable", async (context) => {
      const { adapter, fixture } = subject();
      const commands = fixture.checks;
      if (commands === undefined) {
        context.skip();
        return;
      }
      const planted = { OSTRA_SUITE_RUNNER_SECRET: "runner-secret-suite", GITHUB_TOKEN: "ghs_suite_token_value", ANTHROPIC_API_KEY: "sk-ant-suite" };
      const before = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
      Object.assign(process.env, planted);
      const { box, spec, outputDir } = await boxForChecks([check("env", commands.printsEnv, null)]);
      try {
        const ran = await adapter.runChecks(box, {
          spec,
          changedRepoIds: [],
          // A token named as an environment variable still never reaches a check.
          env: { CHECK_SUITE_VAR: "kept-value", OPENAI_API_KEY: "sk-suite-model-key", GH_TOKEN: "gho_suite" },
          outputDir,
        });
        if (!ran.ok) throw new Error(ran.error.message);
        const tail = ran.value[0]?.outputTail ?? "";
        expect(ran.value[0]?.status).toBe("passed");
        expect(tail).toContain("CHECK_SUITE_VAR");
        expect(tail).toContain("kept-value");
        for (const leaked of ["runner-secret-suite", "ghs_suite_token_value", "sk-ant-suite", "sk-suite-model-key", "gho_suite", "OSTRA_SUITE_RUNNER_SECRET"]) {
          expect(tail.includes(leaked), `${leaked} reached a check`).toBe(false);
        }
      } finally {
        for (const [name, value] of Object.entries(before)) {
          if (value === undefined) {
            Reflect.deleteProperty(process.env, name);
          } else {
            process.env[name] = value;
          }
        }
        await adapter.release(box, "requested");
        await rm(outputDir, { recursive: true, force: true });
      }
    }, CASE_TIMEOUT_MS);

    it("F-054: output over the cap is cut to its tail, and the whole is in its file", async (context) => {
      const { adapter, fixture } = subject();
      const commands = fixture.checks;
      if (commands === undefined) {
        context.skip();
        return;
      }
      const { box, spec, outputDir } = await boxForChecks([check("noisy", commands.noisy, null)]);
      try {
        const ran = await adapter.runChecks(box, { spec, changedRepoIds: [], env: {}, outputDir });
        if (!ran.ok) throw new Error(ran.error.message);
        const result = ran.value[0];
        expect(Buffer.byteLength(result?.outputTail ?? "", "utf8")).toBeLessThanOrEqual(runnerLimits.checkOutputTailMaxBytes);
        expect(result?.outputTail.trimEnd().endsWith("the last line")).toBe(true);
        expect(result?.outputTail).not.toContain("first line");
        const whole = await readFile(result?.outputPath ?? "", "utf8");
        expect(whole).toContain("first line");
        expect(whole).toContain("the last line");
      } finally {
        await adapter.release(box, "requested");
        await rm(outputDir, { recursive: true, force: true });
      }
    }, CASE_TIMEOUT_MS);

    it("F-094: an executor without services refuses a spec that has any, and makes no box", async () => {
      const { adapter, fixture } = subject();
      if (adapter.capabilities.services) {
        return;
      }
      const box = newBox();
      const spec: TaskSpec = { ...fixture.spec, services: [{ name: "postgres", image: "postgres:17", port: 5432, variables: [], healthCheck: null }] };
      expect(await adapter.create({ ...box, spec, proxies: fixture.proxies })).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect((await adapter.state(box)).ok && (await adapter.state(box))).not.toEqual({ ok: true, value: "ready" });
    }, CASE_TIMEOUT_MS);

    it("F-051: an executor refuses to start a box from a snapshot of a kind it doesn't keep", async () => {
      const { adapter, fixture } = subject();
      const box = newBox();
      if (adapter.capabilities.snapshots !== "image") {
        const spec: TaskSpec = {
          ...fixture.spec,
          snapshot: { kind: "image", snapshotId: snapshotIdSchema.parse("suite-snapshot"), imageRef: "ostra-snapshot:suite", digest: `sha256:${"c".repeat(64)}` },
        };
        expect(await adapter.create({ ...box, spec, proxies: fixture.proxies })).toMatchObject({ ok: false, error: { code: "unsupported" } });
      }
      if (adapter.capabilities.snapshots !== "host-cache") {
        const spec: TaskSpec = { ...fixture.spec, snapshot: { kind: "host-cache", cacheKey: "suite-project" } };
        expect(await adapter.create({ ...newBox(), spec, proxies: fixture.proxies })).toMatchObject({ ok: false, error: { code: "unsupported" } });
      }
      if (adapter.capabilities.snapshots === "none") {
        expect(await adapter.hasSnapshot(snapshotIdSchema.parse("suite-snapshot"))).toMatchObject({ ok: false, error: { code: "unsupported" } });
      }
    }, CASE_TIMEOUT_MS);

    it("F-051: a snapshot image is built, found and used by a box", async (context) => {
      const { adapter, fixture } = subject();
      if (adapter.capabilities.snapshots !== "image" || fixture.snapshot === undefined) {
        context.skip();
        return;
      }
      const built = await adapter.buildSnapshot({ ...fixture.snapshot, onOutput: () => undefined });
      if (!built.ok) throw new Error(built.error.message);
      if (built.value.outcome !== "built") throw new Error(`the build failed: ${built.value.reason}`);
      const kept = await adapter.hasSnapshot(fixture.snapshot.snapshotId);
      expect(kept).toEqual({ ok: true, value: { imageRef: built.value.imageRef, imageDigest: built.value.imageDigest } });
      const spec: TaskSpec = {
        ...fixture.spec,
        snapshot: { kind: "image", snapshotId: fixture.snapshot.snapshotId, imageRef: built.value.imageRef, digest: built.value.imageDigest },
      };
      const { box } = await createAndPrepare(spec);
      expect(await adapter.state(box)).toEqual({ ok: true, value: "ready" });
      await adapter.release(box, "requested");
    }, 10 * CASE_TIMEOUT_MS);

    it("F-051: the host cache is reused by the same project's next task, and never by another project's", async (context) => {
      const { adapter, fixture } = subject();
      if (adapter.capabilities.snapshots !== "host-cache" || fixture.cache === undefined) {
        context.skip();
        return;
      }
      const first = await adapter.prepareCache(fixture.cache(String(projectIdSchema.parse("suite-project-a"))));
      const again = await adapter.prepareCache(fixture.cache(String(projectIdSchema.parse("suite-project-a"))));
      const other = await adapter.prepareCache(fixture.cache(String(projectIdSchema.parse("suite-project-b"))));
      expect(first).toMatchObject({ ok: true, value: { reused: false } });
      expect(again).toMatchObject({ ok: true, value: { reused: true } });
      expect(other).toMatchObject({ ok: true, value: { reused: false } });
      if (again.ok && other.ok) {
        expect(again.value.dependencyCacheDir).not.toBe(other.value.dependencyCacheDir);
      }
    }, 5 * CASE_TIMEOUT_MS);

    it("stops every process of the task, a detached helper included (ADR 0029)", async (context) => {
      await withGap(subject().fixture.knownGaps?.detachedHelper, (text) => context.annotate(text), () => helperCase((fixture) => fixture.detachedHelper));
    }, CASE_TIMEOUT_MS);

    it("stops a detached helper that also cleared its environment (ticket 42)", async (context) => {
      await withGap(subject().fixture.knownGaps?.cleanEnvHelper, (text) => context.annotate(text), () => helperCase((fixture) => fixture.cleanEnvHelper));
    }, CASE_TIMEOUT_MS);
  });
};
