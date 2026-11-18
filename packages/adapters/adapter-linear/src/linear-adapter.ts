import { adapterError, ok, parseVendor, TrackerAdapter } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterError,
  AdapterResult,
  BoardRef,
  HealthReport,
  Ticket,
  TicketPage,
  TicketQuery,
  TrackerCapabilities,
} from "@ostra/adapter-sdk";
import { ticketKeySchema } from "@ostra/protocol";
import type { TicketKey } from "@ostra/protocol";
import { z } from "zod";

// The Linear tracker adapter (ADR 0013, ADR 0025): the plain-API basics, over Linear's GraphQL API
// with `fetch`. Milestone 1 needs only a working adapter that passes its contract tests, and its
// health check; tickets come in milestone 2, with Linear's agent mode (spike 11). ostra keeps
// references and a cached copy, never the source of truth. A ticket's text is untrusted: it's
// returned as data, and nothing here puts it in a command.
//
// The token goes in one header and nowhere else: never in a log line, an error message or a URL.

export type LinearAuth =
  /** A personal API key, sent as it is in `Authorization`. */
  | { readonly kind: "api-key"; readonly token: string }
  /** An OAuth access token, sent as a bearer token. */
  | { readonly kind: "oauth"; readonly token: string };

export type LinearAdapterOptions = {
  readonly auth: LinearAuth;
  /** Default `https://api.linear.app/graphql`. */
  readonly apiUrl?: string;
  readonly timeoutMs?: number;
};

const DEFAULT_API_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;

// ---------- what Linear answers, read loosely ----------

const issueSchema = z.looseObject({
  id: z.string(),
  identifier: z.string().min(1),
  title: z.string(),
  description: z.string().nullish(),
  url: z.string(),
  priority: z.number().nullish(),
  updatedAt: z.string(),
  state: z.looseObject({ id: z.string(), name: z.string() }),
  parent: z.looseObject({ identifier: z.string() }).nullish(),
});
type LinearIssue = z.infer<typeof issueSchema>;

const ISSUE_FIELDS = "id identifier title description url priority updatedAt state { id name } parent { identifier }";

const responseSchema = z.looseObject({
  data: z.unknown().optional(),
  errors: z
    .array(z.looseObject({ message: z.string().optional(), extensions: z.looseObject({ type: z.string().optional(), code: z.string().optional() }).nullish() }))
    .nullish(),
});

const toTicket = (issue: LinearIssue): AdapterResult<Ticket> => {
  const key = ticketKeySchema.safeParse(issue.identifier);
  const parent = issue.parent === null || issue.parent === undefined ? null : ticketKeySchema.safeParse(issue.parent.identifier);
  const updated = Date.parse(issue.updatedAt);
  if (!key.success || (parent !== null && !parent.success) || Number.isNaN(updated)) {
    return adapterError("invalid-response", "Linear's issue could not be read");
  }
  return ok({
    key: key.data,
    title: issue.title,
    description: issue.description ?? null,
    status: { id: issue.state.id, name: issue.state.name },
    url: issue.url,
    // Linear's 0 is "no priority"; 1 is urgent and 4 is low: lower is more urgent, as ostra says.
    priority: issue.priority === null || issue.priority === undefined || issue.priority === 0 ? null : issue.priority,
    parentKey: parent?.success === true ? parent.data : null,
    updatedAt: updated,
  });
};

export class LinearAdapter extends TrackerAdapter {
  readonly name = "linear";
  readonly capabilities: TrackerCapabilities = {
    // Linear's agent sessions come with milestone 2 (spike 11).
    agentSessions: false,
    // A ticket's parent is read, so a sub-issue is told from a ticket.
    subIssues: true,
    statusGraph: false,
  };

  readonly #auth: LinearAuth;
  readonly #apiUrl: string;
  readonly #timeoutMs: number;

  constructor(options: LinearAdapterOptions, context?: AdapterContext) {
    super(context);
    this.#auth = options.auth;
    this.#apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async health(): Promise<HealthReport> {
    const viewer = await this.#query("the Linear health check", "query { viewer { id } }", {}, z.looseObject({ viewer: z.looseObject({ id: z.string() }) }));
    return viewer.ok ? { status: "ok" } : { status: "down", reason: viewer.error.message };
  }

  async getTicket(_board: BoardRef, key: TicketKey): Promise<AdapterResult<Ticket>> {
    const found = await this.#issue(key);
    return found.ok ? toTicket(found.value) : found;
  }

