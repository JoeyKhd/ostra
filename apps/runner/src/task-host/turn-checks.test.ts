import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@ostra/adapter-sdk";
import type { BoxRef } from "@ostra/adapter-sdk";
import { fakeMarker, startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { HostExecutor } from "@ostra/adapter-executor-host";
import { blobIdSchema, boxIdSchema, checkIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskEvent, TaskSpec, TaskSpecCheck } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { GIT_TOKEN, MODEL_TOKEN, startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { runTurnChecks } from "./turn-checks.ts";

// Milestone 3's ticket 32 (F-054, ADR 0052, Q188): the environment's checks after a turn with
// changes, between the commit and the push, on `host` with the real executor, the fake agent and
// the git upstream stub behind the task's own git proxy.

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("turn-checks");
  await shared.upstream.createRepo("ostra-test/test2", { "README.md": "# test2\n" });
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const node = `'${process.execPath.replaceAll("\\", "/")}'`;

const check = (id: string, command: string, extra: Partial<TaskSpecCheck> = {}): TaskSpecCheck => ({
  checkId: checkIdSchema.parse(id),
  name: `the ${id} check`,
  command,
  repoId: null,
  timeoutSeconds: 60,
  ...extra,
});

/** Each event's kind, with a check's ID or a pushed ref, so the order reads in one line. */
const trail = (events: readonly TaskEvent[]): readonly string[] =>
  events.flatMap((event) => {
    if (event.kind === "check.started" || event.kind === "check.finished") {
      return [`${event.kind}:${event.checkId}`];
    }
    if (event.kind === "git.pushed") {
      return [`git.pushed:${event.ref.startsWith("refs/heads/") ? "branch" : "hidden"}`];
    }
    return event.kind === "session.saved" ? ["session.saved"] : [];
  });

describe("checks after a turn (F-054)", () => {
  it("F-054/c2: two checks run in order after a turn with changes, with their output uploaded, and none after a turn without", async () => {
    harness = await startHarness(shared);
    const h = harness;
    const checks = [check("lint", "echo linting; echo the lint output"), check("unit", `${node} -e 'console.log("unit: " + require("node:fs").readFileSync("one.txt", "utf8"))'`, { repoId: taskSpecFixture.repos[0]?.repoId ?? null })];
    const { spec } = h.taskFor(fakeMarker("write", "one.txt"), { checks });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 120_000);

    // The commit, the two checks in the environment's order, then the push.
    expect(trail(h.eventsOf(spec))).toEqual([
      "check.started:lint",
      "check.finished:lint",
      "check.started:unit",
      "check.finished:unit",
      "git.pushed:branch",
      "git.pushed:hidden",
      "session.saved",
    ]);
    const started = h.ofKind(spec, "check.started");
    expect(started.map((event) => [event.name, event.repoId])).toEqual([
      ["the lint check", null],
      ["the unit check", spec.repos[0]?.repoId],
    ]);
    const finished = h.ofKind(spec, "check.finished");
    expect(finished.map((event) => [event.checkId, event.status, event.exitCode])).toEqual([
      ["lint", "passed", 0],
      ["unit", "passed", 0],
    ]);
    // The unit check ran in the repo's folder, on the turn's committed work.
    expect(finished[1]?.outputTail).toContain("unit: ");
    // Each full output is a blob of the task, named in its event.
    for (const [event, text] of [
      [finished[0], "the lint output"],
      [finished[1], "unit: "],
    ] as const) {
      const blobId = event?.outputBlobId;
      if (blobId === null || blobId === undefined) throw new Error("no output blob");
      const stored = h.server.blobs.get(blobIdSchema.parse(blobId));
      expect(stored?.purpose).toBe("check-output");
      expect(stored?.contentType).toBe("text/plain");
      expect(Buffer.from(stored?.bytes ?? []).toString("utf8")).toContain(text);
    }
    const [saved] = h.ofKind(spec, "session.saved");
    expect(saved?.checks).toEqual([
      { checkId: "lint", status: "passed" },
      { checkId: "unit", status: "passed" },
    ]);
    expect(saved?.repos[0]).toMatchObject({ ahead: true });

    // A turn that changes nothing runs no check and reports none.
    h.steer(spec, fakeMarker("remember", "kiwi"));
    await h.waitForKind(spec, "session.saved", 2, 120_000);
    expect(h.ofKind(spec, "check.started")).toHaveLength(2);
    expect(h.ofKind(spec, "session.saved")[1]).not.toHaveProperty("checks");

    // A check's output is never logged: neither line of it is in any log record.
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain("the lint output");
    expect(logged).not.toContain("unit: ");
  }, 300_000);

  it("F-054/c2: a failing check is reported and the push goes on", async () => {
    harness = await startHarness(shared);
    const h = harness;
    const { spec } = h.taskFor(fakeMarker("write", "failing.txt"), { checks: [check("tests", "echo 2 tests failed; exit 1")] });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 120_000);
    const [finished] = h.ofKind(spec, "check.finished");
    expect(finished).toMatchObject({ checkId: "tests", status: "failed", exitCode: 1 });
    expect(finished?.outputTail).toContain("2 tests failed");
    const [saved] = h.ofKind(spec, "session.saved");
    expect(saved?.checks).toEqual([{ checkId: "tests", status: "failed" }]);
    // Pushed all the same: the branch upstream is the turn's head, with the agent's file.
    const head = saved?.repos[0]?.headSha;
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await shared.upstream.refSha("ostra-test/test1", `refs/heads/${spec.branchName}`)).toBe(head);
    expect(await shared.upstream.treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`)).toContain("failing.txt");
  }, 300_000);

  it("F-054/c2: a check gets the environment's variables and the committed tree, never a model key or a git token, and what it leaves isn't pushed", async () => {
    harness = await startHarness(shared);
    const h = harness;
    const printEnv = `${node} -e 'process.stdout.write(JSON.stringify(process.env))'`;
    const { spec } = h.taskFor(fakeMarker("write", "env.txt"), {
      checks: [check("env", printEnv, { repoId: taskSpecFixture.repos[0]?.repoId ?? null }), check("leaves", "echo left > check-left.log")],
    });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 120_000);
    const [envCheck] = h.ofKind(spec, "check.finished");
    const blobId = envCheck?.outputBlobId;
    if (blobId === null || blobId === undefined) throw new Error("no output blob");
    const output = Buffer.from(h.server.blobs.get(blobIdSchema.parse(blobId))?.bytes ?? []).toString("utf8");
    const seen: unknown = JSON.parse(output);
    // The repo's variable (the fixture's NODE_ENV) is there; no credential and no runner variable is.
    expect(seen).toMatchObject({ NODE_ENV: "test", CI: "true" });
    expect(output).not.toContain(MODEL_TOKEN);
    expect(output).not.toContain(GIT_TOKEN);
    expect((typeof seen === "object" && seen !== null ? Object.keys(seen) : []).filter((name) => name.startsWith("OSTRA_") && name !== "OSTRA_TASK_UNIT")).toEqual([]);
    // What a check left in the working tree stays out of the pushed branch.
    const files = await shared.upstream.treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`);
    expect(files).toContain("env.txt");
    expect(files).not.toContain("check-left.log");
  }, 300_000);

  it("F-054/c2: in a two-repo task, a check naming the repo the turn didn't change doesn't run; one naming the changed repo and one with no repo do", async () => {
    harness = await startHarness(shared);
    const h = harness;
    const [first] = taskSpecFixture.repos;
    if (first === undefined) throw new Error("no fixture repo");
    const second = { ...first, repoId: repoIdSchema.parse("repo-test2"), fullName: "ostra-test/test2", cloneUrl: "https://github.com/ostra-test/test2.git", checkoutDir: "test2" };
    const { spec } = h.taskFor(fakeMarker("write", "test2/changed.txt"), {
      repos: [first, second],
      environment: { ...taskSpecFixture.environment, setupScript: null, repos: [...taskSpecFixture.environment.repos, { repoId: second.repoId, variables: [], files: [], envFile: ".env" }] },
      checks: [check("test1-only", "echo in test1", { repoId: first.repoId }), check("test2-only", "test -f changed.txt && echo in test2", { repoId: second.repoId }), check("root", "test -d test1 && test -d test2 && echo at the root")],
    });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 120_000);
    expect(trail(h.eventsOf(spec)).filter((item) => item.startsWith("check."))).toEqual([
      "check.started:test2-only",
      "check.finished:test2-only",
      "check.started:root",
      "check.finished:root",
    ]);
    expect(h.ofKind(spec, "check.finished").map((event) => event.status)).toEqual(["passed", "passed"]);
    expect(h.ofKind(spec, "session.saved")[0]?.checks).toEqual([
      { checkId: "test2-only", status: "passed" },
      { checkId: "root", status: "passed" },
    ]);
  }, 300_000);
});

