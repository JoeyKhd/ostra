import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "@ostra/adapter-sdk";
import {
  defaultOstraToolSets,
  draftResultText,
  environmentProposalRequestFromTool,
  environmentProposalResultText,
  memoryKindSchema,
  memoryProposalRequestSchema,
  memoryScopeSchema,
  memorySearchRequestSchema,
  noteIdSchema,
  parseJson,
  PROPOSE_ENVIRONMENT_TOOL,
  proposeEnvironmentDescription,
  proposeEnvironmentInputSchema,
  proposalRelationSchema,
  reviewRequestFromTool,
  reviewResultText,
  runnerLimits,
  SUBMIT_DRAFT_TOOL,
  SUBMIT_REVIEW_TOOL,
  submitDraftDescription,
  submitDraftInputSchema,
  submitReviewDescription,
  submitReviewInputSchema,
  unknownRepoText,
} from "@ostra/protocol";
import type {
  MemoryNoteResponse,
  MemoryProposalResponse,
  MemorySearchResponse,
  NoteId,
  OstraToolSet,
  ProposeEnvironmentInput,
  RepoFullName,
  RepoId,
  SubmitDraftInput,
  SubmitReviewInput,
  TaskEventOf,
  TaskId,
} from "@ostra/protocol";
import { z } from "zod";
import type { MemoryCallFailure, MemoryLink, TeamLink } from "../task-host/server-link.ts";
import { RUNNER_VERSION } from "../version.ts";

// ostra's MCP tools for one task (ticket 20, F-030, F-078): an MCP server over Streamable HTTP
// that the agent's config points at (ticket 11). It listens on loopback on `host`, on the box
// network on `docker`, and takes only the random bearer it put in the agent's config, which grants
// this task's tools and nothing else. The runner's own server credentials never leave the runner.
//
// Milestone 1 has one tool, `set_pull_request_text`, which the agent calls to write the PR's title
// and body. Its input is untrusted: parsed with a strict schema, checked against the task's repos
// and size caps, never passed to a shell, and handed on as a `pr.text_set` event (data).
//
// Milestone 4 (ticket 20, ADR 0044, F-110, F-111): with the spec's `memory.tools`, three more tools,
// `memory_search`, `memory_read` and `memory_propose`. Each input is parsed with the protocol's
// strict schemas and forwarded to core's `/runner/v1/tasks/:taskId/memory/*` with the link's token,
// which stays in the runner's memory: the agent's bearer grants these tools and nothing else. A
// refusal from core goes back as the tool's error text, a network failure as "Memory is unavailable
// right now". A read is reported as `memory.used` (`search` when the note came from a search in the
// same turn). A query, a note's text and a proposal's text are never logged: counts and IDs only.
//
// Milestone 6 (tickets 22 and 23, protocol minor 5): the server serves exactly the tool sets the
// spec's `tools` names (`taskSpecToolSets`): `pr-text` is `set_pull_request_text`, `memory` the three
// memory tools, `draft` is `submit_draft`, `review` is `submit_review` and `environment` is
// `propose_environment`. Each new tool's input is checked against the protocol's own schema
// (`mcp/tools.ts`), its repos named by `owner/name` and turned into IDs here, and the call is
// forwarded to core's `/runner/v1/tasks/:taskId/{draft,review,environment-proposal}` with the link's
// token. Core's answer, a refusal included, goes back in the protocol's words. A draft's, a
// finding's and a proposal's text are never logged: counts and IDs only.

export const SET_PR_TEXT_TOOL = "set_pull_request_text";
export const MEMORY_SEARCH_TOOL = "memory_search";
export const MEMORY_READ_TOOL = "memory_read";
export const MEMORY_PROPOSE_TOOL = "memory_propose";
/** What the agent reads when core can't be reached. */
export const MEMORY_UNAVAILABLE = "Memory is unavailable right now. Carry on without it, and try again later if you need it.";
/** A search's results when the agent names no limit. */
const DEFAULT_SEARCH_LIMIT = 5;
/** The path the server answers on. */
export const MCP_PATH = "/mcp";
/** The PR title's cap (GitHub allows 256). */
export const PR_TITLE_MAX = 256;
/** The PR body's cap (GitHub allows 65,536). */
export const PR_BODY_MAX = 65_536;
/** How much of a repo's PR template goes in the tool's description. */
const TEMPLATE_IN_DESCRIPTION_MAX = 16_384;

