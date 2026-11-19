import { execFile } from "node:child_process";
import { readdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HostExecutor } from "@ostra/adapter-executor-host";
import { createLogger, GIT_GUARD_ENV_NAMES, silentLogger } from "@ostra/adapter-sdk";
import type { AdapterResult, AgentLaunch, AgentProcess, BoxRef, LogRecord } from "@ostra/adapter-sdk";
import { FakeAgentAdapter, startAnthropicStub, startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream, StubServer } from "@ostra/adapter-sdk/testing";
import {
  boxIdSchema,
  runnerIdSchema,
  sessionIdSchema,
  taskCredentialsSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { RunnerEvent, TaskCredentials, TaskEvent, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startConnection } from "../connection/peer.ts";
import type { RunnerConnection } from "../connection/peer.ts";
import { makeCommand, startFakeGateway } from "../testing/fake-gateway.ts";
import type { FakeGateway } from "../testing/fake-gateway.ts";
import { startFakeServer } from "../testing/fake-server.ts";
import type { FakeServer } from "../testing/fake-server.ts";
import { createAgentRegistry } from "./agents.ts";
import type { AgentFactory } from "./agents.ts";
import { runnerServerLink } from "./server-link.ts";
import { createTaskHost } from "./task-host.ts";
import type { TaskHost } from "./task-host.ts";

// Ticket 21's "done when": dispatch → a PR-ready branch, stop → the hidden ref, crash → the hidden
// ref, every event stored once; and a search for the real credentials that finds none. In one
// process: the fake gateway, the scripted fake agent, the stub models, the real git proxy and key
// proxy, the host executor and the git upstream stub.

const runnerId = runnerIdSchema.parse("runner-task-host");
const ACCESS_TOKEN = "ostra-runner-task-host-access-token";
const MODEL_TOKEN = "sk-real-model-token-for-the-task-host-test";
const GIT_TOKEN = "ghs_realGitTokenForTheTaskHostTest0123456789";
const MCP_TOKEN = "ostra-mcp-real-runner-mcp-token-0123456789";

let root = "";
let upstream: GitUpstream;
let models: StubServer;
let server: FakeServer;
let gateway: FakeGateway;
let connection: RunnerConnection | undefined;
let host: TaskHost | undefined;
const logs: LogRecord[] = [];
let counter = 0;

/** Each agent launch the host executor was given, in order. */
const launches: AgentLaunch[] = [];

/** A host executor that records each agent launch it is given. */
const hostExecutorSpy = (executor: HostExecutor): HostExecutor => {
  const startAgent = executor.startAgent.bind(executor);
  executor.startAgent = (box: BoxRef, launch: AgentLaunch): Promise<AdapterResult<AgentProcess>> => {
    launches.push(launch);
    return startAgent(box, launch);
  };
  return executor;
};

/** `git` as the agent would run it, in its launch environment: stdout, or the failure's text. */
const gitAs = (launch: AgentLaunch, args: readonly string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile("git", [...args], { cwd: launch.cwd, env: { ...launch.env, PATH: process.env["PATH"] ?? "" }, windowsHide: true }, (error, stdout, stderr) => {
      resolve(error === null ? stdout : `${stdout}${stderr}`);
    });
  });

const agents: Readonly<Record<string, AgentFactory>> = {
  "fake-acp-agent-rich": (driver) => new FakeAgentAdapter("rich", driver),
};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-task-host-"));
  // It refuses a workflow change as GitHub does for an App without `workflows` (F-006).
  upstream = await startGitUpstream(path.join(root, "upstream"), { refuseWorkflowChanges: true });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
  upstream.tokens.set(GIT_TOKEN, Date.now() + 3_600_000);
  models = await startAnthropicStub({ realKey: MODEL_TOKEN, models: ["stub-model"], brain: () => ({ text: "ok" }) });
}, 60_000);

