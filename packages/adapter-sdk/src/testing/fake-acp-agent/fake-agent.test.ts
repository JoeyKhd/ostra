import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { repoFullNameSchema, turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";

import { effortModelOf } from "../../agent/base.ts";
import type { AgentSession } from "../../agent/base.ts";

import { sampleMemoryBlock } from "../agent-memory-cases.ts";
import type { PrepareLaunchInput } from "../../agent/base.ts";
import type { AgentFixture } from "../agent-suite.ts";
import { memoryNoteFixtures, startFakeMemoryCore } from "../fake-memory-core.ts";
import type { FakeMemoryCore } from "../fake-memory-core.ts";
import { startGitUpstream } from "../git-upstream.ts";
import type { GitUpstream } from "../git-upstream.ts";
import { runAgentSuite } from "../run-agent-suite.ts";
import { runAgentCommand, spawnAgentProcess } from "../spawn-agent.ts";
import { startStubModelServer } from "../stub-models/server.ts";
import type { StubServer } from "../stub-models/server.ts";
import { FAKE_AGENT_MCP_TOOL, FAKE_AGENT_REPO_CONFIG, FAKE_AGENT_UNKNOWN_NOTIFICATION, FAKE_AGENT_UNKNOWN_NOTIFICATION_ENV, fakeMarker, fakeToolArgs } from "./agent.ts";
import type { FakeAgentProfile } from "./agent.ts";
import { FakeAgentAdapter } from "./fake-agent-adapter.ts";
import type { FakeAgentEffort, FakeAgentMemory, FakeAgentParity } from "./fake-agent-adapter.ts";

// The agent contract suite, against the scripted fake ACP agent in both profiles, as a real child
// process through ostra's ACP driver (ticket 10).

const roots: string[] = [];
const cores: FakeMemoryCore[] = [];
const stubs: StubServer[] = [];
const upstreams: GitUpstream[] = [];
afterAll(async () => {
  await Promise.all(upstreams.map((upstream) => upstream.close()));
  await Promise.all(cores.map((core) => core.close()));
  await Promise.all(stubs.map((stub) => stub.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Milestone 4: the two repos every fixture's workspace holds side by side, each a git repo. */
const REPOS = ["test1", "test2"] as const;
const run = promisify(execFile);

/** Milestone 6: a commit in a repo folder, with a fixed author, as a test makes one. */
const commitAll = async (dir: string, message: string): Promise<string> => {
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=ostra@example.test", "-c", "user.name=ostra", "commit", "-q", "--allow-empty", "-m", message], { cwd: dir });
  return (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
};

/** Milestone 6 (ticket 04): the team cases' set-ups, each made in the workspace when its case runs. */
const teamProbes = (root: string, workspaceDir: string, memory: FakeAgentMemory): NonNullable<AgentFixture["team"]> => ({
  askAndContinue: fakeMarker("ask-and-continue"),
  readOnlyPush: async () => {
    // The fetch-only upstream stands where a refine or review task's git proxy is.
    const upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false, fetchOnly: true });
    upstreams.push(upstream);
    await upstream.createRepo("test-org/readonly", { "README.md": "# readonly\n" });
    await run("git", ["clone", "-q", upstream.cloneUrl("test-org/readonly"), "readonly"], { cwd: workspaceDir });
    await writeFile(path.join(workspaceDir, "readonly", "change.txt"), "a change\n");
    await commitAll(path.join(workspaceDir, "readonly"), "A change the task can't push");
    return {
      prompt: fakeMarker("git-push", "readonly"),
      pushesReceived: () => Promise.resolve(upstream.requests.filter((request) => request.endpoint === "git-receive-pack").length),
    };
  },
  reviewCheckout: async () => {
    // Two repos, each checked out at its PR's head: one at its newest commit, one at an older one.
    const heads: { folder: string; sha: string }[] = [];
    for (const [folder, back] of [["review-a", false], ["review-b", true]] as const) {
      const dir = path.join(workspaceDir, folder);
      await mkdir(dir, { recursive: true });
      await run("git", ["init", "-q"], { cwd: dir });
      const first = await commitAll(dir, "first");
      const second = await commitAll(dir, "second");
      if (back) await run("git", ["checkout", "-q", "--detach", first], { cwd: dir });
      heads.push({ folder, sha: back ? first : second });
    }
    return { prompt: fakeMarker("heads", heads.map((head) => head.folder).join(" ")), heads };
  },
  ...(memory === "mcp"
    ? {
        tools: {
          start: async (tools) => {
            const core = await startFakeMemoryCore({
              taskId: fixtureIds.task,
              taskToken: "ostra-task-fake-token",
              mcpBearer: "fake-mcp-bearer",
              notes: memoryNoteFixtures,
              tools,
              repos: [{ repoId: fixtureIds.repo, fullName: repoFullNameSchema.parse("test-org/test1") }],
            });
            cores.push(core);
            return { core, mcp: { url: core.mcpUrl, bearer: core.mcpBearer } };
          },
          list: fakeMarker("memory-tools"),
          submitDraft: (draft) => fakeMarker("submit-draft", fakeToolArgs(draft)),
          submitReview: (review) => fakeMarker("submit-review", fakeToolArgs(review)),
          proposeEnvironment: (proposal) => fakeMarker("propose-environment", fakeToolArgs(proposal)),
          repo: repoFullNameSchema.parse("test-org/test1"),
        },
      }
    : {}),
  writeFiles: async () => {
    await mkdir(path.join(workspaceDir, "onboarding"), { recursive: true });
    await run("git", ["init", "-q"], { cwd: path.join(workspaceDir, "onboarding") });
    return { prompt: (files) => fakeMarker("write", files.join(" ")), repo: "onboarding" };
  },
});

/** The fake's key for its one task: the stub endpoint, standing where the key proxy is, takes it. */
const TASK_KEY = "ostra-fake-key-for-this-task";

const fixtureFor = async (memory: FakeAgentMemory = "mcp", parity: FakeAgentParity = {}): Promise<AgentFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "ostra-fake-agent-"));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(path.join(agentDir, "tmp"), { recursive: true });
  for (const repo of REPOS) {
    await mkdir(path.join(workspaceDir, repo), { recursive: true });
    await run("git", ["init", "-q"], { cwd: path.join(workspaceDir, repo) });
  }
  // Milestone 4: the fake core and its MCP stand-in, for an agent that takes the memory tools.
  const core =
    memory === "mcp"
      ? await startFakeMemoryCore({ taskId: fixtureIds.task, taskToken: "ostra-task-fake-token", mcpBearer: "fake-mcp-bearer", notes: memoryNoteFixtures })
      : undefined;
  if (core !== undefined) cores.push(core);
  // Milestone 7 (ticket 03): a stub endpoint where the key proxy would be, counting every call.
  const stub = await startStubModelServer({ format: "openai-compatible", realKey: TASK_KEY, models: ["stub-model"], brain: () => ({ text: "Noted." }) });
  stubs.push(stub);
  const base: PrepareLaunchInput = {
    taskId: fixtureIds.task,
    sessionId: fixtureIds.session,
    workspaceDir,
    agentDir,
    model: {
      endpointModelId: "stub-model",
      apiFormat: "openai-compatible",
      baseUrl: stub.baseUrl,
      placeholderKey: TASK_KEY,
    },
    mcp: core === undefined ? { url: "http://127.0.0.1:9/mcp" } : { url: core.mcpUrl, bearer: core.mcpBearer },
    instructions: null,
    extraEnv: { NODE_ENV: "test" },
  };
  return {
    launchInput: base,
    secrets: ["the-real-model-token", "the-real-git-token", "ghs_realtokenvalue0123456789"],
    start: spawnAgentProcess,
    simplePrompt: fakeMarker("say"),
    longPrompt: fakeMarker("silent"),
    probes: {
      tools: fakeMarker("tools"),
      permission: fakeMarker("permission"),
      question: fakeMarker("elicit"),
      unknownUpdate: fakeMarker("unknown"),
      environment: {
        prompt: fakeMarker("env"),
        // PATH and SystemRoot to run at all; the task's own folders; the fake key and base URL.
        allowedNames: [
          "PATH",
          "Path",
          "SystemRoot",
          "LANG",
          "HOME",
          "USERPROFILE",
          "TEMP",
          "TMP",
          "FAKE_AGENT_DATA",
          "FAKE_AGENT_BASE_URL",
          "FAKE_AGENT_API_KEY",
          "FAKE_AGENT_CONFIG",
          ...(parity.unknownNotification === true ? [FAKE_AGENT_UNKNOWN_NOTIFICATION_ENV] : []),
          "NODE_ENV",
          // Windows adds these to every process it starts, from the ones above.
          "HOMEDRIVE",
          "HOMEPATH",
          "LOGONSERVER",
          "SYSTEMDRIVE",
          "USERDOMAIN",
          "USERNAME",
          "WINDIR",
        ],
      },
      endpoint: fakeMarker("endpoint"),
      plan: fakeMarker("plan"),
      leftoverProcess: fakeMarker("spawn"),
      steerable: fakeMarker("steerable"),
      backgroundSubagent: {
        prompt: fakeMarker("subagent-bg", "800"),
        hangingPrompt: fakeMarker("subagent-bg", "hang"),
        launched: "launched a subagent, ending my turn",
        childAnswer: "child answer: the README says hello",
        finalAnswer: "the final answer, after the subagent",
      },
    },
    archive: {
      run: runAgentCommand,
      freshBox: async () => {
        const fresh = path.join(root, `fresh-${String(Date.now())}`);
        const freshWorkspace = path.join(fresh, "workspace");
        const freshAgent = path.join(fresh, "agent");
        await mkdir(freshWorkspace, { recursive: true });
        await mkdir(path.join(freshAgent, "tmp"), { recursive: true });
        return { ...base, workspaceDir: freshWorkspace, agentDir: freshAgent };
      },
      archivePath: path.join(root, "session-archive.json"),
      remember: { prompt: fakeMarker("remember", "BLUE-HERON"), recall: fakeMarker("recall"), fact: "BLUE-HERON" },
    },
    profile: {
      askPath: (relativePath) => fakeMarker("ask-path", relativePath),
      askCommand: (command) => fakeMarker("ask-command", command),
      askPair: fakeMarker("ask-pair"),
      planTurn: fakeMarker("plan-turn"),
      mode: fakeMarker("mode"),
      skills: fakeMarker("skills"),
      mcp: fakeMarker("mcp"),
      mcpTool: FAKE_AGENT_MCP_TOOL,
      allowAllRepoConfig: { path: FAKE_AGENT_REPO_CONFIG, content: JSON.stringify({ permission: "allow" }) },
      echoesMarkedBlocks: true,
      asksOneAtATime: false,
    },
    memory: {
      instructions: fakeMarker("instructions"),
      tools: fakeMarker("memory-tools"),
      search: (query) => fakeMarker("memory-search", query),
      read: (noteId) => fakeMarker("memory-read", noteId),
      propose: (title) => fakeMarker("memory-propose", title),
      ...(core === undefined ? {} : { core: () => core }),
      repos: REPOS,
    },
    canary: { prompt: (absolutePath) => fakeMarker("shell-read", absolutePath) },
    // Milestone 4 (F-137): no model behind the fake, so it says its level instead.
    effort: { modelIds: [base.model.endpointModelId], sayEffort: fakeMarker("effort") },
    // Milestone 7 (ticket 03): the parity cases.
    parity: {
      envAllowlist: {
        always: [
          "HOME",
          "USERPROFILE",
          "TEMP",
          "TMP",
          "FAKE_AGENT_DATA",
          "FAKE_AGENT_BASE_URL",
          "FAKE_AGENT_API_KEY",
          "FAKE_AGENT_CONFIG",
          ...(parity.unknownNotification === true ? [FAKE_AGENT_UNKNOWN_NOTIFICATION_ENV] : []),
        ],
        ifSet: process.platform === "win32" ? ["PATH", "Path", "SystemRoot"] : ["PATH", "LANG"],
      },
      ...(parity.unknownNotification === true ? { unknownNotification: { method: FAKE_AGENT_UNKNOWN_NOTIFICATION } } : {}),
      modelCalls: { prompt: fakeMarker("model-calls", "3"), calls: () => stub.calls },
      repoConfigHook: (marker) => ({ path: FAKE_AGENT_REPO_CONFIG, content: `${JSON.stringify({ permission: "allow", hook: marker }, null, 2)}
` }),
      slashCommand: { ran: (name) => `Ran the slash command /${name}.` },
      mismatchedChecksum: () => new FakeAgentAdapter("plain", undefined, undefined, memory, "none", { ...parity, pinnedSha256: "0".repeat(64) }),
    },
    // Milestone 6 (ticket 04): the whole team's task kinds.
    team: teamProbes(root, workspaceDir, memory),
  };
};

// Milestone 7 (ticket 03): each fake by name through `runAgentSuite`, as OpenCode's suite runs.
for (const profile of ["rich", "plain"] as const satisfies readonly FakeAgentProfile[]) {
  runAgentSuite(new FakeAgentAdapter(profile), { model: "stub", fixture: () => fixtureFor() });
}

// Milestone 4 (ticket 02): the third fake, which can't reach an MCP server and takes the memory
// block alone. Milestone 7 (ticket 03): it also sends a notification no client knows after
// `initialize`, so the driver's tolerance of one runs on a fake that sends it.
runAgentSuite(new FakeAgentAdapter("plain", undefined, undefined, "index-only", "none", { unknownNotification: true }), {
  model: "stub",
  fixture: () => fixtureFor("index-only", { unknownNotification: true }),
});

// Milestone 4 (ticket 57, F-137): the fake that takes a reasoning level as a `thought_level`
// session option, beside the fakes above, which declare `none`.
runAgentSuite(new FakeAgentAdapter("rich", undefined, undefined, "mcp", "session-option"), { model: "stub", fixture: () => fixtureFor() });

// F-019: the fakes stand for what OpenCode lacks. `rich` declares native plan updates and
// reject-and-continue, and both happen; `plain` declares neither, and can't be steered.

const turnOf = (n: number) => turnIdSchema.parse(`fake-f019-turn-${String(n)}`);

const runFake = async (
  profile: FakeAgentProfile,
  body: (adapter: FakeAgentAdapter, session: AgentSession, events: TaskEvent[], fixture: AgentFixture) => Promise<void>,
  milestone4: { readonly memory?: FakeAgentMemory; readonly launch?: Partial<PrepareLaunchInput>; readonly effort?: FakeAgentEffort } = {},
): Promise<void> => {
  const fixture = await fixtureFor(milestone4.memory);
  const adapter = new FakeAgentAdapter(profile, undefined, undefined, milestone4.memory, milestone4.effort);
  const launch = await adapter.prepareLaunch({ ...fixture.launchInput, ...milestone4.launch });
  if (!launch.ok) throw new Error(launch.error.message);
  const started = await spawnAgentProcess(launch.value);
  const events: TaskEvent[] = [];
  const session = await adapter.startSession({
    taskId: fixture.launchInput.taskId,
    sessionId: fixture.launchInput.sessionId,
    io: started.io,
    cwd: fixture.launchInput.workspaceDir,
    mcpServers: [],
    onEvents: (batch) => {
      events.push(...batch);
    },
    onPermission: (_sessionId, request) => {
      const reject = request.options.find((option) => option.kind === "reject_once");
      return Promise.resolve(reject === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: reject.optionId });
    },
    onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
  });
  try {
    if (!session.ok) throw new Error(session.error.message);
    await body(adapter, session.value, events, fixture);
    await adapter.close(session.value);
  } finally {
    await started.stop();
  }
};