export type McpToolsRepo = {
  readonly repoId: RepoId;
  readonly fullName: RepoFullName;
  /** The repo's PR template, when it has one (F-078). */
  readonly prTemplate: string | null;
};

export type McpToolsOptions = {
  readonly taskId: TaskId;
  readonly repos: readonly McpToolsRepo[];
  /** The task's title, which the PR title should stay close to. */
  readonly taskTitle: string;
  readonly listenHost: string;
  readonly advertiseHost?: string;
  readonly port?: number;
  readonly logger: Logger;
  /** The text the agent set: becomes a `pr.text_set` event. */
  readonly onPrText: (event: TaskEventOf<"pr.text_set">) => void;
  /** Minor 3: the memory tools, when the spec's `memory.tools` is true. Absent: no memory tools. */
  readonly memory?: McpMemoryOptions;
  /** Minor 5: the tool sets served (the spec's `tools`). Absent: milestone 4's, `defaultOstraToolSets`. */
  readonly tools?: readonly OstraToolSet[];
  /** Minor 5: core's draft, review and proposal endpoints, for the `draft`, `review` and `environment` sets. */
  readonly team?: TeamLink;
};

export type McpMemoryOptions = {
  /** Core's memory endpoints, with the task's token. */
  readonly link: MemoryLink;
  /** A note the agent read: a `memory.used` event. */
  readonly onUsed: (event: TaskEventOf<"memory.used">) => void;
};

export type McpTools = {
  /** The MCP endpoint, for the agent's config. */
  readonly url: string;
  /** The bearer the agent's config sends. Task-scoped; good at this server only. Never logged. */
  readonly bearer: string;
  /** A new turn: a read counts as `search` only for a note a search of the same turn found. */
  readonly turnStarted: () => void;
  readonly close: () => Promise<void>;
};

const inputSchema = z.strictObject({
  repo: z.string().min(1).max(201).describe("The repo, as owner/name, exactly as the task lists it."),
  title: z.string().min(1).max(PR_TITLE_MAX * 4).describe("The pull request's title: one line, close to the task's prompt."),
  body: z.string().max(PR_BODY_MAX * 4).describe("The pull request's body, in Markdown."),
});

const memorySearchInputSchema = z.strictObject({
  query: z
    .string()
    .describe(`What to look for in the project's and the organization's approved notes: words, a command, an identifier. At most ${String(runnerLimits.memoryQueryMaxChars)} characters.`),
  limit: z
    .number()
    .int()
    .optional()
    .describe(`How many notes at most, 1 to ${String(runnerLimits.memorySearchResultsMax)}. Default ${String(DEFAULT_SEARCH_LIMIT)}.`),
});

const memoryReadInputSchema = z.strictObject({
  noteId: z.string().describe("The note's ID, as the memory index or a search lists it."),
});

const memoryProposeInputSchema = z.strictObject({
  title: z.string().describe(`One line, at most ${String(runnerLimits.memoryNoteTitleMaxChars)} characters.`),
  body: z.string().describe("What the next task should know, at most 4 KiB. Never a secret, a token or a password."),
  kind: memoryKindSchema.describe("What the note records."),
  scope: memoryScopeSchema.describe("Whose it is: this project's, or the whole organization's."),
  relatesTo: z.string().nullable().optional().describe("The ID of a note this one contradicts or refines, if any."),
  relation: proposalRelationSchema.nullable().optional().describe("How it relates to that note: contradicts or refines."),
});

