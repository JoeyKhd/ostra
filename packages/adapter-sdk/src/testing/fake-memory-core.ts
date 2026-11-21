import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  draftIdSchema,
  draftRequestSchema,
  draftResponseSchema,
  draftResultText,
  environmentProposalIdSchema,
  environmentProposalRequestFromTool,
  environmentProposalRequestSchema,
  environmentProposalResponseSchema,
  environmentProposalResultText,
  PROPOSE_ENVIRONMENT_TOOL,
  proposeEnvironmentDescription,
  proposeEnvironmentInputSchema,
  reviewRequestFromTool,
  reviewRequestSchema,
  reviewResponseSchema,
  reviewResultText,
  reviewRunIdSchema,
  SUBMIT_DRAFT_TOOL,
  SUBMIT_REVIEW_TOOL,
  submitDraftDescription,
  submitDraftInputSchema,
  submitReviewDescription,
  submitReviewInputSchema,
  unknownRepoText,
  memoryNoteResponseSchema,
  memoryProposalRequestSchema,
  memoryProposalResponseSchema,
  memorySearchRequestSchema,
  memorySearchResponseSchema,
  noteIdSchema,
  proposalIdSchema,
  runnerLimits,
  runnerPaths,
  appToolNames,
  attachmentResultText,
  RECORD_APP_TOOL,
  recordAppDescription,
  recordAppInputSchema,
  SHOW_PREVIEW_TOOL,
  showPreviewDescription,
  showPreviewInputSchema,
  showPreviewResultText,
  START_APP_TOOL,
  startAppDescription,
  startAppInputSchema,
  startAppResultText,
  TAKE_SCREENSHOT_TOOL,
  takeScreenshotDescription,
  takeScreenshotInputSchema,
  viewportPresetSizes,
} from "@ostra/protocol";
import type {
  TakeScreenshotInput,
  DraftRefusal,
  DraftRequestBody,
  DraftResponse,
  EnvironmentProposal,
  EnvironmentProposalRefusal,
  EnvironmentProposalResponse,
  MemoryNote,
  MemoryProposalInput,
  MemoryProposalResponse,
  MemorySearchResponse,
  OstraToolSet,
  ReviewRefusal,
  ReviewRequestBody,
  ReviewResponse,
  TaskId,
  ToolRepo,
} from "@ostra/protocol";
import { z } from "zod";

// Milestone 4 (ticket 02, F-110, F-111): a fake core for the sidecar's memory endpoints, answering
// by the protocol's schemas (minor 3), and in front of it a stand-in for the sidecar's MCP server
// (ticket 20 builds the real one), so an agent's `memory_search`, `memory_read` and
// `memory_propose` round-trip the way they will: the agent calls an MCP tool, and the MCP server
// calls core's runner HTTP with the task's token.
//
// - `POST runnerPaths.taskMemorySearch(taskId)`: a search over the fixture's notes, by every word of
//   the query in a note's title or body, case-insensitive; the result carries the matching line.
// - `GET runnerPaths.taskMemoryNote(taskId, noteId)`: one note, or 404.
// - `POST runnerPaths.taskMemoryProposals(taskId)`: a proposal counted, with its ID, until the task's
//   cap (`limit-reached`); one that doesn't parse is `invalid`.
// - `POST /mcp`: JSON-RPC 2.0, `initialize`, `tools/list` and `tools/call`, with the MCP bearer.
//
// Every request without the right bearer is 401. Nothing here logs: a note's text, a query and a
// proposal's text are never logged.
//
// Milestone 6 (ticket 04) adds the sidecar's three new endpoints, by the protocol's schemas (minor
// 5): `POST runnerPaths.taskDraft`, `taskReview` and `taskEnvironmentProposal`, each recorded, or
// refused as the switch in `refusals` says. The MCP stand-in lists and serves the tools of the
// task's tool sets (`tools`): `submit_draft`, `submit_review` and `propose_environment` beside
// memory's, each answering the agent with the protocol's words.

