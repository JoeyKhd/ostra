import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "@ostra/adapter-sdk";
import { parseJson } from "@ostra/protocol";
import type { RepoFullName, RepoId, TaskEventOf, TaskId } from "@ostra/protocol";
import { z } from "zod";
import { RUNNER_VERSION } from "../version.ts";

// ostra's MCP tools for one task (ticket 20, F-030, F-078): an MCP server over Streamable HTTP
// that the agent's config points at (ticket 11). It listens on loopback on `host`, on the box
// network on `docker`, and takes only the random bearer it put in the agent's config, which grants
// this task's tools and nothing else. The runner's own server credentials never leave the runner.
//
// Milestone 1 has one tool, `set_pull_request_text`, which the agent calls to write the PR's title
// and body. Its input is untrusted: parsed with a strict schema, checked against the task's repos
// and size caps, never passed to a shell, and handed on as a `pr.text_set` event (data).

export const SET_PR_TEXT_TOOL = "set_pull_request_text";
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
};

export type McpTools = {
  /** The MCP endpoint, for the agent's config. */
  readonly url: string;
  /** The bearer the agent's config sends. Task-scoped; good at this server only. Never logged. */
  readonly bearer: string;
  readonly close: () => Promise<void>;
};

const inputSchema = z.strictObject({
  repo: z.string().min(1).max(201).describe("The repo, as owner/name, exactly as the task lists it."),
  title: z.string().min(1).max(PR_TITLE_MAX * 4).describe("The pull request's title: one line, close to the task's prompt."),
  body: z.string().max(PR_BODY_MAX * 4).describe("The pull request's body, in Markdown."),
});

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

  const newServer = (): McpServer => {
    const server = new McpServer({ name: "ostra", version: RUNNER_VERSION });
    server.registerTool(
      SET_PR_TEXT_TOOL,
      { title: "Set the pull request's title and body", description, inputSchema },
      (input) => setPrText(input),
    );
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
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
  };
};
