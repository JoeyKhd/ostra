import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { sampleDraft, sampleProposal, sampleReview, toolSetsByKind } from "@ostra/adapter-sdk/testing";
import {
  draftIdSchema,
  draftResultText,
  environmentProposalIdSchema,
  environmentProposalResultText,
  PROPOSE_ENVIRONMENT_TOOL,
  repoFullNameSchema,
  repoIdSchema,
  reviewResultText,
  reviewRunIdSchema,
  runnerIdSchema,
  SUBMIT_DRAFT_TOOL,
  SUBMIT_REVIEW_TOOL,
  taskIdSchema,
  unknownRepoText,
} from "@ostra/protocol";
import type { EnvironmentProposalRefusal, OstraToolSet } from "@ostra/protocol";
import { taskCredentialsFixture, taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, describe, expect, it } from "vitest";
import { teamLink } from "../task-host/server-link.ts";
import { startFakeServer } from "../testing/fake-server.ts";
import type { FakeServer } from "../testing/fake-server.ts";
import { MEMORY_PROPOSE_TOOL, MEMORY_READ_TOOL, MEMORY_SEARCH_TOOL, SET_PR_TEXT_TOOL, startMcpTools, TEAM_TOOL_UNAVAILABLE } from "./mcp-tools.ts";
import type { McpTools } from "./mcp-tools.ts";

// Tickets 22 and 23 (F-099, F-100, F-113, protocol minor 5): the sidecar's MCP server serves exactly
// the tool sets the spec names, and `submit_draft`, `submit_review` and `propose_environment` round
// trip through the fake core's runner HTTP (the protocol's schemas), with the link's token, each
// refusal coming back in the protocol's words. A real MCP client calls them.

const taskId = taskIdSchema.parse("task-team-tools");
const repoId = repoIdSchema.parse("repo-team-1");
const repo = repoFullNameSchema.parse("ostra-test/test1");
const ACCESS_TOKEN = "ostra-runner-team-tools-access-token";
const MEMORY_TOOLS = [MEMORY_SEARCH_TOOL, MEMORY_READ_TOOL, MEMORY_PROPOSE_TOOL];

let server: FakeServer | undefined;
let tools: McpTools | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  await tools?.close();
  tools = undefined;
  await server?.close();
  server = undefined;
});

