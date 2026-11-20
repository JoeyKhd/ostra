import type { ExternalTicketId, TicketKey, WebhookDeliveryId } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import { adapterError } from "../common/result.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { TrackerCapabilities } from "./capabilities.ts";

// The tracker kind (ADR 0013, ADR 0025, ADR 0047): Linear first, then Jira, GitHub Issues, GitLab.
// ostra keeps references and a cached copy of tickets, never the source of truth. Milestone 2 adds
// the operations a board, the Inbox, ticket context and ticket sync need (spec section 5.2), shaped
// so Jira fits too: boards are Jira projects, statuses have one of four categories, moves go
// through a mapping (Jira through transitions), and a ticket has a stable ID beside its key, which
// changes when the ticket moves.
//
// A ticket's text (title, description, comments, labels) is untrusted: adapters return it as data,
// and nothing here, or in a caller, puts it in a command or a log line.

/** The board a ticket lives on, as the tracker names it: a Linear team, a Jira project. */
export type BoardRef = { readonly externalId: string };

/** A board the credential can see (`listBoards`). */
export type TrackerBoard = {
  readonly externalId: string;
  /** The key tickets on it start with, such as `OST`. */
  readonly key: string;
  readonly name: string;
};

/** The four categories every tracker's statuses map to (Linear's types, Jira's categories). */
export type TicketStatusCategory = "open" | "started" | "done" | "cancelled";

export const ticketStatusCategories: readonly TicketStatusCategory[] = ["open", "started", "done", "cancelled"];

/** A ticket's status, as a ticket carries it. */
export type TicketStatus = {
  readonly id: string;
  readonly name: string;
  readonly category: TicketStatusCategory;
};

/** One of a board's statuses (`listStatuses`). */
export type TrackerStatus = TicketStatus & {
  /**
   * The tracker's own type or category name, such as Linear's `triage`, `backlog`, `unstarted`,
   * `started`, `completed`, `canceled`. The board's default mapping reads it (spec section 3, step 2).
   */
  readonly vendorType: string;
  /** The tracker's order of the statuses on the board, lowest first. */
  readonly position: number;
};

/**
 * How an operation finds a ticket. The stable ID is preferred: a key changes when a ticket moves
 * team (Linear) or project (Jira), and the stable ID never does.
 */
export type TicketRef = { readonly externalId: ExternalTicketId } | { readonly key: TicketKey };

/** A ticket, as every tracker adapter returns it. */
export type Ticket = {
  /** The tracker's stable ID. The ticket cache is keyed by it, never by the key (ticket 14). */
  readonly externalId: ExternalTicketId;
  /** The key as of this read. */
  readonly key: TicketKey;
  readonly title: string;
  /** Markdown. Untrusted text: passed as data, never interpolated into a command. */
  readonly description: string | null;
  readonly status: TicketStatus;
  readonly url: string;
  /** Linear's scale: 1 urgent to 4 low, lower is more urgent; `null` when there's none. */
  readonly priority: number | null;
  readonly parentKey: TicketKey | null;
  readonly parentExternalId: ExternalTicketId | null;
  /** The label names. */
  readonly labels: readonly string[];
  /**
   * Who the ticket is assigned to, for the Inbox's filter and panel. `null`: nobody. Missing: the
   * adapter doesn't say (an older one), which the cache keeps as no assignee.
   */
  readonly assignee?: { readonly id: string; readonly name: string } | null;
  /**
   * Milestone 6 (F-011): the tracker's own project the ticket is in (Linear's project), which an
   * intake rule's filter can name. `null`: none. Missing: the adapter doesn't say, which the cache
   * keeps as none.
   */
  readonly trackerProject?: { readonly id: string; readonly name: string } | null;
  /** In ms since the epoch. */
  readonly updatedAt: number;
  /**
   * Milestone 6 (F-099): the acceptance criteria, as a field of its own, on a tracker whose
   * `ticketFields.acceptanceCriteria` is true. Missing on any other. Untrusted text.
   */
  readonly acceptanceCriteria?: string | null;
};

/** Another ticket, as the context names it: a parent, a child or a linked one. */
export type TicketSummary = {
  readonly externalId: ExternalTicketId;
  readonly key: TicketKey;
  readonly title: string;
  readonly url: string;
  readonly status: TicketStatus;
};

