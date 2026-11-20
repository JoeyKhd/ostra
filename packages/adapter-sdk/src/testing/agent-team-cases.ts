import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { NEUTRAL_REPLY, repoFullNameSchema, turnIdSchema } from "@ostra/protocol";
import type { OstraToolSet, ProposeEnvironmentInput, RepoFullName, SubmitDraftInput, SubmitReviewInput, TaskEvent } from "@ostra/protocol";
import { expect, it } from "vitest";

import type { AgentAdapter, PrepareLaunchInput, QuestionAnswer, QuestionRequest } from "../agent/base.ts";
import { stageCommitPaths } from "../executor/commit-paths.ts";
import { sampleMemoryBlock } from "./agent-memory-cases.ts";
import type { AgentFixture } from "./agent-suite.ts";
import { fakeCoreToolNames } from "./fake-memory-core.ts";
import type { FakeMemoryCore } from "./fake-memory-core.ts";

// Milestone 6 (ticket 04, spec section 5.2, ADR 0028, ADR 0038, ADR 0041): the agent contract
// suite's cases for the whole team's task kinds. An automatic turn's question gets the fixed
// neutral reply and the agent carries on, with a declined question as the control (spike 10); a
// refine or review task's push is refused by its fetch-only remote; a review task's repos are at
// the given heads; ostra's tools are listed for the kinds that have them and absent for the
// others, and each round-trips through the fake core, refusals included; and a commit with
// `commitPaths` leaves the agent's other changes uncommitted.

const run = promisify(execFile);

/** Prompts and set-ups that make an agent show each of milestone 6's behaviors. Each is optional. */
export type AgentTeamProbes = {
  /** The agent asks one question as an ACP elicitation, and says `carried on with: <answer>` once answered. */
  readonly askAndContinue?: string;
  /**
   * Makes a repo folder in the workspace whose `origin` is fetch-only, as a refine or review task's
   * git proxy is, with a commit to push; the prompt pushes from it.
   */
  readonly readOnlyPush?: () => Promise<{
    readonly prompt: string;
    /** The pushes that reached the upstream, which must stay none. */
    readonly pushesReceived: () => Promise<number>;
  }>;
  /** Makes repo folders at a review task's heads; the prompt makes the agent say each one's HEAD as `<folder> <sha>`. */
  readonly reviewCheckout?: () => Promise<{ readonly prompt: string; readonly heads: readonly { readonly folder: string; readonly sha: string }[] }>;
  /** ostra's tools, through a fake core started for the tool sets given. Absent for an agent without `memory: "mcp"`. */
  readonly tools?: {
    /** Starts a fake core serving `tools`, and the launch's `mcp` that points the agent at it. */
    readonly start: (tools: readonly OstraToolSet[]) => Promise<{ readonly core: FakeMemoryCore; readonly mcp: PrepareLaunchInput["mcp"] }>;
    /** Makes the agent list ostra's tools, as `memory tools: a, b` (milestone 4's probe). */
    readonly list: string;
    readonly submitDraft: (draft: SubmitDraftInput) => string;
    readonly submitReview: (review: SubmitReviewInput) => string;
    readonly proposeEnvironment: (proposal: ProposeEnvironmentInput) => string;
    /** The task's repo, as the agent names it in a finding or a proposal. */
    readonly repo: RepoFullName;
  };
  /** Makes a git repo folder under the workspace, `repo`, and a prompt that makes the agent write the workspace-relative files given. */
  readonly writeFiles?: () => Promise<{ readonly prompt: (files: readonly string[]) => string; readonly repo: string }>;
};

type Subject = () => { readonly adapter: AgentAdapter; readonly fixture: AgentFixture };

const textOf = (events: readonly TaskEvent[]): string =>
  events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

/** The runner's answer to a question in an automatic turn (Q160): the neutral reply in every text field, a select's first option. */
export const neutralAnswer = (request: QuestionRequest): QuestionAnswer => ({
  outcome: "answered",
  answers: Object.fromEntries(request.fields.map((field) => [field.id, field.type === "select" ? (field.options?.[0] ?? NEUTRAL_REPLY) : NEUTRAL_REPLY])),
});