describe("the fake ACP agents, for the capabilities OpenCode lacks (F-019)", () => {
  it("F-019: the rich fake declares native plan updates and reject-and-continue, which OpenCode lacks, and both reach ostra", async () => {
    await runFake("rich", async (adapter, session, events) => {
      expect(adapter.capabilities).toMatchObject({ nativePlan: true, rejectAndContinue: true, steerMidTurn: true });
      expect(await adapter.prompt(session, turnOf(1), fakeMarker("plan"))).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      expect(events.filter((event) => event.kind === "plan.updated")).toHaveLength(1);
      // A deny, and the agent carries on in the same turn.
      expect(await adapter.prompt(session, turnOf(2), fakeMarker("permission"))).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      expect(events.some((event) => event.kind === "tool.failed")).toBe(true);
    });
  }, 60_000);

  it("F-019: the plain fake declares neither and can't steer: no plan update, a deny ends the turn, and a steer is refused", async () => {
    await runFake("plain", async (adapter, session, events) => {
      expect(adapter.capabilities).toMatchObject({ nativePlan: false, rejectAndContinue: false, steerMidTurn: false });
      expect(session.connection.steeringAdvertised).toBe(false);
      expect(await adapter.prompt(session, turnOf(1), fakeMarker("plan"))).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      expect(events.some((event) => event.kind === "plan.updated")).toBe(false);
      expect(await adapter.prompt(session, turnOf(2), fakeMarker("permission"))).toEqual({ ok: true, value: { stopReason: "cancelled" } });
      // The deny ended the turn; the next prompt goes on (the re-prompt ADR 0032 describes).
      expect(await adapter.prompt(session, turnOf(3), fakeMarker("say"))).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      expect(await adapter.steer(session, "use tabs")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    });
  }, 60_000);
});

// Milestone 4 (ticket 02, F-110, F-073): the memory block, the memory tools and the canary, on the
// fakes. The contract suite's cases run the same checks on every agent; these name the rows.

const said = (events: readonly TaskEvent[], from: number): string =>
  events.slice(from).flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

describe("the fake ACP agents and project memory (F-110)", () => {
  it("F-110: the memory block goes with the profile's instructions into the task's config folder, and no repo changes", async () => {
    const memory = { block: sampleMemoryBlock(true), tools: true };
    await runFake(
      "rich",
      async (adapter, session, events, fixture) => {
        const launched = await adapter.prepareLaunch({ ...fixture.launchInput, instructions: "Keep the README short.", memory });
        if (!launched.ok) throw new Error(launched.error.message);
        expect(launched.value.files.map((file) => path.dirname(file.path))).toEqual([fixture.launchInput.agentDir]);
        const before = events.length;
        await adapter.prompt(session, turnOf(1), fakeMarker("instructions"));
        const text = said(events, before);
        expect(text).toContain("Keep the README short.");
        expect(text).toContain(memory.block);
        for (const repo of REPOS) {
          expect((await run("git", ["status", "--porcelain"], { cwd: path.join(fixture.launchInput.workspaceDir, repo) })).stdout).toBe("");
        }
      },
      { launch: { instructions: "Keep the README short.", memory } },
    );
  }, 60_000);

  it("F-110: an agent with MCP calls memory_search, memory_read and memory_propose, each through the fake core", async () => {
    const memory = { block: sampleMemoryBlock(true), tools: true };
    await runFake(
      "plain",
      async (adapter, session, events, fixture) => {
        const core = fixture.memory?.core?.();
        const [searched, read] = memoryNoteFixtures;
        if (core === undefined || searched === undefined || read === undefined) throw new Error("the fixture has a fake core and two notes");
        const texts: string[] = [];
        for (const [index, prompt] of [
          fakeMarker("memory-tools"),
          fakeMarker("memory-search", "pnpm install"),
          fakeMarker("memory-read", read.noteId),
          fakeMarker("memory-propose", "Run the linter before a commit"),
        ].entries()) {
          const before = events.length;
          await adapter.prompt(session, turnOf(index + 1), prompt);
          texts.push(said(events, before));
        }
        expect(texts[0]).toBe("memory tools: memory_search, memory_read, memory_propose");
        expect(texts[1]).toContain(searched.title);
        expect(texts[2]).toContain(read.body);
        expect(texts[3]).toContain("proposal-1");
        expect(core.calls).toEqual({ search: 1, read: 1, propose: 1 });
        expect(core.toolCalls).toEqual(["memory_search", "memory_read", "memory_propose"]);
        expect(core.proposals.map((proposal) => proposal.title)).toEqual(["Run the linter before a commit"]);
      },
      { launch: { memory } },
    );
  }, 60_000);

  it("F-110: an agent without MCP gets the index and no tools", async () => {
    const memory = { block: sampleMemoryBlock(false), tools: true };
    await runFake(
      "plain",
      async (adapter, session, events) => {
        expect(adapter.capabilities).toMatchObject({ memory: "index-only" });
        let before = events.length;
        await adapter.prompt(session, turnOf(1), fakeMarker("instructions"));
        expect(said(events, before)).toContain(memory.block);
        before = events.length;
        await adapter.prompt(session, turnOf(2), fakeMarker("memory-tools"));
        expect(said(events, before)).toBe("memory tools: none");
        before = events.length;
        await adapter.prompt(session, turnOf(3), fakeMarker("memory-search", "pnpm"));
        expect(said(events, before)).toBe("memory_search: no such tool");
      },
      // Even a spec that offers the tools gives an index-only agent none.
      { memory: "index-only", launch: { memory } },
    );
  }, 60_000);
});

describe("the fake ACP agents and ADR 0035's canary (F-073)", () => {
  it("F-073: a shell call that reads a file outside the workspace is in the event log, with its full input and output", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "ostra-canary-"));
    roots.push(outside);
    const file = path.join(outside, "canary.txt");
    await writeFile(file, "canary-value-1234\n");
    await runFake("rich", async (adapter, session, events, fixture) => {
      expect(path.relative(fixture.launchInput.workspaceDir, file).startsWith("..")).toBe(true);
      await adapter.prompt(session, turnOf(1), fakeMarker("shell-read", file));
      const call = events.find((event) => event.kind === "tool.called" && event.toolKind === "execute");
      // The command in full; its folder as the event log keeps it, relative to the workspace.
      expect(call).toMatchObject({ kind: "tool.called", input: { command: `cat ${file}`, cwd: "." } });
      const done = events.find((event) => event.kind === "tool.completed" && call?.kind === "tool.called" && event.toolCallId === call.toolCallId);
      expect(JSON.stringify(done)).toContain("canary-value-1234");
    });
  }, 60_000);
});