const SEARCH_DESCRIPTION = [
  "Search this project's memory: the organization's and the project's approved notes.",
  "Returns each match's ID, title, kind and the line that matched. Read one in full with memory_read.",
].join(" ");
const READ_DESCRIPTION = "Read one approved memory note in full, by its ID from the memory index or a search.";
const PROPOSE_DESCRIPTION = [
  "Propose a memory note for the next tasks: a convention, a command, a gotcha, a decision, a preference or a term you learned here.",
  "A member approves it before any agent sees it, so it doesn't reach this session.",
  "If it contradicts or refines a note, name that note in relatesTo and say how in relation.",
  "Never put a secret, a token or a password in a note: such a proposal is refused.",
].join(" ");

const describeTool = (options: McpToolsOptions): string => {
  const lines = [
    "Set the title and body of the pull request ostra opens for a repo when this task's session ends with changes.",
    "Call it once per changed repo, before you finish. A later call for the same repo replaces the earlier text.",
    `Keep the title to one line, close to the task's own title ("${options.taskTitle.slice(0, 200)}"), at most ${String(PR_TITLE_MAX)} characters.`,
    `The body is Markdown, at most ${String(PR_BODY_MAX)} characters: say what changed and why, and how it was checked.`,
    "",
    "The task's repos:",
  ];
  for (const repo of options.repos) {
    if (repo.prTemplate === null) {
      lines.push(`- ${repo.fullName}: no pull request template.`);
    } else {
      lines.push(`- ${repo.fullName}: has a pull request template. Follow it: fill in each of its sections. The template:`);
      lines.push("```markdown", repo.prTemplate.slice(0, TEMPLATE_IN_DESCRIPTION_MAX), "```");
    }
  }
  return lines.join("\n");
};

type ToolAnswer = { content: { type: "text"; text: string }[]; isError?: boolean };

