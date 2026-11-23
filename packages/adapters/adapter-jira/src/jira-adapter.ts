import {
  adapterError,
  filesForCapability,
  isOpenCategory,
  isOwnAttachment,
  isOwnComment,
  mappedStatusId,
  MAX_ROUTE_STEPS,
  ok,
  parseVendor,
  routeTo,
  sha256Hex,
  ticketFileList,
  TrackerAdapter,
  transitionsTaken,
} from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterError,
  AdapterResult,
  AttachedFile,
  BoardRef,
  ChildTicket,
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
  TicketContextFile,
  TicketContextOptions,
  TicketFile,
  TicketImage,
  TicketLinkKind,
  TicketPage,
  TicketQuery,
  TicketRef,
  TicketStatus,
  TicketSummary,
  TicketUpdate,
  TrackerBoard,
  TrackerCapabilities,
  TrackerPerson,
  TrackerStatus,
  TrackerUser,
  TrackerWebhookHint,
  TrackerWebhookRequest,
  TrackerWorkflow,
  TransitionTaken,
  WebhookVerification,
} from "@ostra/adapter-sdk";
import { externalTicketIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { TicketKey } from "@ostra/protocol";
import { z } from "zod";

import { markdownToAdf, readAdf } from "./adf.ts";
import type { AdfReadOptions, ShownFile } from "./adf.ts";
import { markdownLinks } from "./markdown-links.ts";
import {
  accountSchema,
  attachmentSchema,
  childrenPageSchema,
  commentPageSchema,
  commentSchema,
  createdSchema,
  issueSchema,
  markersPropertySchema,
  projectPageSchema,
  projectSchema,
  projectStatusesSchema,
  propertySchema,
  remoteLinkSchema,
  remoteLinksSchema,
  searchPageSchema,
  transitionsSchema,
  usersSchema,
  workflowReadSchema,
  workflowSearchSchema,
} from "./schemas.ts";
import type { JiraAccount, JiraAttachment, JiraComment, JiraIssue, JiraIssueLink, JiraIssueRef, JiraStatusJson, JiraWorkflowJson, JiraWorkflowStatusJson } from "./schemas.ts";
import { jiraStatusCategory, nextTransition, readJiraWorkflows } from "./transitions.ts";
import type { AvailableTransition, JiraWorkflowsAnswer } from "./transitions.ts";
import { JIRA_WEBHOOK_MAX_AGE_MS, jiraWebhookHint, verifyJiraWebhook } from "./webhooks.ts";

// The Jira Cloud tracker adapter (ADR 0013, ADR 0025, ADR 0047): Jira's REST v3 with `fetch`, no
// client library. It signs in as a service account the organization owns, with its scoped API
// token (Basic `email:token`), through Atlassian's gateway (`api.atlassian.com/ex/jira/{cloudId}`)
// as a scoped token needs, or at the site itself with a classic token. Everything is keyed on an
// issue's numeric ID: its key (`PROJ-12`) changes when the issue moves project.
//
// A ticket's text (summary, description, comments, labels, file names) is untrusted: it's returned
// as data, nothing here builds a command from it, and no log line or error message holds it. Jira's
// own error bodies can quote it, so they're read for nothing and never repeated. The token goes in
// one header and nowhere else.

export type JiraAuth = {
  /** The service account's email, such as `ostra-bot@serviceaccount.atlassian.com`. */
  readonly email: string;
  /** Its scoped API token. Never logged. */
  readonly token: string;
};

export type JiraAdapterOptions = {
  /** The site, `https://<name>.atlassian.net`: browse links and its attachment URLs name it. */
  readonly siteUrl: string;
  readonly auth: JiraAuth;
  /**
   * The site's cloud ID (`jiraConnect.findSite`): calls go through Atlassian's gateway, which a scoped
   * token needs (ADR 0047). `null` or absent: calls go to the site, for a classic token.
   */
  readonly cloudId?: string | null;
  /** The gateway's origin. Default `https://api.atlassian.com`; a test points it at its fake. */
  readonly gatewayUrl?: string;
  readonly timeoutMs?: number;
  /** How old a webhook delivery may be. Default `JIRA_WEBHOOK_MAX_AGE_MS` (20 min). */
  readonly webhookMaxAgeMs?: number;
  /**
   * A paragraph custom field that holds acceptance criteria (`customfield_10050`). Jira has none of
   * its own: without it, `ticketFields.acceptanceCriteria` is false and core writes the criteria
   * into the description (F-099).
   */
  readonly acceptanceCriteriaField?: string | null;
};

/** Atlassian's gateway, which a scoped token needs (ADR 0047). */
export const JIRA_GATEWAY_URL = "https://api.atlassian.com";
const DEFAULT_GATEWAY = JIRA_GATEWAY_URL;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const MAX_COMMENT_PAGES = 10;
const MAX_PROJECT_PAGES = 20;
/** Transitions a screen refused, tried and routed around: past this many, the move gives up. */
const MAX_REFUSED = 3;
const GRAPH_TTL_MS = 5 * 60 * 1000;
/** Pages of `/workflows/search` read for one project: a project uses a workflow per issue type at most. */
const MAX_WORKFLOW_PAGES = 5;
/** Jira Cloud's per-issue write limits (research/trackers.md §2.1), kept before Jira answers 429. */
const ISSUE_WRITE_LIMITS: readonly { readonly count: number; readonly windowMs: number }[] = [
  { count: 20, windowMs: 2000 },
  { count: 100, windowMs: 30_000 },
];
/** The largest file `attachFile` uploads: milestone 2's cap on a ticket's file, as Linear's. */
export const MAX_JIRA_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** ostra's issue property that keeps `attachFile`'s markers (Jira's attachments have no subtitle). */
export const MARKERS_PROPERTY = "ostra.attachments";

const TICKET_FIELDS = ["summary", "description", "status", "priority", "parent", "labels", "assignee", "project", "updated", "issuetype", "attachment"] as const;
const CONTEXT_FIELDS = [...TICKET_FIELDS, "subtasks", "issuelinks"] as const;

/**
 * What Jira's adapter declares without a criteria field (ADR 0025). Exported so code that holds no
 * connection's token reads the same declaration.
 */
export const JIRA_CAPABILITIES: TrackerCapabilities = {
  // Jira's agent route is a Forge connector on Atlassian's platform (ADR 0047): progress goes
  // through comments, and every session method answers `unsupported` (the base class's).
  agentSessions: false,
  agentScopes: [],
  agentSessionLink: false,
  // Sub-tasks under a parent, and an epic's children, both through `parent`.
  subIssues: true,
  // The workflow's statuses and transitions, read with `read:workflow:jira` (`readWorkflow`).
  statusGraph: true,
  // The admin webhook, signed `X-Hub-Signature: sha256=…` with the shared secret.
  webhooks: true,
  // The service account edits its own comment in place.
  commentEdit: true,
  // Files are Jira attachments; their markers live in an issue property. Links are remote links.
  attachments: true,
  // A move walks the workflow's transitions; a status is never written.
  transitions: true,
  // `user/search` by email, and an ADF mention by account ID. A user whose address Jira hides from
  // the token is left out, never guessed.
  mentions: true,
  ticketFields: { acceptanceCriteria: false },
  // Milestone 9 (F-149): every attachment, inline in ADF or on the issue; remote links stay links.
  ticketFiles: "all",
  // Milestone 11 (F-008, ticket 02): Jira's GitHub integration links a PR by the key in its branch
  // and title, which ostra always writes, not by a magic word; Jira stores ADF, converted both ways
  // here; the admin webhook takes a JQL filter.
  magicWords: false,
  richText: "adf",
  jqlFilter: true,
};

/** The bytes copied onto an ArrayBuffer of their own, which every `BodyInit` typing accepts. */
const ownBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

/** Where the REST API answers for a site: the gateway for a cloud ID, else the site itself. */
export const jiraApiUrl = (input: { readonly siteUrl: string; readonly cloudId?: string | null; readonly gatewayUrl?: string }): string =>
  input.cloudId === undefined || input.cloudId === null || input.cloudId === ""
    ? trimSlash(new URL(input.siteUrl).origin)
    : `${trimSlash(input.gatewayUrl ?? DEFAULT_GATEWAY)}/ex/jira/${encodeURIComponent(input.cloudId)}`;

/** Jira's priority names on ostra's scale: 1 urgent to 4 low. */
const priorityOf = (name: string | undefined): number | null => {
  switch (name?.trim().toLowerCase()) {
    case "highest":
    case "blocker":
    case "critical":
      return 1;
    case "high":
    case "major":
      return 2;
    case "medium":
      return 3;
    case "low":
    case "lowest":
    case "minor":
    case "trivial":
      return 4;
    case undefined:
    default:
      return null;
  }
};

const toStatus = (status: JiraStatusJson): TicketStatus => ({
  id: status.id,
  name: status.name,
  category: jiraStatusCategory(status.statusCategory?.key, status.name),
});

const CATEGORY_ORDER: readonly string[] = ["new", "indeterminate", "done"];
const categoryRank = (key: string | undefined): number => {
  const rank = CATEGORY_ORDER.indexOf(key ?? "");
  return rank < 0 ? CATEGORY_ORDER.length : rank;
};

/** Jira's time, `2026-11-23T10:00:00.000+0100`, in ms since the epoch; `null` when it isn't one. */
const jiraTime = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const normalised = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = Date.parse(normalised);
  return Number.isNaN(parsed) ? null : parsed;
};

/** A time as JQL takes it, `yyyy/MM/dd HH:mm`, in the account's time zone, down to its minute. */
export const jqlTime = (ms: number, timeZone: string): string => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
  } catch {
    return jqlTime(ms, "UTC");
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((one) => one.type === type)?.value ?? "00";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
};