export type FakeMemoryCoreOptions = {
  readonly taskId: TaskId;
  /** The task's token core's endpoints take, as the sidecar sends it. */
  readonly taskToken: string;
  /** The MCP server's bearer, as the agent's config carries it. */
  readonly mcpBearer: string;
  /** The approved notes the task can reach. */
  readonly notes: readonly MemoryNote[];
  /** The proposals a task may make. Default: the protocol's `memoryProposalsPerTask`. */
  readonly proposalLimit?: number;
  /** Milestone 6: the task's tool sets, which the MCP stand-in lists and serves. Default: milestone 4's, memory's tools. */
  readonly tools?: readonly OstraToolSet[];
  /** Milestone 6: the task's repos, which a finding or a proposal names by `owner/name`. */
  readonly repos?: readonly ToolRepo[];
};

/** Milestone 6: how core's three new endpoints answer: `null` saves, a refusal refuses. Tests flip them. */
export type FakeCoreRefusals = {
  draft: DraftRefusal | null;
  review: ReviewRefusal | null;
  environment: EnvironmentProposalRefusal | null;
};

export type FakeMemoryCore = {
  /** Core's address: the runner HTTP's base. */
  readonly url: string;
  /** The MCP server's address, for `PrepareLaunchInput.mcp.url`. */
  readonly mcpUrl: string;
  readonly mcpBearer: string;
  /** How many requests each endpoint answered, refused ones included. */
  readonly calls: { search: number; read: number; propose: number };
  /** The MCP tools called, in order. */
  readonly toolCalls: string[];
  /** The proposals recorded, in order. */
  readonly proposals: MemoryProposalInput[];
  // ---- milestone 6 ----
  /** Each endpoint's answer: saved, or the refusal set here. */
  readonly refusals: FakeCoreRefusals;
  /** What core saved, in order. */
  readonly drafts: DraftRequestBody[];
  readonly reviews: ReviewRequestBody[];
  readonly environmentProposals: EnvironmentProposal[];
  /** How many requests each new endpoint answered, refused ones included. */
  readonly teamCalls: { draft: number; review: number; environment: number };
  // ---- milestone 8 (ADR 0068) ----
  /** Each `take_screenshot` the agent made, its input as the tool parsed it. */
  readonly screenshots: TakeScreenshotInput[];
  readonly close: () => Promise<void>;
};

/** Two approved notes, for a fixture: a command and a convention, with code identifiers in them. */
export const memoryNoteFixtures: readonly MemoryNote[] = [
  { noteId: noteIdSchema.parse("note-pnpm"), title: "Use pnpm, never npm", body: "Run pnpm install at the root; npm install breaks the lockfile.", kind: "command", scope: "organization", version: 1 },
  { noteId: noteIdSchema.parse("note-branches"), title: "Branch names start with ostra/", body: "Every task branch is ostra/<ticket>, so the reconcile finds it.", kind: "convention", scope: "project", version: 2 },
];

/** The three tools, as `tools/list` offers them. */
export const memoryToolNames = ["memory_search", "memory_read", "memory_propose"] as const;

const MCP_PATH = "/mcp";

const memoryTools = [
  {
    name: "memory_search",
    description: "Search the project's memory notes. Returns each match's ID, title and the line that matched.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "memory_read",
    description: "Read one memory note in full, by its ID.",
    inputSchema: { type: "object", properties: { noteId: { type: "string" } }, required: ["noteId"] },
  },
  {
    name: "memory_propose",
    description: "Propose a note for a member to approve. It reaches no agent until approved.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        kind: { type: "string" },
        scope: { type: "string" },
        relatesTo: { type: ["string", "null"] },
        relation: { type: ["string", "null"] },
      },
      required: ["title", "body", "kind", "scope"],
    },
  },
] as const;

/** Milestone 6: the three tools, as `tools/list` offers them, by the protocol's descriptions and schemas. */
const teamTools = {
  draft: { name: SUBMIT_DRAFT_TOOL, description: submitDraftDescription, inputSchema: z.toJSONSchema(submitDraftInputSchema, { io: "input", unrepresentable: "any" }) },
  review: { name: SUBMIT_REVIEW_TOOL, description: submitReviewDescription, inputSchema: z.toJSONSchema(submitReviewInputSchema, { io: "input", unrepresentable: "any" }) },
  environment: {
    name: PROPOSE_ENVIRONMENT_TOOL,
    description: proposeEnvironmentDescription,
    inputSchema: z.toJSONSchema(proposeEnvironmentInputSchema, { io: "input", unrepresentable: "any" }),
  },
} as const;

