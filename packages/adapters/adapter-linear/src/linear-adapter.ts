import { adapterError, mappedStatusId, ok, parseVendor, sha256Hex, TrackerAdapter } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterError,
  AdapterResult,
  BoardRef,
  CodeHostIntegration,
  DownloadedFile,
  HealthReport,
  LinkedTicket,
  MoveResult,
  MoveTarget,
  NewTicket,
  ParseWebhookInput,
  PullRequestLinkOptions,
  StatusMapping,
  TaskLink,
  Ticket,
  TicketAttachment,
  TicketComment,
  TicketContext,
  TicketImage,
  TicketLinkKind,
  TicketPage,
  TicketQuery,
  TicketRef,
  TicketStatus,
  TicketStatusCategory,
  TicketSummary,
  TrackerBoard,
  TrackerCapabilities,
  TrackerStatus,
  TrackerWebhookHint,
  TrackerWebhookRequest,
  WebhookVerification,
} from "@ostra/adapter-sdk";
import { externalTicketIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { TicketKey } from "@ostra/protocol";
import { z } from "zod";

import { linearWebhookHint, verifyLinearWebhook } from "./app/webhooks.ts";
import { imageName, looksLikeImage, markdownImages } from "./markdown-images.ts";
import { answers, documents, MAX_COMMENT_PAGES, MAX_TICKET_PAGE } from "./queries.ts";
import type { DocumentName, LinearComment, LinearIssue, LinearSummary } from "./queries.ts";

// The Linear tracker adapter (ADR 0013, ADR 0025): Linear's plain API over GraphQL with `fetch`
// (no `@linear/sdk`, spec section 10). ostra keeps references and a cached copy of tickets, never
// the source of truth. Everything is keyed on an issue's UUID; its key (`OST-12`) is only what it
// was at the last read, since it changes when the issue moves team.
//
// A ticket's text is untrusted: it's returned as data, nothing here builds a command from it, and
// no log line or error message holds a title, a description or a comment. The token goes in one
// header and nowhere else: never in a log line, an error message or a URL.

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
  /**
   * The origins whose files `downloadFile` fetches with the token, and so the only images a
   * ticket's context lists. Default `https://uploads.linear.app`; a test adds its fake's.
   */
  readonly fileOrigins?: readonly string[];
};

const DEFAULT_API_URL = "https://api.linear.app/graphql";
const DEFAULT_FILE_ORIGINS: readonly string[] = ["https://uploads.linear.app"];
const DEFAULT_PAGE = 50;

/** Linear's state types, in the four categories every tracker shares. */
export const linearStateCategory = (type: string): TicketStatusCategory => {
  switch (type) {
    case "started":
      return "started";
    case "completed":
      return "done";
    case "canceled":
    case "duplicate":
      return "cancelled";
    default:
      // triage, backlog, unstarted, and any type Linear adds later.
      return "open";
  }
};

/** The order Linear's board shows its state types in. */
const STATE_TYPE_ORDER: readonly string[] = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"];
const typeRank = (type: string): number => {
  const rank = STATE_TYPE_ORDER.indexOf(type);
  return rank < 0 ? STATE_TYPE_ORDER.length : rank;
};

/** The services whose integration links PRs and moves statuses: Linear's GitHub app, on github.com or Enterprise Server. */
const GITHUB_SERVICES: ReadonlySet<string> = new Set(["github", "githubenterpriseserver"]);

const responseSchema = z.looseObject({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.looseObject({
        message: z.string().optional(),
        extensions: z.looseObject({ type: z.string().optional(), code: z.string().optional() }).nullish(),
      }),
    )
    .nullish(),
});

const toStatus = (state: { readonly id: string; readonly name: string; readonly type: string }): TicketStatus => ({
  id: state.id,
  name: state.name,
  category: linearStateCategory(state.type),
});