const start = async (sets: readonly OstraToolSet[] | undefined): Promise<{ readonly core: FakeServer; readonly client: Client; readonly logs: LogRecord[] }> => {
  const core = await startFakeServer();
  server = core;
  core.accessTokens.set(ACCESS_TOKEN, runnerIdSchema.parse("runner-team-tools"));
  // The fake core answers only for a task it knows.
  core.tasks.set(taskId, { spec: { ...taskSpecFixture, taskId }, credentials: taskCredentialsFixture });
  const logs: LogRecord[] = [];
  const tokens = { get: () => Promise.resolve({ ok: true as const, token: ACCESS_TOKEN, expiresAt: Date.now() + 600_000 }), invalidate: () => undefined };
  tools = await startMcpTools({
    taskId,
    repos: [{ repoId, fullName: repo, prTemplate: null }],
    taskTitle: "Refine the banner ticket",
    listenHost: "127.0.0.1",
    logger: createLogger((record) => logs.push(record)),
    onPrText: () => undefined,
    memory: { link: { search: () => Promise.reject(new Error("unused")), read: () => Promise.reject(new Error("unused")), propose: () => Promise.reject(new Error("unused")) }, onUsed: () => undefined },
    ...(sets === undefined ? {} : { tools: sets }),
    team: teamLink({ serverUrl: core.url, tokens }),
  });
  const client = new Client({ name: "ostra-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(tools.url), { requestInit: { headers: { authorization: `Bearer ${tools.bearer}` } } }));
  clients.push(client);
  return { core, client, logs };
};

const textOf = (result: unknown): string => {
  const content: unknown = Reflect.get(Object(result), "content");
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = Reflect.get(Object(first), "text");
  return typeof text === "string" ? text : "";
};

const listed = async (client: Client): Promise<readonly string[]> => (await client.listTools()).tools.map((tool) => tool.name);

describe("ostra's tools per task kind (tickets 22 and 23)", () => {
  it("F-099, F-100, F-113: each kind's tool sets list exactly their tools, and a spec without tools lists milestone 4's", async () => {
    const expected: Readonly<Record<keyof typeof toolSetsByKind, readonly string[]>> = {
      code: [SET_PR_TEXT_TOOL, ...MEMORY_TOOLS],
      refine: [SUBMIT_DRAFT_TOOL, ...MEMORY_TOOLS],
      review: [SUBMIT_REVIEW_TOOL, ...MEMORY_TOOLS],
      onboarding: [SET_PR_TEXT_TOOL, PROPOSE_ENVIRONMENT_TOOL, ...MEMORY_TOOLS],
    };
    for (const [kind, sets] of Object.entries(toolSetsByKind)) {
      const { client } = await start(sets);
      expect([...(await listed(client))].sort(), kind).toEqual([...(Object.entries(expected).find(([name]) => name === kind)?.[1] ?? [])].sort());
      await client.close();
      await tools?.close();
      await server?.close();
      tools = undefined;
      server = undefined;
    }
    const { client } = await start(undefined);
    expect([...(await listed(client))].sort()).toEqual([SET_PR_TEXT_TOOL, ...MEMORY_TOOLS].sort());
  });

  it("F-099: submit_draft reaches the fake core with the runner's token and comes back as the saved version", async () => {
    const { core, client, logs } = await start(toolSetsByKind.refine);
    const first = await client.callTool({ name: SUBMIT_DRAFT_TOOL, arguments: sampleDraft });
    expect(first.isError).not.toBe(true);
    expect(textOf(first)).toBe(draftResultText({ draftId: draftIdSchema.parse("draft-1"), version: 1 }));
    const second = await client.callTool({ name: SUBMIT_DRAFT_TOOL, arguments: { ...sampleDraft, openQuestions: [] } });
    expect(textOf(second)).toContain("Draft version 2 is saved");
    expect(core.team.drafts.map((draft) => [draft.taskId, draft.bearer])).toEqual([
      [taskId, ACCESS_TOKEN],
      [taskId, ACCESS_TOKEN],
    ]);
    expect(core.team.drafts[0]?.body).toEqual(sampleDraft);
    // The draft's text is never logged: counts and IDs only.
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain("banner shows");
    expect(logged).not.toContain("Escape the name");
    expect(logs.some((record) => record.message === "draft submitted" && record.fields["version"] === 2)).toBe(true);
  });

  it("F-099: each draft refusal reaches the agent in the protocol's words, and nothing is saved", async () => {
    const { core, client } = await start(toolSetsByKind.refine);
    for (const code of ["wrong-kind", "invalid", "limit-reached"] as const) {
      core.team.refusals.draft = { code };
      const refused = await client.callTool({ name: SUBMIT_DRAFT_TOOL, arguments: sampleDraft });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(draftResultText({ code }));
    }
    expect(core.team.drafts).toEqual([]);
    // Input the protocol's schema refuses never reaches core.
    const calls = core.team.calls.length;
    const tooMany = await client.callTool({ name: SUBMIT_DRAFT_TOOL, arguments: { ...sampleDraft, subTickets: Array.from({ length: 21 }, () => sampleDraft.subTickets[0]) } });
    expect(tooMany.isError).toBe(true);
    const extra = await client.callTool({ name: SUBMIT_DRAFT_TOOL, arguments: { ...sampleDraft, ready: true } });
    expect(extra.isError).toBe(true);
    expect(core.team.calls).toHaveLength(calls);
    // Core down: the agent hears nothing was saved.
    core.team.refusals.draft = null;
    core.team.down = true;
    const down = await client.callTool({ name: SUBMIT_DRAFT_TOOL, arguments: sampleDraft });
    expect(textOf(down)).toBe(TEAM_TOOL_UNAVAILABLE);
    expect(core.team.drafts).toEqual([]);
  });

  it("F-100: submit_review names each finding's repo by ID for core, and each refusal reaches the agent", async () => {
    const { core, client, logs } = await start(toolSetsByKind.review);
    const saved = await client.callTool({ name: SUBMIT_REVIEW_TOOL, arguments: sampleReview(repo) });
    expect(saved.isError).not.toBe(true);
    expect(textOf(saved)).toBe(reviewResultText({ reviewRunId: reviewRunIdSchema.parse("review-run-1") }));
    const [review] = core.team.reviews;
    expect(review?.bearer).toBe(ACCESS_TOKEN);
    expect(review?.body.findings.map((finding) => [finding.repoId, finding.severity, finding.line])).toEqual([
      [repoId, "blocking", 12],
      [repoId, "nit", 3],
    ]);
    for (const code of ["wrong-kind", "invalid", "limit-reached", "not-in-review"] as const) {
      core.team.refusals.review = { code };
      const refused = await client.callTool({ name: SUBMIT_REVIEW_TOOL, arguments: sampleReview(repo) });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(reviewResultText({ code }));
    }
    // A repo the task doesn't have is refused here, before core.
    const calls = core.team.calls.length;
    const elsewhere = await client.callTool({ name: SUBMIT_REVIEW_TOOL, arguments: sampleReview(repoFullNameSchema.parse("someone/else")) });
    expect(textOf(elsewhere)).toBe(unknownRepoText("someone/else"));
    expect(core.team.calls).toHaveLength(calls);
    expect(core.team.reviews).toHaveLength(1);
    // A finding's text is never logged.
    expect(JSON.stringify(logs)).not.toContain("whoami");
    expect(logs.some((record) => record.message === "review submitted" && record.fields["blocking"] === 1 && record.fields["findings"] === 2)).toBe(true);
  });

  it("F-113: propose_environment reaches the fake core by repo ID, and each refusal reaches the agent", async () => {
    const { core, client, logs } = await start(toolSetsByKind.onboarding);
    const saved = await client.callTool({ name: PROPOSE_ENVIRONMENT_TOOL, arguments: sampleProposal(repo) });
    expect(saved.isError).not.toBe(true);
    expect(textOf(saved)).toBe(environmentProposalResultText({ proposalId: environmentProposalIdSchema.parse("environment-proposal-1") }));
    expect(core.team.proposals[0]?.body.repos.map((each) => each.repoId)).toEqual([repoId]);
    expect(core.team.proposals[0]?.bearer).toBe(ACCESS_TOKEN);
    const refusals: readonly EnvironmentProposalRefusal[] = [{ code: "secret-found", found: ["a GitHub token"] }, { code: "wrong-kind" }, { code: "invalid" }];
    for (const refusal of refusals) {
      core.team.refusals.environment = refusal;
      const refused = await client.callTool({ name: PROPOSE_ENVIRONMENT_TOOL, arguments: sampleProposal(repo) });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(environmentProposalResultText(refusal));
    }
    expect(core.team.proposals).toHaveLength(1);
    // A proposal's scripts are never logged.
    expect(JSON.stringify(logs)).not.toContain("pnpm install --frozen-lockfile");
  });

  it("F-099, F-100: a tool the task's sets don't name can't be called", async () => {
    const { core, client } = await start(toolSetsByKind.code);
    const draft = await client.callTool({ name: SUBMIT_DRAFT_TOOL, arguments: sampleDraft });
    expect(draft.isError).toBe(true);
    const review = await client.callTool({ name: SUBMIT_REVIEW_TOOL, arguments: sampleReview(repo) });
    expect(review.isError).toBe(true);
    expect(core.team.calls).toEqual([]);
  });
});