describe("the checks' limits on host (F-054)", () => {
  let root = "";
  let executor: HostExecutor;
  let upstream: GitUpstream;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ostra-turn-checks-limits-"));
    upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
    await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
    executor = await HostExecutor.start({ dataDir: path.join(root, "runner") });
  }, 60_000);

  afterAll(async () => {
    await upstream.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  it("F-054/c2: a check past its timeout is timed out, and past the checks' total the rest are timed out without running", async () => {
    const box: BoxRef = { taskId: taskIdSchema.parse("task-turn-checks-limits"), boxId: boxIdSchema.parse("box-turn-checks-limits") };
    const checks = [
      check("slow", `${node} -e 'setTimeout(() => {}, 60000)'`, { timeoutSeconds: 1 }),
      check("after-the-total", "echo never"),
      check("also-after", "echo never"),
    ];
    const spec: TaskSpec = { ...taskSpecFixture, taskId: box.taskId, environment: { ...taskSpecFixture.environment, setupScript: null }, checks, checksTotalMinutes: 1 };
    const proxies = { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    if (!prepared.ok) throw new Error(prepared.error.message);
    // The total's clock: a minute passes while the slow check runs.
    let clock = 1_000_000;
    const events: TaskEvent[] = [];
    const uploads: string[] = [];
    const saved = await runTurnChecks(
      {
        executor: {
          runChecks: async (ref, input) => {
            const ran = await executor.runChecks(ref, input);
            clock += 61_000;
            return ran;
          },
        },
        link: {
          uploadBlob: (upload) => {
            uploads.push(Buffer.from(upload.bytes).toString("utf8"));
            return Promise.resolve({ ok: true, value: { blobId: blobIdSchema.parse(`blob-${String(uploads.length)}`), sha256: "0".repeat(64), size: upload.bytes.length } });
          },
        },
        emit: (event) => {
          events.push(event);
          return Promise.resolve();
        },
        logger: createLogger(() => undefined),
        now: () => clock,
      },
      { box, spec, changedRepoIds: [spec.repos[0]?.repoId ?? repoIdSchema.parse("none")], outputDir: path.join(root, "checks", "turn-1") },
    );
    expect(saved).toEqual([
      { checkId: "slow", status: "timed-out" },
      { checkId: "after-the-total", status: "timed-out" },
      { checkId: "also-after", status: "timed-out" },
    ]);
    const finished = events.filter((event) => event.kind === "check.finished");
    expect(finished.map((event) => [event.checkId, event.durationMs >= 900, event.durationMs < 30_000])).toEqual([
      ["slow", true, true],
      ["after-the-total", false, true],
      ["also-after", false, true],
    ]);
    expect(finished[1]).toMatchObject({ exitCode: null, outputBlobId: null, outputTail: "The checks' total time ran out before this one." });
    // Only the check that ran has an output to upload; nothing said "never".
    expect(uploads).toHaveLength(1);
    expect(uploads.join("")).not.toContain("never");
    await executor.release(box, "requested");
  }, 120_000);
});