const toolJsonSchema = (schema: z.ZodType): unknown => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });

/** Milestone 8 (ADR 0068): the four app tools, as `tools/list` offers them, by the protocol's descriptions and schemas. */
const appTools = [
  { name: START_APP_TOOL, description: startAppDescription, inputSchema: toolJsonSchema(startAppInputSchema) },
  { name: SHOW_PREVIEW_TOOL, description: showPreviewDescription, inputSchema: toolJsonSchema(showPreviewInputSchema) },
  { name: TAKE_SCREENSHOT_TOOL, description: takeScreenshotDescription, inputSchema: toolJsonSchema(takeScreenshotInputSchema) },
  { name: RECORD_APP_TOOL, description: recordAppDescription, inputSchema: toolJsonSchema(recordAppInputSchema) },
] as const;

/** The tools a task's tool sets list, memory's, milestone 6's and milestone 8's; `pr-text` is the sidecar's own (ticket 20), not this stand-in's. */
export const fakeCoreToolNames = (tools: readonly OstraToolSet[]): readonly string[] => [
  ...(tools.includes("memory") ? memoryToolNames : []),
  ...(tools.includes("draft") ? [SUBMIT_DRAFT_TOOL] : []),
  ...(tools.includes("review") ? [SUBMIT_REVIEW_TOOL] : []),
  ...(tools.includes("environment") ? [PROPOSE_ENVIRONMENT_TOOL] : []),
  ...(tools.includes("app") ? appToolNames : []),
];

/** The attachment ID the stand-in gives the first screenshot, `att-1`, then `att-2` and on: the protocol's words carry it back. */
export const fakeAttachmentId = (n: number): string => `att-${String(n)}`;

const jsonRpcSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const toolCallParamsSchema = z.looseObject({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** The search's answer: every note with all the query's words, by its first line that has one. */
const search = (notes: readonly MemoryNote[], query: string, limit: number): MemorySearchResponse => {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  const results = notes
    .filter((note) => words.every((word) => `${note.title}\n${note.body}`.toLowerCase().includes(word)))
    .slice(0, limit)
    .map((note) => {
      const line = [note.title, ...note.body.split("\n")].find((candidate) => words.some((word) => candidate.toLowerCase().includes(word))) ?? note.title;
      return { noteId: note.noteId, title: note.title, line: line.slice(0, runnerLimits.memoryQueryMaxChars), kind: note.kind, scope: note.scope };
    });
  return memorySearchResponseSchema.parse({ results });
};

export const startFakeMemoryCore = async (options: FakeMemoryCoreOptions): Promise<FakeMemoryCore> => {
  const limit = options.proposalLimit ?? runnerLimits.memoryProposalsPerTask;
  const toolSets: readonly OstraToolSet[] = options.tools ?? ["pr-text", "memory"];
  const offered = new Set(fakeCoreToolNames(toolSets));
  const refusals: FakeCoreRefusals = { draft: null, review: null, environment: null };
  const drafts: DraftRequestBody[] = [];
  const reviews: ReviewRequestBody[] = [];
  const environmentProposals: EnvironmentProposal[] = [];
  const teamCalls = { draft: 0, review: 0, environment: 0 };
  const calls = { search: 0, read: 0, propose: 0 };
  const toolCalls: string[] = [];
  const screenshots: TakeScreenshotInput[] = [];
  const proposals: MemoryProposalInput[] = [];
  let base = "";

  const searchPath = runnerPaths.taskMemorySearch(options.taskId);
  const proposalsPath = runnerPaths.taskMemoryProposals(options.taskId);
  const notePrefix = runnerPaths.taskMemoryNote(options.taskId, "");

  /** Core's runner HTTP, as the sidecar calls it. */
  const core = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    if (request.headers.authorization !== `Bearer ${options.taskToken}`) {
      send(response, 401, { error: "the task's token was refused" });
      return;
    }
    if (request.method === "POST" && path === searchPath) {
      calls.search += 1;
      const parsed = memorySearchRequestSchema.safeParse(parseJson(await readBody(request)));
      if (!parsed.success) {
        send(response, 400, { error: "a search is a query and a limit" });
        return;
      }
      send(response, 200, search(options.notes, parsed.data.query, parsed.data.limit));
      return;
    }
    if (request.method === "GET" && path.startsWith(notePrefix)) {
      calls.read += 1;
      const noteId = decodeURIComponent(path.slice(notePrefix.length));
      const note = options.notes.find((candidate) => candidate.noteId === noteId);
      if (note === undefined) {
        send(response, 404, { error: "no such note" });
        return;
      }
      send(response, 200, memoryNoteResponseSchema.parse(note));
      return;
    }
    // ---- milestone 6: the draft, the review and the proposal ----
    if (request.method === "POST" && path === runnerPaths.taskDraft(options.taskId)) {
      teamCalls.draft += 1;
      const parsed = draftRequestSchema.safeParse(parseJson(await readBody(request)));
      let answer: DraftResponse;
      if (!parsed.success) {
        answer = { code: "invalid" };
      } else if (refusals.draft !== null) {
        answer = refusals.draft;
      } else {
        drafts.push(parsed.data);
        answer = { draftId: draftIdSchema.parse(`draft-${String(drafts.length)}`), version: drafts.length };
      }
      send(response, 200, draftResponseSchema.parse(answer));
      return;
    }
    if (request.method === "POST" && path === runnerPaths.taskReview(options.taskId)) {
      teamCalls.review += 1;
      const parsed = reviewRequestSchema.safeParse(parseJson(await readBody(request)));
      let answer: ReviewResponse;
      if (!parsed.success) {
        answer = { code: "invalid" };
      } else if (refusals.review !== null) {
        answer = refusals.review;
      } else {
        reviews.push(parsed.data);
        answer = { reviewRunId: reviewRunIdSchema.parse(`review-run-${String(reviews.length)}`) };
      }
      send(response, 200, reviewResponseSchema.parse(answer));
      return;
    }
    if (request.method === "POST" && path === runnerPaths.taskEnvironmentProposal(options.taskId)) {
      teamCalls.environment += 1;
      const parsed = environmentProposalRequestSchema.safeParse(parseJson(await readBody(request)));
      let answer: EnvironmentProposalResponse;
      if (!parsed.success) {
        answer = { code: "invalid" };
      } else if (refusals.environment !== null) {
        answer = refusals.environment;
      } else {
        environmentProposals.push(parsed.data);
        answer = { proposalId: environmentProposalIdSchema.parse(`environment-proposal-${String(environmentProposals.length)}`) };
      }
      send(response, 200, environmentProposalResponseSchema.parse(answer));
      return;
    }
    if (request.method === "POST" && path === proposalsPath) {
      calls.propose += 1;
      const parsed = memoryProposalRequestSchema.safeParse(parseJson(await readBody(request)));
      let answer: MemoryProposalResponse;
      if (!parsed.success) {
        answer = { code: "invalid" };
      } else if (proposals.length >= limit) {
        answer = { code: "limit-reached" };
      } else {
        proposals.push(parsed.data);
        answer = { proposalId: proposalIdSchema.parse(`proposal-${String(proposals.length)}`) };
      }
      send(response, 200, memoryProposalResponseSchema.parse(answer));
      return;
    }
    send(response, 404, { error: "no such endpoint" });
  };

  /** Milestone 6: posts a tool's request to core with the task's token, and reads the answer by `schema`. */
  const postToCore = async <T,>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T | null> => {
    const answer = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.taskToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = schema.safeParse(answer.ok ? await answer.json() : undefined);
    return parsed.success ? parsed.data : null;
  };

  /**
   * Milestone 8: the sidecar's side of the app tools, as a box with no app would answer them: the
   * input parsed by the tool's schema, a screenshot recorded with the attachment's ID in the
   * protocol's words. The real tools are the runner's (tickets 12 and 13).
   */
  const callAppTool = (name: string, args: Readonly<Record<string, unknown>>): { readonly text: string; readonly saved: boolean } | undefined => {
    switch (name) {
      case START_APP_TOOL:
        return startAppInputSchema.safeParse(args).success ? { text: startAppResultText({ processes: [] }), saved: true } : { text: "invalid input", saved: false };
      case SHOW_PREVIEW_TOOL: {
        const input = showPreviewInputSchema.safeParse(args);
        return input.success ? { text: showPreviewResultText(input.data), saved: true } : { text: "invalid input", saved: false };
      }
      case TAKE_SCREENSHOT_TOOL: {
        const input = takeScreenshotInputSchema.safeParse(args);
        if (!input.success) return { text: "invalid input", saved: false };
        screenshots.push(input.data);
        const size = input.data.size ?? viewportPresetSizes[input.data.width ?? "desktop"];
        return {
          text: attachmentResultText({ attachmentId: fakeAttachmentId(screenshots.length), kind: "screenshot", width: size.width, height: size.height, durationMs: null, frameCount: null }),
          saved: true,
        };
      }
      case RECORD_APP_TOOL:
        return recordAppInputSchema.safeParse(args).success
          ? { text: attachmentResultText({ attachmentId: fakeAttachmentId(screenshots.length + 1), kind: "recording", width: 1440, height: 900, durationMs: 1000, frameCount: 10 }), saved: true }
          : { text: "invalid input", saved: false };
      default:
        return undefined;
    }
  };

  /**
   * Milestone 6: the sidecar's side of `submit_draft`, `submit_review` and `propose_environment`:
   * the agent's input parsed by the tool's schema, the repos named by ID, core's answer in the
   * protocol's words. A text result, as MCP's `content` carries it; `undefined` for another tool.
   */
  const callTeamTool = async (name: string, args: Readonly<Record<string, unknown>>): Promise<{ readonly text: string; readonly saved: boolean } | undefined> => {
    const repos = options.repos ?? [];
    switch (name) {
      case SUBMIT_DRAFT_TOOL: {
        const input = submitDraftInputSchema.safeParse(args);
        const answer: DraftResponse | null = input.success ? await postToCore(runnerPaths.taskDraft(options.taskId), input.data, draftResponseSchema) : { code: "invalid" };
        const response = answer ?? { code: "invalid" };
        return { text: draftResultText(response), saved: "draftId" in response };
      }
      case SUBMIT_REVIEW_TOOL: {
        const input = submitReviewInputSchema.safeParse(args);
        if (!input.success) return { text: reviewResultText({ code: "invalid" }), saved: false };
        const mapped = reviewRequestFromTool(input.data, repos);
        if (!mapped.ok) return { text: unknownRepoText(mapped.unknownRepo), saved: false };
        const response = (await postToCore(runnerPaths.taskReview(options.taskId), mapped.value, reviewResponseSchema)) ?? { code: "invalid" };
        return { text: reviewResultText(response), saved: "reviewRunId" in response };
      }
      case PROPOSE_ENVIRONMENT_TOOL: {
        const input = proposeEnvironmentInputSchema.safeParse(args);
        if (!input.success) return { text: environmentProposalResultText({ code: "invalid" }), saved: false };
        const mapped = environmentProposalRequestFromTool(input.data, repos);
        if (!mapped.ok) return { text: unknownRepoText(mapped.unknownRepo), saved: false };
        const response =
          (await postToCore(runnerPaths.taskEnvironmentProposal(options.taskId), mapped.value, environmentProposalResponseSchema)) ?? ({ code: "invalid" } as const);
        return { text: environmentProposalResultText(response), saved: "proposalId" in response };
      }
      default:
        return undefined;
    }
  };

  /** The sidecar's side of one tool call: core's endpoint, with the task's token. */
  const callTool = async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    const headers = { authorization: `Bearer ${options.taskToken}`, "content-type": "application/json" };
    switch (name) {
      case "memory_search": {
        const body = { query: args["query"], limit: args["limit"] ?? 5 };
        const answer = await fetch(`${base}${searchPath}`, { method: "POST", headers, body: JSON.stringify(body) });
        return answer.ok ? memorySearchResponseSchema.parse(await answer.json()) : { error: `the search was refused (${String(answer.status)})` };
      }
      case "memory_read": {
        const noteId = typeof args["noteId"] === "string" ? args["noteId"] : "";
        const answer = await fetch(`${base}${runnerPaths.taskMemoryNote(options.taskId, noteId)}`, { headers });
        return answer.ok ? memoryNoteResponseSchema.parse(await answer.json()) : { error: "no such note" };
      }
      case "memory_propose": {
        const body = { relatesTo: null, relation: null, ...args };
        const answer = await fetch(`${base}${proposalsPath}`, { method: "POST", headers, body: JSON.stringify(body) });
        return answer.ok ? memoryProposalResponseSchema.parse(await answer.json()) : { error: `the proposal was refused (${String(answer.status)})` };
      }
      default:
        return undefined;
    }
  };

  /** The MCP stand-in: JSON-RPC over one POST, answered as JSON. */
  const mcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.headers.authorization !== `Bearer ${options.mcpBearer}`) {
      send(response, 401, { error: "the MCP bearer was refused" });
      return;
    }
    const message = jsonRpcSchema.safeParse(parseJson(await readBody(request)));
    if (!message.success) {
      send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "not a JSON-RPC message" } });
      return;
    }
    const { id, method, params } = message.data;
    if (id === undefined) {
      // A notification, such as `notifications/initialized`.
      response.writeHead(202).end();
      return;
    }
    const reply = (result: unknown): void => {
      send(response, 200, { jsonrpc: "2.0", id, result });
    };
    switch (method) {
      case "initialize":
        reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ostra", version: "0.0.0" } });
        return;
      case "tools/list":
        reply({
          tools: [
            ...(toolSets.includes("memory") ? memoryTools : []),
            ...(toolSets.includes("draft") ? [teamTools.draft] : []),
            ...(toolSets.includes("review") ? [teamTools.review] : []),
            ...(toolSets.includes("environment") ? [teamTools.environment] : []),
            ...(toolSets.includes("app") ? appTools : []),
          ],
        });
        return;
      case "tools/call": {
        const call = toolCallParamsSchema.safeParse(params);
        if (call.success && !offered.has(call.data.name)) {
          // A tool outside the task's sets isn't served, whatever its name.
          send(response, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: "no such tool" } });
          return;
        }
        const team = call.success ? (callAppTool(call.data.name, call.data.arguments ?? {}) ?? (await callTeamTool(call.data.name, call.data.arguments ?? {}))) : undefined;
        if (call.success && team !== undefined) {
          toolCalls.push(call.data.name);
          reply({ content: [{ type: "text", text: team.text }], isError: !team.saved });
          return;
        }
        const result = call.success ? await callTool(call.data.name, call.data.arguments ?? {}) : undefined;
        if (!call.success || result === undefined) {
          send(response, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: "no such tool" } });
          return;
        }
        toolCalls.push(call.data.name);
        reply({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
        return;
      }
      default:
        send(response, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } });
    }
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    // No server-sent stream, as MCP's streamable HTTP lets a server say: a client that opens one
    // (OpenCode does, after `initialize`) goes on with plain answers.
    if (path === MCP_PATH && request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const handled = path === MCP_PATH ? mcp(request, response) : core(request, response, path);
    handled.catch(() => {
      if (!response.headersSent) send(response, 500, { error: "the fake core failed" });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() satisfies AddressInfo | string | null;
  if (address === null || typeof address === "string") {
    throw new Error("the fake memory core has no port");
  }
  base = `http://127.0.0.1:${String(address.port)}`;
  return {
    url: base,
    mcpUrl: `${base}${MCP_PATH}`,
    mcpBearer: options.mcpBearer,
    calls,
    toolCalls,
    proposals,
    refusals,
    drafts,
    reviews,
    environmentProposals,
    teamCalls,
    screenshots,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
