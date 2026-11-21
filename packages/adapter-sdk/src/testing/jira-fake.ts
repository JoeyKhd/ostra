import { randomUUID } from "node:crypto";

import { externalTicketIdSchema, ticketKeySchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ExternalTicketId, TicketKey } from "@ostra/protocol";
import { z } from "zod";

import type { AdapterContext } from "../common/context.ts";
import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import { hmacSha256Hex, sha256Hex, verifyHmacSha256Hex } from "../plumbing/signature.ts";
import { filesForCapability, isOpenCategory, isOwnAttachment, isOwnComment, mappedStatusId, ticketFileList, TrackerAdapter } from "../tracker/base.ts";
import type {
  AttachedFile,
  BoardRef,
  CodeHostIntegration,
  DownloadedFile,
  MoveResult,
  MoveTarget,
  NewTicket,
  ParseWebhookInput,
  StatusMapping,
  TaskLink,
  Ticket,
  TicketAttachment,
  TicketContext,
  TicketContextFile,
  TicketContextOptions,
  TicketFileWhere,
  TicketPage,
  TicketQuery,
  TicketRef,
  TicketStatus,
  TicketStatusCategory,
  TicketFile,
  TicketUpdate,
  TrackerBoard,
  TrackerPerson,
  TrackerStatus,
  TrackerWebhookHint,
  TrackerWebhookRequest,
  WebhookVerification,
  TrackerUser,
} from "../tracker/base.ts";
import type { TrackerCapabilities } from "../tracker/capabilities.ts";
import { manualClock } from "./memory.ts";
import type { TrackerFilesHooks, TrackerSuiteFixture } from "./tracker-suite.ts";
import type { ManualClock } from "./memory.ts";

// The Jira fake (ADR 0047, Q104): a test-only `TrackerAdapter` over an in-memory Jira site. It
// never ships as a product adapter: Jira itself is F-008, after v1. It exists so the tracker
// interface is shaped by two trackers, not one. It has what makes Jira unlike Linear:
// - a status graph: a move walks its transitions, it can't write a status directly;
// - rich text as ADF, which the fake converts to markdown;
// - keys that change when an issue moves project (`JIRA-7` becomes `OPS-2`), and a stable ID;
// - webhooks signed `X-Hub-Signature: sha256=<hex>`, with `X-Atlassian-Webhook-Identifier`;
// - a per-issue write limit (Jira Cloud: 20 writes per 2 s), answered 429 with `Retry-After`.
// Another site is another organization: an adapter on one never sees the other's issues.

// ---------- ADF, Jira's rich text ----------

/** A node of Atlassian Document Format, read loosely. */
export type AdfNode = {
  readonly type: string;
  readonly text?: string | undefined;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
  readonly marks?: readonly { readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> | undefined }[] | undefined;
  readonly content?: readonly AdfNode[] | undefined;
};

const adfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(z.looseObject({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() })).optional(),
    content: z.array(adfNodeSchema).optional(),
  }),
);

const attrString = (node: { readonly attrs?: Readonly<Record<string, unknown>> | undefined }, key: string): string | null => {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value : null;
};

const markText = (node: AdfNode): string => {
  let text = node.text ?? "";
  for (const mark of node.marks ?? []) {
    if (mark.type === "strong") text = `**${text}**`;
    else if (mark.type === "em") text = `_${text}_`;
    else if (mark.type === "code") text = `\`${text}\``;
    else if (mark.type === "strike") text = `~~${text}~~`;
    else if (mark.type === "link") {
      const href = mark.attrs?.["href"];
      if (typeof href === "string") text = `[${text}](${href})`;
    }
  }
  return text;
};

const inline = (nodes: readonly AdfNode[] | undefined): string =>
  (nodes ?? [])
    .map((node) => {
      switch (node.type) {
        case "text":
          return markText(node);
        case "hardBreak":
          return "\n";
        case "mention":
          return `@${attrString(node, "text")?.replace(/^@/, "") ?? "someone"}`;
        case "emoji":
          return attrString(node, "text") ?? "";
        case "inlineCard":
          return attrString(node, "url") ?? "";
        default:
          return inline(node.content);
      }
    })
    .join("");

/** Milestone 9: how a `media` node of type `file` finds its attachment (Jira names it by its media ID). */
export type AdfMediaResolver = (id: string) => { readonly url: string; readonly name: string; readonly image: boolean } | null;

const block = (node: AdfNode, depth: number, media: AdfMediaResolver): string => {
  switch (node.type) {
    case "paragraph":
      return inline(node.content);
    case "heading": {
      const level = Number(node.attrs?.["level"] ?? 1);
      return `${"#".repeat(Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1)} ${inline(node.content)}`;
    }
    case "bulletList":
    case "orderedList":
      return (node.content ?? [])
        .map((item, index) => {
          const marker = node.type === "bulletList" ? "-" : `${String(index + 1)}.`;
          const body = (item.content ?? []).map((child) => block(child, depth + 1, media)).join("\n");
          return `${"  ".repeat(depth)}${marker} ${body.trimStart()}`;
        })
        .join("\n");
    case "codeBlock":
      return `\`\`\`${attrString(node, "language") ?? ""}\n${inline(node.content)}\n\`\`\``;
    case "blockquote":
      return (node.content ?? []).map((child) => `> ${block(child, depth, media)}`).join("\n");
    case "rule":
      return "---";
    case "mediaSingle":
    case "mediaGroup":
      return (node.content ?? []).map((child) => block(child, depth, media)).join("\n");
    case "media": {
      // Milestone 9: an attachment's media, by its ID, as Jira's editor writes an upload: an image
      // as an image, any other file as a link to it.
      const id = attrString(node, "type") === "file" ? attrString(node, "id") : null;
      const file = id === null ? null : media(id);
      if (file !== null) {
        return file.image ? `![${file.name}](${file.url})` : `[${file.name}](${file.url})`;
      }
      const url = attrString(node, "url");
      const alt = attrString(node, "alt") ?? "image";
      return url === null ? "" : `![${alt}](${url})`;
    }
    default:
      return node.content === undefined ? inline([node]) : (node.content.map((child) => block(child, depth, media)).join("\n"));
  }
};

const noMedia: AdfMediaResolver = () => null;

/**
 * ADF to markdown, as the Jira adapter will convert it (spec section 5.2). Unknown nodes keep their
 * text. `media` finds the file an attachment's media node shows; without it, only external media show.
 */