const toTicket = (issue: LinearIssue): AdapterResult<Ticket> => {
  const key = ticketKeySchema.safeParse(issue.identifier);
  const externalId = externalTicketIdSchema.safeParse(issue.id);
  const parent = issue.parent === null || issue.parent === undefined ? null : ticketKeySchema.safeParse(issue.parent.identifier);
  const parentId = issue.parent === null || issue.parent === undefined ? null : externalTicketIdSchema.safeParse(issue.parent.id);
  const updated = Date.parse(issue.updatedAt);
  const unreadable =
    !key.success || !externalId.success || parent?.success === false || parentId?.success === false || Number.isNaN(updated);
  if (unreadable) {
    return adapterError("invalid-response", "Linear's issue could not be read");
  }
  return ok({
    externalId: externalId.data,
    key: key.data,
    title: issue.title,
    description: issue.description ?? null,
    status: toStatus(issue.state),
    url: issue.url,
    // Linear's 0 is "no priority"; 1 is urgent and 4 is low: lower is more urgent, as ostra says.
    priority: issue.priority === null || issue.priority === undefined || issue.priority === 0 ? null : issue.priority,
    parentKey: parent?.success === true ? parent.data : null,
    parentExternalId: parentId?.success === true ? parentId.data : null,
    labels: issue.labels?.nodes.map((label) => label.name) ?? [],
    updatedAt: updated,
  });
};

/** A summary that doesn't parse is left out: it's context, and the rest still reads. */
const toSummary = (summary: LinearSummary | null | undefined): TicketSummary | null => {
  if (summary === null || summary === undefined) {
    return null;
  }
  const key = ticketKeySchema.safeParse(summary.identifier);
  const externalId = externalTicketIdSchema.safeParse(summary.id);
  return key.success && externalId.success
    ? { externalId: externalId.data, key: key.data, title: summary.title, url: summary.url, status: toStatus(summary.state) }
    : null;
};

const toComment = (comment: LinearComment): TicketComment | null => {
  const createdAt = Date.parse(comment.createdAt);
  const updatedAt = Date.parse(comment.updatedAt);
  if (Number.isNaN(createdAt) || Number.isNaN(updatedAt)) {
    return null;
  }
  return {
    id: comment.id,
    body: comment.body,
    author: comment.user === null || comment.user === undefined ? null : { id: comment.user.id, name: comment.user.name },
    parentId: comment.parent?.id ?? null,
    createdAt,
    updatedAt,
  };
};

/** Linear's relation types, from the issue's side (`relations`) and from the other's (`inverseRelations`). */
const linkKindOf = (type: string, inverse: boolean): TicketLinkKind | null => {
  switch (type) {
    case "blocks":
      return inverse ? "blocked-by" : "blocks";
    case "duplicate":
      return inverse ? "duplicated-by" : "duplicate";
    case "related":
      return "related";
    default:
      // `similar` is Linear's suggestion, not a person's link; anything newer is left out too.
      return null;
  }
};

const present = <T,>(values: readonly (T | null)[]): T[] => values.flatMap((value) => (value === null ? [] : [value]));

export class LinearAdapter extends TrackerAdapter {
  readonly name = "linear";
  readonly capabilities: TrackerCapabilities = {
    // Linear's agent sessions come with milestone 6 (F-012).
    agentSessions: false,
    // A ticket's parent is read, so a sub-issue is told from a ticket.
    subIssues: true,
    statusGraph: false,
    // Signed deliveries, verified and read by `app/webhooks.ts` (ticket 08).
    webhooks: true,
    commentEdit: true,
    // Linear takes file copies as attachments (ADR 0043), used from milestone 6.
    attachments: true,
    // Linear sets a status directly.
    transitions: false,
  };

  readonly #auth: LinearAuth;
  readonly #apiUrl: string;
  readonly #timeoutMs: number;
  readonly #fileOrigins: ReadonlySet<string>;
  readonly #budgetKey: string;

  constructor(options: LinearAdapterOptions, context?: AdapterContext) {
    super(context);
    this.#auth = options.auth;
    this.#apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fileOrigins = new Set((options.fileOrigins ?? DEFAULT_FILE_ORIGINS).map((origin) => new URL(origin).origin));
    // The budget is per credential: named by a digest of the token, never by the token.
    this.#budgetKey = `linear:${sha256Hex(options.auth.token).slice(0, 16)}`;
  }

  async health(): Promise<HealthReport> {
    const viewer = await this.#query("viewer", {}, answers.viewer);
    return viewer.ok ? { status: "ok" } : { status: "down", reason: viewer.error.message };
  }

  // ---------- reads ----------

  async getTicket(board: BoardRef, ref: TicketKey | TicketRef): Promise<AdapterResult<Ticket>> {
    const found = await this.#issueOnBoard(board, typeof ref === "string" ? { key: ref } : ref);
    return found.ok ? toTicket(found.value) : found;
  }