/** The tool sets of each task kind (protocol minor 5's `tools`): milestone 4's for a code task. */
export const toolSetsByKind = {
  code: ["pr-text", "memory"],
  refine: ["memory", "draft"],
  review: ["memory", "review"],
  onboarding: ["pr-text", "memory", "environment"],
} as const satisfies Readonly<Record<string, readonly OstraToolSet[]>>;

/** A draft as the drafting fake hands it in: a field of each kind. */
export const sampleDraft: SubmitDraftInput = {
  description: "## What\n\nThe banner shows the signed-in user's name.",
  acceptanceCriteria: ["The banner shows the name", "A name with `<script>` stays text"],
  edgeCases: ["A name of 200 characters"],
  openQuestions: ["Should a guest see a banner?"],
  subTickets: [{ title: "Escape the name", description: "Use the template's escaping." }],
};

/** A review as the reviewing fake hands it in: one blocking finding and one nit. */
export const sampleReview = (repo: RepoFullName): SubmitReviewInput => ({
  summary: "One problem must change before a merge; one nit.",
  findings: [
    { repo, path: "src/banner.ts", line: 12, side: "new", severity: "blocking", title: "The name isn't escaped", body: "`$(whoami)` reaches the page as HTML.", suggestion: "escape(name)" },
    { repo, path: "src/banner.ts", line: 3, side: "new", severity: "nit", title: "An unused import", body: "`fs` isn't used.", suggestion: null },
  ],
});

/** An environment proposal as the proposing fake hands it in: names only, never a value. */
export const sampleProposal = (repo: RepoFullName): ProposeEnvironmentInput => ({
  repos: [{ repo, setupScript: "pnpm install --frozen-lockfile", checks: [{ name: "test", command: "pnpm test", timeoutSeconds: 600 }], variableNames: ["DATABASE_URL"] }],
  services: [{ name: "postgres", image: "postgres:17", port: 5432, healthCheck: "pg_isready", variableNames: ["POSTGRES_PASSWORD"] }],
  notes: "The setup needed pnpm 11; the tests need Postgres.",
});

/** Every kind's tool sets hold memory's, so a launch with ostra's tools carries the memory block with its tools. */
const withTools = { block: sampleMemoryBlock(true), tools: true } as const;