export const adfToMarkdown = (doc: unknown, media: AdfMediaResolver = noMedia): string => {
  const parsed = adfNodeSchema.safeParse(doc);
  if (!parsed.success) {
    return "";
  }
  return (parsed.data.content ?? []).map((node) => block(node, 0, media)).filter((text) => text !== "").join("\n\n");
};

/** Plain text as one ADF paragraph per line, as a Jira client writes it. */
export const markdownToAdf = (markdown: string): AdfNode => ({
  type: "doc",
  attrs: { version: 1 },
  content: markdown.split("\n").map((line) => ({ type: "paragraph", content: line === "" ? [] : [{ type: "text", text: line }] })),
});

const imagesInMarkdown = (markdown: string): { readonly url: string; readonly name: string }[] =>
  [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((match) => {
    const url = match[2] ?? "";
    return { url, name: url.split("/").pop() ?? (match[1] ?? "image") };
  });

/** Where the site serves its attachments: the only URLs `downloadFile` fetches (milestone 9). */
export const JIRA_FAKE_FILE_HOST = "https://jira-fake.invalid/secure/attachment/";

/**
 * Milestone 9: the images and file links in a piece of markdown, in order (`![alt](url)` and
 * `[text](url)`), on the site's file host only. The text is untrusted: the pattern is linear in it,
 * and nothing it finds is run.
 */
const hostedLinksInMarkdown = (markdown: string): { readonly url: string; readonly name: string }[] =>
  [...markdown.matchAll(/!?\[([^\]\n]{0,500})\]\(([^)\s]{1,2048})\)/g)].flatMap((match) => {
    const url = match[2] ?? "";
    if (!url.startsWith(JIRA_FAKE_FILE_HOST)) {
      return [];
    }
    const text = (match[1] ?? "").trim();
    if (/^[\w .()-]{1,200}\.[A-Za-z0-9]{1,10}$/.test(text)) {
      return [{ url, name: text }];
    }
    const last = url.split("/").filter((segment) => segment !== "").at(-1) ?? "file";
    try {
      return [{ url, name: decodeURIComponent(last) }];
    } catch {
      return [{ url, name: last }];
    }
  });

// ---------- the site ----------

/** Jira's three status categories. A `done` status named like "won't do" reads as cancelled. */
export type JiraCategory = "new" | "indeterminate" | "done";

export type JiraStatus = { readonly id: string; readonly name: string; readonly category: JiraCategory };

export type JiraTransition = {
  readonly id: string;
  readonly name: string;
  /** The statuses it can be taken from; empty means any. */
  readonly from: readonly string[];
  readonly to: string;
};

type JiraComment = { readonly id: string; body: AdfNode; readonly authorId: string; readonly created: number; updated: number };
type JiraLink = { readonly id: string; readonly url: string; readonly title: string; readonly subtitle: string | null };
/** Milestone 9: a file on the issue, as Jira's attachment holds it: its type, size and who added it. */
type JiraAttachment = JiraLink & { readonly mimeType: string; readonly size: number; readonly authorId: string };
type JiraIssue = {
  readonly id: ExternalTicketId;
  key: TicketKey;
  projectId: string;
  summary: string;
  description: AdfNode | null;
  /** Milestone 6: the criteria, as a field of its own (`ticketFields.acceptanceCriteria`). */
  acceptanceCriteria: string | null;
  statusId: string;
  labels: string[];
  priority: number | null;
  parentId: ExternalTicketId | null;
  readonly links: { readonly kind: "blocks" | "relates"; readonly to: ExternalTicketId }[];
  readonly comments: JiraComment[];
  readonly remoteLinks: JiraLink[];
  /** Milestone 6: files attached to the issue (`attachFile`), served from `files`; milestone 9: a person's too. */
  readonly attachments: JiraAttachment[];
  readonly created: number;
  updated: number;
  readonly writes: number[];
};

export type JiraProject = { readonly id: string; readonly key: string; readonly name: string };

/** A fault the next call meets: Jira's 429, or the write applied and then a 500 (spec section 8). */
export type JiraFault =
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "fail-after-write" };

export type JiraSite = {
  readonly id: string;
  readonly clock: ManualClock;
  /** The app's account on the site: what an adapter's own writes are made as. */
  readonly appAccountId: string;
  /** A person's account, for changes made outside ostra. */
  readonly personAccountId: string;
  readonly webhookSecret: string;
  readonly projects: readonly JiraProject[];
  readonly statuses: readonly JiraStatus[];
  readonly transitions: readonly JiraTransition[];
  /** Jira's development panel for GitHub (F-031). */
  devPanelInstalled: boolean;
  /** Writes per issue in the window before Jira answers 429. */
  readonly writeLimit: { readonly count: number; readonly windowMs: number };
  readonly addProject: (key: string, name: string) => JiraProject;
  /** A person creates an issue. */
  readonly createIssue: (
    projectId: string,
    input: { readonly summary: string; readonly description?: string | null; readonly labels?: readonly string[]; readonly comments?: readonly string[]; readonly imageUrl?: string },
  ) => { readonly externalId: ExternalTicketId; readonly key: TicketKey };
  /** A person edits an issue. */
  readonly editIssue: (id: ExternalTicketId, change: { readonly summary?: string }) => void;
  /** Moves an issue to another project: its key changes, its ID doesn't. */
  readonly moveIssue: (id: ExternalTicketId, projectId: string) => TicketKey;
  readonly statusOf: (id: ExternalTicketId) => string;
  /** A signed delivery about an issue, as Jira would send it. */
  readonly signedDelivery: (input: {
    readonly externalId: ExternalTicketId;
    readonly event?: string;
    readonly byAccountId: string;
    readonly sentAt: number;
  }) => { readonly rawBody: Uint8Array; readonly headers: Readonly<Record<string, string>> };
  readonly injectFault: (fault: JiraFault) => void;
  /** Bytes an attachment URL serves. */
  readonly files: Map<string, { readonly bytes: Uint8Array; readonly contentType: string }>;
  /** Internal: what the adapter reads. */
  readonly issues: Map<ExternalTicketId, JiraIssue>;
  readonly takeFault: () => JiraFault | undefined;
  /** Milestone 3: the site's people, by account ID and email (F-036); milestone 6 names them. */
  readonly users: { readonly accountId: string; readonly email: string; readonly name: string; active: boolean }[];
  /** Milestone 3: adds a person to the site, and gives back their account ID. */
  readonly addUser: (email: string, name?: string) => string;
  readonly nextId: () => string;
  readonly nextKey: (projectId: string) => TicketKey;
  /**
   * Milestone 9: a file attached to the issue, as Jira's editor attaches anything dropped into a
   * description or a comment: served from `files`. Its media ID is its attachment's ID.
   */
  readonly attachToIssue: (
    id: ExternalTicketId,
    file: { readonly name: string; readonly contentType: string; readonly bytes: Uint8Array; readonly byAccountId: string; readonly subtitle?: string | null },
  ) => { readonly id: string; readonly url: string };
  /** Milestone 9: a person adds a web link to the issue (a remote link). */
  readonly addRemoteLink: (id: ExternalTicketId, link: { readonly url: string; readonly title: string }) => void;
  /** Milestone 9: a person sets the description, in ADF. */
  readonly setDescription: (id: ExternalTicketId, description: AdfNode) => void;
  /** Milestone 9: someone comments, in ADF; the comment's ID. */
  readonly addComment: (id: ExternalTicketId, body: AdfNode, byAccountId: string) => string;
  /** Milestone 9: the file an attachment's media node shows, by its media ID. */
  readonly mediaOf: AdfMediaResolver;
};

