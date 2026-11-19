import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { AgentLaunch } from "../agent/base.ts";
import type { BoxRef, CreatedBox, ExecutorAdapter, TaskProxies } from "../executor/base.ts";
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
  readonly knownGaps?: { readonly detachedHelper?: string; readonly cleanEnvHelper?: string };
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
      snapshots: "boolean",
      processContainment: "string",
    });

    const createAndPrepare = async (spec: TaskSpec): Promise<{ readonly box: BoxRef; readonly created: CreatedBox }> => {
      const { adapter, fixture } = subject();
      const box = newBox();
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
      expect(await adapter.release(box)).toEqual({ ok: true, value: undefined });
      expect(await adapter.state(box)).toEqual({ ok: true, value: "released" });
    }, CASE_TIMEOUT_MS);

    it("refuses to start an agent in a released box", async () => {
      const { adapter, fixture } = subject();
      const { box, created } = await createAndPrepare(fixture.spec);
      await adapter.release(box);
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
      expect(prepared.ok && prepared.value.setup !== null && prepared.value.setup.exitCode !== 0).toBe(true);
      await adapter.release(box);
    }, CASE_TIMEOUT_MS);

    const helperCase = async (pick: (fixture: ExecutorFixture) => HelperCase): Promise<void> => {
      const { adapter, fixture } = subject();
      const helper = pick(fixture);
      const { box, created } = await createAndPrepare(fixture.spec);
      const agent = await adapter.startAgent(box, helper.launch(created));
      expect(agent.ok).toBe(true);
      const pid = await pollFor(() => helper.readPid(created), 10_000);
      try {
        expect(pid, "the helper wrote its PID").not.toBeNull();
        if (pid === null) {
          return;
        }
        await adapter.stop({ box, graceMs: 500 });
        const gone = await waitFor(async () => !(await helper.isAlive(pid)), 5_000);
        expect(gone, "a detached helper outlived the task's stop").toBe(true);
      } finally {
        if (pid !== null) {
          await helper.kill(pid);
        }
        await adapter.release(box);
      }
    };

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

    it("stops every process of the task, a detached helper included (ADR 0029)", async (context) => {
      await withGap(subject().fixture.knownGaps?.detachedHelper, (text) => context.annotate(text), () => helperCase((fixture) => fixture.detachedHelper));
    }, CASE_TIMEOUT_MS);

    it("stops a detached helper that also cleared its environment (ticket 42)", async (context) => {
      await withGap(subject().fixture.knownGaps?.cleanEnvHelper, (text) => context.annotate(text), () => helperCase((fixture) => fixture.cleanEnvHelper));
    }, CASE_TIMEOUT_MS);
  });
};