  async listTickets(query: TicketQuery): Promise<AdapterResult<TicketPage>> {
    const filter: Record<string, unknown> = { team: { id: { eq: query.board.externalId } } };
    if (query.statusIds !== undefined) {
      filter["state"] = { id: { in: [...query.statusIds] } };
    }
    if (query.updatedSince !== undefined) {
      // Inclusive, as the interface says.
      filter["updatedAt"] = { gte: new Date(query.updatedSince).toISOString() };
    }
    const first = Math.max(1, Math.min(query.pageSize ?? DEFAULT_PAGE, MAX_TICKET_PAGE));
    // `orderBy: updatedAt` answers the newest first; `sort` ascending answers the oldest first
    // (both checked against ostra-test on 2026-11-19), which a poller's cursor needs.
    const page = await this.#query(
      query.order === "updatedAt" ? "issuesByUpdatedAt" : "issues",
      { filter, after: query.cursor ?? null, first },
      answers.issues,
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

  async listBoards(): Promise<AdapterResult<readonly TrackerBoard[]>> {
    const boards: TrackerBoard[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const listed: AdapterResult<z.infer<typeof answers.teams>> = await this.#query("teams", { after }, answers.teams);
      if (!listed.ok) {
        return listed;
      }
      boards.push(...listed.value.teams.nodes.map((team) => ({ externalId: team.id, key: team.key, name: team.name })));
      const { hasNextPage } = listed.value.teams.pageInfo;
      const endCursor: string | null | undefined = listed.value.teams.pageInfo.endCursor;
      if (!hasNextPage || endCursor === null || endCursor === undefined) {
        break;
      }
      after = endCursor;
    }
    return ok(boards);
  }

  async listStatuses(board: BoardRef): Promise<AdapterResult<readonly TrackerStatus[]>> {
    const found = await this.#query("teamStates", { id: board.externalId }, answers.teamStates);
    if (!found.ok) {
      return found;
    }
    if (found.value.team.id !== board.externalId) {
      return this.#notOnBoard("listing statuses");
    }
    // Linear's board shows its states by type, then by their position within it.
    const ordered = [...found.value.team.states.nodes].sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.position - b.position);
    return ok(ordered.map((state, index) => ({ ...toStatus(state), vendorType: state.type, position: index })));
  }

  async getTicketContext(board: BoardRef, ref: TicketRef): Promise<AdapterResult<TicketContext>> {
    const found = await this.#query("issueContext", { id: this.#idOf(ref) }, answers.issueContext);
    if (!found.ok) {
      return found;
    }
    const { issue } = found.value;
    if (!this.#matches(issue, board, ref)) {
      return this.#notOnBoard("reading a ticket's context");
    }
    const ticket = toTicket(issue);
    if (!ticket.ok) {
      return ticket;
    }

    const rawComments = [...issue.comments.nodes];
    let { hasNextPage, endCursor } = issue.comments.pageInfo;
    for (let page = 1; page < MAX_COMMENT_PAGES && hasNextPage && endCursor !== null && endCursor !== undefined; page += 1) {
      const more = await this.#query("issueComments", { id: issue.id, after: endCursor }, answers.issueComments);
      if (!more.ok) {
        return more;
      }
      rawComments.push(...more.value.issue.comments.nodes);
      ({ hasNextPage, endCursor } = more.value.issue.comments.pageInfo);
    }
    const comments = present(rawComments.map(toComment)).sort((a, b) => a.createdAt - b.createdAt);

    const attachments: TicketAttachment[] = issue.attachments.nodes.map((attachment) => ({
      id: attachment.id,
      url: attachment.url,
      title: attachment.title,
      subtitle: attachment.subtitle ?? null,
    }));

    const linked: LinkedTicket[] = [
      ...present(
        issue.relations.nodes.map((relation) => {
          const kind = linkKindOf(relation.type, false);
          const other = toSummary(relation.relatedIssue);
          return kind === null || other === null ? null : { kind, ticket: other };
        }),
      ),
      ...present(
        issue.inverseRelations.nodes.map((relation) => {
          const kind = linkKindOf(relation.type, true);
          const other = toSummary(relation.issue);
          return kind === null || other === null ? null : { kind, ticket: other };
        }),
      ),
    ];

    return ok({
      ticket: ticket.value,
      comments,
      attachments,
      images: this.#imagesOf(ticket.value.description, comments, attachments),
      parent: toSummary(issue.parent),
      children: present(issue.children.nodes.map(toSummary)),
      linked,
    });
  }