const defaultStatuses: readonly JiraStatus[] = [
  { id: "10000", name: "To Do", category: "new" },
  { id: "10001", name: "In Progress", category: "indeterminate" },
  { id: "10002", name: "In Review", category: "indeterminate" },
  { id: "10003", name: "Done", category: "done" },
  { id: "10004", name: "Won't Do", category: "done" },
];

// A small workflow: To Do → In Progress → In Review → Done, back from review to progress, and
// Won't Do from anywhere. No direct To Do → Done, so a move has to walk the graph.
const defaultTransitions: readonly JiraTransition[] = [
  { id: "11", name: "Start", from: ["10000"], to: "10001" },
  { id: "21", name: "Review", from: ["10001"], to: "10002" },
  { id: "31", name: "Back to work", from: ["10002"], to: "10001" },
  { id: "41", name: "Done", from: ["10002"], to: "10003" },
  { id: "51", name: "Won't do", from: [], to: "10004" },
  { id: "61", name: "Reopen", from: ["10003", "10004"], to: "10000" },
];

let sitesMade = 0;

/** A fresh in-memory Jira site with one project, `JIRA`, and the default workflow. */
export const createJiraSite = (options: { readonly clock?: ManualClock; readonly projectKey?: string } = {}): JiraSite => {
  const clock = options.clock ?? manualClock();
  const projects: JiraProject[] = [];
  const counters = new Map<string, number>();
  const issues = new Map<ExternalTicketId, JiraIssue>();
  const faults: JiraFault[] = [];
  const users: { readonly accountId: string; readonly email: string; readonly name: string; active: boolean }[] = [];
  // Each site numbers from its own range, as two Jira sites never share an ID.
  sitesMade += 1;
  let idCounter = sitesMade * 1_000_000;
  const nextId = (): string => {
    idCounter += 1;
    return String(idCounter);
  };
  const projectOf = (projectId: string): JiraProject => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("the Jira fake has no such project");
    return project;
  };
  const nextKey = (projectId: string): TicketKey => {
    const project = projectOf(projectId);
    const count = (counters.get(projectId) ?? 0) + 1;
    counters.set(projectId, count);
    return ticketKeySchema.parse(`${project.key}-${String(count)}`);
  };
  const issueOf = (id: ExternalTicketId): JiraIssue => {
    const issue = issues.get(id);
    if (issue === undefined) throw new Error("the Jira fake has no such issue");
    return issue;
  };
  const site: JiraSite = {
    id: randomUUID(),
    clock,
    appAccountId: `app-${randomUUID()}`,
    personAccountId: `person-${randomUUID()}`,
    webhookSecret: `jira-secret-${randomUUID()}`,
    projects,
    statuses: defaultStatuses,
    transitions: defaultTransitions,
    devPanelInstalled: false,
    writeLimit: { count: 20, windowMs: 2000 },
    files: new Map(),
    users,
    addUser: (email, name) => {
      const accountId = `user-${randomUUID()}`;
      users.push({ accountId, email, name: name ?? email.split("@")[0] ?? email, active: true });
      return accountId;
    },
    issues,
    addProject: (key, name) => {
      const project = { id: nextId(), key, name };
      projects.push(project);
      return project;
    },
    createIssue: (projectId, input) => {
      const now = clock.now();
      const id = externalTicketIdSchema.parse(nextId());
      const description = input.description === undefined || input.description === null ? null : markdownToAdf(input.description);
      const issue: JiraIssue = {
        id,
        key: nextKey(projectId),
        projectId,
        summary: input.summary,
        description:
          input.imageUrl === undefined
            ? description
            : {
                type: "doc",
                content: [
                  ...(description?.content ?? []),
                  { type: "mediaSingle", content: [{ type: "media", attrs: { type: "external", url: input.imageUrl, alt: "screenshot" } }] },
                ],
              },
        acceptanceCriteria: null,
        statusId: "10000",
        labels: [...(input.labels ?? [])],
        priority: 3,
        parentId: null,
        links: [],
        comments: (input.comments ?? []).map((text, index) => ({
          id: nextId(),
          body: markdownToAdf(text),
          authorId: site.personAccountId,
          created: now + index,
          updated: now + index,
        })),
        remoteLinks: [],
        attachments: [],
        created: now,
        updated: now,
        writes: [],
      };
      issues.set(id, issue);
      return { externalId: id, key: issue.key };
    },
    editIssue: (id, change) => {
      const issue = issueOf(id);
      if (change.summary !== undefined) issue.summary = change.summary;
      issue.updated = clock.now();
    },
    moveIssue: (id, projectId) => {
      const issue = issueOf(id);
      issue.projectId = projectId;
      issue.key = nextKey(projectId);
      issue.updated = clock.now();
      return issue.key;
    },
    statusOf: (id) => issueOf(id).statusId,
    signedDelivery: (input) => {
      const issue = issueOf(input.externalId);
      const body = {
        timestamp: input.sentAt,
        webhookEvent: input.event ?? "jira:issue_updated",
        user: { accountId: input.byAccountId },
        issue: { id: issue.id, key: issue.key, fields: { project: { id: issue.projectId, key: projectOf(issue.projectId).key } } },
      };
      const rawBody = new TextEncoder().encode(JSON.stringify(body));
      return {
        rawBody,
        headers: {
          "x-hub-signature": `sha256=${hmacSha256Hex(site.webhookSecret, rawBody)}`,
          "x-atlassian-webhook-identifier": randomUUID(),
          "content-type": "application/json",
        },
      };
    },
    injectFault: (fault) => {
      faults.push(fault);
    },
    takeFault: () => faults.shift(),
    nextId,
    nextKey,
    attachToIssue: (id, file) => {
      const issue = issueOf(id);
      const attachmentId = nextId();
      const url = `${JIRA_FAKE_FILE_HOST}${attachmentId}/${encodeURIComponent(file.name)}`;
      site.files.set(url, { bytes: new Uint8Array(file.bytes), contentType: file.contentType });
      issue.attachments.push({
        id: attachmentId,
        url,
        title: file.name,
        subtitle: file.subtitle ?? null,
        mimeType: file.contentType,
        size: file.bytes.length,
        authorId: file.byAccountId,
      });
      issue.updated = clock.now();
      return { id: attachmentId, url };
    },
    addRemoteLink: (id, link) => {
      const issue = issueOf(id);
      issue.remoteLinks.push({ id: nextId(), url: link.url, title: link.title, subtitle: null });
      issue.updated = clock.now();
    },
    setDescription: (id, description) => {
      const issue = issueOf(id);
      issue.description = description;
      issue.updated = clock.now();
    },
    addComment: (id, body, byAccountId) => {
      const issue = issueOf(id);
      const now = clock.now();
      const commentId = nextId();
      issue.comments.push({ id: commentId, body, authorId: byAccountId, created: now, updated: now });
      issue.updated = now;
      return commentId;
    },
    mediaOf: (mediaId) => {
      for (const issue of issues.values()) {
        const attachment = issue.attachments.find((candidate) => candidate.id === mediaId);
        if (attachment !== undefined) {
          return { url: attachment.url, name: attachment.title, image: attachment.mimeType.startsWith("image/") };
        }
      }
      return null;
    },
  };
  site.addProject(options.projectKey ?? "JIRA", "Jira fake");
  return site;
};

