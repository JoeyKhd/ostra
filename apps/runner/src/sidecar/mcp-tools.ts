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
  fencedNoteText,
  MEMORY_PROPOSE_TOOL,
  MEMORY_READ_TOOL,
  MEMORY_SEARCH_TOOL,
  memoryKindSchema,
  memoryProposalRequestSchema,
  memoryScopeSchema,
  memorySearchRequestSchema,
  noteIdSchema,
  parseJson,
  PR_TITLE_TARGET_CHARS,
  prTitleSchema,
  PROPOSE_ENVIRONMENT_TOOL,
  proposeEnvironmentDescription,
  proposeEnvironmentInputSchema,
  proposalRelationSchema,
  quotedNoteLine,
  RECORD_APP_TOOL,
  recordAppDescription,
  recordAppInputSchema,
  reviewRequestFromTool,
  reviewResultText,
  runnerLimits,
  SHOW_PREVIEW_TOOL,
  showPreviewDescription,
  showPreviewInputSchema,
  START_APP_TOOL,
  startAppDescription,
  startAppInputSchema,
  SUBMIT_DRAFT_TOOL,
  SUBMIT_REVIEW_TOOL,
  submitDraftDescription,
  submitDraftInputSchema,
  submitReviewDescription,
  submitReviewInputSchema,
  TAKE_SCREENSHOT_TOOL,
  takeScreenshotDescription,
  takeScreenshotInputSchema,
  unknownRepoText,
} from "@ostra/protocol";
import type {
  MemoryNoteResponse,
  MemoryProposalResponse,
  MemorySearchResponse,
  NoteId,
  OstraToolSet,
  ProposeEnvironmentInput,
  RecordAppInput,
  RepoFullName,
  RepoId,
  ShowPreviewInput,
  SubmitDraftInput,
  SubmitReviewInput,
  TakeScreenshotInput,
  TaskEventOf,
  TaskId,
  TicketKey,
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
// and size caps, never passed to a shell, and handed on as a `pr.text_set` event (data). Since
// 2026-11-22 (F-030/c2, the maintainer's report of a PR titled "hiiiiiiiiiiiii"), the title is the
// agent's own summary of the change, in the repo's style for PR titles and commit subjects, read
// through the protocol's `prTitleSchema` (one line, no control characters, cut to its cap); a ticket
// task's key is ostra's to put in front, so the agent is told not to write it.
//
// Milestone 4 (ticket 20, ADR 0044, F-110, F-111): with the spec's `memory.tools`, three more tools,
// `memory_search`, `memory_read` and `memory_propose`. Each input is parsed with the protocol's
// strict schemas and forwarded to core's `/runner/v1/tasks/:taskId/memory/*` with the link's token,
// which stays in the runner's memory: the agent's bearer grants these tools and nothing else. A
// refusal from core goes back as the tool's error text, a network failure as "Memory is unavailable
// right now". A read is reported as `memory.used` (`search` when the note came from a search in the
// same turn). A query, a note's text and a proposal's text are never logged: counts and IDs only.
// Since 2026-11-21 (ADR 0044, borrowed from claude-mem's batched `get_observations`), `memory_read`
// takes up to 10 IDs in `noteIds` beside the one `noteId`: each is read from core's endpoint for one
// note, so core checks every one against the task's organization and project, and an ID it doesn't
// answer for is "not found", whether no such note exists or it's another scope's.
//
// Milestone 6 (tickets 22 and 23, protocol minor 5): the server serves exactly the tool sets the
// spec's `tools` names (`taskSpecToolSets`): `pr-text` is `set_pull_request_text`, `memory` the three
// memory tools, `draft` is `submit_draft`, `review` is `submit_review` and `environment` is
// `propose_environment`. Each new tool's input is checked against the protocol's own schema
// (`mcp/tools.ts`), its repos named by `owner/name` and turned into IDs here, and the call is
// forwarded to core's `/runner/v1/tasks/:taskId/{draft,review,environment-proposal}` with the link's
// token. Core's answer, a refusal included, goes back in the protocol's words. A draft's, a
// finding's and a proposal's text are never logged: counts and IDs only.
//
// Milestone 8 (ticket 12, protocol minor 7): with the `app` set, `start_app` and `show_preview`,
// the box's own app (`task-host/app-processes.ts`): the start waits for each process's ready check
// and answers each one's state, address and log path; a shown port is checked against the box's own
// ports and the limit before it joins the task's previews. A process's command and its log never
// reach a log line or the tool's answer.
//
// Milestone 8 (ticket 13): `take_screenshot` and `record_app`, the box's pictures
// (`task-host/app-pictures.ts`): each in a page of its own in the box's browser, uploaded as a blob
// of the task, its answer the attachment's ID or why there's none. A caption, a step and a path
// never reach a log line: the tool's name and counts only.
//
// Milestone 10 (ticket 06, F-151, protocol minor 9): a repeat `submit_review`, for a round whose
// review is already in, is answered by core `{ reviewRunId, already: true }`. That's a success:
// the agent reads `reviewResultText`'s already words with no error, so it reports the call done and
// the thread never draws it failed. Its log line says `already` beside the run's ID. A refusal is
// still an error.

export const SET_PR_TEXT_TOOL = "set_pull_request_text";
// The memory tools' names are the protocol's, which the thread reads them by (`ostraToolOf`, F-151).
export { MEMORY_PROPOSE_TOOL, MEMORY_READ_TOOL, MEMORY_SEARCH_TOOL };
/** What the agent reads when core can't be reached. */
export const MEMORY_UNAVAILABLE = "Memory is unavailable right now. Carry on without it, and try again later if you need it.";
/** A search's results when the agent names no limit. */
const DEFAULT_SEARCH_LIMIT = 5;
/** The path the server answers on. */
export const MCP_PATH = "/mcp";
/** The most a title may be before it's cleaned (`prTitleSchema` cuts it to its cap). */
const PR_TITLE_INPUT_MAX = 1024;
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
  /** A ticket task's key, which ostra puts in front of the PR's title; `null` or absent for a prompt task. */
  readonly ticketKey?: TicketKey | null;
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
  /** Minor 7 (ticket 12): the box's app, for the `app` set's `start_app` and `show_preview`. */
  readonly app?: McpAppTools;
};