/** A JQL query's own `ORDER BY`, cut off outside its quotes: the adapter orders every search itself. */
export const withoutOrderBy = (jql: string): string => {
  let quote: string | null = null;
  let cut = jql.length;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql.charAt(index);
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/order\s+by\b/iy.test(jql.slice(index, index + 64)) && (index === 0 || /\s/.test(jql.charAt(index - 1)))) {
      cut = index;
      break;
    }
  }
  return jql.slice(0, cut).trim();
};

const NUMERIC_ID = /^\d{1,20}$/;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;

const isImageAttachment = (attachment: { readonly filename: string; readonly mimeType?: string | undefined }): boolean =>
  attachment.mimeType !== undefined && attachment.mimeType !== "" ? attachment.mimeType.toLowerCase().startsWith("image/") : IMAGE_NAME.test(attachment.filename);

/** A plain file name a link shows, else `null`. Untrusted either way: core makes it safe. */
const plainName = (text: string): string | null => (/^[\w .()-]{1,200}\.[A-Za-z0-9]{1,10}$/.test(text.trim()) ? text.trim() : null);

/** A remote link's ID, the same for the same URL however often it's linked (Jira upserts by it). */
const globalIdOf = (url: string): string => `ostra:${sha256Hex(url).slice(0, 40)}`;

type Request = {
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly json?: unknown;
  readonly form?: FormData;
  readonly accept?: string;
  /** The issue this call writes to: Jira's per-issue write limits are kept for it. */
  readonly writesIssue?: string;
};

type Markers = Readonly<Record<string, string>>;

/** Jira's refusal: the credential, or a scope or permission it lacks. */
const isRefusal = (error: AdapterError): boolean => error.code === "unauthorized" || error.code === "forbidden";

export class JiraAdapter extends TrackerAdapter {
  readonly name = "jira";
  readonly capabilities: TrackerCapabilities;

  readonly #api: string;
  readonly #site: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #webhookMaxAgeMs: number;
  readonly #criteriaField: string | null;
  readonly #budgetKey: string;
  #me: JiraAccount | undefined;
  readonly #graphs = new Map<string, { readonly at: number; readonly graph: TrackerWorkflow | null; readonly readable: boolean }>();
  /** When this adapter last wrote to each issue, for Jira's per-issue write limits. */
  readonly #issueWrites = new Map<string, number[]>();