// ---------- the adapter ----------

const categoryOf = (status: JiraStatus): TicketStatusCategory => {
  switch (status.category) {
    case "new":
      return "open";
    case "indeterminate":
      return "started";
    case "done":
      return /won'?t|cancel|declin|reject/i.test(status.name) ? "cancelled" : "done";
    default:
      return status.category satisfies never;
  }
};

const JIRA_TIMESTAMP_WINDOW_MS = 60_000;

const webhookBodySchema = z.looseObject({
  timestamp: z.number(),
  webhookEvent: z.string(),
  user: z.looseObject({ accountId: z.string() }).nullish(),
  issue: z
    .looseObject({
      id: z.string(),
      key: z.string(),
      fields: z.looseObject({ project: z.looseObject({ id: z.string() }).nullish() }).nullish(),
    })
    .nullish(),
});

export type JiraFakeAdapterOptions = {
  readonly site: JiraSite;
  /** The account the adapter's credential belongs to. Default: the site's app account. */
  readonly accountId?: string;
};

/** A `TrackerAdapter` over an in-memory Jira site. Test-only. */
export class JiraFakeAdapter extends TrackerAdapter {
  readonly name = "jira-fake";
  readonly capabilities: TrackerCapabilities = {
    // Jira has no agent sessions: its methods answer `unsupported` (the base class's).
    agentSessions: false,
    agentScopes: [],
    agentSessionLink: false,
    // Sub-tasks under a parent, one level deep.
    subIssues: true,
    statusGraph: true,
    webhooks: true,
    commentEdit: true,
    attachments: true,
    transitions: true,
    mentions: true,
    // Jira takes the criteria as a field of its own (a custom field on a real site).
    ticketFields: { acceptanceCriteria: true },
    // Milestone 9 (F-149): every file, inline in ADF or attached; web links stay links.
    ticketFiles: "all",
  };

  readonly #site: JiraSite;
  readonly #accountId: string;

  constructor(options: JiraFakeAdapterOptions, context?: AdapterContext) {
    super(context);
    this.#site = options.site;
    this.#accountId = options.accountId ?? options.site.appAccountId;
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  getTicket(board: BoardRef, ref: TicketKey | TicketRef): Promise<AdapterResult<Ticket>> {
    return this.#read(() => {
      const issue = this.#find(board, typeof ref === "string" ? { key: ref } : ref);
      return issue.ok ? ok(this.#ticket(issue.value)) : issue;
    });
  }

  listTickets(query: TicketQuery): Promise<AdapterResult<TicketPage>> {
    return this.#read(() => {
      const project = this.#project(query.board);
      if (!project.ok) {
        return project;
      }
      const since = query.updatedSince;
      const statusIds = query.statusIds;
      const matching = [...this.#site.issues.values()]
        .filter((issue) => issue.projectId === project.value.id)
        .filter((issue) => since === undefined || issue.updated >= since)
        .filter((issue) => statusIds === undefined || statusIds.includes(issue.statusId))
        .sort((a, b) => (query.order === "updatedAt" ? a.updated - b.updated || Number(a.id) - Number(b.id) : Number(b.id) - Number(a.id)));
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      if (!Number.isInteger(start) || start < 0) {
        return adapterError("invalid-input", "a bad cursor");
      }
      const size = Math.max(1, Math.min(query.pageSize ?? 50, 100));
      const page = matching.slice(start, start + size);
      const next = start + size < matching.length ? String(start + size) : null;
      return ok({ tickets: page.map((issue) => this.#ticket(issue)), nextCursor: next });
    });
  }

  updateStatus(board: BoardRef, key: TicketKey, statusId: string): Promise<AdapterResult<void>> {
    return this.#write({ key }, board, (issue) => {
      // Jira can't write a status directly; this walks the graph like `moveTicket`.
      const walked = this.#walkTo(issue, statusId);
      return walked.ok ? ok(undefined) : walked;
    });
  }