/** What the `app` set's tools reach: the box's app processes and previews, in words for the agent. */
export type McpAppTools = {
  /** `start_app`: these processes, or all (`null`), each until it's ready or failed. */
  readonly start: (names: readonly string[] | null) => Promise<{ readonly text: string; readonly isError: boolean }>;
  /** `show_preview`: a port the agent started, for the task's previews. */
  readonly announce: (input: ShowPreviewInput) => Promise<{ readonly text: string; readonly isError: boolean }>;
  /** Ticket 13, `take_screenshot`: a screenshot of the app in the box's browser. */
  readonly screenshot: (input: TakeScreenshotInput) => Promise<{ readonly text: string; readonly isError: boolean }>;
  /** Ticket 13, `record_app`: a recording of the app while its steps run. */
  readonly record: (input: RecordAppInput) => Promise<{ readonly text: string; readonly isError: boolean }>;
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
  title: z
    .string()
    .min(1)
    .max(PR_TITLE_INPUT_MAX)
    .describe(`The pull request's title: a short imperative summary of what it changes, in the repo's style, on one line of at most ${String(PR_TITLE_TARGET_CHARS)} characters.`),
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

/** The most notes one `memory_read` reads (ADR 0044, 2026-11-21). */
const READ_NOTES_MAX = runnerLimits.memoryReadNotesMax;

const memoryReadInputSchema = z.strictObject({
  noteId: z.string().optional().describe("One note's ID, as the memory index or a search lists it."),
  noteIds: z
    .array(z.string())
    .optional()
    .describe(`Several notes' IDs, up to ${String(READ_NOTES_MAX)}, to read them all in this one call.`),
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
  "Returns each match's ID, title, kind and the line that matched. Read the ones you need in full with memory_read, all in one call.",
].join(" ");
const READ_DESCRIPTION = [
  "Read approved memory notes in full, by their IDs from the memory index or a search.",
  `To read several, name them all in noteIds (up to ${String(READ_NOTES_MAX)}) in one call, rather than calling once per note.`,
  "An ID that isn't an approved note of this project or its organization is reported as not found.",
].join(" ");
const PROPOSE_DESCRIPTION = [
  "Propose a memory note for the next tasks: a convention, a command, a gotcha, a decision, a preference or a term you learned here.",
  "A member approves it before any agent sees it, so it doesn't reach this session.",
  "If it contradicts or refines a note, name that note in relatesTo and say how in relation.",
  "Never put a secret, a token or a password in a note: such a proposal is refused.",
].join(" ");

const describeTool = (options: McpToolsOptions): string => {
  const lines = [
    "Set the title and body of the pull request ostra opens for a repo when this task's session ends with changes.",
    "Call it once per changed repo, before you finish. A later call for the same repo replaces the earlier text, and once the pull request is open, a new title renames it.",
    [
      "The title says what the pull request changes: a short summary in the imperative, such as \"Add a history panel to the calculator\", not a copy of the member's message, which may be a greeting or a question.",
      "Write it in the repo's own style for pull request titles and commit subjects, which you read from its history (`git log -n 20 --format=%s`): a prefix like `feat:` or an emoji, the tense, the case.",
      `One line, at most ${String(PR_TITLE_TARGET_CHARS)} characters.`,
    ].join(" "),
    ...(options.ticketKey === undefined || options.ticketKey === null
      ? []
      : [`ostra puts the ticket's key in front of the title (\`${options.ticketKey}: ...\`): don't write the key yourself.`]),
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
    `${String(response.results.length)} approved memory note${response.results.length === 1 ? "" : "s"} matched. Read the ones you need in full with memory_read, in one call.`,
    // Each title and matched line quoted (F-110/c10), so a note's text can't pass for a line of the answer.
    ...response.results.map((result) => `- ${result.noteId} (${result.kind}, ${result.scope}): ${quotedNoteLine(result.title)}\n  ${quotedNoteLine(result.line)}`),
  ].join("\n");
};

/**
 * A note as the agent reads it: its title quoted, then its body in a fence no line of it can
 * close, its headings and ostra's markers neutralised (F-110/c10, ADR 0044's 2026-11-21 note). Never logged.
 */
const noteText = (note: MemoryNoteResponse): string =>
  [
    `Note ${quotedNoteLine(note.title)}: an approved ${note.scope} note (${note.kind}), ${note.noteId}, version ${String(note.version)}. Its text, as approved:`,
    "",
    fencedNoteText(note.body),
  ].join("\n");

/** An ID the agent named, as the answer quotes it back: one line, cut. */
const quotedId = (raw: string): string => raw.replaceAll(/\s+/g, " ").slice(0, 100);

/** One note's read in a read of several: the note, or why there's none. */
type NoteRead =
  | { readonly kind: "read"; readonly note: MemoryNoteResponse }
  | { readonly kind: "not-found"; readonly asked: string }
  | { readonly kind: "failed"; readonly asked: string; readonly failure: MemoryCallFailure };

/**
 * A read of several notes as the agent reads them (F-110/c9): each note found, in the order asked,
 * then the IDs not found, in one line that never says whether such a note is somewhere else. Never logged.
 */
const notesText = (reads: readonly NoteRead[]): string => {
  const found = reads.flatMap((read) => (read.kind === "read" ? [read.note] : []));
  const missing = reads.flatMap((read) => (read.kind === "not-found" ? [quotedId(read.asked)] : []));
  const failed = reads.flatMap((read) => (read.kind === "failed" ? [quotedId(read.asked)] : []));
  const parts = [`Read ${String(found.length)} of the ${String(reads.length)} memory notes asked for.`, ...found.map(noteText)];
  if (missing.length > 0) {
    parts.push(`Not found: ${missing.join(", ")}. None of these is an approved memory note of this project or its organization.`);
  }
  if (failed.length > 0) {
    parts.push(`Not read: ${failed.join(", ")}. Memory couldn't answer for these right now; try them again later if you need them.`);
  }
  return parts.join("\n\n");
};

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
    // Untrusted: one line, its control characters stripped, cut at a word to the protocol's cap.
    const cleaned = prTitleSchema.safeParse(input.title);
    if (!cleaned.success) {
      log.info("tool call refused", { tool: SET_PR_TEXT_TOOL, reason: "title-empty", repoId: repo.repoId });
      return answer(`The title must say what the pull request changes, on one line of at most ${String(PR_TITLE_TARGET_CHARS)} characters.`, true);
    }
    const title = cleaned.data;
    if (input.body.length > PR_BODY_MAX) {
      log.info("tool call refused", { tool: SET_PR_TEXT_TOOL, reason: "body-size", repoId: repo.repoId });
      return answer(`The body must be at most ${String(PR_BODY_MAX)} characters; it was ${String(input.body.length)}. Shorten it.`, true);
    }
    options.onPrText({ kind: "pr.text_set", repoId: repo.repoId, title, body: input.body });
    log.info("pull request text set", { repoId: repo.repoId, titleChars: title.length, bodyChars: input.body.length });
    return answer(`Saved the pull request text for ${repo.fullName}, titled "${title}". ostra opens the pull request when the session ends with changes.`);
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

  /** The notes read, as `memory.used`: those this turn's search found as `search`, the others as `read`. */
  const reportReads = (memory: McpMemoryOptions, notes: readonly MemoryNoteResponse[]): void => {
    const searched = notes.filter((note) => searchedThisTurn.has(note.noteId)).map((note) => note.noteId);
    const read = notes.filter((note) => !searchedThisTurn.has(note.noteId)).map((note) => note.noteId);
    if (searched.length > 0) {
      memory.onUsed({ kind: "memory.used", noteIds: searched, via: "search" });
    }
    if (read.length > 0) {
      memory.onUsed({ kind: "memory.used", noteIds: read, via: "read" });
    }
  };

  const memoryRead = async (memory: McpMemoryOptions, input: z.infer<typeof memoryReadInputSchema>): Promise<ToolAnswer> => {
    const asked = [...new Set([...(input.noteId === undefined ? [] : [input.noteId]), ...(input.noteIds ?? [])].map((id) => id.trim()))];
    if (asked.length === 0 || asked.length > READ_NOTES_MAX) {
      log.info("tool call refused", { tool: MEMORY_READ_TOOL, reason: asked.length === 0 ? "no-id" : "too-many", ids: asked.length });
      return answer(`Name the notes to read: one ID in noteId, or up to ${String(READ_NOTES_MAX)} in noteIds.`, true);
    }
    const [only] = asked;
    if (asked.length === 1 && only !== undefined) {
      // One note: its text, or core's words for why not, as before the reads of several.
      const noteId = noteIdSchema.safeParse(only);
      if (!noteId.success) {
        log.info("tool call refused", { tool: MEMORY_READ_TOOL, reason: "invalid" });
        return answer("That isn't a note's ID: use one the memory index or a search lists.", true);
      }
      const result = await memory.link.read(options.taskId, noteId.data);
      if (!result.ok) {
        return failed(MEMORY_READ_TOOL, result.failure);
      }
      reportReads(memory, [result.value]);
      log.info("memory note read", { noteId: result.value.noteId, via: searchedThisTurn.has(result.value.noteId) ? "search" : "read" });
      return answer(noteText(result.value));
    }
    // Several (F-110/c9): each through core's own endpoint, which answers within the task's
    // organization and project only, so a note of another scope is a 404 like a note that isn't.
    const reads = await Promise.all(
      asked.map(async (raw): Promise<NoteRead> => {
        const noteId = noteIdSchema.safeParse(raw);
        if (!noteId.success) {
          return { kind: "not-found", asked: raw };
        }
        const result = await memory.link.read(options.taskId, noteId.data);
        if (result.ok) {
          return { kind: "read", note: result.value };
        }
        return result.failure.kind === "refused" && result.failure.status === 404
          ? { kind: "not-found", asked: raw }
          : { kind: "failed", asked: raw, failure: result.failure };
      }),
    );
    const notes = reads.flatMap((read) => (read.kind === "read" ? [read.note] : []));
    log.info("memory notes read", {
      asked: asked.length,
      read: notes.length,
      notFound: reads.filter((read) => read.kind === "not-found").length,
      failed: reads.filter((read) => read.kind === "failed").length,
    });
    if (notes.length === 0) {
      const failure = reads.find((read) => read.kind === "failed");
      if (failure?.kind === "failed" && reads.every((read) => read.kind === "failed")) {
        return failed(MEMORY_READ_TOOL, failure.failure);
      }
      return answer(notesText(reads), true);
    }
    reportReads(memory, notes);
    return answer(notesText(reads));
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
      // Minor 9 (F-151): a repeat hand-in, for a round already in, is a success too; it changed nothing.
      log.info("review submitted", {
        reviewRunId: response.reviewRunId,
        findings: input.findings.length,
        blocking,
        ...(response.already === true ? { already: true } : {}),
      });
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
    const app = toolSets.has("app") ? options.app : undefined;
    if (app !== undefined) {
      server.registerTool(START_APP_TOOL, { title: "Start the app", description: startAppDescription, inputSchema: startAppInputSchema }, async (input) => {
        log.info("app tool called", { tool: START_APP_TOOL, names: input.names?.length ?? null });
        const result = await app.start(input.names ?? null);
        return answer(result.text, result.isError);
      });
      server.registerTool(
        SHOW_PREVIEW_TOOL,
        { title: "Show a port in the task's preview pane", description: showPreviewDescription, inputSchema: showPreviewInputSchema },
        async (input) => {
          log.info("app tool called", { tool: SHOW_PREVIEW_TOOL, port: input.port });
          const result = await app.announce(input);
          return answer(result.text, result.isError);
        },
      );
      server.registerTool(
        TAKE_SCREENSHOT_TOOL,
        { title: "Take a screenshot of the app", description: takeScreenshotDescription, inputSchema: takeScreenshotInputSchema },
        async (input) => {
          // The target's kind and the size asked: never the caption or the path.
          log.info("app tool called", { tool: TAKE_SCREENSHOT_TOOL, target: "process" in input.target ? "process" : "port", width: input.width ?? null, fullPage: input.fullPage === true });
          const result = await app.screenshot(input);
          return answer(result.text, result.isError);
        },
      );
      server.registerTool(
        RECORD_APP_TOOL,
        { title: "Record the app while steps run", description: recordAppDescription, inputSchema: recordAppInputSchema },
        async (input) => {
          // How many steps and seconds: never a step or the caption.
          log.info("app tool called", { tool: RECORD_APP_TOOL, target: "process" in input.target ? "process" : "port", steps: input.steps.length, seconds: input.seconds ?? null });
          const result = await app.record(input);
          return answer(result.text, result.isError);
        },
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