const answer = (text: string, isError = false): ToolAnswer => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const readBody = async (request: IncomingMessage, limit: number): Promise<Buffer | null> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += value.length;
    if (total > limit) {
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

/** A search's results as the agent reads them. Never logged. */
const searchText = (response: MemorySearchResponse): string => {
  if (response.results.length === 0) {
    return "No approved memory note matches that search.";
  }
  return [
    `${String(response.results.length)} approved memory note${response.results.length === 1 ? "" : "s"} matched. Read one in full with memory_read.`,
    ...response.results.map((result) => `- ${result.noteId} (${result.kind}, ${result.scope}): ${result.title}\n  ${result.line}`),
  ].join("\n");
};

/** A note as the agent reads it. Never logged. */
const noteText = (note: MemoryNoteResponse): string =>
  [`# ${note.title}`, "", `An approved ${note.scope} note (${note.kind}), ${note.noteId}, version ${String(note.version)}.`, "", note.body].join("\n");

/** Core's answer to a proposal, in words for the agent. */
const proposalText = (response: MemoryProposalResponse): ToolAnswer => {
  if ("proposalId" in response) {
    return answer(`Proposed as ${response.proposalId}. A member approves it before any agent sees it; it doesn't reach this session.`);
  }
  switch (response.code) {
    case "secret-found":
      return answer(`The proposal was refused: it holds ${response.found.join(", ")}. A memory note never holds a secret: take it out and propose it again.`, true);
    case "limit-reached":
      return answer(`The proposal was refused: this task has made the ${String(runnerLimits.memoryProposalsPerTask)} proposals a task may make.`, true);
    case "invalid":
      return answer("The proposal was refused: core couldn't read it as a note.", true);
    default:
      return response satisfies never;
  }
};

/** What a milestone 6 tool says when core can't be reached: nothing was saved. */
export const TEAM_TOOL_UNAVAILABLE = "ostra can't be reached right now, so nothing was saved. Try the call again in a moment.";

/** The most one MCP request may carry: the tool's caps, with room for JSON-RPC. */
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export const startMcpTools = async (options: McpToolsOptions): Promise<McpTools> => {
  const bearer = randomBytes(32).toString("base64url");
  const log = options.logger.child({ taskId: options.taskId, component: "mcp-tools" });
  const description = describeTool(options);

  const setPrText = (input: z.infer<typeof inputSchema>): ToolAnswer => {
    const repo = options.repos.find((item) => item.fullName.toLowerCase() === input.repo.trim().toLowerCase());
    if (repo === undefined) {
      log.info("tool call refused", { tool: SET_PR_TEXT_TOOL, reason: "unknown-repo" });
      return answer(`"${input.repo.slice(0, 100)}" isn't one of this task's repos: ${options.repos.map((item) => item.fullName).join(", ")}.`, true);
    }
    const title = input.title.replace(/\s+/g, " ").trim();
    if (title.length === 0 || title.length > PR_TITLE_MAX) {
      log.info("tool call refused", { tool: SET_PR_TEXT_TOOL, reason: "title-size", repoId: repo.repoId });
      return answer(`The title must be 1 to ${String(PR_TITLE_MAX)} characters on one line; it was ${String(title.length)}.`, true);
    }
    if (input.body.length > PR_BODY_MAX) {
      log.info("tool call refused", { tool: SET_PR_TEXT_TOOL, reason: "body-size", repoId: repo.repoId });
      return answer(`The body must be at most ${String(PR_BODY_MAX)} characters; it was ${String(input.body.length)}. Shorten it.`, true);
    }
    options.onPrText({ kind: "pr.text_set", repoId: repo.repoId, title, body: input.body });
    log.info("pull request text set", { repoId: repo.repoId, titleChars: title.length, bodyChars: input.body.length });
    return answer(`Saved the pull request text for ${repo.fullName}. ostra opens the pull request when the session ends with changes.`);
  };

  // ---- memory (minor 3) ----
  /** The notes this turn's searches found: a read of one is `via: "search"`. IDs only. */
  let searchedThisTurn = new Set<NoteId>();
  const failed = (tool: string, failure: MemoryCallFailure): ToolAnswer => {
    log.info("memory call failed", { tool, failure: failure.kind, ...(failure.kind === "refused" ? { status: failure.status } : {}) });
    return failure.kind === "unavailable" ? answer(MEMORY_UNAVAILABLE, true) : answer(failure.message, true);
  };

  const memorySearch = async (memory: McpMemoryOptions, input: z.infer<typeof memorySearchInputSchema>): Promise<ToolAnswer> => {
    const request = memorySearchRequestSchema.safeParse({ query: input.query, limit: input.limit ?? DEFAULT_SEARCH_LIMIT });
    if (!request.success) {
      log.info("tool call refused", { tool: MEMORY_SEARCH_TOOL, reason: "invalid" });
      return answer(
        `A search is a query of 1 to ${String(runnerLimits.memoryQueryMaxChars)} characters and a limit of 1 to ${String(runnerLimits.memorySearchResultsMax)}.`,
        true,
      );
    }
    const result = await memory.link.search(options.taskId, request.data);
    if (!result.ok) {
      return failed(MEMORY_SEARCH_TOOL, result.failure);
    }
    for (const found of result.value.results) {
      searchedThisTurn.add(found.noteId);
    }
    log.info("memory searched", { results: result.value.results.length });
    return answer(searchText(result.value));
  };

  const memoryRead = async (memory: McpMemoryOptions, input: z.infer<typeof memoryReadInputSchema>): Promise<ToolAnswer> => {
    const noteId = noteIdSchema.safeParse(input.noteId.trim());
    if (!noteId.success) {
      log.info("tool call refused", { tool: MEMORY_READ_TOOL, reason: "invalid" });
      return answer("That isn't a note's ID: use one the memory index or a search lists.", true);
    }
    const result = await memory.link.read(options.taskId, noteId.data);
    if (!result.ok) {
      return failed(MEMORY_READ_TOOL, result.failure);
    }
    const via = searchedThisTurn.has(result.value.noteId) ? "search" : "read";
    memory.onUsed({ kind: "memory.used", noteIds: [result.value.noteId], via });
    log.info("memory note read", { noteId: result.value.noteId, via });
    return answer(noteText(result.value));
  };

  const memoryPropose = async (memory: McpMemoryOptions, input: z.infer<typeof memoryProposeInputSchema>): Promise<ToolAnswer> => {
    const request = memoryProposalRequestSchema.safeParse({ ...input, relatesTo: input.relatesTo ?? null, relation: input.relation ?? null });
    if (!request.success) {
      log.info("tool call refused", { tool: MEMORY_PROPOSE_TOOL, reason: "invalid" });
      return answer(
        `A proposal is a one-line title of at most ${String(runnerLimits.memoryNoteTitleMaxChars)} characters, a body of at most 4 KiB, a kind and a scope; relatesTo and relation go together.`,
        true,
      );
    }
    const result = await memory.link.propose(options.taskId, request.data);
    if (!result.ok) {
      return failed(MEMORY_PROPOSE_TOOL, result.failure);
    }
    if ("proposalId" in result.value) {
      log.info("memory proposed", { proposalId: result.value.proposalId });
    } else {
      log.info("memory proposal refused", { code: result.value.code });
    }
    return proposalText(result.value);
  };

  // ---- milestone 6: the draft, the review and the proposal (minor 5) ----
  const toolRepos = options.repos.map((repo) => ({ repoId: repo.repoId, fullName: repo.fullName }));
  const teamFailed = (tool: string, failure: MemoryCallFailure): ToolAnswer => {
    log.info("tool call failed", { tool, failure: failure.kind, ...(failure.kind === "refused" ? { status: failure.status } : {}) });
    return failure.kind === "unavailable" ? answer(TEAM_TOOL_UNAVAILABLE, true) : answer(failure.message, true);
  };

  const submitDraft = async (team: TeamLink, input: SubmitDraftInput): Promise<ToolAnswer> => {
    const result = await team.draft(options.taskId, input);
    if (!result.ok) {
      return teamFailed(SUBMIT_DRAFT_TOOL, result.failure);
    }
    const response = result.value;
    if ("draftId" in response) {
      log.info("draft submitted", { draftId: response.draftId, version: response.version, acceptanceCriteria: input.acceptanceCriteria.length, subTickets: input.subTickets.length });
      return answer(draftResultText(response));
    }
    log.info("draft refused", { code: response.code });
    return answer(draftResultText(response), true);
  };

  const submitReview = async (team: TeamLink, input: SubmitReviewInput): Promise<ToolAnswer> => {
    const mapped = reviewRequestFromTool(input, toolRepos);
    if (!mapped.ok) {
      log.info("tool call refused", { tool: SUBMIT_REVIEW_TOOL, reason: "unknown-repo" });
      return answer(unknownRepoText(mapped.unknownRepo), true);
    }
    const result = await team.review(options.taskId, mapped.value);
    if (!result.ok) {
      return teamFailed(SUBMIT_REVIEW_TOOL, result.failure);
    }
    const response = result.value;
    if ("reviewRunId" in response) {
      const blocking = input.findings.filter((finding) => finding.severity === "blocking").length;
      log.info("review submitted", { reviewRunId: response.reviewRunId, findings: input.findings.length, blocking });
      return answer(reviewResultText(response));
    }
    log.info("review refused", { code: response.code });
    return answer(reviewResultText(response), true);
  };

  const proposeEnvironment = async (team: TeamLink, input: ProposeEnvironmentInput): Promise<ToolAnswer> => {
    const mapped = environmentProposalRequestFromTool(input, toolRepos);
    if (!mapped.ok) {
      log.info("tool call refused", { tool: PROPOSE_ENVIRONMENT_TOOL, reason: "unknown-repo" });
      return answer(unknownRepoText(mapped.unknownRepo), true);
    }
    const result = await team.environmentProposal(options.taskId, mapped.value);
    if (!result.ok) {
      return teamFailed(PROPOSE_ENVIRONMENT_TOOL, result.failure);
    }
    const response = result.value;
    if ("proposalId" in response) {
      log.info("environment proposed", { proposalId: response.proposalId, repos: input.repos.length, services: input.services.length });
      return answer(environmentProposalResultText(response));
    }
    log.info("environment proposal refused", { code: response.code });
    return answer(environmentProposalResultText(response), true);
  };

  const toolSets: ReadonlySet<OstraToolSet> = new Set(options.tools ?? defaultOstraToolSets);

  const newServer = (): McpServer => {
    const server = new McpServer({ name: "ostra", version: RUNNER_VERSION });
    if (toolSets.has("pr-text")) {
      server.registerTool(
        SET_PR_TEXT_TOOL,
        { title: "Set the pull request's title and body", description, inputSchema },
        (input) => setPrText(input),
      );
    }
    const team = options.team;
    if (team !== undefined && toolSets.has("draft")) {
      server.registerTool(
        SUBMIT_DRAFT_TOOL,
        { title: "Hand in the refined ticket", description: submitDraftDescription, inputSchema: submitDraftInputSchema },
        (input) => submitDraft(team, input),
      );
    }
    if (team !== undefined && toolSets.has("review")) {
      server.registerTool(
        SUBMIT_REVIEW_TOOL,
        { title: "Hand in the review", description: submitReviewDescription, inputSchema: submitReviewInputSchema },
        (input) => submitReview(team, input),
      );
    }
    if (team !== undefined && toolSets.has("environment")) {
      server.registerTool(
        PROPOSE_ENVIRONMENT_TOOL,
        { title: "Propose the environment", description: proposeEnvironmentDescription, inputSchema: proposeEnvironmentInputSchema },
        (input) => proposeEnvironment(team, input),
      );
    }
    const memory = toolSets.has("memory") ? options.memory : undefined;
    if (memory !== undefined) {
      server.registerTool(MEMORY_SEARCH_TOOL, { title: "Search memory", description: SEARCH_DESCRIPTION, inputSchema: memorySearchInputSchema }, (input) =>
        memorySearch(memory, input),
      );
      server.registerTool(MEMORY_READ_TOOL, { title: "Read a memory note", description: READ_DESCRIPTION, inputSchema: memoryReadInputSchema }, (input) =>
        memoryRead(memory, input),
      );
      server.registerTool(
        MEMORY_PROPOSE_TOOL,
        { title: "Propose a memory note", description: PROPOSE_DESCRIPTION, inputSchema: memoryProposeInputSchema },
        (input) => memoryPropose(memory, input),
      );
    }
    return server;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://mcp.invalid");
    if (url.pathname !== MCP_PATH) {
      request.resume();
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    const header = request.headers.authorization;
    const presented = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
    if (presented === undefined || !sameSecret(presented, bearer)) {
      request.resume();
      log.warn("MCP request refused", { reason: presented === undefined ? "no-bearer" : "wrong-bearer" });
      response
        .writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="ostra"' })
        .end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body: unknown;
    if (request.method === "POST") {
      const raw = await readBody(request, MAX_REQUEST_BYTES);
      if (raw === null) {
        response.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "too large" }));
        return;
      }
      const parsed = parseJson(raw.toString("utf8"));
      if (!parsed.ok) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "not JSON" }));
        return;
      }
      body = parsed.value;
    }
    // Stateless: a server and a transport per request, so no session lingers between calls.
    const server = newServer();
    const transport = new StreamableHTTPServerTransport({});
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  };

  const http = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log.warn("MCP request failed", { error: error instanceof Error ? error.name : "unknown" });
      if (!response.headersSent) {
        response.writeHead(500).end();
      } else {
        response.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, options.listenHost, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address: AddressInfo | string | null = http.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://${options.advertiseHost ?? options.listenHost}:${String(port)}${MCP_PATH}`,
    bearer,
    turnStarted: () => {
      searchedThisTurn = new Set();
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
  };
};