  comment(board: BoardRef, key: TicketKey, markdown: string): Promise<AdapterResult<{ readonly commentId: string }>> {
    return this.#write({ key }, board, (issue) => {
      const now = this.#site.clock.now();
      const id = this.#site.nextId();
      issue.comments.push({ id, body: markdownToAdf(markdown), authorId: this.#accountId, created: now, updated: now });
      return ok({ commentId: id });
    });
  }

  linkPullRequest(board: BoardRef, key: TicketKey, pullRequestUrl: string): Promise<AdapterResult<void>> {
    return this.#write({ key }, board, (issue) => {
      this.#link(issue, { url: pullRequestUrl, title: "Pull request", subtitle: null });
      return ok(undefined);
    });
  }

  listBoards(): Promise<AdapterResult<readonly TrackerBoard[]>> {
    return this.#read(() =>
      ok(this.#site.projects.map((project) => ({ externalId: project.id, key: project.key, name: project.name }))),
    );
  }

  listStatuses(board: BoardRef): Promise<AdapterResult<readonly TrackerStatus[]>> {
    return this.#read(() => {
      const project = this.#project(board);
      if (!project.ok) {
        return project;
      }
      return ok(
        this.#site.statuses.map((status, position) => ({
          id: status.id,
          name: status.name,
          category: categoryOf(status),
          vendorType: status.category,
          position,
        })),
      );
    });
  }

  getTicketContext(board: BoardRef, ref: TicketRef, options?: TicketContextOptions): Promise<AdapterResult<TicketContext>> {
    return this.#read(() => {
      const found = this.#find(board, ref);
      if (!found.ok) {
        return found;
      }
      const issue = found.value;
      const ticket = this.#ticket(issue);
      const summary = (id: ExternalTicketId) => {
        const other = this.#site.issues.get(id);
        return other === undefined
          ? null
          : { externalId: other.id, key: other.key, title: other.summary, url: this.#url(other), status: this.#status(other) };
      };
      const comments = issue.comments.map((comment) => ({
        id: comment.id,
        body: adfToMarkdown(comment.body, this.#site.mediaOf),
        author: { id: comment.authorId, name: comment.authorId === this.#site.appAccountId ? "ostra" : "A person" },
        parentId: null,
        createdAt: comment.created,
        updatedAt: comment.updated,
      }));
      const seen = new Set<string>();
      const images = [ticket.description ?? "", ...comments.map((comment) => comment.body)]
        .flatMap(imagesInMarkdown)
        .filter((image) => (seen.has(image.url) ? false : (seen.add(image.url), true)))
        .map((image) => ({ url: image.url, name: image.name, contentType: this.#site.files.get(image.url)?.contentType ?? null }));
      const children = [...this.#site.issues.values()].filter((other) => other.parentId === issue.id).flatMap((other) => {
        const child = summary(other.id);
        return child === null ? [] : [{ ...child, open: isOpenCategory(child.status.category) }];
      });
      const linked = issue.links.flatMap((link) => {
        const other = summary(link.to);
        return other === null ? [] : [{ kind: link.kind === "blocks" ? ("blocks" as const) : ("related" as const), ticket: other }];
      });
      // Milestone 9 (F-149): the description's files, each comment's, then the attachments; web
      // links (`remoteLinks`) are never files.
      const files = ticketFileList();
      const fromText = (markdown: string, where: TicketFileWhere, commentId: string | null, byOstra: boolean): void => {
        for (const file of this.#hostedFilesIn(markdown)) {
          files.add({ ...file, where, commentId, byOstra });
        }
      };
      fromText(ticket.description ?? "", "description", null, false);
      for (const comment of comments) {
        fromText(comment.body, "comment", comment.id, isOwnComment(options?.own, comment));
      }
      for (const attachment of issue.attachments) {
        files.add({
          url: attachment.url,
          name: attachment.title,
          contentType: attachment.mimeType,
          size: attachment.size,
          where: "attachment",
          commentId: null,
          byOstra: isOwnAttachment(options?.own, attachment),
        });
      }
      return ok({
        ticket,
        comments,
        attachments: [...issue.remoteLinks, ...issue.attachments].map((link) => ({ id: link.id, url: link.url, title: link.title, subtitle: link.subtitle })),
        images,
        files: filesForCapability(files.files(), this.capabilities.ticketFiles),
        parent: issue.parentId === null ? null : summary(issue.parentId),
        children,
        linked,
      });
    });
  }

  moveTicket(board: BoardRef, ref: TicketRef, target: MoveTarget, mapping: StatusMapping): Promise<AdapterResult<MoveResult>> {
    return this.#write<MoveResult>(ref, board, (issue) => {
      const goal = mappedStatusId(mapping, target);
      if (issue.statusId === goal) {
        return ok({ moved: false, status: this.#status(issue) });
      }
      const walked = this.#walkTo(issue, goal);
      return walked.ok ? ok({ moved: true, status: this.#status(issue) }) : walked;
    });
  }

  updateComment(board: BoardRef, ref: TicketRef, commentId: string, markdown: string): Promise<AdapterResult<void>> {
    return this.#write(ref, board, (issue) => {
      const comment = issue.comments.find((candidate) => candidate.id === commentId);
      if (comment === undefined) {
        return adapterError("not-found", "no such comment on the ticket");
      }
      if (comment.authorId !== this.#accountId) {
        return adapterError("forbidden", "only the comment's author can edit it");
      }
      comment.body = markdownToAdf(markdown);
      comment.updated = this.#site.clock.now();
      return ok(undefined);
    });
  }

  linkTask(board: BoardRef, ref: TicketRef, link: TaskLink): Promise<AdapterResult<{ readonly attachmentId: string }>> {
    return this.#write(ref, board, (issue) => ok({ attachmentId: this.#link(issue, link) }));
  }

  createTicket(board: BoardRef, ticket: NewTicket): Promise<AdapterResult<Ticket>> {
    return this.#read(() => {
      const project = this.#project(board);
      if (!project.ok) {
        return project;
      }
      let parentId: ExternalTicketId | null = null;
      if (ticket.parent !== undefined) {
        const parent = this.#find(board, ticket.parent);
        if (!parent.ok) {
          return parent;
        }
        // Jira's sub-tasks are one level deep: a sub-task can't have its own.
        if (parent.value.parentId !== null) {
          return adapterError("invalid-input", "a sub-task can't have sub-tasks");
        }
        parentId = parent.value.id;
      }
      const created = this.#site.createIssue(project.value.id, { summary: ticket.title, description: ticket.description });
      const issue = this.#site.issues.get(created.externalId);
      if (issue === undefined) {
        return adapterError("unavailable", "the issue wasn't created");
      }
      issue.parentId = parentId;
      return ok(this.#ticket(issue));
    });
  }

  /** Milestone 6 (F-099): the description as ADF, and the criteria in their own field. */
  override updateTicket(board: BoardRef, ref: TicketRef, update: TicketUpdate): Promise<AdapterResult<void>> {
    return this.#write(ref, board, (issue) => {
      issue.description = markdownToAdf(update.description);
      if (update.acceptanceCriteria !== undefined) {
        issue.acceptanceCriteria = update.acceptanceCriteria;
      }
      return ok(undefined);
    });
  }

  /** Milestone 6 (F-099): an attachment on the issue, which `downloadFile` serves back. */
  override attachFile(board: BoardRef, ref: TicketRef, file: TicketFile): Promise<AdapterResult<AttachedFile>> {
    return this.#write(ref, board, (issue) => {
      const attached = this.#site.attachToIssue(issue.id, {
        name: file.name,
        contentType: file.contentType,
        bytes: file.bytes,
        byAccountId: this.#accountId,
        subtitle: file.marker ?? null,
      });
      return ok({ attachmentId: attached.id, url: attached.url });
    });
  }

  /** Milestone 9 (F-149): a follow-up's files, read from its markdown as a comment's are. */
  override filesInText(markdown: string): readonly TicketContextFile[] {
    const files = ticketFileList();
    for (const file of this.#hostedFilesIn(markdown)) {
      files.add({ ...file, where: "comment", commentId: null, byOstra: false });
    }
    return filesForCapability(files.files(), this.capabilities.ticketFiles);
  }

  /** Milestone 6 (F-099): the issue's attachments, files and links, each with its subtitle. */
  override listAttachments(board: BoardRef, ref: TicketRef): Promise<AdapterResult<readonly TicketAttachment[]>> {
    return this.#read(() => {
      const found = this.#find(board, ref);
      return found.ok
        ? ok([...found.value.remoteLinks, ...found.value.attachments].map((link) => ({ id: link.id, url: link.url, title: link.title, subtitle: link.subtitle })))
        : found;
    });
  }

  /** Milestone 6 (F-012): a person on the site, by account ID. */
  override getUser(userId: string): Promise<AdapterResult<TrackerPerson>> {
    return this.#read(() => {
      const user = this.#site.users.find((candidate) => candidate.accountId === userId);
      return user === undefined
        ? adapterError("not-found", "no such user on the site")
        : ok({ userId: user.accountId, name: user.name, email: user.email, active: user.active });
    });
  }

  detectCodeHostIntegration(board: BoardRef): Promise<AdapterResult<CodeHostIntegration>> {
    return this.#read(() => {
      const project = this.#project(board);
      return project.ok
        ? ok({ installed: this.#site.devPanelInstalled, name: this.#site.devPanelInstalled ? "GitHub for Jira" : null })
        : project;
    });
  }

  downloadFile(url: string, maxBytes: number): Promise<AdapterResult<DownloadedFile>> {
    return this.#read(() => {
      // Milestone 9: only the site's own content URLs; nothing is asked of any other host.
      if (!url.startsWith(JIRA_FAKE_FILE_HOST)) {
        return adapterError("invalid-input", "not a file the site holds");
      }
      const file = this.#site.files.get(url);
      if (file === undefined) {
        return adapterError("not-found", "no such file on the site");
      }
      if (file.bytes.length > maxBytes) {
        return adapterError("invalid-input", `the file is over ${String(maxBytes)} bytes`);
      }
      return ok({ bytes: file.bytes, contentType: file.contentType });
    });
  }

  verifyWebhook(request: TrackerWebhookRequest): WebhookVerification {
    const header = request.headers["x-hub-signature"];
    if (header === undefined || header === "") {
      return { ok: false, reason: "missing-signature" };
    }
    const signature = header.startsWith("sha256=") ? header.slice("sha256=".length) : "";
    if (!verifyHmacSha256Hex(request.secret, request.rawBody, signature)) {
      return { ok: false, reason: "bad-signature" };
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(request.rawBody));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const parsed = webhookBodySchema.safeParse(body);
    const deliveryId = webhookDeliveryIdSchema.safeParse(request.headers["x-atlassian-webhook-identifier"]);
    if (!parsed.success || !deliveryId.success) {
      return { ok: false, reason: "malformed" };
    }
    if (Math.abs(request.now - parsed.data.timestamp) > JIRA_TIMESTAMP_WINDOW_MS) {
      return { ok: false, reason: "stale" };
    }
    return { ok: true, deliveryId: deliveryId.data, signatureHash: sha256Hex(header), sentAt: parsed.data.timestamp, body };
  }

  /** Milestone 3: Jira mentions by account ID, as `[~accountid:<id>]` (F-036). */
  override findUsersByEmail(board: BoardRef, emails: readonly string[]): Promise<AdapterResult<readonly TrackerUser[]>> {
    return this.#read(() => {
      if (!this.#site.projects.some((project) => project.id === board.externalId)) {
        return adapterError("not-found", "no such board");
      }
      const wanted = new Set(emails.map((email) => email.toLowerCase()));
      return ok(
        this.#site.users
          .filter((user) => wanted.has(user.email.toLowerCase()))
          .map((user) => ({ email: user.email, userId: user.accountId, mention: `[~accountid:${user.accountId}]` })),
      );
    });
  }

  parseWebhook(input: ParseWebhookInput): AdapterResult<TrackerWebhookHint> {
    const parsed = webhookBodySchema.safeParse(input.body);
    if (!parsed.success) {
      return adapterError("invalid-response", "the Jira delivery couldn't be read");
    }
    const { webhookEvent, issue, user } = parsed.data;
    const externalId = issue === null || issue === undefined ? null : externalTicketIdSchema.safeParse(issue.id);
    const key = issue === null || issue === undefined ? null : ticketKeySchema.safeParse(issue.key);
    const subject = webhookEvent.startsWith("comment_")
      ? ("comment" as const)
      : webhookEvent.startsWith("jira:issue_")
        ? ("ticket" as const)
        : ("other" as const);
    const action = webhookEvent.endsWith("created")
      ? ("create" as const)
      : webhookEvent.endsWith("updated")
        ? ("update" as const)
        : webhookEvent.endsWith("deleted")
          ? ("remove" as const)
          : ("other" as const);
    return ok({
      event: webhookEvent,
      subject,
      action,
      ticketExternalId: externalId?.success === true ? externalId.data : null,
      ticketKey: key?.success === true ? key.data : null,
      boardExternalId: issue?.fields?.project?.id ?? null,
      byOwnUser: input.ownUserId !== null && user?.accountId === input.ownUserId,
    });
  }

  // ---------- internals ----------

  /** Milestone 9: the files a piece of markdown shows on the site's host, with what the site knows of each. */
  #hostedFilesIn(markdown: string): readonly Pick<TicketContextFile, "url" | "name" | "contentType" | "size">[] {
    return hostedLinksInMarkdown(markdown).map((link) => {
      const stored = this.#site.files.get(link.url);
      return { url: link.url, name: link.name, contentType: stored?.contentType ?? null, size: stored?.bytes.length ?? null };
    });
  }

  /** A read: a 429 fault applies; nothing is written. */
  #read<T>(work: () => AdapterResult<T>): Promise<AdapterResult<T>> {
    const fault = this.#site.takeFault();
    if (fault?.kind === "rate-limited") {
      return Promise.resolve(adapterError("rate-limited", "Jira's rate limit", fault.retryAfterSeconds * 1000));
    }
    if (fault !== undefined) {
      // A fail-after-write fault waits for the next write.
      this.#site.injectFault(fault);
    }
    return Promise.resolve(work());
  }

  /** A write on one issue: the per-issue limit, then the work, then a fail-after-write fault. */
  #write<T>(ref: TicketRef, board: BoardRef, work: (issue: JiraIssue) => AdapterResult<T>): Promise<AdapterResult<T>> {
    const fault = this.#site.takeFault();
    if (fault?.kind === "rate-limited") {
      return Promise.resolve(adapterError("rate-limited", "Jira's rate limit", fault.retryAfterSeconds * 1000));
    }
    const found = this.#find(board, ref);
    if (!found.ok) {
      return Promise.resolve(found);
    }
    const issue = found.value;
    const now = this.#site.clock.now();
    const recent = issue.writes.filter((at) => at > now - this.#site.writeLimit.windowMs);
    if (recent.length >= this.#site.writeLimit.count) {
      const oldest = recent[0] ?? now;
      return Promise.resolve(
        adapterError("rate-limited", "Jira's per-issue write limit", oldest + this.#site.writeLimit.windowMs - now),
      );
    }
    issue.writes.splice(0, issue.writes.length, ...recent, now);
    const result = work(issue);
    if (result.ok) {
      issue.updated = now;
    }
    if (fault?.kind === "fail-after-write") {
      return Promise.resolve(adapterError("unavailable", "Jira answered 500 after applying the write"));
    }
    return Promise.resolve(result);
  }

  #project(board: BoardRef): AdapterResult<JiraProject> {
    const project = this.#site.projects.find((candidate) => candidate.id === board.externalId);
    return project === undefined ? adapterError("not-found", "no such project on this site") : ok(project);
  }

  #find(board: BoardRef, ref: TicketRef): AdapterResult<JiraIssue> {
    const project = this.#project(board);
    if (!project.ok) {
      return project;
    }
    const issue =
      "externalId" in ref
        ? this.#site.issues.get(ref.externalId)
        : [...this.#site.issues.values()].find((candidate) => candidate.key === ref.key);
    return issue?.projectId === project.value.id ? ok(issue) : adapterError("not-found", "no such issue on the board");
  }

  #status(issue: JiraIssue): TicketStatus {
    const status = this.#site.statuses.find((candidate) => candidate.id === issue.statusId);
    if (status === undefined) throw new Error("the Jira fake lost a status");
    return { id: status.id, name: status.name, category: categoryOf(status) };
  }

  #url(issue: JiraIssue): string {
    return `https://jira-fake.invalid/browse/${issue.key}`;
  }

  #ticket(issue: JiraIssue): Ticket {
    const parent = issue.parentId === null ? undefined : this.#site.issues.get(issue.parentId);
    return {
      externalId: issue.id,
      key: issue.key,
      title: issue.summary,
      description: issue.description === null ? null : adfToMarkdown(issue.description, this.#site.mediaOf),
      status: this.#status(issue),
      url: this.#url(issue),
      priority: issue.priority,
      parentKey: parent?.key ?? null,
      parentExternalId: parent?.id ?? null,
      labels: [...issue.labels],
      // Jira's own project is the one the issue is in (F-011): the board's, here.
      trackerProject: { id: issue.projectId, name: this.#site.projects.find((project) => project.id === issue.projectId)?.name ?? issue.projectId },
      updatedAt: issue.updated,
      acceptanceCriteria: issue.acceptanceCriteria,
    };
  }

  #link(issue: JiraIssue, link: TaskLink): string {
    const existing = issue.remoteLinks.find((candidate) => candidate.url === link.url);
    if (existing !== undefined) {
      return existing.id;
    }
    const id = this.#site.nextId();
    issue.remoteLinks.push({ id, url: link.url, title: link.title, subtitle: link.subtitle });
    return id;
  }

  /** Walks the shortest path of transitions to `goal`, as Jira's API makes a client do. */
  #walkTo(issue: JiraIssue, goal: string): AdapterResult<void> {
    if (!this.#site.statuses.some((status) => status.id === goal)) {
      return adapterError("invalid-input", "the mapping names a status this site doesn't have");
    }
    const queue = [issue.statusId];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const at = queue.shift();
      if (at === undefined || at === goal) break;
      for (const transition of this.#site.transitions) {
        const takeable = transition.from.length === 0 || transition.from.includes(at);
        if (takeable && !seen.has(transition.to)) {
          seen.add(transition.to);
          queue.push(transition.to);
        }
      }
    }
    if (!seen.has(goal)) {
      return adapterError("conflict", "no transition path reaches the mapped status");
    }
    issue.statusId = goal;
    return ok(undefined);
  }
}