afterAll(async () => {
  await models.close();
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

afterEach(async () => {
  await host?.shutdown();
  await connection?.stop();
  await gateway.close();
  await server.close();
  host = undefined;
  connection = undefined;
});

type Setup = { readonly dataDir: string; readonly dispatch: (spec: TaskSpec) => void };

const start = async (): Promise<Setup> => {
  counter += 1;
  const dataDir = path.join(root, `runner-${String(counter)}`);
  server = await startFakeServer();
  server.accessTokens.set(ACCESS_TOKEN, runnerId);
  gateway = startFakeGateway(server);
  const tokens = { get: () => Promise.resolve({ ok: true as const, token: ACCESS_TOKEN, expiresAt: Date.now() + 600_000 }), invalidate: () => undefined };
  const holder: { connection: RunnerConnection | undefined } = { connection: undefined };
  const logger = createLogger((record) => logs.push(record));
  const taskHost = createTaskHost({
    link: runnerServerLink({
      serverUrl: server.url,
      tokens,
      connection: {
        openSession: (ref) => {
          if (holder.connection === undefined) {
            throw new Error("not connected");
          }
          return holder.connection.openSession(ref);
        },
        statusChanged: () => {
          holder.connection?.statusChanged();
        },
      },
    }),
    executor: hostExecutorSpy(new HostExecutor({ dataDir }, { logger, clock: { now: () => Date.now() } })),
    agents: createAgentRegistry(agents),
    logger,
    listenHost: "127.0.0.1",
    stopGraceMs: 1_000,
    capacity: 1,
    executorKind: "host",
    labels: [],
    gitUpstreamUrl: (cloneUrl) => cloneUrl.replace("https://github.com", upstream.origin),
  });
  host = taskHost;
  holder.connection = await startConnection({
    serverUrl: server.url,
    peer: { kind: "runner", runnerId },
    tokens,
    dataDir,
    handlers: taskHost.handlers,
    status: taskHost.status,
    logger: silentLogger,
    timers: { backoffMinMs: 5, backoffMaxMs: 20, checkMs: 10, liveTextIntervalMs: 20 },
    hooks: {
      onStaleLease: (sessionId) => {
        taskHost.abandon(sessionId);
      },
    },
  });
  connection = holder.connection;
  await gateway.waitFor(() => gateway.connected());
  return {
    dataDir,
    dispatch: (spec) => {
      gateway.sendCommand(
        makeCommand({
          seq: counter * 10,
          id: `dispatch-${String(counter)}`,
          notAfter: Date.now() + 120_000,
          kind: "dispatch",
          body: { taskId: spec.taskId, sessionId: spec.sessionId, boxId: boxIdSchema.parse(`box-${String(counter)}`), leaseEpoch: spec.leaseEpoch },
        }),
      );
    },
  };
};

const taskFor = (prompt: string, setupScript: string | null = null): { readonly spec: TaskSpec; readonly credentials: TaskCredentials } => {
  const taskId = taskIdSchema.parse(`0196f1a0-task-${String(counter)}-${String(Date.now())}`);
  const spec: TaskSpec = {
    ...taskSpecFixture,
    taskId,
    sessionId: sessionIdSchema.parse(`session-${String(counter)}-${String(Date.now())}`),
    branchName: `ostra/task-${String(counter)}-add-a-file`,
    prompt,
    title: "Add a file",
    agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-rich", apiFormat: "anthropic-messages" },
    environment: { ...taskSpecFixture.environment, setupScript },
  };
  const credentials = taskCredentialsSchema.parse({
    taskId,
    leaseEpoch: spec.leaseEpoch,
    model: { baseUrl: models.baseUrl, apiFormat: "anthropic-messages", authScheme: "x-api-key", token: MODEL_TOKEN },
    repos: spec.repos.map((repo) => ({ repoId: repo.repoId, gitToken: GIT_TOKEN, expiresAt: Date.now() + 3_600_000 })),
    secrets: [],
    mcpToken: MCP_TOKEN,
  });
  server.tasks.set(taskId, { spec, credentials });
  return { spec, credentials };
};

const eventsOf = (spec: TaskSpec): readonly RunnerEvent[] =>
  [...(gateway.stored.get(spec.sessionId)?.values() ?? [])].sort((a, b) => a.sessionSeq - b.sessionSeq);

const kinds = (spec: TaskSpec): readonly TaskEvent["kind"][] => eventsOf(spec).map((item) => item.event.kind);

const waitForKind = (spec: TaskSpec, kind: TaskEvent["kind"], timeoutMs = 60_000): Promise<void> =>
  gateway.waitFor(() => kinds(spec).includes(kind), timeoutMs);

const everyEventOnce = (): boolean => [...gateway.received.values()].every((count) => count === 1);

/** A refine or review task: its agent's git fetches through the proxy, and every push is refused (ADR 0028). */
const fetchOnly = async (kind: "refine" | "review"): Promise<void> => {
  const { dispatch } = await start();
  launches.length = 0;
  const { spec, credentials } = taskFor("[[fake:silent]]");
  const readOnly: TaskSpec = { ...spec, kind };
  server.tasks.set(spec.taskId, { spec: readOnly, credentials });
  dispatch(readOnly);
  await waitForKind(readOnly, "turn.started");
  const launch = launches.at(-1);
  if (launch === undefined) {
    throw new Error("no agent was started");
  }
  expect(await gitAs(launch, ["fetch", "origin"])).not.toMatch(/fatal|error/i);
  await writeFile(path.join(launch.cwd, "read-only.txt"), "x\n");
  await gitAs(launch, ["add", "read-only.txt"]);
  await gitAs(launch, ["commit", "--quiet", "-m", `a ${kind} task may not push`]);
  const before = upstream.requests.filter((request) => request.endpoint === "git-receive-pack").length;
  const pushed = await gitAs(launch, ["push", "origin", `HEAD:refs/heads/${readOnly.branchName}`]);
  expect(pushed).toMatch(/403|can fetch but not push/);
  expect(await upstream.refSha("ostra-test/test1", `refs/heads/${readOnly.branchName}`)).toBeNull();
  expect(upstream.requests.filter((request) => request.endpoint === "git-receive-pack").length).toBe(before);
};

describe("the task host", () => {
  it("F-090, F-078: runs a dispatch to a PR-ready branch, committing what the agent left with the bot and the trailer, and every event is stored once", async () => {
    const { dataDir, dispatch } = await start();
    // One repo: the agent starts in its checkout (F-025), so a relative path lands in the repo.
    const made = taskFor("[[fake:write CONTRIBUTING.md]]", "echo setting up\n");
    // Two members prompted it: each gets a trailer (F-078).
    const spec: TaskSpec = { ...made.spec, coAuthors: [...made.spec.coAuthors, { name: "Bea Member", email: "bea@example.com" }] };
    server.tasks.set(spec.taskId, { spec, credentials: made.credentials });
    dispatch(spec);
    await waitForKind(spec, "session.ended");
    await gateway.waitFor(() => host?.running().length === 0);
    const events = eventsOf(spec).map((item) => item.event);
    expect(kinds(spec)).toEqual(
      expect.arrayContaining([
        "environment.setup_started",
        "environment.setup_output",
        "environment.setup_finished",
        "turn.started",
        "tool.called",
        "agent.message",
        "turn.ended",
        "git.pushed",
        "session.ended",
      ]),
    );
    expect(kinds(spec).indexOf("turn.started")).toBeLessThan(kinds(spec).indexOf("turn.ended"));
    expect(kinds(spec).at(-1)).toBe("session.ended");
    const ended = events.find((event) => event.kind === "session.ended");
    expect(ended).toEqual({ kind: "session.ended", outcome: "with-changes", repos: [{ repoId: spec.repos[0]?.repoId, ahead: true }] });
    const pushes = events.flatMap((event) => (event.kind === "git.pushed" ? [event.ref] : []));
    expect(pushes).toEqual([`refs/heads/${spec.branchName}`, `refs/ostra/wip/${spec.taskId}`]);
    expect(await upstream.treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`)).toContain("CONTRIBUTING.md");
    const message = await upstream.commitMessage("ostra-test/test1", `refs/heads/${spec.branchName}`);
    expect(message).toContain("Co-authored-by: Admin <admin@example.com>");
    expect(message).toContain("Co-authored-by: Bea Member <bea@example.com>");
    // The App's bot authored and committed it.
    const bot = `${spec.gitIdentity.name} <${spec.gitIdentity.email}>`;
    expect(await upstream.commitPeople("ostra-test/test1", `refs/heads/${spec.branchName}`)).toEqual({ author: bot, committer: bot });
    expect(gateway.acks.flatMap((ack) => ack.results)).toEqual(expect.arrayContaining([expect.objectContaining({ result: "accepted" })]));
    expect(everyEventOnce()).toBe(true);
    // The workspace is released.
    expect(await readdir(path.join(dataDir, "tasks"))).toEqual([]);
  }, 120_000);

  it("starts the agent in the repo's checkout, so a relative path in the prompt lands in the repo (F-025)", async () => {
    const { dispatch } = await start();
    // The prompt names no repo, as a member's would not: the fake agent writes the path relative to
    // the folder its session opened on.
    const { spec } = taskFor("[[fake:write docs/numbers.md]]");
    dispatch(spec);
    await waitForKind(spec, "session.ended");
    const ended = eventsOf(spec).find((item) => item.event.kind === "session.ended")?.event;
    expect(ended).toMatchObject({ outcome: "with-changes" });
    expect(await upstream.treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`)).toContain("docs/numbers.md");
  }, 120_000);

  it("F-065: ends a session with no changes as without-changes, pushing nothing", async () => {
    const { dispatch } = await start();
    const { spec } = taskFor("[[fake:say]]");
    dispatch(spec);
    await waitForKind(spec, "session.ended");
    const ended = eventsOf(spec).find((item) => item.event.kind === "session.ended")?.event;
    expect(ended).toMatchObject({ outcome: "without-changes" });
    expect(kinds(spec)).not.toContain("git.pushed");
    expect(await upstream.refSha("ostra-test/test1", `refs/heads/${spec.branchName}`)).toBeNull();
  }, 120_000);

  it("F-006: a change to .github/workflows/ fails on the code host, and the task says why", async () => {
    const { dispatch } = await start();
    const { spec } = taskFor("[[fake:write .github/workflows/ci.yml]]");
    dispatch(spec);
    await waitForKind(spec, "session.crashed");
    const crashed = eventsOf(spec).find((item) => item.event.kind === "session.crashed")?.event;
    const error = crashed?.kind === "session.crashed" ? crashed.error : "";
    expect(error).toContain("pushing the task's work failed");
    expect(error).toContain("GitHub refused the push because it changes a file in .github/workflows/");
    expect(error).toContain("doesn't have the workflows permission");
    expect(kinds(spec)).not.toContain("session.ended");
    expect(await upstream.refSha("ostra-test/test1", `refs/heads/${spec.branchName}`)).toBeNull();
  }, 120_000);

  it("F-025: stops a running turn: the agent's turn ends cancelled, and no session.ended is sent", async () => {
    const { dataDir, dispatch } = await start();
    const { spec } = taskFor("[[fake:silent]]");
    dispatch(spec);
    await waitForKind(spec, "turn.started");
    await writeFile(path.join(dataDir, "tasks", spec.taskId, "workspace", "test1", "half-done.txt"), "unfinished\n");
    gateway.sendCommand(
      makeCommand({
        seq: counter * 10 + 1,
        id: `stop-${String(counter)}`,
        notAfter: Date.now() + 120_000,
        kind: "stop",
        body: { taskId: spec.taskId, sessionId: spec.sessionId, leaseEpoch: spec.leaseEpoch, reason: "requested" },
      }),
    );
    await gateway.waitFor(() => gateway.acks.some((ack) => ack.results.some((item) => item.id === `stop-${String(counter)}`)), 60_000);
    const stopAck = gateway.acks.flatMap((ack) => ack.results).find((item) => item.id === `stop-${String(counter)}`);
    expect(stopAck?.result).toBe("done");
    const ended = eventsOf(spec).find((item) => item.event.kind === "turn.ended")?.event;
    expect(ended).toMatchObject({ stopReason: "cancelled" });
    await gateway.waitFor(() => host?.running().length === 0);
    expect(kinds(spec)).not.toContain("session.ended");
    expect(kinds(spec)).not.toContain("session.crashed");
    expect(everyEventOnce()).toBe(true);
  }, 120_000);

  it("F-025: a stopped task's branch and hidden ref hold its unfinished work, and stay after its workspace is released", async () => {
    const { dataDir, dispatch } = await start();
    const { spec } = taskFor("[[fake:silent]]");
    dispatch(spec);
    await waitForKind(spec, "turn.started");
    await writeFile(path.join(dataDir, "tasks", spec.taskId, "workspace", "test1", "half-done.txt"), "unfinished\n");
    gateway.sendCommand(
      makeCommand({
        seq: counter * 10 + 1,
        id: `stop-${String(counter)}`,
        notAfter: Date.now() + 120_000,
        kind: "stop",
        body: { taskId: spec.taskId, sessionId: spec.sessionId, leaseEpoch: spec.leaseEpoch, reason: "requested" },
      }),
    );
    await gateway.waitFor(() => gateway.acks.some((ack) => ack.results.some((item) => item.id === `stop-${String(counter)}`)), 60_000);
    // The run ends and its workspace is released; what it pushed stays upstream, ready to reopen.
    await gateway.waitFor(() => host?.running().length === 0);
    expect(await readdir(path.join(dataDir, "tasks"))).toEqual([]);
    const branch = `refs/heads/${spec.branchName}`;
    const hiddenRef = `refs/ostra/wip/${spec.taskId}`;
    const pushes = eventsOf(spec).flatMap((item) => (item.event.kind === "git.pushed" ? [item.event.ref] : []));
    expect(pushes).toEqual([branch, hiddenRef]);
    expect(await upstream.treeFiles("ostra-test/test1", branch)).toContain("half-done.txt");
    expect(await upstream.treeFiles("ostra-test/test1", hiddenRef)).toContain("half-done.txt");
    expect(await upstream.refSha("ostra-test/test1", hiddenRef)).toBe(await upstream.refSha("ostra-test/test1", branch));
    expect(await upstream.commitMessage("ostra-test/test1", hiddenRef)).toContain("(stopped: unfinished work)");
  }, 120_000);

  it("pushes the hidden ref and sends session.crashed when the agent crashes mid-turn", async () => {
    const { dispatch } = await start();
    // The setup leaves an untracked file: work the crash must not lose.
    const { spec } = taskFor("[[fake:crash]]", "echo 'set up' > setup-output.txt\n");
    dispatch(spec);
    await waitForKind(spec, "session.crashed");
    const crashed = eventsOf(spec).find((item) => item.event.kind === "session.crashed")?.event;
    expect(crashed?.kind === "session.crashed" ? crashed.error : "").toMatch(/exited mid-turn/);
    expect(kinds(spec)).toContain("turn.failed");
    expect(kinds(spec)).not.toContain("session.ended");
    expect(await upstream.treeFiles("ostra-test/test1", `refs/ostra/wip/${spec.taskId}`)).toContain("setup-output.txt");
    expect(everyEventOnce()).toBe(true);
  }, 120_000);

  it("starts the agent with the task's git config as the only one, whatever a repo's variables say", async () => {
    const { dataDir, dispatch } = await start();
    launches.length = 0;
    const { spec } = taskFor("[[fake:silent]]");
    const [repo] = spec.repos;
    if (repo === undefined) {
      throw new Error("the spec has a repo");
    }
    // A repo variable cannot move the git guard: not the global config, not the system one.
    const variables = GIT_GUARD_ENV_NAMES.map((name) => ({ name, value: "hostile", availableDuringSetup: false }));
    const hostile: TaskSpec = { ...spec, environment: { ...spec.environment, repos: [{ repoId: repo.repoId, variables, files: [], envFile: ".env" }] } };
    const credentials = server.tasks.get(spec.taskId)?.credentials;
    if (credentials === undefined) {
      throw new Error("no credentials");
    }
    server.tasks.set(spec.taskId, { spec: hostile, credentials });
    dispatch(hostile);
    await waitForKind(hostile, "turn.started");
    const launch = launches.at(-1);
    if (launch === undefined) {
      throw new Error("no agent was started");
    }
    const gitConfig = path.join(dataDir, "tasks", (await readdir(path.join(dataDir, "tasks")))[0] ?? "", "git", "config");
    expect(launch.env["GIT_CONFIG_GLOBAL"]).toBe(gitConfig);
    expect(launch.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(launch.env["GCM_INTERACTIVE"]).toBe("never");
    expect(launch.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(launch.env["GIT_CONFIG_COUNT"]).toBe("1");
    expect(launch.env["GIT_CONFIG_KEY_0"]).toBe("credential.helper");
    expect(launch.env["GIT_CONFIG_VALUE_0"]).toBe("");
    // As the agent runs git: no system config, and no global one but the task's own,
    // and no credential helper but the empty one.
    const scopes = await gitAs(launch, ["config", "--list", "--show-scope", "--show-origin"]);
    const lines = scopes.split(/\r?\n/).filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.startsWith("system\t"))).toEqual([]);
    expect(lines.some((line) => /^global\tfile:.*git.+config/.test(line))).toBe(true);
    expect((await gitAs(launch, ["config", "--get-all", "credential.helper"])).trim()).toBe("");
    expect(await gitAs(launch, ["config", "--get-regexp", "^url[.].*[.]insteadof$"])).toContain("https://github.com/");
  }, 120_000);

  it("F-090: the agent's own git clones, fetches and pushes through the proxy, which adds the repo's token; its push to main is refused", async () => {
    const { dispatch } = await start();
    launches.length = 0;
    const { spec } = taskFor("[[fake:silent]]");
    dispatch(spec);
    await waitForKind(spec, "turn.started");
    const launch = launches.at(-1);
    if (launch === undefined) {
      throw new Error("no agent was started");
    }
    // The checkout's remote is the proxy, on loopback behind its secret path, with no credential in it.
    const origin = (await gitAs(launch, ["remote", "get-url", "origin"])).trim();
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/ostra-test\/test1\.git$/);
    expect(origin).not.toContain(GIT_TOKEN);
    const fetched = await gitAs(launch, ["fetch", "origin"]);
    expect(fetched).not.toMatch(/fatal|error/i);
    const before = upstream.requests.length;
    // A fresh clone by GitHub's URL, as an agent would type it.
    const cloneDir = path.join(root, `agent-clone-${String(counter)}`);
    expect(await gitAs(launch, ["clone", "--quiet", "https://github.com/ostra-test/test1.git", cloneDir])).not.toMatch(/fatal/i);
    expect(await readFile(path.join(cloneDir, "README.md"), "utf8")).toBe("# test1\n");
    await writeFile(path.join(launch.cwd, "by-the-agent.txt"), "committed by the agent\n");
    await gitAs(launch, ["add", "by-the-agent.txt"]);
    await gitAs(launch, ["commit", "--quiet", "-m", "the agent's own commit"]);
    const head = (await gitAs(launch, ["rev-parse", "HEAD"])).trim();
    const pushed = await gitAs(launch, ["push", "origin", `HEAD:refs/heads/${spec.branchName}`]);
    expect(pushed).not.toMatch(/rejected|fatal/);
    expect(await upstream.refSha("ostra-test/test1", `refs/heads/${spec.branchName}`)).toBe(head);
    // Every request the agent's git made reached the upstream with the task's token, added by the proxy.
    const made = upstream.requests.slice(before).filter((request) => request.repo === "ostra-test/test1");
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((request) => request.authorized)).toBe(true);
    const mainBefore = await upstream.refSha("ostra-test/test1", "refs/heads/main");
    const toMain = await gitAs(launch, ["push", "origin", "HEAD:main"]);
    expect(toMain).toContain("ostra: only the task's branch and its hidden ref can be pushed");
    expect(await upstream.refSha("ostra-test/test1", "refs/heads/main")).toBe(mainBefore);
  }, 120_000);

  it("F-090: a refine task's proxy lets the agent's git fetch but not push", async () => {
    await fetchOnly("refine");
  }, 120_000);

  it("F-090: a review task's proxy lets the agent's git fetch but not push", async () => {
    await fetchOnly("review");
  }, 120_000);

  it("F-089: the agent gets a base URL that points at the key proxy and a fake key valid for its one task, never the real key", async () => {
    const { dispatch } = await start();
    const endpointOf = (launch: AgentLaunch | undefined): { readonly baseUrl: string; readonly key: string } => {
      const baseUrl = launch?.env["FAKE_AGENT_BASE_URL"];
      const key = launch?.env["FAKE_AGENT_API_KEY"];
      if (baseUrl === undefined || key === undefined) {
        throw new Error("the agent's launch has no model endpoint");
      }
      return { baseUrl, key };
    };
    const callWith = (baseUrl: string, key: string) =>
      fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "stub-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });

    // The first task: its agent runs one short turn, then its session ends.
    launches.length = 0;
    const first = taskFor("[[fake:say]]");
    dispatch(first.spec);
    await waitForKind(first.spec, "turn.started");
    const one = endpointOf(launches.at(-1));
    // The proxy on the runner, at the provider's own base path, not the provider itself.
    const proxied = new URL(one.baseUrl);
    const provider = new URL(models.baseUrl);
    expect(proxied.hostname).toBe("127.0.0.1");
    expect(proxied.origin).not.toBe(provider.origin);
    expect(proxied.pathname).toBe(provider.pathname);
    // A fake key: not the real one, and the real one is nowhere in the agent's environment.
    expect(one.key).toMatch(/^ostra-fake-/);
    expect(one.key).not.toBe(MODEL_TOKEN);
    expect(JSON.stringify(launches.at(-1)?.env)).not.toContain(MODEL_TOKEN);
    // While the task runs, the fake key works: the provider sees the real one.
    const before = models.calls.length;
    const answer = await callWith(one.baseUrl, one.key);
    expect(answer.status).toBe(200);
    await answer.text();
    expect(models.calls.slice(before).map((call) => call.authOk)).toEqual([true]);
    await waitForKind(first.spec, "session.ended");
    await gateway.waitFor(() => host?.running().length === 0);

    // The second task gets its own key: the first task's is refused there.
    const second = taskFor("[[fake:silent]]");
    gateway.sendCommand(
      makeCommand({
        seq: counter * 10 + 1,
        id: `dispatch-${String(counter)}-second`,
        notAfter: Date.now() + 120_000,
        kind: "dispatch",
        body: { taskId: second.spec.taskId, sessionId: second.spec.sessionId, boxId: boxIdSchema.parse(`box-${String(counter)}-second`), leaseEpoch: second.spec.leaseEpoch },
      }),
    );
    await waitForKind(second.spec, "turn.started");
    const two = endpointOf(launches.at(-1));
    expect(two.key).not.toBe(one.key);
    const callsBefore = models.calls.length;
    const refused = await callWith(two.baseUrl, one.key);
    expect(refused.status).toBe(401);
    await refused.text();
    expect(models.calls.length).toBe(callsBefore);
    const accepted = await callWith(two.baseUrl, two.key);
    expect(accepted.status).toBe(200);
    await accepted.text();
  }, 120_000);

  it("refuses to start an agent whose environment would hold a real credential", async () => {
    const { dispatch } = await start();
    const { spec } = taskFor("[[fake:say]]");
    const [repo] = spec.repos;
    if (repo === undefined) {
      throw new Error("the spec has a repo");
    }
    // A variable whose value is the model's real token: the agent would get it in its environment.
    const leaky: TaskSpec = {
      ...spec,
      environment: {
        ...spec.environment,
        repos: [{ repoId: repo.repoId, variables: [{ name: "LEAKED", value: MODEL_TOKEN, availableDuringSetup: false }], files: [], envFile: ".env" }],
      },
    };
    const credentials = server.tasks.get(spec.taskId)?.credentials;
    if (credentials === undefined) {
      throw new Error("no credentials");
    }
    server.tasks.set(spec.taskId, { spec: leaky, credentials });
    dispatch(leaky);
    await waitForKind(leaky, "session.crashed");
    const crashed = eventsOf(leaky).find((item) => item.event.kind === "session.crashed")?.event;
    expect(crashed?.kind === "session.crashed" ? crashed.error : "").toContain("the model provider's token");
    expect(kinds(leaky)).not.toContain("turn.started");
  }, 120_000);

  it("F-089: reports a model provider's rate limit as an event with its retry time, once for a burst of 429s", async () => {
    const { dispatch } = await start();
    const limited = await startAnthropicStub({
      realKey: MODEL_TOKEN,
      models: ["stub-model"],
      brain: () => ({ error: { status: 429, message: "slow down", retryAfterSeconds: 7 } }),
    });
    try {
      const { spec, credentials } = taskFor("[[fake:silent]]");
      server.tasks.set(spec.taskId, { spec, credentials: { ...credentials, model: { ...credentials.model, baseUrl: limited.baseUrl } } });
      launches.length = 0;
      dispatch(spec);
      await waitForKind(spec, "turn.started");
      const env = launches.at(-1)?.env ?? {};
      const baseUrl = env["FAKE_AGENT_BASE_URL"];
      const key = env["FAKE_AGENT_API_KEY"];
      if (baseUrl === undefined || key === undefined) {
        throw new Error("the agent's launch has no model endpoint");
      }
      // The agent retries into the limit: three calls, each answered 429 through the key proxy.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const answer = await fetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: "stub-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
        });
        expect(answer.status).toBe(429);
        await answer.text();
      }
      await waitForKind(spec, "provider.rate_limited");
      const reports = eventsOf(spec).flatMap((item) => (item.event.kind === "provider.rate_limited" ? [item.event] : []));
      expect(reports).toEqual([{ kind: "provider.rate_limited", providerId: spec.agent.providerId, retryAfterSeconds: 7 }]);
      expect(everyEventOnce()).toBe(true);
    } finally {
      await limited.close();
    }
  }, 120_000);

  it("F-090: keeps every real credential out of the agent's environment, the task root, the event stream and the logs", async () => {
    const { dataDir, dispatch } = await start();
    const { spec } = taskFor("[[fake:silent]]");
    launches.length = 0;
    dispatch(spec);
    await waitForKind(spec, "turn.started");
    // While the agent runs: every file the runner wrote, the task root included.
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          files.push(full);
        }
      }
    };
    await walk(dataDir);
    expect(files.some((file) => file.includes(`${path.sep}tasks${path.sep}`))).toBe(true);
    // The agent's own process: no real credential in any variable it was launched with.
    const launchEnv = JSON.stringify(launches.at(-1)?.env ?? null);
    expect(launchEnv).not.toBe("null");
    for (const secret of [MODEL_TOKEN, GIT_TOKEN, MCP_TOKEN, ACCESS_TOKEN]) {
      expect(launchEnv.includes(secret), `${secret.slice(0, 6)}… in the agent's environment`).toBe(false);
    }
    for (const file of files) {
      const content = await readFile(file, "utf8").catch(() => "");
      for (const secret of [MODEL_TOKEN, GIT_TOKEN, MCP_TOKEN]) {
        expect(content.includes(secret), `${secret.slice(0, 6)}… in ${file}`).toBe(false);
      }
    }
    await host?.shutdown();
    const everything = JSON.stringify([eventsOf(spec), gateway.liveText, logs]);
    for (const secret of [MODEL_TOKEN, GIT_TOKEN, MCP_TOKEN, ACCESS_TOKEN]) {
      expect(everything.includes(secret)).toBe(false);
    }
  }, 120_000);
});