  async listTickets(query: TicketQuery): Promise<AdapterResult<TicketPage>> {
    const filter: Record<string, unknown> = { team: { id: { eq: query.board.externalId } } };
    if (query.statusIds !== undefined) {
      filter["state"] = { id: { in: [...query.statusIds] } };
    }
    if (query.updatedSince !== undefined) {
      filter["updatedAt"] = { gt: new Date(query.updatedSince).toISOString() };
    }
    const page = await this.#query(
      "listing tickets",
      `query ($filter: IssueFilter, $after: String, $first: Int) { issues(filter: $filter, after: $after, first: $first, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { filter, after: query.cursor ?? null, first: PAGE_SIZE },
      z.looseObject({
        issues: z.looseObject({
          nodes: z.array(issueSchema),
          pageInfo: z.looseObject({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
        }),
      }),
    );
    if (!page.ok) {
      return page;
    }
    const tickets: Ticket[] = [];
    for (const node of page.value.issues.nodes) {
      const ticket = toTicket(node);
      if (!ticket.ok) {
        return ticket;
      }
      tickets.push(ticket.value);
    }
    const { hasNextPage, endCursor } = page.value.issues.pageInfo;
    return ok({ tickets, nextCursor: hasNextPage ? (endCursor ?? null) : null });
  }

  async updateStatus(_board: BoardRef, key: TicketKey, statusId: string): Promise<AdapterResult<void>> {
    const issue = await this.#issue(key);
    if (!issue.ok) {
      return issue;
    }
    const updated = await this.#query(
      "moving a ticket",
      "mutation ($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
      { id: issue.value.id, stateId: statusId },
      z.looseObject({ issueUpdate: z.looseObject({ success: z.boolean() }) }),
    );
    if (!updated.ok) {
      return updated;
    }
    return updated.value.issueUpdate.success ? ok(undefined) : adapterError("conflict", "Linear did not move the ticket");
  }

  async comment(_board: BoardRef, key: TicketKey, markdown: string): Promise<AdapterResult<{ readonly commentId: string }>> {
    const issue = await this.#issue(key);
    if (!issue.ok) {
      return issue;
    }
    const created = await this.#query(
      "commenting on a ticket",
      "mutation ($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }",
      { issueId: issue.value.id, body: markdown },
      z.looseObject({
        commentCreate: z.looseObject({ success: z.boolean(), comment: z.looseObject({ id: z.string() }).nullish() }),
      }),
    );
    if (!created.ok) {
      return created;
    }
    const { success, comment } = created.value.commentCreate;
    return success && comment !== null && comment !== undefined
      ? ok({ commentId: comment.id })
      : adapterError("conflict", "Linear did not save the comment");
  }

  async linkPullRequest(_board: BoardRef, key: TicketKey, pullRequestUrl: string): Promise<AdapterResult<void>> {
    const issue = await this.#issue(key);
    if (!issue.ok) {
      return issue;
    }
    const linked = await this.#query(
      "linking a PR",
      "mutation ($issueId: String!, $url: String!) { attachmentLinkGitHubPR(issueId: $issueId, url: $url) { success } }",
      { issueId: issue.value.id, url: pullRequestUrl },
      z.looseObject({ attachmentLinkGitHubPR: z.looseObject({ success: z.boolean() }) }),
    );
    if (!linked.ok) {
      return linked;
    }
    return linked.value.attachmentLinkGitHubPR.success ? ok(undefined) : adapterError("conflict", "Linear did not link the PR");
  }

  // ---------- internals ----------

  async #issue(key: TicketKey): Promise<AdapterResult<LinearIssue>> {
    // Linear takes a ticket's identifier, such as `OST-12`, where it takes an ID.
    const found = await this.#query(
      "reading a ticket",
      `query ($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: key },
      z.looseObject({ issue: issueSchema }),
    );
    return found.ok ? ok(found.value.issue) : found;
  }

  async #query<S extends z.ZodType>(
    operation: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    schema: S,
  ): Promise<AdapterResult<z.infer<S>>> {
    let response: Response;
    try {
      response = await fetch(this.#apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "ostra-linear-adapter",
          authorization: this.#auth.kind === "oauth" ? `Bearer ${this.#auth.token}` : this.#auth.token,
        },
        body: JSON.stringify({ query, variables }),
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      return adapterError("unavailable", `${operation} failed: Linear could not be reached`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const parsed = responseSchema.safeParse(body);
    const errors = parsed.success ? (parsed.data.errors ?? []) : [];
    if (!response.ok || errors.length > 0) {
      return { ok: false, error: this.#errorOf(operation, response, errors.flatMap((error) => [error.extensions?.type ?? error.extensions?.code ?? "", error.message ?? ""])) };
    }
    if (!parsed.success || parsed.data.data === undefined) {
      return adapterError("invalid-response", `${operation} failed: Linear's answer was not what was expected`);
    }
    return parseVendor(schema, parsed.data.data, `Linear's answer to ${operation}`);
  }

  /** An error in ostra's own words: Linear's message is read to classify it, and never repeated: it can hold ticket text. */
  #errorOf(operation: string, response: Response, kinds: readonly string[]): AdapterError {
    const lower = kinds.map((kind) => kind.toLowerCase());
    const where = `${operation} failed (HTTP ${String(response.status)})`;
    if (response.status === 401 || lower.some((kind) => kind.includes("authentication"))) {
      return { code: "unauthorized", message: `${where}: Linear refused the credentials` };
    }
    if (response.status === 403 || lower.some((kind) => kind.includes("forbidden"))) {
      return { code: "forbidden", message: `${where}: the credentials lack a permission` };
    }
    if (response.status === 429 || lower.some((kind) => kind.includes("ratelimit"))) {
      const retry = Number(response.headers.get("retry-after"));
      return Number.isFinite(retry) && retry > 0
        ? { code: "rate-limited", message: where, retryAfterMs: retry * 1000 }
        : { code: "rate-limited", message: where };
    }
    if (lower.some((kind) => kind.includes("not found"))) {
      return { code: "not-found", message: `${where}: not found, or not visible to the credentials` };
    }
    return response.status >= 500
      ? { code: "unavailable", message: `${where}: Linear is failing` }
      : { code: "invalid-input", message: where };
  }
}