// ---------- the tracker suite's fixture, on two sites ----------

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** The Jira fake set up for `defineTrackerContractSuite`: this organization's site, and another's. */
export const createJiraFakeSuiteSubject = (
  context?: AdapterContext,
): { readonly site: JiraSite; readonly otherSite: JiraSite; readonly adapter: JiraFakeAdapter; readonly fixture: TrackerSuiteFixture } => {
  const site = createJiraSite({ projectKey: "JIRA" });
  const ops = site.addProject("OPS", "Operations");
  const otherSite = createJiraSite({ projectKey: "JIRA" });
  const board = { externalId: site.projects[0]?.id ?? "" };
  let images = 0;
  const adapter = new JiraFakeAdapter({ site }, context);
  return {
    site,
    otherSite,
    adapter,
    fixture: {
      board,
      boardKey: "JIRA",
      otherBoard: { externalId: ops.id },
      mapping: { started: "10001", inReview: "10002", done: "10003" },
      other: new JiraFakeAdapter({ site: otherSite }),
      webhookSecret: site.webhookSecret,
      ownUserId: site.appAccountId,
      integrationInstalled: site.devPanelInstalled,
      now: () => site.clock.now(),
      advance: (ms) => {
        site.clock.advance(ms);
        return Promise.resolve();
      },
      seedTicket: (input) => {
        let imageUrl: string | undefined;
        if (input.withImage === true) {
          images += 1;
          imageUrl = `https://jira-fake.invalid/secure/attachment/${String(images)}/screenshot.png`;
          site.files.set(imageUrl, { bytes: PNG_BYTES, contentType: "image/png" });
        }
        return Promise.resolve(
          site.createIssue(board.externalId, {
            summary: input.title,
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.labels === undefined ? {} : { labels: input.labels }),
            ...(input.comments === undefined ? {} : { comments: input.comments }),
            ...(imageUrl === undefined ? {} : { imageUrl }),
          }),
        );
      },
      editTicket: (externalId, title) => {
        site.editIssue(externalId, { summary: title });
        return Promise.resolve();
      },
      moveToOtherBoard: (externalId) => Promise.resolve(site.moveIssue(externalId, ops.id)),
      signedDelivery: (input) =>
        Promise.resolve(
          site.signedDelivery({
            externalId: input.ticket.externalId,
            byAccountId: input.byOwnUser ? site.appAccountId : site.personAccountId,
            sentAt: input.sentAt,
          }),
        ),
      seedUser: (email) => Promise.resolve({ userId: site.addUser(email) }),
      // Milestone 6: people by ID; Jira has no agent sessions, so no session hooks.
      milestone6: { seedPerson: (person) => Promise.resolve({ userId: site.addUser(person.email, person.name) }) },
      rateLimitNext: (retryAfterSeconds) => {
        site.injectFault({ kind: "rate-limited", retryAfterSeconds });
        return Promise.resolve();
      },
      files: jiraFilesHooks(site, board),
    },
  };
};