// Milestone 4 (ticket 57, F-137): the scripted fakes keep adapter parity for reasoning effort.

describe("F-137 on the scripted fakes", () => {
  const model: PrepareLaunchInput["model"] = {
    endpointModelId: "stub-model",
    apiFormat: "openai-compatible",
    baseUrl: "http://127.0.0.1:9/key-proxy/v1",
    placeholderKey: "ostra-fake-key-for-this-task",
    reasoning: { supported: true, toggle: true, effort: ["low", "high"] },
  };

  it("F-137: the session-option fake advertises a thought_level option with the model's levels and records each value set; a level it lacks is clamped first", async () => {
    let turns = 0;
    await runFake(
      "rich",
      async (adapter, session, events) => {
        const effortModel = effortModelOf(model);
        expect(adapter.capabilities.reasoningEffort).toBe("session-option");
        expect(adapter.effortLevels(effortModel)).toEqual(["default", "none", "low", "high", "on"]);
        const option = session.configOptions.find((candidate) => candidate.category === "thought_level");
        expect(option).toEqual({ id: "reasoning", category: "thought_level", currentValue: "default", values: ["none", "low", "high", "on", "default"] });
        for (const [asked, ran] of [["high", "high"], ["max", "high"], ["low", "low"], ["default", "default"]] as const) {
          const set = await adapter.setEffort(session, asked, effortModel);
          expect(set, asked).toMatchObject({ ok: true, value: { level: ran } });
        }
        turns += 1;
        expect(await adapter.prompt(session, turnIdSchema.parse(`fake-effort-${String(turns)}`), fakeMarker("effort"))).toMatchObject({ ok: true });
        // `max` was clamped to `high`, which the session already had: nothing was sent for it.
        const said = events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");
        expect(said).toContain("effort: default set: high,low,default");
      },
      { effort: "session-option", launch: { model } },
    );
  }, 60_000);

  it("F-137: the fakes that declare none advertise no level, and setEffort leaves them at default", async () => {
    for (const profile of ["rich", "plain"] as const) {
      await runFake(profile, async (adapter, session) => {
        const effortModel = effortModelOf(model);
        expect(adapter.capabilities.reasoningEffort).toBe("none");
        expect(adapter.effortLevels(effortModel)).toEqual(["default"]);
        expect(session.configOptions).toEqual([]);
        expect(await adapter.setEffort(session, "high", effortModel)).toEqual({ ok: true, value: { session, level: "default", adjustedFrom: "high", events: [] } });
      }, { launch: { model } });
    }
  }, 60_000);
});