export type TicketComment = {
  readonly id: string;
  /** Markdown. Untrusted text. */
  readonly body: string;
  /** The person or app that wrote it; `null` when the tracker doesn't say. */
  readonly author: { readonly id: string; readonly name: string } | null;
  /** The comment it replies to, in a threaded tracker. */
  readonly parentId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** A link or file attached to a ticket: ostra's own links are found here by their URL (F-046). */
export type TicketAttachment = {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly subtitle: string | null;
};

/** An image the ticket shows, inline in its text or attached: core copies it into the workspace. */
export type TicketImage = {
  /** Fetched with `downloadFile`, which adds the credential: never handed to the runner. */
  readonly url: string;
  /** A name for the file, from the tracker or the URL. Untrusted: core sanitizes it. */
  readonly name: string;
  /** The type the tracker says, when it says. */
  readonly contentType: string | null;
};

export type TicketLinkKind = "blocks" | "blocked-by" | "related" | "duplicate" | "duplicated-by";

export type LinkedTicket = { readonly kind: TicketLinkKind; readonly ticket: TicketSummary };

/**
 * A sub-issue, as its parent's context lists it (F-077). `open`: it isn't done or cancelled yet,
 * so the parent's page counts it as still to do.
 */
export type ChildTicket = TicketSummary & { readonly open: boolean };

/** Whether a status category is still open: neither done nor cancelled. */
export const isOpenCategory = (category: TicketStatusCategory): boolean => {
  switch (category) {
    case "open":
    case "started":
      return true;
    case "done":
    case "cancelled":
      return false;
    default:
      return category satisfies never;
  }
};

/** Everything the ticket prompt is rendered from (F-064). Every string in it is untrusted. */
export type TicketContext = {
  readonly ticket: Ticket;
  /** Oldest first. */
  readonly comments: readonly TicketComment[];
  readonly attachments: readonly TicketAttachment[];
  /** Inline images in the description and comments, then image attachments, each once. */
  readonly images: readonly TicketImage[];
  readonly parent: TicketSummary | null;
  readonly children: readonly ChildTicket[];
  readonly linked: readonly LinkedTicket[];
};

export type TicketQuery = {
  readonly board: BoardRef;
  readonly statusIds?: readonly string[];
  /** Inclusive, in ms since the epoch: tickets updated at or after it. Polling asks with an overlap. */
  readonly updatedSince?: number;
  /**
   * `updatedAt`: oldest change first, so a poller can move its cursor forward after each page.
   * Without it, the tracker's own order.
   */
  readonly order?: "updatedAt";
  readonly cursor?: string;
  /** At most this many per page; the adapter may send fewer. */
  readonly pageSize?: number;
};

export type TicketPage = { readonly tickets: readonly Ticket[]; readonly nextCursor: string | null };

/** Where `moveTicket` moves a ticket: one of the steps ticket sync maps (F-031). */
export type MoveTarget = "started" | "in-review" | "done";

/**
 * A board's status mapping, as the tracker reads it: the status ID each step moves to. The domain's
 * `boardMappingSchema` output fits this shape (this package never imports the domain, ADR 0045).
 */
export type StatusMapping = {
  readonly started: string;
  readonly inReview: string;
  readonly done: string;
};

/** The status ID a mapping names for a target. */
export const mappedStatusId = (mapping: StatusMapping, target: MoveTarget): string => {
  switch (target) {
    case "started":
      return mapping.started;
    case "in-review":
      return mapping.inReview;
    case "done":
      return mapping.done;
    default:
      return target satisfies never;
  }
};

export type MoveResult = {
  /** `false` when the ticket was already there: nothing was written. */
  readonly moved: boolean;
  readonly status: TicketStatus;
};

/** How a PR's link relates to its ticket: the board's magic word, `Closes` or `Refs` (spec section 11, item 5). */
export type PullRequestLinkKind = "closes" | "references";

export type PullRequestLinkOptions = { readonly kind?: PullRequestLinkKind };

/** ostra's link to the task on the ticket (F-031). Made once per URL. */
export type TaskLink = {
  readonly url: string;
  readonly title: string;
  readonly subtitle: string | null;
};

export type NewTicket = {
  readonly title: string;
  /** Markdown. */
  readonly description: string | null;
  /**
   * Milestone 6 (F-077, F-099): the ticket this one is a sub-issue of, on the same board. Needs
   * `subIssues`; without it, a ticket with a parent is `unsupported`.
   */
  readonly parent?: TicketRef;
};

/**
 * Milestone 6 (F-099): what "Update ticket" writes. `acceptanceCriteria` only where the tracker
 * has the field (`ticketFields.acceptanceCriteria`); anywhere else it's `invalid-input`, and core
 * writes the criteria into the description.
 */
export type TicketUpdate = {
  /** Markdown. */
  readonly description: string;
  readonly acceptanceCriteria?: string;
};

/** Milestone 6 (F-099): a file a member added to a draft, attached to the ticket (`attachFile`). */
export type TicketFile = {
  /** A plain file name. Untrusted: the adapter never builds a path from it. */
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
};

/** The file once attached: where the tracker keeps it. */
export type AttachedFile = { readonly attachmentId: string; readonly url: string };

/** Whether the tracker's own code host integration links PRs and moves statuses (F-031). */
export type CodeHostIntegration = { readonly installed: boolean; readonly name: string | null };

/** A file fetched from the tracker with the adapter's credential. */
export type DownloadedFile = { readonly bytes: Uint8Array; readonly contentType: string | null };

// ---------- webhooks ----------

/** A webhook request as the server received it, before anything trusts it. */
export type TrackerWebhookRequest = {
  /** The raw body, exactly as sent: the signature covers these bytes. */
  readonly rawBody: Uint8Array;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The connection's webhook signing secret. Never logged. */
  readonly secret: string;
  /** The server's clock, in ms since the epoch. */
  readonly now: number;
};

export type WebhookRefusal =
  /** No signature header. */
  | "missing-signature"
  | "bad-signature"
  /** Signed, but outside the freshness window (Linear: 60 s). */
  | "stale"
  /** Not JSON, or no delivery ID. */
  | "malformed";

export type WebhookVerification =
  | {
      readonly ok: true;
      /** The vendor's delivery ID (`Linear-Delivery`, `X-Atlassian-Webhook-Identifier`). */
      readonly deliveryId: WebhookDeliveryId;
      /** SHA-256 of the signature header, hex: Linear's second claim key (spec section 4). */
      readonly signatureHash: string;
      /** When the sender says it sent it, in ms since the epoch, for the transit time; `null` if it doesn't. */
      readonly sentAt: number | null;
      /** The parsed body: still untrusted, for `parseWebhook`. */
      readonly body: unknown;
    }
  | { readonly ok: false; readonly reason: WebhookRefusal };

/** What a delivery is about, loosely: a hint to fetch the ticket by, never the ticket itself. */
export type TrackerWebhookHint = {
  /** The vendor's event name (`Issue`, `Comment`, `jira:issue_updated`). */
  readonly event: string;
  readonly subject: "ticket" | "comment" | "label" | "attachment" | "other";
  readonly action: "create" | "update" | "remove" | "other";
  /** The ticket it touches, when it touches one. */
  readonly ticketExternalId: ExternalTicketId | null;
  readonly ticketKey: TicketKey | null;
  /** The board, when the delivery names it. */
  readonly boardExternalId: string | null;
  /** The connection's own user made the change: recorded, not acted on (no echo). */
  readonly byOwnUser: boolean;
};

export type ParseWebhookInput = {
  /** `body` from a successful `verifyWebhook`. */
  readonly body: unknown;
  /** The connection's own user on the tracker, for the echo check; `null` when it has none. */
  readonly ownUserId: string | null;
};

/** A tracker user matched by email (milestone 3, F-036): the markdown in `mention` notifies them. */
export type TrackerUser = {
  readonly email: string;
  readonly userId: string;
  /** Such as Linear's `@<displayName>` link or Jira's `[~accountid:<id>]`. */
  readonly mention: string;
};

// ---------- milestone 6: agent sessions and people (F-012, ADR 0013) ----------

/**
 * A tracker's agent-session event (Linear's `AgentSessionEvent`): a person delegated or mentioned
 * the app (`created`), or wrote in the session (`prompted`). A stop is a `prompted` event with
 * `signal: "stop"`: ostra receives it, and never asks the tracker to stop anything (ADR 0013).
 */
export type AgentSessionEvent = {
  readonly sessionId: string;
  readonly action: "created" | "prompted";
  readonly ticketExternalId: ExternalTicketId;
  /** The board the ticket is on (a Linear team). */
  readonly teamExternalId: string;
  /** The person who started the session or wrote the follow-up. Matched to a member by `getUser`. */
  readonly creator: { readonly userId: string; readonly name: string; readonly email: string | null };
  /** A follow-up's text, or a mention's. Untrusted, and never logged. `null` for a plain delegation. */
  readonly prompt: string | null;
  readonly signal: "stop" | null;
  /** The comment the session hangs from, when it started from a mention or a thread. */
  readonly commentId: string | null;
};

export type AgentActivityKind = "thought" | "action" | "elicitation" | "response" | "error";

export const agentActivityKinds: readonly AgentActivityKind[] = ["thought", "action", "elicitation", "response", "error"];

/** What ostra posts into a session: its progress, a question, the final answer, or an error. */
export type AgentActivity = {
  readonly kind: AgentActivityKind;
  /** Markdown. Never logged. */
  readonly body: string;
  /** Shown until the next activity replaces it. Only a thought or an action can be ephemeral. */
  readonly ephemeral: boolean;
  /** Posting twice with one key posts once (F-046's rule): a retry finds the first. */
  readonly idempotencyKey: string;
};

/** A tracker user, by ID (`getUser`): for matching a session's creator to a member. */
export type TrackerPerson = {
  readonly userId: string;
  readonly name: string;
  /** `null` when the credential can't read it. Never logged. */
  readonly email: string | null;
  readonly active: boolean;
};

const refId = (ref: TicketRef): string => ("externalId" in ref ? ref.externalId : ref.key);

export abstract class TrackerAdapter {
  readonly kind = "tracker" as const;
  abstract readonly name: string;
  abstract readonly capabilities: TrackerCapabilities;

  readonly #context: AdapterContext;
  #plumbing: Plumbing | undefined;

  constructor(context: AdapterContext = defaultAdapterContext) {
    this.#context = context;
  }

  /** Retries, rate budgets, idempotency and the logger, shared by every adapter (ADR 0025). */
  protected get plumbing(): Plumbing {
    this.#plumbing ??= createPlumbing(this.#context, { kind: this.kind, name: this.name });
    return this.#plumbing;
  }

  /** Whether the tracker answers with the adapter's credentials. */
  abstract health(): Promise<HealthReport>;

  // ---------- milestone 1's operations, which keep their shapes ----------

  /** One ticket, by key or by its stable ID. A ticket on another board or workspace is `not-found`. */
  abstract getTicket(board: BoardRef, ref: TicketKey | TicketRef): Promise<AdapterResult<Ticket>>;

  /** A page of a board's tickets. */
  abstract listTickets(query: TicketQuery): Promise<AdapterResult<TicketPage>>;

  /** Sets a ticket's status directly. Ticket sync moves through `moveTicket`, which a Jira can do. */
  abstract updateStatus(board: BoardRef, key: TicketKey, statusId: string): Promise<AdapterResult<void>>;

  /** Adds a comment, written by ostra. */
  abstract comment(board: BoardRef, key: TicketKey, markdown: string): Promise<AdapterResult<{ readonly commentId: string }>>;

  /**
   * Links a PR to a ticket. Linking the same URL again links it once. `options.kind` (milestone 2)
   * is the board's magic word: `closes` for `Closes`, `references` for `Refs`. A tracker that
   * can't say how a link relates ignores it; without it, the tracker's default.
   */
  abstract linkPullRequest(
    board: BoardRef,
    key: TicketKey,
    pullRequestUrl: string,
    options?: PullRequestLinkOptions,
  ): Promise<AdapterResult<void>>;

  // ---------- milestone 2 ----------

  /** The boards the credential can see: Linear teams, Jira projects. */
  abstract listBoards(): Promise<AdapterResult<readonly TrackerBoard[]>>;

  /** A board's statuses, each with its category, in the tracker's order. */
  abstract listStatuses(board: BoardRef): Promise<AdapterResult<readonly TrackerStatus[]>>;

  /** The ticket with its comments, attachments, images, parent, children and linked tickets (F-064). */
  abstract getTicketContext(board: BoardRef, ref: TicketRef): Promise<AdapterResult<TicketContext>>;

  /**
   * Moves a ticket to the mapping's status for `target`. Linear sets the status; Jira walks its
   * transitions. Already there: `moved: false`, and nothing is written.
   */
  abstract moveTicket(
    board: BoardRef,
    ref: TicketRef,
    target: MoveTarget,
    mapping: StatusMapping,
  ): Promise<AdapterResult<MoveResult>>;

  /** Edits ostra's own comment in place (ADR 0047). `unsupported` without `commentEdit`. */
  abstract updateComment(board: BoardRef, ref: TicketRef, commentId: string, markdown: string): Promise<AdapterResult<void>>;

  /** Links the task on the ticket, once per URL: linking it again returns the same attachment. */
  abstract linkTask(board: BoardRef, ref: TicketRef, link: TaskLink): Promise<AdapterResult<{ readonly attachmentId: string }>>;

  /** Creates a ticket on the board (F-097, "Create ticket"). */
  abstract createTicket(board: BoardRef, ticket: NewTicket): Promise<AdapterResult<Ticket>>;

  /** Whether the tracker's own GitHub integration is installed for the board's workspace. */
  abstract detectCodeHostIntegration(board: BoardRef): Promise<AdapterResult<CodeHostIntegration>>;

  /**
   * Fetches a ticket's file (an image of `getTicketContext`) with the adapter's credential, which
   * never leaves the server. Over `maxBytes` is `invalid-input`, and nothing more is read.
   */
  abstract downloadFile(url: string, maxBytes: number): Promise<AdapterResult<DownloadedFile>>;

  /**
   * Checks a delivery's signature and freshness, and reads its delivery ID. Pure: no call is made,
   * so the server can answer within the sender's deadline (ADR 0013). A tracker without the
   * `webhooks` capability refuses every delivery as `bad-signature`.
   */
  abstract verifyWebhook(request: TrackerWebhookRequest): WebhookVerification;

  /** Reads a verified body loosely into a hint. A delivery it can't read is `invalid-response`. */
  abstract parseWebhook(input: ParseWebhookInput): AdapterResult<TrackerWebhookHint>;

  /**
   * Milestone 3 (F-036): the board's users with these emails, each with the markdown that mentions
   * them. An email with no user is left out, never an error. Needs the capability `mentions`;
   * without it, `unsupported`. The emails are never logged.
   */
  findUsersByEmail(board: BoardRef, emails: readonly string[]): Promise<AdapterResult<readonly TrackerUser[]>> {
    this.plumbing.logger.debug("findUsersByEmail is not supported", { board: board.externalId, count: emails.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't find users by email`));
  }

  // ---------- milestone 6 (spec section 5.2): each `unsupported` until an adapter has it ----------

  /**
   * Reads a verified delivery's body as an agent-session event, loosely: the tracker owns the
   * format, so unknown fields are tolerated. A body that isn't one is `invalid-response`. Pure.
   * Needs `agentSessions`.
   */
  parseAgentSessionEvent(body: unknown): AdapterResult<AgentSessionEvent> {
    this.plumbing.logger.debug("parseAgentSessionEvent is not supported", { present: body !== undefined });
    return adapterError("unsupported", `${this.name} has no agent sessions`);
  }

  /** Posts an activity into a session, once per `idempotencyKey`. Needs `agentSessions`. */
  postAgentActivity(sessionId: string, activity: AgentActivity): Promise<AdapterResult<{ readonly activityId: string }>> {
    this.plumbing.logger.debug("postAgentActivity is not supported", { sessionId, kind: activity.kind });
    return Promise.resolve(adapterError("unsupported", `${this.name} has no agent sessions`));
  }

  /** Sets the session's link to the task in ostra. Needs `agentSessionLink`. */
  setAgentSessionLink(sessionId: string, url: string): Promise<AdapterResult<void>> {
    this.plumbing.logger.debug("setAgentSessionLink is not supported", { sessionId, present: url !== "" });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't link an agent session`));
  }

  /** A tracker user by ID; an unknown one is `not-found`. */
  getUser(userId: string): Promise<AdapterResult<TrackerPerson>> {
    this.plumbing.logger.debug("getUser is not supported", { userId });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't read a user`));
  }

  /** Writes a draft's description (and, where the tracker has the field, its criteria) to the ticket (F-099). */
  updateTicket(board: BoardRef, ref: TicketRef, update: TicketUpdate): Promise<AdapterResult<void>> {
    this.plumbing.logger.debug("updateTicket is not supported", { board: board.externalId, ticket: refId(ref), criteria: update.acceptanceCriteria !== undefined });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't update a ticket`));
  }

  /** Attaches a file to the ticket. Needs `attachments`. The bytes and the name are never logged. */
  attachFile(board: BoardRef, ref: TicketRef, file: TicketFile): Promise<AdapterResult<AttachedFile>> {
    this.plumbing.logger.debug("attachFile is not supported", { board: board.externalId, ticket: refId(ref), bytes: file.bytes.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't attach a file`));
  }
}