// ---------- milestone 9: a ticket's files, as people put them on a Jira site (F-149) ----------

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** A zip's first bytes: an Office file as far as the fake cares. */
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n%fake\n");

const paragraph = (text: string): AdfNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const mediaOfFile = (container: "mediaSingle" | "mediaGroup", id: string): AdfNode => ({
  type: container,
  content: [{ type: "media", attrs: { type: "file", id, collection: "jira-fake" } }],
});

/**
 * The files cases' hooks on a Jira site, as Jira's editor makes them: whatever is dropped into a
 * description or a comment is attached to the issue and shown by a `media` node naming it.
 */
export const jiraFilesHooks = (site: JiraSite, board: BoardRef): TrackerFilesHooks => {
  const person = site.personAccountId;
  return {
    seedTicketWithFiles: () => {
      const created = site.createIssue(board.externalId, { summary: "With files" });
      const id = created.externalId;
      const image = site.attachToIssue(id, { name: "mock.png", contentType: "image/png", bytes: PNG_BYTES, byAccountId: person });
      const spec = site.attachToIssue(id, { name: "spec.docx", contentType: DOCX_TYPE, bytes: ZIP_BYTES, byAccountId: person });
      const shot = site.attachToIssue(id, { name: "broken.png", contentType: "image/png", bytes: PNG_BYTES, byAccountId: person });
      const design = site.attachToIssue(id, { name: "design.pdf", contentType: "application/pdf", bytes: PDF_BYTES, byAccountId: person });
      site.setDescription(id, {
        type: "doc",
        content: [paragraph("Match the mock; the spec is attached. $(whoami)"), mediaOfFile("mediaSingle", image.id), mediaOfFile("mediaGroup", spec.id)],
      });
      const commentId = site.addComment(id, { type: "doc", content: [paragraph("Here it breaks:"), mediaOfFile("mediaSingle", shot.id)] }, person);
      const figma = "https://www.figma.com/file/0196f1a0/History?node-id=1-2";
      site.addRemoteLink(id, { url: figma, title: "History panel (Figma)" });
      const spareImage = `${JIRA_FAKE_FILE_HOST}${site.nextId()}/progress.png`;
      site.files.set(spareImage, { bytes: PNG_BYTES, contentType: "image/png" });
      return Promise.resolve({
        ...created,
        descriptionImage: image.url,
        descriptionFile: spec.url,
        commentId,
        commentImage: shot.url,
        attachedFile: design.url,
        linkAttachment: figma,
        spareImage,
      });
    },
    followUpText: () => {
      const holder = site.createIssue(board.externalId, { summary: "A follow-up's files" });
      const image = site.attachToIssue(holder.externalId, { name: "follow-up.png", contentType: "image/png", bytes: PNG_BYTES, byAccountId: person });
      const file = site.attachToIssue(holder.externalId, { name: "numbers.xlsx", contentType: XLSX_TYPE, bytes: ZIP_BYTES, byAccountId: person });
      const offHost = "https://files.example.test/secure/attachment/1/numbers.xlsx";
      const text = adfToMarkdown(
        {
          type: "doc",
          content: [
            paragraph("Also look at these:"),
            mediaOfFile("mediaSingle", image.id),
            mediaOfFile("mediaGroup", file.id),
            { type: "paragraph", content: [{ type: "text", text: "numbers.xlsx", marks: [{ type: "link", attrs: { href: offHost } }] }] },
          ],
        },
        site.mediaOf,
      );
      return Promise.resolve({ text, image: image.url, file: file.url, offHost });
    },
    seedFile: (size) => {
      const url = `${JIRA_FAKE_FILE_HOST}${site.nextId()}/sized.bin`;
      site.files.set(url, { bytes: new Uint8Array(size).fill(7), contentType: "application/octet-stream" });
      return Promise.resolve(url);
    },
  };
};