  async detectCodeHostIntegration(): Promise<AdapterResult<CodeHostIntegration>> {
    let after: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const listed: AdapterResult<z.infer<typeof answers.integrations>> = await this.#query("integrations", { after }, answers.integrations);
      if (!listed.ok) {
        return listed;
      }
      if (listed.value.integrations.nodes.some((integration) => GITHUB_SERVICES.has(integration.service.toLowerCase()))) {
        return ok({ installed: true, name: "GitHub" });
      }
      const { hasNextPage } = listed.value.integrations.pageInfo;
      const endCursor: string | null | undefined = listed.value.integrations.pageInfo.endCursor;
      if (!hasNextPage || endCursor === null || endCursor === undefined) {
        break;
      }
      after = endCursor;
    }
    return ok({ installed: false, name: null });
  }

  async downloadFile(url: string, maxBytes: number): Promise<AdapterResult<DownloadedFile>> {
    if (!URL.canParse(url)) {
      return adapterError("invalid-input", "downloading a ticket's file failed: not a URL");
    }
    const target = new URL(url);
    if (!this.#fileOrigins.has(target.origin)) {
      // The token is sent only to Linear's own file host.
      return adapterError("invalid-input", "downloading a ticket's file failed: not a file Linear holds");
    }
    let response: Response;
    try {
      response = await fetch(target, {
        headers: { authorization: this.#authorization(), "user-agent": "ostra-linear-adapter" },
        // A redirect would leave Linear's host: it isn't followed.
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(this.#timeoutMs, 30_000)),
      });
    } catch {
      return adapterError("unavailable", "downloading a ticket's file failed: Linear could not be reached");
    }
    const where = `downloading a ticket's file failed (HTTP ${String(response.status)})`;
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) return adapterError("unauthorized", `${where}: Linear refused the credentials`);
      if (response.status === 403) return adapterError("forbidden", `${where}: the credentials lack a permission`);
      if (response.status === 404) return adapterError("not-found", `${where}: not found`);
      if (response.status === 429) return { ok: false, error: this.#rateLimited(where, response) };
      return response.status >= 500 ? adapterError("unavailable", `${where}: Linear is failing`) : adapterError("invalid-response", where);
    }
    const tooBig = adapterError("invalid-input", `downloading a ticket's file failed: it's larger than ${String(maxBytes)} bytes`);
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      return tooBig;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body !== null) {
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      for (;;) {
        let read: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
        try {
          read = await reader.read();
        } catch {
          return adapterError("unavailable", "downloading a ticket's file failed: the download broke off");
        }
        if (read.done) break;
        size += read.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          return tooBig;
        }
        chunks.push(read.value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return ok({ bytes, contentType: response.headers.get("content-type") });
  }

  // ---------- writes ----------

  async updateStatus(board: BoardRef, key: TicketKey, statusId: string): Promise<AdapterResult<void>> {
    const issue = await this.#issueOnBoard(board, { key });
    if (!issue.ok) {
      return issue;
    }
    const updated = await this.#setState(issue.value.id, statusId);
    return updated.ok ? ok(undefined) : updated;
  }

  async moveTicket(board: BoardRef, ref: TicketRef, target: MoveTarget, mapping: StatusMapping): Promise<AdapterResult<MoveResult>> {
    const issue = await this.#issueOnBoard(board, ref);
    if (!issue.ok) {
      return issue;
    }
    const statusId = mappedStatusId(mapping, target);
    if (issue.value.state.id === statusId) {
      // Already there: nothing is written, so a retried step changes no history.
      return ok({ moved: false, status: toStatus(issue.value.state) });
    }
    const updated = await this.#setState(issue.value.id, statusId);
    return updated.ok ? ok({ moved: true, status: updated.value }) : updated;
  }

  async comment(board: BoardRef, key: TicketKey, markdown: string): Promise<AdapterResult<{ readonly commentId: string }>> {
    const issue = await this.#issueOnBoard(board, { key });
    if (!issue.ok) {
      return issue;
    }
    const created = await this.#query("commentCreate", { issueId: issue.value.id, body: markdown }, answers.commentCreate);
    if (!created.ok) {
      return created;
    }
    const { success, comment } = created.value.commentCreate;
    return success && comment !== null && comment !== undefined
      ? ok({ commentId: comment.id })
      : adapterError("conflict", "Linear did not save the comment");
  }

  async updateComment(board: BoardRef, ref: TicketRef, commentId: string, markdown: string): Promise<AdapterResult<void>> {
    const issue = await this.#issueOnBoard(board, ref);
    if (!issue.ok) {
      return issue;
    }
    // The comment must be on this ticket: an ID from elsewhere edits nothing.
    const owner = await this.#query("commentOwner", { id: commentId }, answers.commentOwner);
    if (!owner.ok) {
      return owner;
    }
    if (owner.value.comment.issue?.id !== issue.value.id) {
      return adapterError("not-found", "editing a comment failed: the comment is not on this ticket");
    }
    const updated = await this.#query("commentUpdate", { id: commentId, body: markdown }, answers.commentUpdate);
    if (!updated.ok) {
      return updated;
    }
    return updated.value.commentUpdate.success ? ok(undefined) : adapterError("conflict", "Linear did not save the comment");
  }

  async linkPullRequest(
    board: BoardRef,
    key: TicketKey,
    pullRequestUrl: string,
    options?: PullRequestLinkOptions,
  ): Promise<AdapterResult<void>> {
    const issue = await this.#issueOnBoard(board, { key });
    if (!issue.ok) {
      return issue;
    }
    // Linear keeps one attachment per URL on an issue, so linking again links once.
    const linked =
      options?.kind === undefined
        ? await this.#query("attachmentLinkGitHubPR", { issueId: issue.value.id, url: pullRequestUrl }, answers.attachmentLinkGitHubPR)
        : await this.#query(
            "attachmentLinkGitHubPRWithKind",
            // Linear's `GitLinkKind`: `closes`, `contributes` or `links`. `Refs` links without closing.
            { issueId: issue.value.id, url: pullRequestUrl, linkKind: options.kind === "closes" ? "closes" : "links" },
            answers.attachmentLinkGitHubPR,
          );
    if (!linked.ok) {
      return linked;
    }
    return linked.value.attachmentLinkGitHubPR.success ? ok(undefined) : adapterError("conflict", "Linear did not link the PR");
  }

  async linkTask(board: BoardRef, ref: TicketRef, link: TaskLink): Promise<AdapterResult<{ readonly attachmentId: string }>> {
    const issue = await this.#issueOnBoard(board, ref);
    if (!issue.ok) {
      return issue;
    }
    // `attachmentCreate` is idempotent on the URL per issue: a second call updates the first's
    // title and subtitle and answers the same attachment (the live suite checks it on ostra-test).
    const created = await this.#query(
      "attachmentCreate",
      { issueId: issue.value.id, url: link.url, title: link.title, subtitle: link.subtitle },
      answers.attachmentCreate,
    );
    if (!created.ok) {
      return created;
    }
    const { success, attachment } = created.value.attachmentCreate;
    return success && attachment !== null && attachment !== undefined
      ? ok({ attachmentId: attachment.id })
      : adapterError("conflict", "Linear did not link the task");
  }

  async createTicket(board: BoardRef, ticket: NewTicket): Promise<AdapterResult<Ticket>> {
    const created = await this.#query(
      "issueCreate",
      { teamId: board.externalId, title: ticket.title, description: ticket.description },
      answers.issueCreate,
    );
    if (!created.ok) {
      return created;
    }
    const { success, issue } = created.value.issueCreate;
    return success && issue !== null && issue !== undefined ? toTicket(issue) : adapterError("conflict", "Linear did not create the ticket");
  }

  // ---------- webhooks ----------

  verifyWebhook(request: TrackerWebhookRequest): WebhookVerification {
    return verifyLinearWebhook(request);
  }

  parseWebhook(input: ParseWebhookInput): AdapterResult<TrackerWebhookHint> {
    return linearWebhookHint(input);
  }

  // ---------- internals ----------

  #authorization(): string {
    return this.#auth.kind === "oauth" ? `Bearer ${this.#auth.token}` : this.#auth.token;
  }

  /** What Linear's `issue(id:)` takes: an ID or an identifier. */
  #idOf(ref: TicketRef): string {
    return "externalId" in ref ? ref.externalId : ref.key;
  }

  /** Whether the issue is on the board, and is the one the ref names. */
  #matches(issue: LinearIssue, board: BoardRef, ref: TicketRef): boolean {
    const sameTicket = "externalId" in ref ? issue.id === ref.externalId : issue.identifier === ref.key;
    return sameTicket && issue.team?.id === board.externalId;
  }

  #notOnBoard(operation: string): AdapterResult<never> {
    return adapterError("not-found", `${operation} failed: not found on this board, or not visible to the credentials`);
  }

  async #issueOnBoard(board: BoardRef, ref: TicketRef): Promise<AdapterResult<LinearIssue>> {
    const found = await this.#query("issue", { id: this.#idOf(ref) }, answers.issue);
    if (!found.ok) {
      return found;
    }
    return this.#matches(found.value.issue, board, ref) ? ok(found.value.issue) : this.#notOnBoard("reading a ticket");
  }

  async #setState(issueId: string, stateId: string): Promise<AdapterResult<TicketStatus>> {
    const updated = await this.#query("issueUpdateState", { id: issueId, stateId }, answers.issueUpdateState);
    if (!updated.ok) {
      return updated;
    }
    const { success, issue } = updated.value.issueUpdate;
    return success && issue !== null && issue !== undefined ? ok(toStatus(issue.state)) : adapterError("conflict", "Linear did not move the ticket");
  }

  /** Inline images in the description, then the comments', then image attachments: each once, and only files Linear holds. */
  #imagesOf(description: string | null, comments: readonly TicketComment[], attachments: readonly TicketAttachment[]): readonly TicketImage[] {
    const images: TicketImage[] = [];
    const seen = new Set<string>();
    const add = (raw: string, alt: string): void => {
      if (!URL.canParse(raw)) return;
      const url = new URL(raw);
      if (!this.#fileOrigins.has(url.origin) || seen.has(url.href)) return;
      seen.add(url.href);
      images.push({ url: url.href, name: imageName(url, alt), contentType: null });
    };
    for (const text of [description ?? "", ...comments.map((comment) => comment.body)]) {
      for (const image of markdownImages(text)) {
        add(image.url, image.alt);
      }
    }
    for (const attachment of attachments) {
      if (URL.canParse(attachment.url) && looksLikeImage(new URL(attachment.url))) {
        add(attachment.url, attachment.title);
      }
    }
    return images;
  }

  async #query<S extends z.ZodType>(
    name: DocumentName,
    variables: Readonly<Record<string, unknown>>,
    schema: S,
  ): Promise<AdapterResult<z.infer<S>>> {
    const operation = `Linear's ${name}`;
    const budget = this.plumbing.rateBudget;
    if (budget !== undefined) {
      const decision = await budget.check(this.#budgetKey);
      if (!decision.go) {
        return adapterError("rate-limited", `${operation} waits for Linear's rate limit to reset`, decision.waitMs);
      }
    }
    let response: Response;
    try {
      response = await fetch(this.#apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "ostra-linear-adapter",
          authorization: this.#authorization(),
        },
        body: JSON.stringify({ query: documents[name], variables }),
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      this.plumbing.logger.warn("linear.call.failed", { operation: name, code: "unavailable" });
      return adapterError("unavailable", `${operation} failed: Linear could not be reached`);
    }
    if (budget !== undefined) {
      const reset = Number(response.headers.get("x-ratelimit-requests-reset") ?? Number.NaN);
      await budget.record(this.#budgetKey, {
        remaining: response.headers.get("x-ratelimit-requests-remaining"),
        limit: response.headers.get("x-ratelimit-requests-limit"),
        // Linear's reset is in ms since the epoch; the budget reads seconds.
        reset: Number.isFinite(reset) && reset > 0 ? String(Math.ceil(reset / 1000)) : null,
      });
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
      const kinds = errors.flatMap((error) => [error.extensions?.type ?? "", error.extensions?.code ?? "", error.message ?? ""]);
      const error = this.#errorOf(operation, response, kinds);
      this.plumbing.logger.warn("linear.call.failed", { operation: name, code: error.code, status: response.status });
      return { ok: false, error };
    }
    if (!parsed.success || parsed.data.data === undefined || parsed.data.data === null) {
      return adapterError("invalid-response", `${operation} failed: Linear's answer was not what was expected`);
    }
    return parseVendor(schema, parsed.data.data, `${operation}'s answer`);
  }

  #rateLimited(where: string, response: Response): AdapterError {
    const retry = Number(response.headers.get("retry-after") ?? Number.NaN);
    if (Number.isFinite(retry) && retry > 0) {
      return { code: "rate-limited", message: where, retryAfterMs: retry * 1000 };
    }
    const reset = Number(response.headers.get("x-ratelimit-requests-reset") ?? Number.NaN);
    const wait = reset - this.plumbing.clock.now();
    return Number.isFinite(wait) && wait > 0 ? { code: "rate-limited", message: where, retryAfterMs: wait } : { code: "rate-limited", message: where };
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
      return this.#rateLimited(where, response);
    }
    if (lower.some((kind) => kind.includes("not found"))) {
      return { code: "not-found", message: `${where}: not found, or not visible to the credentials` };
    }
    return response.status >= 500
      ? { code: "unavailable", message: `${where}: Linear is failing` }
      : { code: "invalid-input", message: where };
  }
}