  constructor(options: JiraAdapterOptions, context?: AdapterContext) {
    super(context);
    this.#site = trimSlash(new URL(options.siteUrl).origin);
    this.#api = jiraApiUrl({
      siteUrl: options.siteUrl,
      ...(options.cloudId === undefined ? {} : { cloudId: options.cloudId }),
      ...(options.gatewayUrl === undefined ? {} : { gatewayUrl: options.gatewayUrl }),
    });
    this.#authorization = `Basic ${Buffer.from(`${options.auth.email}:${options.auth.token}`, "utf8").toString("base64")}`;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#webhookMaxAgeMs = options.webhookMaxAgeMs ?? JIRA_WEBHOOK_MAX_AGE_MS;
    this.#criteriaField = options.acceptanceCriteriaField ?? null;
    this.capabilities = { ...JIRA_CAPABILITIES, ticketFields: { acceptanceCriteria: this.#criteriaField !== null } };
    // The budget is per credential: named by a digest of the token, never by the token.
    this.#budgetKey = `jira:${sha256Hex(options.auth.token).slice(0, 16)}`;
  }

  async health(): Promise<HealthReport> {
    const me = await this.#myself();
    return me.ok ? { status: "ok" } : { status: "down", reason: me.error.message };
  }

  // ---------- reads ----------

  async getTicket(board: BoardRef, ref: TicketKey | TicketRef): Promise<AdapterResult<Ticket>> {
    const found = await this.#issueOnBoard(board, typeof ref === "string" ? { key: ref } : ref, this.#ticketFields(TICKET_FIELDS));
    return found.ok ? this.#ticket(found.value) : found;
  }

  async listTickets(query: TicketQuery): Promise<AdapterResult<TicketPage>> {
    if (!NUMERIC_ID.test(query.board.externalId)) {
      return this.#notOnBoard("listing tickets");
    }
    const clauses = [`project = ${query.board.externalId}`];
    if (query.statusIds !== undefined) {
      if (query.statusIds.length === 0) return ok({ tickets: [], nextCursor: null });
      if (!query.statusIds.every((id) => NUMERIC_ID.test(id))) {
        return adapterError("invalid-input", "listing tickets failed: a status ID isn't Jira's");
      }
      clauses.push(`status in (${query.statusIds.join(", ")})`);
    }
    if (query.updatedSince !== undefined) {
      // JQL takes minutes in the account's own time zone: the query asks from the minute, and the
      // page keeps only what changed at or after the exact time.
      const me = await this.#myself();
      if (!me.ok) return me;
      clauses.push(`updated >= "${jqlTime(query.updatedSince, me.value.timeZone ?? "UTC")}"`);
    }
    const order = query.order === "updatedAt" ? "ORDER BY updated ASC, id ASC" : "ORDER BY updated DESC, id DESC";
    const page = await this.#search(`${clauses.join(" AND ")} ${order}`, query.cursor, query.pageSize, this.#ticketFields(TICKET_FIELDS));
    if (!page.ok) {
      return page;
    }
    const since = query.updatedSince;
    return ok({ tickets: since === undefined ? page.value.tickets : page.value.tickets.filter((ticket) => ticket.updatedAt >= since), nextCursor: page.value.nextCursor });
  }

  /**
   * Intake by JQL (research/trackers.md §2.4): the board's tickets that a rule's JQL matches, oldest
   * change first. The JQL is the admin's, bounded to the board's project; its own `ORDER BY` is
   * dropped. Jira's refusal of a query is `invalid-input`. Jira only: core reaches it through the
   * Jira adapter, never the shared interface.
   */
  async searchTickets(
    board: BoardRef,
    jql: string,
    page: { readonly cursor?: string; readonly pageSize?: number } = {},
  ): Promise<AdapterResult<TicketPage>> {
    if (!NUMERIC_ID.test(board.externalId)) {
      return this.#notOnBoard("searching tickets");
    }
    const rule = withoutOrderBy(jql);
    const bounded = rule === "" ? `project = ${board.externalId}` : `project = ${board.externalId} AND (${rule})`;
    return this.#search(`${bounded} ORDER BY updated ASC, id ASC`, page.cursor, page.pageSize, this.#ticketFields(TICKET_FIELDS));
  }

  async listBoards(): Promise<AdapterResult<readonly TrackerBoard[]>> {
    const boards: TrackerBoard[] = [];
    let startAt = 0;
    for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
      const listed = await this.#call("Jira's projects", { method: "GET", path: "/rest/api/3/project/search", query: { startAt: String(startAt), maxResults: String(DEFAULT_PAGE) } }, projectPageSchema);
      if (!listed.ok) {
        return listed;
      }
      boards.push(...listed.value.values.map((project) => ({ externalId: project.id, key: project.key, name: project.name })));
      startAt += listed.value.values.length;
      if (listed.value.isLast !== false || listed.value.values.length === 0) {
        break;
      }
    }
    return ok(boards);
  }

  async listStatuses(board: BoardRef): Promise<AdapterResult<readonly TrackerStatus[]>> {
    const listed = await this.#projectStatuses(board);
    if (!listed.ok) {
      return listed;
    }
    // Jira's board shows its statuses by category: to do, in progress, done.
    const ordered = [...listed.value].map((status, index) => ({ status, index })).sort((a, b) => categoryRank(a.status.statusCategory?.key) - categoryRank(b.status.statusCategory?.key) || a.index - b.index);
    return ok(ordered.map(({ status }, position) => ({ ...toStatus(status), vendorType: status.statusCategory?.key ?? "undefined", position })));
  }

  /**
   * The board's workflow (spec section 5.3): its statuses, and the transitions of the workflows its
   * issue types use, in one (each once per `(from, to, name)`, a global one from `any`), for the
   * Boards page's `by …` lines and warnings. Read through `/workflows/search` for the project.
   * Without `read:workflow:jira`, or when Jira shows the token none of the project's workflows (it
   * may answer an empty page rather than refuse: S-12), `readable: false` and the statuses alone.
   */
  override async readWorkflow(board: BoardRef): Promise<AdapterResult<TrackerWorkflow>> {
    const statuses = await this.listStatuses(board);
    if (!statuses.ok) {
      return statuses;
    }
    const unreadable = ok({ readable: false, statuses: statuses.value, transitions: [] });
    const read = await this.#searchWorkflows(board.externalId);
    if (!read.ok) {
      this.plumbing.logger.debug("jira.workflow.unread", { project: board.externalId, code: read.error.code });
      return isRefusal(read.error) ? unreadable : read;
    }
    if (read.value.workflows.length === 0) {
      this.plumbing.logger.debug("jira.workflow.unread", { project: board.externalId, code: "none-shown" });
      return unreadable;
    }
    return ok(readJiraWorkflows(read.value, statuses.value));
  }

  async getTicketContext(board: BoardRef, ref: TicketRef, options?: TicketContextOptions): Promise<AdapterResult<TicketContext>> {
    const found = await this.#issueOnBoard(board, ref, this.#ticketFields(CONTEXT_FIELDS));
    if (!found.ok) {
      return found;
    }
    const issue = found.value;
    const ticket = this.#ticket(issue);
    if (!ticket.ok) {
      return ticket;
    }
    const rawComments = await this.#comments(issue.id);
    if (!rawComments.ok) {
      return rawComments;
    }
    const links = await this.#remoteLinks(issue.id);
    if (!links.ok) {
      return links;
    }
    const children = await this.#children(issue);
    if (!children.ok) {
      return children;
    }
    const markers = await this.#markers(issue.id);
    if (!markers.ok) {
      return markers;
    }
    const attachments = issue.fields.attachment ?? [];
    const read = this.#readOptions(attachments);
    const description = readAdf(issue.fields.description, read);

    const comments: { readonly comment: TicketComment; readonly files: readonly ShownFile[] }[] = [];
    for (const raw of rawComments.value) {
      const createdAt = jiraTime(raw.created);
      if (createdAt === null) continue;
      const body = readAdf(raw.body, read);
      comments.push({
        comment: {
          id: raw.id,
          body: body.markdown,
          author: raw.author === null || raw.author === undefined ? null : { id: raw.author.accountId, name: raw.author.displayName ?? raw.author.accountId },
          parentId: null,
          createdAt,
          updatedAt: jiraTime(raw.updated) ?? createdAt,
        },
        files: body.files,
      });
    }
    comments.sort((a, b) => a.comment.createdAt - b.comment.createdAt);

    const byUrl = new Map(attachments.map((attachment) => [this.#fileUrl(attachment.id), attachment]));
    const files = ticketFileList();
    const images: TicketImage[] = [];
    const imageUrls = new Set<string>();
    const add = (file: ShownFile, where: TicketContextFile["where"], commentId: string | null, byOstra: boolean): void => {
      const attachment = byUrl.get(file.url);
      files.add({ url: file.url, name: file.name, contentType: attachment?.mimeType ?? null, size: attachment?.size ?? null, where, commentId, byOstra });
      if (file.image && !imageUrls.has(file.url)) {
        imageUrls.add(file.url);
        images.push({ url: file.url, name: file.name, contentType: attachment?.mimeType ?? null });
      }
    };
    for (const file of description.files) add(file, "description", null, false);
    for (const { comment, files: shown } of comments) {
      const own = isOwnComment(options?.own, comment);
      for (const file of shown) add(file, "comment", comment.id, own);
    }
    const ownUser = options?.own?.userId ?? null;
    for (const attachment of attachments) {
      const subtitle = markers.value[attachment.id] ?? null;
      const byOstra = isOwnAttachment(options?.own, { subtitle }) || (ownUser !== null && attachment.author?.accountId === ownUser);
      add(this.#shownAttachment(attachment), "attachment", null, byOstra);
    }

    return ok({
      ticket: ticket.value,
      comments: comments.map(({ comment }) => comment),
      attachments: this.#attachmentList(links.value, attachments, markers.value),
      images,
      files: filesForCapability(files.files(), this.capabilities.ticketFiles),
      parent: this.#summary(issue.fields.parent),
      children: children.value,
      linked: (issue.fields.issuelinks ?? []).flatMap((link) => this.#linked(link)),
    });
  }

  async detectCodeHostIntegration(board: BoardRef): Promise<AdapterResult<CodeHostIntegration>> {
    const project = await this.#project(board);
    // GitHub for Atlassian is a Marketplace app, which a service account's scopes can't list: Jira
    // says nothing ostra can read, so it's never reported installed, and Done is moved by ostra by
    // default (boards-mixed.md, choice 8).
    return project.ok ? ok({ installed: false, name: null }) : project;
  }

  async downloadFile(url: string, maxBytes: number): Promise<AdapterResult<DownloadedFile>> {
    const id = this.#attachmentIdOf(url);
    if (id === null) {
      // The token is sent only to the site's own attachments.
      return adapterError("invalid-input", "downloading a ticket's file failed: not a file Jira holds");
    }
    // `redirect=false`: Jira answers with the bytes instead of a redirect to its media host.
    const sent = await this.#send("Jira's attachment", { method: "GET", path: `/rest/api/3/attachment/content/${id}`, query: { redirect: "false" }, accept: "*/*" }, Math.max(this.#timeoutMs, 30_000));
    if (!sent.ok) {
      return sent;
    }
    const response = sent.value;
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

  /** Milestone 9 (F-149): a follow-up's files, read from its markdown as a comment's are. */
  override filesInText(markdown: string): readonly TicketContextFile[] {
    const files = ticketFileList();
    for (const link of markdownLinks(markdown)) {
      const id = this.#attachmentIdOf(link.url);
      if (id === null) continue;
      const fallback = link.url.split("/").filter((segment) => segment !== "").at(-1) ?? "file";
      const name = plainName(link.text) ?? (NUMERIC_ID.test(fallback) ? "file" : safeDecode(fallback));
      files.add({ url: this.#fileUrl(id), name, contentType: null, size: null, where: "comment", commentId: null, byOstra: false });
    }
    return filesForCapability(files.files(), this.capabilities.ticketFiles);
  }

  // ---------- writes ----------

  /** Jira can't write a status (spec section 5.3): a ticket moves only by `moveTicket`'s transitions. */
  updateStatus(board: BoardRef, key: TicketKey, statusId: string): Promise<AdapterResult<void>> {
    this.plumbing.logger.debug("jira.status.refused", { board: board.externalId, ticket: key, status: statusId });
    return Promise.resolve(adapterError("unsupported", "Jira moves a ticket only by its workflow's transitions, never by writing its status: use moveTicket"));
  }

  async moveTicket(board: BoardRef, ref: TicketRef, target: MoveTarget, mapping: StatusMapping): Promise<AdapterResult<MoveResult>> {
    const found = await this.#issueOnBoard(board, ref, ["status", "project", "issuetype"]);
    if (!found.ok) {
      return found;
    }
    const goal = mappedStatusId(mapping, target);
    if (found.value.fields.status.id === goal) {
      // Already there: nothing is written, so a retried step changes no history.
      return ok({ moved: false, status: toStatus(found.value.fields.status), via: [] });
    }
    // Milestone 11 (ticket 02): the transitions it took, in order, are its `via`.
    const walked = await this.#walk(found.value, goal);
    return walked.ok ? ok({ moved: true, status: walked.value.status, via: walked.value.via }) : walked;
  }

  async comment(board: BoardRef, key: TicketKey, markdown: string): Promise<AdapterResult<{ readonly commentId: string }>> {
    if (markdown.trim() === "") {
      return adapterError("invalid-input", "commenting failed: the comment has no text");
    }
    const found = await this.#issueOnBoard(board, { key }, ["project"]);
    if (!found.ok) {
      return found;
    }
    const created = await this.#call(
      "Jira's new comment",
      { method: "POST", path: `/rest/api/3/issue/${found.value.id}/comment`, json: { body: this.#adf(markdown) }, writesIssue: found.value.id },
      commentSchema,
    );
    return created.ok ? ok({ commentId: created.value.id }) : created;
  }

  async updateComment(board: BoardRef, ref: TicketRef, commentId: string, markdown: string): Promise<AdapterResult<void>> {
    if (markdown.trim() === "") {
      return adapterError("invalid-input", "editing a comment failed: the comment has no text");
    }
    if (!NUMERIC_ID.test(commentId)) {
      return adapterError("not-found", "editing a comment failed: the comment is not on this ticket");
    }
    const found = await this.#issueOnBoard(board, ref, ["project"]);
    if (!found.ok) {
      return found;
    }
    // The path names the issue: a comment from elsewhere is Jira's 404, and edits nothing. Only
    // the service account's own is edited, even where its permissions would allow a person's.
    const existing = await this.#call("Jira's comment", { method: "GET", path: `/rest/api/3/issue/${found.value.id}/comment/${commentId}` }, commentSchema);
    if (!existing.ok) {
      return existing;
    }
    const me = await this.#myself();
    if (!me.ok) {
      return me;
    }
    if (existing.value.author?.accountId !== me.value.accountId) {
      return adapterError("forbidden", "editing a comment failed: only the service account's own comment is edited");
    }
    const updated = await this.#call(
      "Jira's comment edit",
      { method: "PUT", path: `/rest/api/3/issue/${found.value.id}/comment/${commentId}`, json: { body: this.#adf(markdown) }, writesIssue: found.value.id },
      commentSchema,
    );
    return updated.ok ? ok(undefined) : updated;
  }

  async linkPullRequest(board: BoardRef, key: TicketKey, pullRequestUrl: string, options?: PullRequestLinkOptions): Promise<AdapterResult<void>> {
    if (!/^https?:\/\//i.test(pullRequestUrl) || !URL.canParse(pullRequestUrl)) {
      return adapterError("invalid-input", "linking a PR failed: not a URL");
    }
    const found = await this.#issueOnBoard(board, { key }, ["project"]);
    if (!found.ok) {
      return found;
    }
    const number = /\/pull\/(\d{1,10})(?:[/?#]|$)/.exec(new URL(pullRequestUrl).pathname)?.[1];
    // Jira can't act on how a PR relates (`options.kind`): its link only says it's a pull request.
    this.plumbing.logger.debug("jira.pr.link", { ticket: found.value.id, kind: options?.kind ?? "default" });
    const linked = await this.#remoteLink(found.value.id, {
      url: pullRequestUrl,
      title: number === undefined ? "Pull request" : `Pull request #${number}`,
      summary: null,
      application: { type: "com.github", name: "GitHub" },
      relationship: "pull request",
    });
    return linked.ok ? ok(undefined) : linked;
  }

  async linkTask(board: BoardRef, ref: TicketRef, link: TaskLink): Promise<AdapterResult<{ readonly attachmentId: string }>> {
    if (!/^https?:\/\//i.test(link.url) || !URL.canParse(link.url)) {
      return adapterError("invalid-input", "linking the task failed: not a URL");
    }
    const found = await this.#issueOnBoard(board, ref, ["project"]);
    if (!found.ok) {
      return found;
    }
    const linked = await this.#remoteLink(found.value.id, {
      url: link.url,
      title: link.title,
      summary: link.subtitle,
      application: { type: "ostra", name: "ostra" },
      relationship: "ostra task",
    });
    return linked.ok ? ok({ attachmentId: linked.value }) : linked;
  }

  async createTicket(board: BoardRef, ticket: NewTicket): Promise<AdapterResult<Ticket>> {
    if (ticket.title.trim() === "") {
      return adapterError("invalid-input", "creating a ticket failed: it has no title");
    }
    let parent: JiraIssue | null = null;
    if (ticket.parent !== undefined) {
      // A sub-task's parent must be on this board: one from elsewhere makes nothing.
      const found = await this.#issueOnBoard(board, ticket.parent, ["project", "issuetype", "status"]);
      if (!found.ok) {
        return found;
      }
      parent = found.value;
    }
    const project = await this.#project(board);
    if (!project.ok) {
      return project;
    }
    const types = project.value.issueTypes ?? [];
    // Under an epic (a level above a task) a child is a task; under a task, a sub-task.
    const wantsSubtask = parent !== null && (parent.fields.issuetype?.hierarchyLevel ?? 0) < 1;
    const type = wantsSubtask
      ? types.find((one) => one.subtask === true || one.hierarchyLevel === -1)
      : (types.find((one) => one.subtask !== true && one.name.toLowerCase() === "task") ?? types.find((one) => one.subtask !== true && (one.hierarchyLevel ?? 0) === 0));
    if (type === undefined) {
      return adapterError("invalid-input", wantsSubtask ? "creating a ticket failed: the project has no sub-task type" : "creating a ticket failed: the project has no task type");
    }
    const fields: Record<string, unknown> = { project: { id: project.value.id }, summary: ticket.title, issuetype: { id: type.id } };
    if (ticket.description !== null && ticket.description.trim() !== "") fields["description"] = this.#adf(ticket.description);
    if (parent !== null) fields["parent"] = { id: parent.id };
    const created = await this.#call("Jira's new issue", { method: "POST", path: "/rest/api/3/issue", json: { fields } }, createdSchema);
    if (!created.ok) {
      return created;
    }
    return this.getTicket(board, { externalId: externalTicketIdSchema.parse(created.value.id) });
  }

  /** Milestone 6 (F-099): the description as ADF, and the criteria in their field where the site has one. */
  override async updateTicket(board: BoardRef, ref: TicketRef, update: TicketUpdate): Promise<AdapterResult<void>> {
    if (update.acceptanceCriteria !== undefined && this.#criteriaField === null) {
      return adapterError("invalid-input", "updating a ticket failed: this Jira connection has no acceptance-criteria field");
    }
    const found = await this.#issueOnBoard(board, ref, ["project"]);
    if (!found.ok) {
      return found;
    }
    const fields: Record<string, unknown> = { description: update.description.trim() === "" ? null : this.#adf(update.description) };
    if (update.acceptanceCriteria !== undefined && this.#criteriaField !== null) {
      fields[this.#criteriaField] = update.acceptanceCriteria.trim() === "" ? null : this.#adf(update.acceptanceCriteria);
    }
    return this.#write("Jira's issue edit", { method: "PUT", path: `/rest/api/3/issue/${found.value.id}`, json: { fields }, writesIssue: found.value.id });
  }

  /** Milestone 6 (F-099): a Jira attachment, its marker kept in ostra's issue property. */
  override async attachFile(board: BoardRef, ref: TicketRef, file: TicketFile): Promise<AdapterResult<AttachedFile>> {
    if (file.bytes.length > MAX_JIRA_ATTACHMENT_BYTES) {
      return adapterError("invalid-input", `attaching a file failed: it's larger than ${String(MAX_JIRA_ATTACHMENT_BYTES)} bytes`);
    }
    if (file.name.trim() === "" || file.contentType.trim() === "") {
      return adapterError("invalid-input", "attaching a file failed: it has no name or no type");
    }
    const found = await this.#issueOnBoard(board, ref, ["project"]);
    if (!found.ok) {
      return found;
    }
    const form = new FormData();
    form.append("file", new Blob([ownBuffer(file.bytes)], { type: file.contentType }), file.name);
    const uploaded = await this.#call(
      "Jira's attachment upload",
      { method: "POST", path: `/rest/api/3/issue/${found.value.id}/attachments`, form, writesIssue: found.value.id },
      z.array(attachmentSchema).min(1),
    );
    if (!uploaded.ok) {
      return uploaded;
    }
    const [attachment] = uploaded.value;
    if (attachment === undefined) {
      return adapterError("invalid-response", "attaching a file failed: Jira listed no attachment");
    }
    if (file.marker !== undefined && file.marker !== "") {
      const markers = await this.#markers(found.value.id);
      if (!markers.ok) {
        return markers;
      }
      const written = await this.#write("ostra's attachment markers", {
        method: "PUT",
        path: `/rest/api/3/issue/${found.value.id}/properties/${MARKERS_PROPERTY}`,
        json: { markers: { ...markers.value, [attachment.id]: file.marker.slice(0, 500) } },
        writesIssue: found.value.id,
      });
      if (!written.ok) {
        return written;
      }
    }
    return ok({ attachmentId: attachment.id, url: this.#fileUrl(attachment.id) });
  }

  /** The issue's remote links, then its files, each file with the marker `attachFile` kept for it. */
  override async listAttachments(board: BoardRef, ref: TicketRef): Promise<AdapterResult<readonly TicketAttachment[]>> {
    const found = await this.#issueOnBoard(board, ref, ["project", "attachment"]);
    if (!found.ok) {
      return found;
    }
    const links = await this.#remoteLinks(found.value.id);
    if (!links.ok) {
      return links;
    }
    const markers = await this.#markers(found.value.id);
    return markers.ok ? ok(this.#attachmentList(links.value, found.value.fields.attachment ?? [], markers.value)) : markers;
  }

  // ---------- people ----------

  /** A site user by account ID. The address only when Jira shows it to the token. */
  override async getUser(userId: string): Promise<AdapterResult<TrackerPerson>> {
    const found = await this.#call("Jira's user", { method: "GET", path: "/rest/api/3/user", query: { accountId: userId } }, accountSchema);
    if (!found.ok) {
      return found;
    }
    if (found.value.accountId !== userId) {
      return adapterError("not-found", "reading a user failed: not found, or not visible to the credentials");
    }
    const email = found.value.emailAddress?.trim() ?? "";
    return ok({ userId: found.value.accountId, name: found.value.displayName ?? found.value.accountId, email: email === "" ? null : email, active: found.value.active !== false });
  }

  /**
   * The site's active people with these emails (F-036), each mentioned by account ID. `user/search`
   * matches the query against names and addresses by prefix, so a user counts only when Jira shows
   * the token their address and it's the one asked: a hidden address is left out, never guessed.
   */
  override async findUsersByEmail(board: BoardRef, emails: readonly string[]): Promise<AdapterResult<readonly TrackerUser[]>> {
    const asked = new Map<string, string>();
    for (const email of emails) {
      const key = email.trim().toLowerCase();
      if (key !== "" && !asked.has(key)) asked.set(key, email);
    }
    const found: TrackerUser[] = [];
    const seen = new Set<string>();
    for (const [key, email] of asked) {
      const listed = await this.#call("Jira's user search", { method: "GET", path: "/rest/api/3/user/search", query: { query: key, maxResults: "10" } }, usersSchema);
      if (!listed.ok) {
        this.plumbing.logger.warn("jira.users.failed", { board: board.externalId, code: listed.error.code, count: asked.size });
        return listed;
      }
      for (const user of listed.value) {
        const visible = user.emailAddress?.trim().toLowerCase();
        if (visible !== key || user.active === false || (user.accountType !== undefined && user.accountType !== "atlassian") || seen.has(user.accountId)) continue;
        seen.add(user.accountId);
        found.push({ email, userId: user.accountId, mention: `[~accountid:${user.accountId}]` });
      }
    }
    this.plumbing.logger.debug("jira.users.found", { board: board.externalId, asked: asked.size, found: found.length });
    return ok(found);
  }

  // ---------- webhooks ----------

  verifyWebhook(request: TrackerWebhookRequest): WebhookVerification {
    return verifyJiraWebhook(request, this.#webhookMaxAgeMs);
  }

  parseWebhook(input: ParseWebhookInput): AdapterResult<TrackerWebhookHint> {
    return jiraWebhookHint(input);
  }

  // ---------- internals ----------

  /** The token's own account, read once: its time zone is what JQL's times are read in. */
  async #myself(): Promise<AdapterResult<JiraAccount>> {
    if (this.#me !== undefined) {
      return ok(this.#me);
    }
    const me = await this.#call("Jira's myself", { method: "GET", path: "/rest/api/3/myself" }, accountSchema);
    if (me.ok) {
      this.#me = me.value;
    }
    return me;
  }

  /** The fields a ticket is read with: Jira's own, and the criteria field where the connection names one. */
  #ticketFields(fields: readonly string[]): readonly string[] {
    return this.#criteriaField === null ? fields : [...fields, this.#criteriaField];
  }

  #adf(markdown: string): unknown {
    return markdownToAdf(markdown, { isHostedFile: (url) => this.#attachmentIdOf(url) !== null });
  }

  #notOnBoard(operation: string): AdapterResult<never> {
    return adapterError("not-found", `${operation} failed: not found on this board, or not visible to the credentials`);
  }

  async #issueOnBoard(board: BoardRef, ref: TicketRef, fields: readonly string[]): Promise<AdapterResult<JiraIssue>> {
    const idOrKey = "externalId" in ref ? ref.externalId : ref.key;
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(idOrKey)) {
      return this.#notOnBoard("reading a ticket");
    }
    const found = await this.#call(
      "Jira's issue",
      { method: "GET", path: `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, query: { fields: [...new Set([...fields, "project", "status", "summary", "updated"])].join(",") } },
      issueSchema,
    );
    if (!found.ok) {
      return found.error.code === "not-found" ? this.#notOnBoard("reading a ticket") : found;
    }
    const sameTicket = "externalId" in ref ? found.value.id === ref.externalId : true;
    return sameTicket && found.value.fields.project.id === board.externalId ? found : this.#notOnBoard("reading a ticket");
  }

  async #project(board: BoardRef): Promise<AdapterResult<z.infer<typeof projectSchema>>> {
    if (!NUMERIC_ID.test(board.externalId)) {
      return this.#notOnBoard("reading a project");
    }
    const found = await this.#call("Jira's project", { method: "GET", path: `/rest/api/3/project/${board.externalId}` }, projectSchema);
    return found.ok && found.value.id !== board.externalId ? this.#notOnBoard("reading a project") : found;
  }

  /** The project's statuses across its issue types, each once, in Jira's order. */
  async #projectStatuses(board: BoardRef): Promise<AdapterResult<readonly JiraStatusJson[]>> {
    if (!NUMERIC_ID.test(board.externalId)) {
      return this.#notOnBoard("listing statuses");
    }
    const listed = await this.#call("Jira's project statuses", { method: "GET", path: `/rest/api/3/project/${board.externalId}/statuses` }, projectStatusesSchema);
    if (!listed.ok) {
      return listed;
    }
    const statuses = new Map<string, JiraStatusJson>();
    for (const type of listed.value) {
      for (const status of type.statuses) {
        if (!statuses.has(status.id)) statuses.set(status.id, status);
      }
    }
    return ok([...statuses.values()]);
  }

  #ticket(issue: JiraIssue): AdapterResult<Ticket> {
    const key = ticketKeySchema.safeParse(issue.key);
    const externalId = externalTicketIdSchema.safeParse(issue.id);
    const updatedAt = jiraTime(issue.fields.updated);
    const parent = issue.fields.parent;
    const parentKey = parent === null || parent === undefined ? null : ticketKeySchema.safeParse(parent.key);
    const parentId = parent === null || parent === undefined ? null : externalTicketIdSchema.safeParse(parent.id);
    if (!key.success || !externalId.success || updatedAt === null || parentKey?.success === false || parentId?.success === false) {
      return adapterError("invalid-response", "Jira's issue could not be read");
    }
    const description = issue.fields.description;
    const ticket: Ticket = {
      externalId: externalId.data,
      key: key.data,
      title: issue.fields.summary,
      description: description === null || description === undefined ? null : readAdf(description, this.#readOptions(issue.fields.attachment ?? [])).markdown,
      status: toStatus(issue.fields.status),
      url: `${this.#site}/browse/${key.data}`,
      priority: priorityOf(issue.fields.priority?.name),
      parentKey: parentKey?.success === true ? parentKey.data : null,
      parentExternalId: parentId?.success === true ? parentId.data : null,
      labels: [...(issue.fields.labels ?? [])],
      assignee: issue.fields.assignee === null || issue.fields.assignee === undefined ? null : { id: issue.fields.assignee.accountId, name: issue.fields.assignee.displayName ?? issue.fields.assignee.accountId },
      // The Jira project is the board itself (F-011's tracker project).
      trackerProject: { id: issue.fields.project.id, name: issue.fields.project.name ?? issue.fields.project.key ?? issue.fields.project.id },
      updatedAt,
    };
    if (this.#criteriaField === null) {
      return ok(ticket);
    }
    const criteria: unknown = issue.fields[this.#criteriaField];
    const read = criteria === null || criteria === undefined ? "" : readAdf(criteria).markdown;
    return ok({ ...ticket, acceptanceCriteria: read === "" ? null : read });
  }

  #summary(ref: JiraIssueRef | null | undefined): TicketSummary | null {
    if (ref?.fields?.status === undefined) {
      return null;
    }
    const key = ticketKeySchema.safeParse(ref.key);
    const externalId = externalTicketIdSchema.safeParse(ref.id);
    return key.success && externalId.success
      ? { externalId: externalId.data, key: key.data, title: ref.fields.summary ?? "", url: `${this.#site}/browse/${key.data}`, status: toStatus(ref.fields.status) }
      : null;
  }

  /** A Jira issue link from this issue's side: an outward issue is what this one does to it. */
  #linked(link: JiraIssueLink): LinkedTicket[] {
    const outward = link.outwardIssue !== undefined;
    const other = this.#summary(link.outwardIssue ?? link.inwardIssue);
    if (other === null) {
      return [];
    }
    const type = link.type.name.toLowerCase();
    const kind: TicketLinkKind = type.startsWith("block") ? (outward ? "blocks" : "blocked-by") : type.startsWith("duplicat") ? (outward ? "duplicate" : "duplicated-by") : "related";
    return [{ kind, ticket: other }];
  }

  /** Sub-tasks, and the issues whose parent this is (an epic's children), oldest first, each once. */
  async #children(issue: JiraIssue): Promise<AdapterResult<readonly ChildTicket[]>> {
    const children = new Map<string, TicketSummary>();
    for (const subtask of issue.fields.subtasks ?? []) {
      const summary = this.#summary(subtask);
      if (summary !== null) children.set(summary.externalId, summary);
    }
    const found = await this.#call(
      "Jira's child issues",
      { method: "POST", path: "/rest/api/3/search/jql", json: { jql: `parent = ${issue.id} ORDER BY created ASC`, maxResults: MAX_PAGE, fields: ["summary", "status"] } },
      childrenPageSchema,
    );
    // A site whose JQL refuses `parent` still has the sub-tasks the issue lists.
    if (!found.ok && found.error.code !== "invalid-input") {
      return found;
    }
    for (const child of found.ok ? found.value.issues : []) {
      const summary = this.#summary(child);
      if (summary !== null && !children.has(summary.externalId)) children.set(summary.externalId, summary);
    }
    return ok([...children.values()].map((child) => ({ ...child, open: isOpenCategory(child.status.category) })));
  }

  async #comments(issueId: string): Promise<AdapterResult<readonly JiraComment[]>> {
    const comments: JiraComment[] = [];
    let startAt = 0;
    for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
      const listed = await this.#call(
        "Jira's comments",
        { method: "GET", path: `/rest/api/3/issue/${issueId}/comment`, query: { startAt: String(startAt), maxResults: String(MAX_PAGE), orderBy: "created" } },
        commentPageSchema,
      );
      if (!listed.ok) {
        return listed;
      }
      comments.push(...listed.value.comments);
      startAt += listed.value.comments.length;
      if (listed.value.comments.length === 0 || startAt >= (listed.value.total ?? startAt)) {
        break;
      }
    }
    return ok(comments);
  }

  async #remoteLinks(issueId: string): Promise<AdapterResult<z.infer<typeof remoteLinksSchema>>> {
    return this.#call("Jira's remote links", { method: "GET", path: `/rest/api/3/issue/${issueId}/remotelink` }, remoteLinksSchema);
  }

  /** Upserts a remote link by its global ID, so linking a URL twice links it once. Its ID. */
  async #remoteLink(
    issueId: string,
    link: { readonly url: string; readonly title: string; readonly summary: string | null; readonly application: { readonly type: string; readonly name: string }; readonly relationship: string },
  ): Promise<AdapterResult<string>> {
    const created = await this.#call(
      "Jira's remote link",
      {
        method: "POST",
        path: `/rest/api/3/issue/${issueId}/remotelink`,
        writesIssue: issueId,
        json: {
          globalId: globalIdOf(link.url),
          application: link.application,
          relationship: link.relationship,
          object: { url: link.url, title: link.title.slice(0, 255), ...(link.summary === null ? {} : { summary: link.summary.slice(0, 255) }) },
        },
      },
      remoteLinkSchema.pick({ id: true }),
    );
    return created.ok ? ok(created.value.id) : created;
  }

  /** ostra's attachment markers on the issue; none when the property isn't there or isn't ostra's shape. */
  async #markers(issueId: string): Promise<AdapterResult<Markers>> {
    const read = await this.#call("ostra's attachment markers", { method: "GET", path: `/rest/api/3/issue/${issueId}/properties/${MARKERS_PROPERTY}` }, propertySchema);
    if (!read.ok) {
      return read.error.code === "not-found" ? ok({}) : read;
    }
    const parsed = markersPropertySchema.safeParse(read.value.value);
    return ok(parsed.success ? parsed.data.markers : {});
  }

  #attachmentList(links: z.infer<typeof remoteLinksSchema>, attachments: readonly JiraAttachment[], markers: Markers): TicketAttachment[] {
    return [
      ...links.map((link) => ({ id: link.id, url: link.object.url, title: link.object.title ?? link.object.url, subtitle: link.object.summary ?? null })),
      ...attachments.map((attachment) => ({ id: attachment.id, url: this.#fileUrl(attachment.id), title: attachment.filename, subtitle: markers[attachment.id] ?? null })),
    ];
  }

  /** Where `downloadFile` fetches an attachment: the API's content URL, by the attachment's ID. */
  #fileUrl(id: string): string {
    return `${this.#api}/rest/api/3/attachment/content/${id}`;
  }

  #shownAttachment(attachment: JiraAttachment): ShownFile {
    return { url: this.#fileUrl(attachment.id), name: attachment.filename, image: isImageAttachment(attachment) };
  }

  /**
   * An attachment's ID, when the URL is one of the site's attachments: the API's content URL (at the
   * gateway or the site), or the site's `/secure/attachment/<id>/…`. `null` for anything else: the
   * token never leaves for another host.
   */
  #attachmentIdOf(raw: string): string | null {
    if (!URL.canParse(raw)) return null;
    const url = new URL(raw);
    const href = `${url.origin}${url.pathname}`;
    for (const prefix of [`${this.#api}/rest/api/3/attachment/content/`, `${this.#site}/rest/api/3/attachment/content/`, `${this.#site}/rest/api/2/attachment/content/`]) {
      if (href.startsWith(prefix)) {
        const id = href.slice(prefix.length);
        return NUMERIC_ID.test(id) ? id : null;
      }
    }
    const secure = `${this.#site}/secure/attachment/`;
    if (href.startsWith(secure)) {
      const id = href.slice(secure.length).split("/")[0] ?? "";
      return NUMERIC_ID.test(id) ? id : null;
    }
    return null;
  }

  /**
   * How a document finds its files: a `media` node by its ID or, as Jira's editor writes an upload,
   * by its file name among the issue's attachments; a link by its attachment URL.
   */
  #readOptions(attachments: readonly JiraAttachment[]): AdfReadOptions {
    return {
      media: ({ id, alt }) => {
        const found =
          attachments.find((attachment) => id !== null && attachment.id === id) ??
          (alt === null ? undefined : (attachments.find((attachment) => attachment.filename === alt) ?? attachments.find((attachment) => attachment.filename.toLowerCase() === alt.toLowerCase())));
        return found === undefined ? null : this.#shownAttachment(found);
      },
      hostedFile: (href, text) => {
        const id = this.#attachmentIdOf(href);
        if (id === null) return null;
        const attachment = attachments.find((one) => one.id === id);
        if (attachment !== undefined) return this.#shownAttachment(attachment);
        const name = plainName(text) ?? "file";
        return { url: this.#fileUrl(id), name, image: IMAGE_NAME.test(name) };
      },
    };
  }

  /**
   * Every workflow `/workflows/search` shows for a project (the workflows its issue types use, or a
   * team-managed project's own), page by page, with the statuses they reference.
   */
  async #searchWorkflows(projectId: string): Promise<AdapterResult<JiraWorkflowsAnswer>> {
    if (!NUMERIC_ID.test(projectId)) {
      return this.#notOnBoard("reading a workflow");
    }
    const workflows: JiraWorkflowJson[] = [];
    const statuses = new Map<string, JiraWorkflowStatusJson>();
    let startAt = 0;
    for (let page = 0; page < MAX_WORKFLOW_PAGES; page += 1) {
      const listed = await this.#call(
        "Jira's workflows",
        { method: "GET", path: "/rest/api/3/workflows/search", query: { projectId, expand: "values.transitions", startAt: String(startAt), maxResults: String(DEFAULT_PAGE) } },
        workflowSearchSchema,
      );
      if (!listed.ok) {
        return listed;
      }
      workflows.push(...listed.value.values);
      for (const status of listed.value.statuses ?? []) statuses.set(status.statusReference, status);
      startAt += listed.value.values.length;
      if (listed.value.isLast !== false || listed.value.values.length === 0) {
        break;
      }
    }
    return ok({ workflows, statuses: [...statuses.values()] });
  }

  /**
   * The workflow of a project's issue type, for a move (`POST /workflows` by the project and issue
   * type), read once every few minutes. `graph: null` when it can't be read: `readable: false`
   * when the token isn't allowed, or Jira shows it none, and the move then finds its transitions
   * per ticket.
   */
  async #graph(projectId: string, issueTypeId: string): Promise<{ readonly graph: TrackerWorkflow | null; readonly readable: boolean }> {
    const cacheKey = `${projectId}:${issueTypeId}`;
    const cached = this.#graphs.get(cacheKey);
    const now = this.plumbing.clock.now();
    if (cached !== undefined && now - cached.at < GRAPH_TTL_MS) {
      return cached;
    }
    const remember = (graph: TrackerWorkflow | null, readable: boolean): { readonly graph: TrackerWorkflow | null; readonly readable: boolean } => {
      const entry = { at: now, graph, readable };
      this.#graphs.set(cacheKey, entry);
      return entry;
    };
    const read = await this.#call("Jira's workflow", { method: "POST", path: "/rest/api/3/workflows", json: { projectAndIssueTypes: [{ projectId, issueTypeId }] } }, workflowReadSchema);
    if (!read.ok) {
      this.plumbing.logger.debug("jira.workflow.unread", { project: projectId, code: read.error.code });
      return isRefusal(read.error) ? remember(null, false) : { graph: null, readable: true };
    }
    if (read.value.workflows.length === 0) {
      return remember(null, false);
    }
    return remember(readJiraWorkflows({ workflows: read.value.workflows, statuses: read.value.statuses ?? [] }, null), true);
  }

  /**
   * Walks the issue to `goal` by its available transitions, one call each, at most
   * `MAX_ROUTE_STEPS` of them (Q352): by the workflow's shortest way when the token reads
   * workflows, else one category step at a time. A transition its screen refuses (Jira's 400: a
   * field it needs) is routed around. A goal no route reaches is `conflict`, with the issue left
   * where it was. The status reached, and the transitions taken (a refused one isn't).
   */
  async #walk(issue: JiraIssue, goal: string): Promise<AdapterResult<{ readonly status: TicketStatus; readonly via: readonly TransitionTaken[] }>> {
    const projectId = issue.fields.project.id;
    const issueTypeId = issue.fields.issuetype?.id;
    const read = issueTypeId === undefined ? { graph: null } : await this.#graph(projectId, issueTypeId);
    const refused = new Set<string>();
    // The workflow less what a screen refused: what the next step is planned on.
    const graphNow = (): TrackerWorkflow | null => (read.graph === null ? null : { ...read.graph, transitions: read.graph.transitions.filter((transition) => !refused.has(transition.id)) });
    const noRoute = (from: string): AdapterResult<never> =>
      adapterError("conflict", `moving a ticket failed: no route of at most ${String(MAX_ROUTE_STEPS)} transitions reaches status ${goal} from status ${from}`);
    let goalCategory = read.graph?.statuses.find((status) => status.id === goal)?.category ?? null;
    if (read.graph !== null) {
      if (!read.graph.statuses.some((status) => status.id === goal)) {
        return adapterError("invalid-input", `moving a ticket failed: status ${goal} isn't in the ticket's workflow`);
      }
      if (routeTo(read.graph, issue.fields.status.id, goal) === null) {
        return noRoute(issue.fields.status.id);
      }
    } else {
      const statuses = await this.#projectStatuses({ externalId: projectId });
      if (!statuses.ok) {
        return statuses;
      }
      const target = statuses.value.find((status) => status.id === goal);
      if (target === undefined) {
        return adapterError("invalid-input", `moving a ticket failed: status ${goal} isn't on the board`);
      }
      goalCategory = toStatus(target).category;
    }
    let current = toStatus(issue.fields.status);
    const visited = new Set<string>([current.id]);
    const steps: AvailableTransition[] = [];
    let taken = 0;
    while (taken < MAX_ROUTE_STEPS) {
      const graph = graphNow();
      if (graph !== null && routeTo(graph, current.id, goal, MAX_ROUTE_STEPS - taken) === null) {
        return noRoute(current.id);
      }
      const listed = await this.#call("Jira's transitions", { method: "GET", path: `/rest/api/3/issue/${issue.id}/transitions` }, transitionsSchema);
      if (!listed.ok) {
        return listed;
      }
      const available: AvailableTransition[] = listed.value.transitions
        .filter((transition) => transition.isAvailable !== false && !refused.has(transition.id))
        .map((transition) => ({ id: transition.id, name: transition.name, to: toStatus(transition.to) }));
      const choice = nextTransition({ available, goal, goalCategory, currentCategory: current.category, visited, workflow: graph, stepsLeft: MAX_ROUTE_STEPS - taken });
      if (choice === null) {
        return noRoute(current.id);
      }
      const done = await this.#write("Jira's transition", { method: "POST", path: `/rest/api/3/issue/${issue.id}/transitions`, json: { transition: { id: choice.id } }, writesIssue: issue.id });
      if (!done.ok) {
        // A screen that needs a field ostra doesn't fill: another transition may still get there.
        if (done.error.code === "invalid-input" && refused.size < MAX_REFUSED) {
          this.plumbing.logger.debug("jira.transition.refused", { ticket: issue.id, transition: choice.id });
          refused.add(choice.id);
          continue;
        }
        return done;
      }
      this.plumbing.logger.debug("jira.transition", { ticket: issue.id, transition: choice.id, to: choice.to.id });
      taken += 1;
      steps.push(choice);
      current = { id: choice.to.id, name: choice.to.name, category: choice.to.category };
      visited.add(current.id);
      if (current.id === goal) {
        return ok({ status: current, via: transitionsTaken(steps) });
      }
    }
    return noRoute(current.id);
  }

  async #search(jql: string, cursor: string | undefined, pageSize: number | undefined, fields: readonly string[]): Promise<AdapterResult<TicketPage>> {
    const maxResults = Math.max(1, Math.min(pageSize ?? DEFAULT_PAGE, MAX_PAGE));
    const page = await this.#call(
      "Jira's search",
      { method: "POST", path: "/rest/api/3/search/jql", json: { jql, maxResults, fields: [...fields], ...(cursor === undefined ? {} : { nextPageToken: cursor }) } },
      searchPageSchema,
    );
    if (!page.ok) {
      return page;
    }
    const tickets: Ticket[] = [];
    for (const issue of page.value.issues) {
      const ticket = this.#ticket(issue);
      if (!ticket.ok) {
        return ticket;
      }
      tickets.push(ticket.value);
    }
    const next = page.value.nextPageToken;
    return ok({ tickets, nextCursor: page.value.isLast === true || next === null || next === undefined || next === "" ? null : next });
  }

  /** A call whose answer is read with `schema`. */
  async #call<S extends z.ZodType>(operation: string, request: Request, schema: S): Promise<AdapterResult<z.infer<S>>> {
    const sent = await this.#send(operation, request);
    if (!sent.ok) {
      return sent;
    }
    let body: unknown;
    try {
      body = await sent.value.json();
    } catch {
      return adapterError("invalid-response", `${operation} failed: Jira's answer was not JSON`);
    }
    return parseVendor(schema, body, `${operation}'s answer`);
  }

  /** A call whose answer has no body worth reading (Jira's 204). */
  async #write(operation: string, request: Request): Promise<AdapterResult<void>> {
    const sent = await this.#send(operation, request);
    if (!sent.ok) {
      return sent;
    }
    await sent.value.body?.cancel();
    return ok(undefined);
  }

  /**
   * Counts a write to an issue against Jira's per-issue limits (20 in 2 s, 100 in 30 s): one past
   * them waits here, with the time until the window frees, instead of spending a call on a 429.
   */
  #countIssueWrite(issueId: string): AdapterResult<void> {
    const now = this.plumbing.clock.now();
    const longest = Math.max(...ISSUE_WRITE_LIMITS.map((limit) => limit.windowMs));
    const recent = (this.#issueWrites.get(issueId) ?? []).filter((at) => at > now - longest);
    for (const limit of ISSUE_WRITE_LIMITS) {
      const inWindow = recent.filter((at) => at > now - limit.windowMs);
      const oldest = inWindow[0];
      if (inWindow.length >= limit.count && oldest !== undefined) {
        this.plumbing.logger.debug("jira.write.limited", { ticket: issueId, windowMs: limit.windowMs });
        return adapterError("rate-limited", "writing to a ticket waits for Jira's per-issue write limit", Math.max(1, oldest + limit.windowMs - now));
      }
    }
    recent.push(now);
    this.#issueWrites.set(issueId, recent);
    if (this.#issueWrites.size > 1000) {
      for (const [id, times] of this.#issueWrites) {
        if (times.every((at) => at <= now - longest)) this.#issueWrites.delete(id);
      }
    }
    return ok(undefined);
  }

  async #send(operation: string, request: Request, timeoutMs = this.#timeoutMs): Promise<AdapterResult<Response>> {
    if (request.writesIssue !== undefined) {
      const counted = this.#countIssueWrite(request.writesIssue);
      if (!counted.ok) {
        return counted;
      }
    }
    const budget = this.plumbing.rateBudget;
    if (budget !== undefined) {
      const decision = await budget.check(this.#budgetKey);
      if (!decision.go) {
        return adapterError("rate-limited", `${operation} waits for Jira's rate limit to reset`, decision.waitMs);
      }
    }
    const url = new URL(`${this.#api}${request.path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      for (const one of typeof value === "string" ? [value] : value) url.searchParams.append(name, one);
    }
    const headers: Record<string, string> = { authorization: this.#authorization, accept: request.accept ?? "application/json", "user-agent": "ostra-jira-adapter" };
    let body: string | FormData | undefined;
    if (request.form !== undefined) {
      // Jira refuses an upload without it (XSRF protection).
      headers["x-atlassian-token"] = "no-check";
      body = request.form;
    } else if (request.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(request.json);
    }
    let response: Response;
    try {
      response = await fetch(url, { method: request.method, headers, ...(body === undefined ? {} : { body }), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      this.plumbing.logger.warn("jira.call.failed", { operation, code: "unavailable" });
      return adapterError("unavailable", `${operation} failed: Jira could not be reached`);
    }
    if (budget !== undefined) {
      await budget.record(this.#budgetKey, {
        remaining: response.headers.get("x-ratelimit-remaining"),
        limit: response.headers.get("x-ratelimit-limit"),
        reset: resetSeconds(response.headers.get("x-ratelimit-reset")),
      });
    }
    if (response.ok) {
      return ok(response);
    }
    await response.body?.cancel();
    const error = this.#errorOf(operation, response);
    this.plumbing.logger.warn("jira.call.failed", { operation, code: error.code, status: response.status });
    return { ok: false, error };
  }

  /** An error in ostra's own words: Jira's body can quote ticket text, so it's never read. */
  #errorOf(operation: string, response: Response): AdapterError {
    const where = `${operation} failed (HTTP ${String(response.status)})`;
    switch (response.status) {
      case 401:
        return { code: "unauthorized", message: `${where}: Jira refused the credentials, or the token lacks a scope` };
      case 403:
        return { code: "forbidden", message: `${where}: the service account lacks a permission` };
      case 404:
        return { code: "not-found", message: `${where}: not found, or not visible to the credentials` };
      case 409:
        return { code: "conflict", message: where };
      case 429:
        return this.#rateLimited(where, response);
      default:
        if (response.status >= 300 && response.status < 400) return { code: "invalid-response", message: `${where}: Jira answered with a redirect` };
        return response.status >= 500 ? { code: "unavailable", message: `${where}: Jira is failing` } : { code: "invalid-input", message: where };
    }
  }

  /** Jira's 429: `Retry-After` in seconds (or a date), else `X-RateLimit-Reset`. */
  #rateLimited(where: string, response: Response): AdapterError {
    const now = this.plumbing.clock.now();
    const retry = response.headers.get("retry-after");
    const seconds = retry === null ? Number.NaN : Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { code: "rate-limited", message: where, retryAfterMs: Math.max(1, seconds) * 1000 };
    }
    const at = retry === null ? Number.NaN : Date.parse(retry);
    const reset = resetSeconds(response.headers.get("x-ratelimit-reset"));
    const wait = Number.isFinite(at) ? at - now : reset === null ? Number.NaN : Number(reset) * 1000 - now;
    return Number.isFinite(wait) && wait > 0 ? { code: "rate-limited", message: where, retryAfterMs: wait } : { code: "rate-limited", message: where };
  }
}

/** Jira's `X-RateLimit-Reset`, an ISO time, as the budget's seconds since the epoch. */
const resetSeconds = (value: string | null): string | null => {
  if (value === null || value.trim() === "") return null;
  if (/^\d{1,12}$/.test(value.trim())) return value.trim();
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : String(Math.ceil(at / 1000));
};

const safeDecode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};