describe("the environment prepares the box (F-050)", () => {
  it("F-050: the box is prepared by the environment before the agent starts, and the setup's output goes out as the task's events", async () => {
    const { dispatch } = await start();
    launches.length = 0;
    const { spec, credentials } = taskFor("[[fake:silent]]", 'echo "prepared with $NODE_ENV"\necho "$NODE_ENV" > prepared.txt\necho "a warning" >&2\n');
    const [repo] = spec.environment.repos;
    if (repo === undefined) throw new Error("the fixture has a repo");
    const prepared: TaskSpec = { ...spec, environment: { ...spec.environment, repos: [{ ...repo, files: [{ path: "config/app.json", content: "{}\n" }] }] } };
    server.tasks.set(spec.taskId, {
      spec: prepared,
      credentials: { ...credentials, secrets: [{ repoId: repo.repoId, entries: [{ kind: "file", path: "config/secret.json", content: "{\"k\":1}\n", availableDuringSetup: false }] }] },
    });
    dispatch(prepared);
    await waitForKind(prepared, "turn.started");

    // Everything the environment puts in the workspace is there when the agent starts.
    const launch = launches.at(-1);
    if (launch === undefined) throw new Error("no agent was started");
    expect(await readFile(path.join(launch.cwd, "prepared.txt"), "utf8")).toBe("test\n");
    expect(await readFile(path.join(launch.cwd, "config", "app.json"), "utf8")).toBe("{}\n");
    expect(await readFile(path.join(launch.cwd, "config", "secret.json"), "utf8")).toBe('{"k":1}\n');
    expect(await readFile(path.join(launch.cwd, ".env"), "utf8")).toContain("NODE_ENV=test");

    // The setup's log goes out as the task's events, before the agent's turn.
    const order = kinds(prepared);
    expect(order.indexOf("environment.setup_started")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("environment.setup_started")).toBeLessThan(order.indexOf("environment.setup_output"));
    expect(order.lastIndexOf("environment.setup_output")).toBeLessThan(order.indexOf("environment.setup_finished"));
    expect(order.indexOf("environment.setup_finished")).toBeLessThan(order.indexOf("turn.started"));
    const events = eventsOf(prepared).map((item) => item.event);
    const out = (stream: "stdout" | "stderr"): string =>
      events.flatMap((event) => (event.kind === "environment.setup_output" && event.stream === stream ? [event.text] : [])).join("");
    expect(out("stdout")).toContain("prepared with test");
    expect(out("stderr")).toContain("a warning");
    expect(events.find((event) => event.kind === "environment.setup_finished")).toMatchObject({ exitCode: 0 });
  }, 120_000);
});