export const defineAgentTeamCases = (subject: Subject): void => {
  /** One session launched with `extra`, one turn of `prompt`, with `onQuestion`: its events and its stop reason. */
  const runTurn = async (
    prompt: string,
    options: { readonly extra?: Partial<PrepareLaunchInput>; readonly onQuestion?: (request: QuestionRequest) => QuestionAnswer } = {},
  ): Promise<{ readonly text: string; readonly events: readonly TaskEvent[]; readonly stopReason: string }> => {
    const { adapter, fixture } = subject();
    const input: PrepareLaunchInput = { ...fixture.launchInput, ...options.extra };
    const prepared = await adapter.prepareLaunch(input);
    if (!prepared.ok) throw new Error(`prepareLaunch failed: ${prepared.error.message}`);
    const started = await fixture.start(prepared.value);
    const events: TaskEvent[] = [];
    const session = await adapter.startSession({
      taskId: input.taskId,
      sessionId: input.sessionId,
      io: started.io,
      cwd: input.workspaceDir,
      mcpServers: [],
      onEvents: (batch) => {
        events.push(...batch);
      },
      onPermission: () => Promise.resolve({ outcome: "cancelled" }),
      onQuestion: (_agentSessionId, request) => Promise.resolve(options.onQuestion?.(request) ?? { outcome: "cancelled" }),
    });
    if (!session.ok) {
      await started.stop();
      throw new Error(`startSession failed: ${session.error.message}`);
    }
    try {
      const turn = await adapter.prompt(session.value, turnIdSchema.parse("team-turn-1"), prompt);
      if (!turn.ok) throw new Error(`the turn failed: ${turn.error.message}`);
      return { text: textOf(events), events, stopReason: turn.value.stopReason };
    } finally {
      await adapter.close(session.value);
      await started.stop();
    }
  };

  const team = (context: { readonly skip: () => void }): NonNullable<AgentFixture["team"]> | undefined => {
    const value = subject().fixture.team;
    if (value === undefined) context.skip();
    return value;
  };

  it("F-101: in an automatic turn, the agent's question gets the fixed neutral reply, and the agent carries on", async (context) => {
    const prompt = team(context)?.askAndContinue;
    if (prompt === undefined || !subject().adapter.capabilities.elicitationForm) {
      // An agent that can't ask mid-turn needs no reply in an automatic turn.
      context.skip();
      return;
    }
    const asked: QuestionRequest[] = [];
    const answered = await runTurn(prompt, {
      onQuestion: (request) => {
        asked.push(request);
        return neutralAnswer(request);
      },
    });
    expect(asked).toHaveLength(1);
    expect(answered.stopReason).toBe("end_turn");
    expect(answered.text).toContain(NEUTRAL_REPLY);
  });

  it("F-101: the control: the same question declined ends the turn cancelled, as OpenCode's did in spike 10", async (context) => {
    const prompt = team(context)?.askAndContinue;
    if (prompt === undefined || !subject().adapter.capabilities.elicitationForm) {
      context.skip();
      return;
    }
    const declined = await runTurn(prompt, { onQuestion: () => ({ outcome: "declined" }) });
    expect(declined.stopReason).toBe("cancelled");
    expect(declined.text).not.toContain("carried on with");
  });

  it("F-099: a read-only task's push is refused by its fetch-only remote, and nothing reaches the upstream", async (context) => {
    const setUp = team(context)?.readOnlyPush;
    if (setUp === undefined) {
      context.skip();
      return;
    }
    const probe = await setUp();
    const pushed = await runTurn(probe.prompt);
    expect(pushed.text).toContain("push refused");
    // The agent's push shows in the event log as a failed shell call.
    expect(pushed.events.some((event) => event.kind === "tool.failed")).toBe(true);
    expect(await probe.pushesReceived()).toBe(0);
  });

  it("F-100: a review task's repos are checked out at the given heads, one per repo", async (context) => {
    const setUp = team(context)?.reviewCheckout;
    if (setUp === undefined) {
      context.skip();
      return;
    }
    const probe = await setUp();
    expect(probe.heads.length).toBeGreaterThan(1);
    const said = await runTurn(probe.prompt);
    for (const head of probe.heads) {
      expect(said.text).toContain(`${head.folder} ${head.sha}`);
    }
  });

  it("F-099: ostra's tools are listed for the task kinds that have them, and absent for the others", async (context) => {
    const tools = team(context)?.tools;
    if (tools === undefined) {
      context.skip();
      return;
    }
    for (const sets of Object.values(toolSetsByKind)) {
      const { core, mcp } = await tools.start(sets);
      try {
        const listed = await runTurn(tools.list, { extra: { mcp, memory: withTools } });
        const names = /memory tools: (.*)/.exec(listed.text)?.[1]?.split(", ").filter((name) => name !== "none") ?? [];
        expect(names.sort()).toEqual([...fakeCoreToolNames(sets)].sort());
      } finally {
        await core.close();
      }
    }
  });

  it("F-099: the drafting agent's submit_draft reaches core as a draft, and a refusal reaches the agent in the protocol's words", async (context) => {
    const tools = team(context)?.tools;
    if (tools === undefined) {
      context.skip();
      return;
    }
    const { core, mcp } = await tools.start(toolSetsByKind.refine);
    try {
      const saved = await runTurn(tools.submitDraft(sampleDraft), { extra: { mcp, memory: withTools } });
      expect(saved.text).toContain("Draft version 1 is saved");
      expect(core.drafts).toEqual([sampleDraft]);
      core.refusals.draft = { code: "limit-reached" };
      const refused = await runTurn(tools.submitDraft(sampleDraft), { extra: { mcp, memory: withTools } });
      expect(refused.text).toContain("as many drafts as it may");
      expect(core.drafts).toHaveLength(1);
    } finally {
      await core.close();
    }
  });

  it("F-100: the reviewing agent's submit_review reaches core with its findings by repo ID, and not-in-review reaches the agent", async (context) => {
    const tools = team(context)?.tools;
    if (tools === undefined) {
      context.skip();
      return;
    }
    const { core, mcp } = await tools.start(toolSetsByKind.review);
    try {
      const review = sampleReview(tools.repo);
      const saved = await runTurn(tools.submitReview(review), { extra: { mcp, memory: withTools } });
      expect(saved.text).toContain("The review is saved");
      expect(core.reviews).toHaveLength(1);
      expect(core.reviews[0]?.findings.map((finding) => [finding.severity, finding.path, finding.line])).toEqual([
        ["blocking", "src/banner.ts", 12],
        ["nit", "src/banner.ts", 3],
      ]);
      core.refusals.review = { code: "not-in-review" };
      const refused = await runTurn(tools.submitReview(review), { extra: { mcp, memory: withTools } });
      expect(refused.text).toContain("no longer waiting for this review");
      // A finding on a repo the task lacks is refused before core is asked.
      const calls = core.teamCalls.review;
      const stranger = await runTurn(tools.submitReview(sampleReview(repoFullNameSchema.parse(`${tools.repo}-other`))), { extra: { mcp, memory: withTools } });
      expect(stranger.text).toContain("This task has no repo");
      expect(core.teamCalls.review).toBe(calls);
    } finally {
      await core.close();
    }
  });

  it("F-113: the proposing agent's propose_environment reaches core, and a secret found reaches the agent by kind, never by value", async (context) => {
    const tools = team(context)?.tools;
    if (tools === undefined) {
      context.skip();
      return;
    }
    const { core, mcp } = await tools.start(toolSetsByKind.onboarding);
    try {
      const saved = await runTurn(tools.proposeEnvironment(sampleProposal(tools.repo)), { extra: { mcp, memory: withTools } });
      expect(saved.text).toContain("The proposal is saved");
      expect(core.environmentProposals[0]?.repos[0]?.variableNames).toEqual(["DATABASE_URL"]);
      core.refusals.environment = { code: "secret-found", found: ["a GitHub token"] };
      const refused = await runTurn(tools.proposeEnvironment(sampleProposal(tools.repo)), { extra: { mcp, memory: withTools } });
      expect(refused.text).toContain("a GitHub token");
      expect(core.environmentProposals).toHaveLength(1);
    } finally {
      await core.close();
    }
  });

  it("F-113: after a turn, a commit with commitPaths keeps only those; the agent's other changes stay uncommitted", async (context) => {
    const setUp = team(context)?.writeFiles;
    if (setUp === undefined) {
      context.skip();
      return;
    }
    const probe = await setUp();
    const repoDir = path.join(subject().fixture.launchInput.workspaceDir, probe.repo);
    const files = ["AGENTS.md", "src/setup.ts", "notes.txt"];
    await runTurn(probe.prompt(files.map((file) => `${probe.repo}/${file}`)));
    const staged = await stageCommitPaths(repoDir, ["AGENTS.md"]);
    expect(staged.kept).toEqual(["AGENTS.md"]);
    expect(staged.droppedCount).toBe(2);
    await run("git", ["-c", "user.email=ostra@example.test", "-c", "user.name=ostra", "commit", "-q", "-m", "Add AGENTS.md"], { cwd: repoDir });
    expect((await run("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: repoDir })).stdout.trim()).toBe("AGENTS.md");
    const left = (await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoDir })).stdout.trimEnd().split("\n").map((line) => line.slice(3)).sort();
    expect(left).toEqual(["notes.txt", "src/setup.ts"]);
  });
};
