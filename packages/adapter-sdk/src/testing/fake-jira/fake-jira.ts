import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { externalTicketIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { ExternalTicketId, TicketKey } from "@ostra/protocol";
import { z } from "zod";

import { hmacSha256Hex } from "../../plumbing/signature.ts";
import { markdownToAdf } from "../jira-fake.ts";
import type { AdfNode } from "../jira-fake.ts";
import { manualClock } from "../memory.ts";
import type { ManualClock } from "../memory.ts";
import { matchesJql, parseJql } from "./fake-jql.ts";
import type { JqlSubject } from "./fake-jql.ts";

// The fake Jira (m11 spec section 5.3, ADR 0047): a local stand-in for Jira Cloud's REST v3, the
// way the fake Linear stands in for Linear, for `adapter-jira`'s tests and core's, the API's and
// the browser specs' (spec section 9). One in-process HTTP server that answers Jira's own paths
// and JSON shapes, built from Atlassian's docs (context/research/trackers.md §2). It serves a site
// and Atlassian's gateway at once: `/rest/api/3/...` is the site (a classic token),
// `/ex/jira/{cloudId}/rest/api/3/...` the gateway (a scoped token), and `/_edge/tenant_info` names
// the cloud ID without a credential. The in-memory `JiraFakeAdapter` (`../jira-fake.ts`) stays for
// the tests where a `TrackerAdapter` is enough.
//
// What it has: accounts (a service account and people) with Basic `email:token` sign-in, scoped
// tokens whose scopes each route checks; projects with issue types, statuses in Jira's three
// categories and a workflow per issue type whose transitions are the only way to change a status,
// one of them behind a screen that refuses; issues with ADF descriptions and comments, labels,
// priorities, sub-tasks and epic children, issue links, attachments (multipart uploads,
// `attachment/content/{id}?redirect=false`), remote links upserted by `globalId`, and issue
// properties; JQL search with `nextPageToken`; user search by name or address, with addresses
// each person may hide; project permissions per account; signed admin-webhook deliveries, rightly
// or wrongly signed; 429 with `Retry-After`, as asked or past Jira's per-issue write limit (20
// writes per 2 s); and a record of each request: its route, whether it came to the gateway or the
// site, and a digest of its credential.
//
// Where the docs don't say, the fake assumes, and says so:
// - Each fake site numbers its IDs from its own range, so one site's IDs never name another's
//   issues. Two real sites can share IDs: isolation is by connection, and the suite checks it.
// - A missing scope is 401, as Atlassian answers a scoped token ("scope does not match").
// - JQL's times are read in the asking account's time zone, and `updated` is compared to the ms.
// - A comment event's body has no `user`, only the comment's author: the adapter reads either.
// - A media node in ADF names its upload by a media ID that isn't the attachment's, and its `alt`
//   is the file's name, as Jira's editor writes an upload.

export type FakeJiraCategory = "new" | "indeterminate" | "done";
export type FakeJiraStatus = { readonly id: string; readonly name: string; readonly category: FakeJiraCategory };
export type FakeJiraTransition = {
  readonly id: string;
  readonly name: string;
  readonly from: readonly string[] | "any";
  readonly to: string;
  /** A screen whose fields Jira needs before it takes the transition: an API call without them is refused (400). */
  readonly screenRequires?: readonly string[];
};
export type FakeJiraWorkflow = { readonly name: string; readonly statuses: readonly string[]; readonly transitions: readonly FakeJiraTransition[] };
export type FakeJiraIssueType = { readonly id: string; readonly name: string; readonly subtask: boolean; readonly hierarchyLevel: number };
export type FakeJiraProject = { readonly id: string; readonly key: string; readonly name: string };

export type FakeJiraAccount = {
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string;
  readonly accountType: "app" | "atlassian";
  active: boolean;
  readonly timeZone: string;
  /** Whether Jira shows this account's address to others (a person's profile setting). */
  emailVisible: boolean;
};

type Comment = { readonly id: string; body: AdfNode; readonly authorId: string; updateAuthorId: string; readonly created: number; updated: number };
type Attachment = {
  readonly id: string;
  readonly mediaId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly authorId: string;
  readonly created: number;
  readonly bytes: Uint8Array | null;
};
type RemoteLink = { readonly id: string; readonly globalId: string | null; object: { url: string; title: string; summary: string | null }; relationship: string | null };
type Issue = {
  readonly id: ExternalTicketId;
  key: TicketKey;
  readonly keys: TicketKey[];
  projectId: string;
  issueTypeId: string;
  summary: string;
  description: AdfNode | null;
  statusId: string;
  labels: string[];
  priority: string;
  parentId: string | null;
  readonly created: number;
  updated: number;
  readonly comments: Comment[];
  readonly attachments: Attachment[];
  readonly remoteLinks: RemoteLink[];
  readonly properties: Map<string, unknown>;
  readonly fields: Map<string, unknown>;
  readonly writes: number[];
};
type IssueLink = { readonly id: string; readonly type: "Blocks" | "Relates" | "Duplicate"; readonly outwardId: string; readonly inwardId: string };
type Token = { readonly accountId: string; readonly scopes: readonly string[] | null };

export type FakeJiraFault =
  /** Jira's 429; `retryAfterSeconds: null` sends only `X-RateLimit-Reset`. */
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number | null; readonly resetInSeconds?: number }
  | { readonly kind: "unavailable" };

export type FakeJiraOptions = {
  readonly clock?: ManualClock;
  /** The first project's key. Default `PROJ`. */
  readonly projectKey?: string;
  /** The service account's time zone, which JQL's times are read in. Default `America/Los_Angeles`, west of UTC, so a time read in the wrong zone loses changes instead of hiding. */
  readonly timeZone?: string;
  /** Custom fields issues take (`customfield_10050`), beside Jira's own. */
  readonly customFields?: readonly string[];
};

export type FakeJiraDelivery = { readonly rawBody: Uint8Array; readonly headers: Readonly<Record<string, string>> };

export type FakeJira = {
  /** The site, `http://127.0.0.1:<port>`, standing in for `https://<name>.atlassian.net`. */
  readonly siteUrl: string;
  /** The gateway's origin, standing in for `https://api.atlassian.com` (the same server). */
  readonly gatewayUrl: string;
  readonly cloudId: string;
  readonly clock: ManualClock;
  /** ostra's service account, and its scoped token with the four scopes. */
  readonly serviceAccount: FakeJiraAccount;
  readonly token: string;
  /** A person on the site, who makes changes outside ostra. */
  readonly person: FakeJiraAccount;
  readonly project: FakeJiraProject;
  readonly statuses: readonly FakeJiraStatus[];
  readonly workflow: FakeJiraWorkflow;
  /** Task, Bug, Epic (a level above) and Sub-task (a level below). */
  readonly issueTypes: readonly FakeJiraIssueType[];
  /** The admin webhook's shared secret. */
  readonly webhookSecret: string;
  /** The REST API's root as an adapter in `mode` calls it: what its file URLs start with. */
  readonly apiUrl: (mode: "gateway" | "site") => string;
  readonly addProject: (key: string, name: string) => FakeJiraProject;
  readonly addAccount: (input: { readonly displayName: string; readonly email: string; readonly accountType?: "app" | "atlassian"; readonly emailVisible?: boolean; readonly timeZone?: string }) => FakeJiraAccount;
  /** A token for the account: `scopes: null` is a classic, unscoped token (the site only). */
  readonly mintToken: (accountId: string, scopes: readonly string[] | null) => string;
  /** Takes project permissions from an account (`BROWSE_PROJECTS` hides the project from it). */
  readonly revokePermissions: (accountId: string, projectId: string, permissions: readonly string[]) => void;
  /** A person creates an issue. The description is markdown, written as Jira's editor would. */
  readonly createIssue: (input: {
    readonly projectId?: string;
    readonly summary: string;
    readonly description?: string | null;
    readonly labels?: readonly string[];
    readonly comments?: readonly string[];
    readonly withImage?: boolean;
    readonly parentId?: string;
    readonly issueTypeId?: string;
    readonly priority?: string;
  }) => { readonly id: ExternalTicketId; readonly key: TicketKey };
  readonly editIssue: (id: string, change: { readonly summary?: string }) => void;
  /** Moves an issue to another project: its key changes, its ID doesn't, and its old key still finds it. */
  readonly moveIssue: (id: string, projectId: string) => TicketKey;
  readonly setStatus: (id: string, statusId: string) => void;
  readonly setDescription: (id: string, description: AdfNode) => void;
  /** Someone comments, in ADF or markdown; the comment's ID. */
  readonly addComment: (id: string, body: AdfNode | string, byAccountId?: string) => string;
  /** A file on the issue, as Jira's editor attaches an upload: its attachment ID and its media ID. */
  readonly attach: (id: string, file: { readonly name: string; readonly contentType: string; readonly bytes: Uint8Array; readonly byAccountId?: string }) => { readonly id: string; readonly mediaId: string };
  /** An attachment whose download never ends and declares no length. */
  readonly attachEndless: (id: string) => { readonly id: string };
  readonly addRemoteLink: (id: string, link: { readonly url: string; readonly title: string }) => void;
  readonly linkIssues: (type: "Blocks" | "Relates" | "Duplicate", outwardId: string, inwardId: string) => void;
  /** What's on an issue, as Jira holds it. */
  readonly issueView: (id: string) => {
    readonly key: TicketKey;
    readonly statusId: string;
    readonly description: AdfNode | null;
    readonly comments: readonly { readonly id: string; readonly body: AdfNode; readonly authorId: string }[];
    readonly remoteLinks: readonly { readonly id: string; readonly globalId: string | null; readonly url: string; readonly relationship: string | null }[];
    readonly attachments: readonly { readonly id: string; readonly filename: string }[];
    readonly properties: ReadonlyMap<string, unknown>;
    readonly fields: ReadonlyMap<string, unknown>;
  };
  /** A delivery about an issue, signed as Jira signs an admin webhook's. */
  readonly signedDelivery: (input: {
    readonly issueId: string;
    readonly event?: string;
    readonly byAccountId: string;
    readonly sentAt: number;
    readonly commentId?: string;
    readonly secret?: string;
    readonly identifier?: string;
  }) => FakeJiraDelivery;
  readonly injectFaults: (faults: readonly FakeJiraFault[]) => void;
  /** Headers every answer carries from now on (`X-RateLimit-Remaining` and the rest). */
  readonly setRateHeaders: (headers: Readonly<Record<string, string>>) => void;
  /** Each API call, as `METHOD /rest/api/3/...` without the gateway prefix, where it came, and a digest of its token. */
  readonly calls: () => readonly { readonly route: string; readonly query: string; readonly via: "gateway" | "site"; readonly credential: string | null }[];
  readonly close: () => Promise<void>;
};

let sitesMade = 0;

const CATEGORY: Readonly<Record<FakeJiraCategory, { readonly id: number; readonly name: string; readonly colorName: string }>> = {
  new: { id: 2, name: "To Do", colorName: "blue-gray" },
  indeterminate: { id: 4, name: "In Progress", colorName: "yellow" },
  done: { id: 3, name: "Done", colorName: "green" },
};

/**
 * The four scopes the adapter asks for (ADR 0047, jira-connect.md choice 5), each route needing
 * one. Every account holds every project permission until `revokePermissions` takes one.
 */
type Scope = "read:jira-work" | "write:jira-work" | "read:jira-user" | "read:workflow:jira";

/** A field of a request's JSON object, read loosely. */
const prop = (value: unknown, name: string): unknown => {
  if (typeof value !== "object" || value === null) return undefined;
  const got: unknown = Reflect.get(value, name);
  return got;
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/** Thrown by a route: the status Jira answers, with its error shape and headers. */
type Answer = Error & { readonly status: number; readonly headers: Readonly<Record<string, string>> };
const answer = (status: number, message: string, headers: Readonly<Record<string, string>> = {}): Answer => Object.assign(new Error(message), { status, headers });
const isAnswer = (value: unknown): value is Answer => value instanceof Error && typeof Reflect.get(value, "status") === "number";

/** The parts of a wall-clock time in a time zone. */
const zoned = (ms: number, timeZone: string): { readonly y: number; readonly mo: number; readonly d: number; readonly h: number; readonly mi: number; readonly s: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((one) => one.type === type)?.value ?? "0");
  return { y: part("year"), mo: part("month"), d: part("day"), h: part("hour"), mi: part("minute"), s: part("second") };
};

const offsetMinutes = (ms: number, timeZone: string): number => {
  const local = zoned(ms, timeZone);
  return Math.round((Date.UTC(local.y, local.mo - 1, local.d, local.h, local.mi, local.s) - Math.floor(ms / 1000) * 1000) / 60_000);
};

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** Jira's time, `2026-11-23T10:00:00.000+0100`, in the reader's time zone. */
const jiraTime = (ms: number, timeZone: string): string => {
  const local = zoned(ms, timeZone);
  const offset = offsetMinutes(ms, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${pad(local.y, 4)}-${pad(local.mo)}-${pad(local.d)}T${pad(local.h)}:${pad(local.mi)}:${pad(local.s)}.${pad(ms % 1000, 3)}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
};

/** A JQL time (`yyyy/MM/dd HH:mm`, `yyyy-MM-dd`) in a time zone, in ms; `null` when it isn't one. */
const jqlInstant = (value: string, timeZone: string): number | null => {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})(?:\s+(\d{2}):(\d{2}))?$/.exec(value.trim());
  if (match === null) return null;
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? "0"), Number(match[5] ?? "0"));
  // The wall-clock time's instant: the guess, less the zone's offset there (twice, across a change).
  const first = guess - offsetMinutes(guess, timeZone) * 60_000;
  return guess - offsetMinutes(first, timeZone) * 60_000;
};

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void => {
  response.writeHead(status, { "content-type": "application/json;charset=UTF-8", ...headers });
  response.end(JSON.stringify(body));
};

/** A multipart/form-data body's `file` part: its name, type and bytes. */
const multipartFile = (body: Buffer, contentType: string): { readonly name: string; readonly type: string; readonly bytes: Uint8Array } | null => {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (marker === undefined) return null;
  const delimiter = Buffer.from(`--${marker}`);
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const headerStart = start + delimiter.length + 2;
    const headerEnd = body.indexOf("\r\n\r\n", headerStart);
    const next = body.indexOf(delimiter, headerStart);
    if (headerEnd === -1 || next === -1) return null;
    const headers = body.subarray(headerStart, headerEnd).toString("utf8");
    if (headers.includes('name="file"')) {
      const name = /filename="((?:[^"\\]|\\.)*)"/.exec(headers)?.[1] ?? "file";
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? "application/octet-stream";
      return { name: decodeURIComponent(name.replace(/\\"/g, '"')), type, bytes: new Uint8Array(body.subarray(headerEnd + 4, next - 2)) };
    }
    start = next;
  }
  return null;
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

/** Whether a document is ADF Jira would take: a `doc` of version 1 with no empty text. */
const validDoc = (value: unknown): value is AdfNode => {
  const parsed = adfNodeSchema.safeParse(value);
  if (!parsed.success || parsed.data.type !== "doc" || Reflect.get(Object(value), "version") !== 1 || parsed.data.content === undefined) return false;
  const stack: AdfNode[] = [...parsed.data.content];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === "text" && (node.text ?? "") === "") return false;
    stack.push(...(node.content ?? []));
  }
  return true;
};

export const createFakeJira = async (options: FakeJiraOptions = {}): Promise<FakeJira> => {
  const clock = options.clock ?? manualClock();
  sitesMade += 1;
  let counter = sitesMade * 100_000 + 10_000;
  const nextId = (): string => {
    counter += 1;
    return String(counter);
  };
  const cloudId = randomUUID();
  const webhookSecret = `jira-webhook-${randomUUID()}`;
  const customFields = new Set(options.customFields ?? []);

  const statuses: FakeJiraStatus[] = [
    { id: nextId(), name: "Backlog", category: "new" },
    { id: nextId(), name: "To Do", category: "new" },
    { id: nextId(), name: "In Progress", category: "indeterminate" },
    { id: nextId(), name: "In Review", category: "indeterminate" },
    { id: nextId(), name: "Blocked", category: "indeterminate" },
    { id: nextId(), name: "Done", category: "done" },
    { id: nextId(), name: "Won't Do", category: "done" },
  ];
  const statusNamed = (name: string): FakeJiraStatus => {
    const found = statuses.find((status) => status.name === name);
    if (found === undefined) throw new Error(`the fake Jira has no status ${name}`);
    return found;
  };
  const [backlog, todo, progress, review, blocked, done, wontDo] = ["Backlog", "To Do", "In Progress", "In Review", "Blocked", "Done", "Won't Do"].map((name) => statusNamed(name).id);
  if (backlog === undefined || todo === undefined || progress === undefined || review === undefined || blocked === undefined || done === undefined || wontDo === undefined) {
    throw new Error("the fake Jira's statuses are incomplete");
  }
  // A company-managed workflow: To Do or Backlog → In Progress → In Review → Done, review back to
  // progress, Blocked only to and from In Progress, Won't Do from anywhere (global), and reopen.
  // No direct To Do → Done, so a move walks the graph; nothing reaches In Review from Blocked directly.
  const workflow: FakeJiraWorkflow = {
    name: "Software workflow for PROJ",
    statuses: [backlog, todo, progress, review, blocked, done, wontDo],
    transitions: [
      { id: "11", name: "Start progress", from: [backlog, todo], to: progress },
      { id: "21", name: "Ready for review", from: [progress], to: review },
      { id: "31", name: "Back to work", from: [review], to: progress },
      { id: "41", name: "Done", from: [review], to: done },
      { id: "51", name: "Won't do", from: "any", to: wontDo },
      { id: "61", name: "Reopen", from: [done, wontDo], to: todo },
      { id: "71", name: "Block", from: [progress], to: blocked },
      { id: "81", name: "Unblock", from: [blocked], to: progress },
      { id: "91", name: "Plan", from: [backlog], to: todo },
      // The one way straight from Backlog to Done, behind a screen that needs a resolution: a call
      // that doesn't give one is refused, and a move has to go round by review.
      { id: "101", name: "Close", from: [backlog], to: done, screenRequires: ["resolution"] },
    ],
  };
  const issueTypes: FakeJiraIssueType[] = [
    { id: nextId(), name: "Task", subtask: false, hierarchyLevel: 0 },
    { id: nextId(), name: "Bug", subtask: false, hierarchyLevel: 0 },
    { id: nextId(), name: "Epic", subtask: false, hierarchyLevel: 1 },
    { id: nextId(), name: "Sub-task", subtask: true, hierarchyLevel: -1 },
  ];
  const taskType = issueTypes[0];
  if (taskType === undefined) throw new Error("the fake Jira has no task type");

  const projects: FakeJiraProject[] = [];
  const counters = new Map<string, number>();
  const accounts: FakeJiraAccount[] = [];
  const tokens = new Map<string, Token>();
  const revoked = new Map<string, Set<string>>();
  const issues = new Map<string, Issue>();
  const links: IssueLink[] = [];
  const faults: FakeJiraFault[] = [];
  let rateHeaders: Readonly<Record<string, string>> = {};
  const calls: { route: string; query: string; via: "gateway" | "site"; credential: string | null }[] = [];
  const defaultTimeZone = options.timeZone ?? "America/Los_Angeles";

  const addProject = (key: string, name: string): FakeJiraProject => {
    const project = { id: nextId(), key, name };
    projects.push(project);
    return project;
  };
  const addAccount: FakeJira["addAccount"] = (input) => {
    const account: FakeJiraAccount = {
      accountId: `${sitesMade.toString(16)}:${randomUUID()}`,
      displayName: input.displayName,
      email: input.email,
      accountType: input.accountType ?? "atlassian",
      active: true,
      timeZone: input.timeZone ?? defaultTimeZone,
      emailVisible: input.emailVisible ?? true,
    };
    accounts.push(account);
    return account;
  };
  const mintToken: FakeJira["mintToken"] = (accountId, scopes) => {
    const token = `ATATT${randomUUID().replace(/-/g, "")}`;
    tokens.set(token, { accountId, scopes });
    return token;
  };

  const project = addProject(options.projectKey ?? "PROJ", "Globex shop");
  const serviceAccount = addAccount({ displayName: "ostra-bot", email: "ostra-bot@serviceaccount.atlassian.com", accountType: "app", emailVisible: false });
  const person = addAccount({ displayName: "Alex Kim", email: "alex@globex.example", accountType: "atlassian" });
  const token = mintToken(serviceAccount.accountId, ["read:jira-work", "write:jira-work", "read:jira-user", "read:workflow:jira"]);

  const projectOf = (idOrKey: string): FakeJiraProject | undefined => projects.find((one) => one.id === idOrKey || one.key === idOrKey);
  const can = (accountId: string, projectId: string, permission: string): boolean => !(revoked.get(`${accountId}:${projectId}`)?.has(permission) ?? false);
  // An old key still finds a moved issue, as Jira keeps its key history.
  const issueOf = (idOrKey: string): Issue | undefined => issues.get(idOrKey) ?? [...issues.values()].find((issue) => issue.keys.some((key) => key === idOrKey));
  const mustIssue = (id: string): Issue => {
    const issue = issueOf(id);
    if (issue === undefined) throw new Error("the fake Jira has no such issue");
    return issue;
  };
  const nextKey = (projectId: string): TicketKey => {
    const owner = projects.find((one) => one.id === projectId);
    if (owner === undefined) throw new Error("the fake Jira has no such project");
    const count = (counters.get(projectId) ?? 0) + 1;
    counters.set(projectId, count);
    return ticketKeySchema.parse(`${owner.key}-${String(count)}`);
  };
  const statusOf = (id: string): FakeJiraStatus => {
    const status = statuses.find((one) => one.id === id);
    if (status === undefined) throw new Error("the fake Jira lost a status");
    return status;
  };
  const typeOf = (id: string): FakeJiraIssueType => issueTypes.find((one) => one.id === id) ?? taskType;
  const accountOf = (accountId: string): FakeJiraAccount | undefined => accounts.find((one) => one.accountId === accountId);

  const makeIssue = (input: { readonly projectId: string; readonly summary: string; readonly description: AdfNode | null; readonly issueTypeId: string; readonly parentId: string | null }): Issue => {
    const now = clock.now();
    const key = nextKey(input.projectId);
    const issue: Issue = {
      id: externalTicketIdSchema.parse(nextId()),
      key,
      keys: [key],
      projectId: input.projectId,
      issueTypeId: input.issueTypeId,
      summary: input.summary,
      description: input.description,
      statusId: todo,
      labels: [],
      priority: "Medium",
      parentId: input.parentId,
      created: now,
      updated: now,
      comments: [],
      attachments: [],
      remoteLinks: [],
      properties: new Map(),
      fields: new Map(),
      writes: [],
    };
    issues.set(issue.id, issue);
    return issue;
  };
  const touch = (issue: Issue): void => {
    issue.updated = clock.now();
  };
  const attachTo = (issue: Issue, file: { readonly name: string; readonly contentType: string; readonly bytes: Uint8Array | null; readonly byAccountId: string }): Attachment => {
    const attachment: Attachment = { id: nextId(), mediaId: randomUUID(), filename: file.name, mimeType: file.contentType, authorId: file.byAccountId, created: clock.now(), bytes: file.bytes };
    issue.attachments.push(attachment);
    touch(issue);
    return attachment;
  };
  const findAttachment = (id: string): Attachment | undefined => {
    for (const issue of issues.values()) {
      const found = issue.attachments.find((attachment) => attachment.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  let base = "";

  // ---------- JSON as Jira shapes it ----------

  const statusJson = (id: string): unknown => {
    const status = statusOf(id);
    const category = CATEGORY[status.category];
    return { self: `${base}/rest/api/3/status/${status.id}`, id: status.id, name: status.name, statusCategory: { id: category.id, key: status.category, name: category.name, colorName: category.colorName } };
  };
  const accountJson = (account: FakeJiraAccount, viewer: FakeJiraAccount): unknown => ({
    self: `${base}/rest/api/3/user?accountId=${account.accountId}`,
    accountId: account.accountId,
    accountType: account.accountType,
    displayName: account.displayName,
    active: account.active,
    timeZone: account.timeZone,
    ...(account.emailVisible || account.accountId === viewer.accountId ? { emailAddress: account.email } : {}),
  });
  const projectJson = (owner: FakeJiraProject, full: boolean): unknown => ({
    self: `${base}/rest/api/3/project/${owner.id}`,
    id: owner.id,
    key: owner.key,
    name: owner.name,
    projectTypeKey: "software",
    style: "classic",
    ...(full ? { issueTypes: issueTypes.map((type) => ({ id: type.id, name: type.name, subtask: type.subtask, hierarchyLevel: type.hierarchyLevel })) } : {}),
  });
  const refJson = (issue: Issue): unknown => ({
    id: issue.id,
    key: issue.key,
    self: `${base}/rest/api/3/issue/${issue.id}`,
    fields: { summary: issue.summary, status: statusJson(issue.statusId), issuetype: { id: issue.issueTypeId, name: typeOf(issue.issueTypeId).name, subtask: typeOf(issue.issueTypeId).subtask } },
  });
  const attachmentJson = (attachment: Attachment, viewer: FakeJiraAccount): unknown => {
    const author = accountOf(attachment.authorId);
    return {
      self: `${base}/rest/api/3/attachment/${attachment.id}`,
      id: attachment.id,
      filename: attachment.filename,
      author: author === undefined ? null : accountJson(author, viewer),
      created: jiraTime(attachment.created, viewer.timeZone),
      size: attachment.bytes?.length ?? 0,
      mimeType: attachment.mimeType,
      // Jira names the site's own URL here, whichever way the call came.
      content: `${base}/rest/api/3/attachment/content/${attachment.id}`,
    };
  };
  const issueJson = (issue: Issue, viewer: FakeJiraAccount, fields: ReadonlySet<string> | null): unknown => {
    const owner = projects.find((one) => one.id === issue.projectId);
    const type = typeOf(issue.issueTypeId);
    const parent = issue.parentId === null ? undefined : issues.get(issue.parentId);
    const all: Record<string, () => unknown> = {
      summary: () => issue.summary,
      description: () => issue.description,
      status: () => statusJson(issue.statusId),
      priority: () => ({ id: String(["Highest", "High", "Medium", "Low", "Lowest"].indexOf(issue.priority) + 1), name: issue.priority }),
      parent: () => (parent === undefined ? undefined : refJson(parent)),
      labels: () => [...issue.labels],
      assignee: () => null,
      project: () => (owner === undefined ? null : projectJson(owner, false)),
      updated: () => jiraTime(issue.updated, viewer.timeZone),
      created: () => jiraTime(issue.created, viewer.timeZone),
      issuetype: () => ({ id: type.id, name: type.name, subtask: type.subtask, hierarchyLevel: type.hierarchyLevel }),
      subtasks: () => [...issues.values()].filter((other) => other.parentId === issue.id && typeOf(other.issueTypeId).subtask).map(refJson),
      issuelinks: () =>
        links
          .filter((link) => link.outwardId === issue.id || link.inwardId === issue.id)
          .flatMap((link) => {
            // `linkIssues(type, a, b)` reads "a blocks b". From b's side the entry names a as `inwardIssue` ("b is blocked by a"); from a's, b as `outwardIssue` ("a blocks b").
            const isInwardEnd = link.inwardId === issue.id;
            const other = issues.get(isInwardEnd ? link.outwardId : link.inwardId);
            const names = { Blocks: ["blocks", "is blocked by"], Relates: ["relates to", "relates to"], Duplicate: ["duplicates", "is duplicated by"] }[link.type];
            return other === undefined ? [] : [{ id: link.id, type: { name: link.type, outward: names[0], inward: names[1] }, ...(isInwardEnd ? { inwardIssue: refJson(other) } : { outwardIssue: refJson(other) }) }];
          }),
      attachment: () => issue.attachments.map((attachment) => attachmentJson(attachment, viewer)),
    };
    const out: Record<string, unknown> = {};
    for (const [name, read] of Object.entries(all)) {
      if (fields === null || fields.has(name) || fields.has("*all")) {
        const value = read();
        if (value !== undefined) out[name] = value;
      }
    }
    for (const [name, value] of issue.fields) {
      if (fields === null || fields.has(name) || fields.has("*all")) out[name] = value;
    }
    return { id: issue.id, key: issue.key, self: `${base}/rest/api/3/issue/${issue.id}`, fields: out };
  };
  const commentJson = (comment: Comment, viewer: FakeJiraAccount): unknown => {
    const author = accountOf(comment.authorId);
    const updater = accountOf(comment.updateAuthorId);
    return {
      self: `${base}/rest/api/3/comment/${comment.id}`,
      id: comment.id,
      author: author === undefined ? null : accountJson(author, viewer),
      updateAuthor: updater === undefined ? null : accountJson(updater, viewer),
      body: comment.body,
      created: jiraTime(comment.created, viewer.timeZone),
      updated: jiraTime(comment.updated, viewer.timeZone),
    };
  };

  // ---------- the routes ----------

  type Call = {
    readonly method: string;
    readonly path: string;
    readonly query: URLSearchParams;
    readonly viewer: FakeJiraAccount;
    readonly scopes: readonly string[] | null;
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
  };

  const needScope = (call: Call, scope: Scope): void => {
    if (call.scopes !== null && !call.scopes.includes(scope)) throw answer(401, "Unauthorized; scope does not match");
  };
  const json = async (call: Call): Promise<Record<string, unknown>> => {
    const body = (await readBody(call.request)).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw answer(400, "the body isn't JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw answer(400, "the body isn't an object");
    return Object.fromEntries(Object.entries(parsed));
  };
  /** The issue, if the viewer may browse its project; Jira's 404 otherwise. */
  const visibleIssue = (call: Call, idOrKey: string): Issue => {
    const issue = issueOf(decodeURIComponent(idOrKey));
    if (issue === undefined || !can(call.viewer.accountId, issue.projectId, "BROWSE_PROJECTS")) throw answer(404, "Issue does not exist or you do not have permission to see it.");
    return issue;
  };
  const visibleProject = (call: Call, idOrKey: string): FakeJiraProject => {
    const owner = projectOf(decodeURIComponent(idOrKey));
    if (owner === undefined || !can(call.viewer.accountId, owner.id, "BROWSE_PROJECTS")) throw answer(404, "No project could be found");
    return owner;
  };
  const needPermission = (call: Call, issue: Issue, permission: string): void => {
    if (!can(call.viewer.accountId, issue.projectId, permission)) throw answer(403, "You do not have permission");
  };
  /** Jira Cloud's per-issue write limit: 20 writes in 2 s, then 429. */
  const countWrite = (issue: Issue): void => {
    const now = clock.now();
    const recent = issue.writes.filter((at) => at > now - 2000);
    if (recent.length >= 20) throw answer(429, "Rate limit exceeded", { "retry-after": "2", "ratelimit-reason": "jira-per-issue-on-write" });
    issue.writes.splice(0, issue.writes.length, ...recent, now);
  };
  const availableTransitions = (issue: Issue): readonly FakeJiraTransition[] =>
    workflow.transitions.filter((transition) => transition.to !== issue.statusId && (transition.from === "any" || transition.from.includes(issue.statusId)));
  const docOrRefuse = (value: unknown, what: string): AdfNode => {
    if (!validDoc(value)) throw answer(400, `${what}: Operation value must be an Atlassian Document`);
    return value;
  };

  const jqlSubject = (issue: Issue, viewer: FakeJiraAccount): JqlSubject => {
    const time = (field: string, op: string, value: string): boolean => {
      const at = jqlInstant(value, viewer.timeZone);
      if (at === null) throw answer(400, `Date value '${value}' for field '${field}' is invalid`);
      const mine = field === "updated" ? issue.updated : issue.created;
      switch (op) {
        case ">=":
          return mine >= at;
        case ">":
          return mine > at;
        case "<=":
          return mine <= at;
        case "<":
          return mine < at;
        case "=":
          return mine === at;
        case "!=":
          return mine !== at;
        default:
          throw answer(400, `the operator ${op} isn't supported for ${field}`);
      }
    };
    const equals = (field: string, value: string): boolean => {
      const lower = value.toLowerCase();
      switch (field) {
        case "project": {
          const owner = projectOf(value) ?? projects.find((one) => one.key.toLowerCase() === lower);
          if (owner === undefined) throw answer(400, `The value '${value}' does not exist for the field 'project'.`);
          return issue.projectId === owner.id;
        }
        case "status":
          return issue.statusId === value || statusOf(issue.statusId).name.toLowerCase() === lower;
        case "statuscategory": {
          const category = statusOf(issue.statusId).category;
          return category === lower || CATEGORY[category].name.toLowerCase() === lower || String(CATEGORY[category].id) === value;
        }
        case "labels":
          return issue.labels.includes(value);
        case "issuetype":
        case "type":
          return issue.issueTypeId === value || typeOf(issue.issueTypeId).name.toLowerCase() === lower;
        case "key":
        case "issuekey":
          return issue.keys.some((key) => key.toLowerCase() === lower);
        case "id":
          return issue.id === value;
        case "parent": {
          const parent = issue.parentId === null ? undefined : issues.get(issue.parentId);
          return parent !== undefined && (parent.id === value || parent.keys.some((key) => key.toLowerCase() === lower));
        }
        case "priority":
          return issue.priority.toLowerCase() === lower;
        default:
          throw answer(400, `Field '${field}' does not exist or you do not have permission to view it.`);
      }
    };
    return {
      compare: (field, op, value) => {
        if (field === "updated" || field === "created") return time(field, op, value);
        if (op === "=") return equals(field, value);
        if (op === "!=") return !equals(field, value);
        throw answer(400, `the operator ${op} isn't supported for ${field}`);
      },
      isEmpty: (field) => {
        switch (field) {
          case "labels":
            return issue.labels.length === 0;
          case "parent":
            return issue.parentId === null;
          case "assignee":
            return true;
          default:
            throw answer(400, `Field '${field}' does not support EMPTY in the fake`);
        }
      },
    };
  };

  const search = async (call: Call): Promise<void> => {
    needScope(call, "read:jira-work");
    const body = await json(call);
    const jql = typeof body["jql"] === "string" ? body["jql"] : "";
    let query: ReturnType<typeof parseJql>;
    try {
      query = parseJql(jql);
    } catch (error) {
      throw answer(400, error instanceof Error ? error.message : "a bad query");
    }
    if (query.where === null) throw answer(400, "Unbounded JQL queries are not allowed here. Please add a search restriction to your query.");
    const fields = Array.isArray(body["fields"]) ? new Set(body["fields"].filter((field): field is string => typeof field === "string")) : new Set(["*navigable"]);
    const { where } = query;
    const matching = [...issues.values()].filter((issue) => can(call.viewer.accountId, issue.projectId, "BROWSE_PROJECTS") && matchesJql(where, jqlSubject(issue, call.viewer)));
    const order = query.orderBy.length === 0 ? [{ field: "created", direction: "desc" as const }] : query.orderBy;
    const sortValue = (issue: Issue, field: string): number => {
      switch (field) {
        case "updated":
          return issue.updated;
        case "created":
          return issue.created;
        case "id":
        case "key":
          return Number(issue.id);
        default:
          throw answer(400, `Not able to sort using field '${field}'.`);
      }
    };
    matching.sort((a, b) => {
      for (const { field, direction } of order) {
        const delta = sortValue(a, field) - sortValue(b, field);
        if (delta !== 0) return direction === "asc" ? delta : -delta;
      }
      return 0;
    });
    const maxResults = Math.max(1, Math.min(typeof body["maxResults"] === "number" ? body["maxResults"] : 50, 100));
    const token = typeof body["nextPageToken"] === "string" ? body["nextPageToken"] : null;
    let offset = 0;
    if (token !== null) {
      const decoded = /^o(\d{1,9})$/.exec(Buffer.from(token, "base64url").toString("utf8"));
      if (decoded?.[1] === undefined) throw answer(400, "Invalid nextPageToken");
      offset = Number(decoded[1]);
    }
    const page = matching.slice(offset, offset + maxResults);
    const last = offset + maxResults >= matching.length;
    const known = fields.has("*navigable") || fields.has("*all") ? null : fields;
    sendJson(call.response, 200, {
      issues: page.map((issue) => issueJson(issue, call.viewer, known)),
      ...(last ? { isLast: true } : { nextPageToken: Buffer.from(`o${String(offset + maxResults)}`).toString("base64url"), isLast: false }),
    });
  };

  const route = async (call: Call): Promise<void> => {
    const { method, path, query, viewer, response } = call;
    const parts = path.split("/").filter((part) => part !== "");
    // parts[0..2] are rest, api, 3.
    const [rest, api, version, resource, idOrKey, sub, subId] = parts;
    if (rest !== "rest" || api !== "api" || version !== "3" || resource === undefined) throw answer(404, "no such resource");
    const at =
      resource === "attachment" && idOrKey === "content"
        ? `${method} attachment/content/:id`
        : `${method} ${resource}${idOrKey === undefined ? "" : "/:id"}${sub === undefined ? "" : `/${sub}`}${subId === undefined ? "" : "/:id"}`;
    switch (at) {
      case "GET myself":
        needScope(call, "read:jira-user");
        sendJson(response, 200, accountJson(viewer, viewer));
        return;
      case "GET user": {
        needScope(call, "read:jira-user");
        const found = accountOf(query.get("accountId") ?? "");
        if (found === undefined) throw answer(404, "Specified user does not exist or you do not have required permissions");
        sendJson(response, 200, accountJson(found, viewer));
        return;
      }
      case "GET user/:id": {
        // `user/search`.
        if (idOrKey !== "search") throw answer(404, "no such resource");
        needScope(call, "read:jira-user");
        const asked = (query.get("query") ?? "").toLowerCase();
        const found = asked === "" ? [] : accounts.filter((account) => account.displayName.toLowerCase().startsWith(asked) || account.email.toLowerCase().startsWith(asked));
        sendJson(response, 200, found.slice(0, Number(query.get("maxResults") ?? "50")).map((account) => accountJson(account, viewer)));
        return;
      }
      case "GET project/:id": {
        needScope(call, "read:jira-work");
        if (idOrKey === "search") {
          const visible = projects.filter((one) => can(viewer.accountId, one.id, "BROWSE_PROJECTS"));
          const startAt = Number(query.get("startAt") ?? "0");
          const maxResults = Number(query.get("maxResults") ?? "50");
          const page = visible.slice(startAt, startAt + maxResults);
          sendJson(response, 200, { startAt, maxResults, total: visible.length, isLast: startAt + maxResults >= visible.length, values: page.map((one) => projectJson(one, false)) });
          return;
        }
        sendJson(response, 200, projectJson(visibleProject(call, idOrKey ?? ""), true));
        return;
      }
      case "GET project/:id/statuses": {
        needScope(call, "read:jira-work");
        visibleProject(call, idOrKey ?? "");
        sendJson(response, 200, issueTypes.map((type) => ({ id: type.id, name: type.name, subtask: type.subtask, statuses: workflow.statuses.map(statusJson) })));
        return;
      }
      case "GET mypermissions": {
        needScope(call, "read:jira-work");
        const wanted = (query.get("permissions") ?? "").split(",").filter((one) => one !== "");
        if (wanted.length === 0) throw answer(400, "The permissions parameter is required");
        const projectId = query.get("projectId");
        const owner = projectId === null ? undefined : projectOf(projectId);
        if (projectId !== null && owner === undefined) throw answer(404, "No project could be found");
        sendJson(response, 200, {
          permissions: Object.fromEntries(wanted.map((key) => [key, { id: key, key, name: key, type: "PROJECT", havePermission: owner === undefined ? true : can(viewer.accountId, owner.id, key) }])),
        });
        return;
      }
      case "POST search/:id": {
        if (idOrKey !== "jql") throw answer(404, "no such resource");
        await search(call);
        return;
      }
      case "GET issue/:id": {
        needScope(call, "read:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        const fields = query.get("fields");
        sendJson(response, 200, issueJson(issue, viewer, fields === null ? null : new Set(fields.split(","))));
        return;
      }
      case "POST issue": {
        needScope(call, "write:jira-work");
        const body = await json(call);
        const fields: Record<string, unknown> = typeof body["fields"] === "object" && body["fields"] !== null ? Object.fromEntries(Object.entries(body["fields"])) : {};
        const projectRef: unknown = fields["project"];
        const projectId = prop(projectRef, "id") ?? prop(projectRef, "key");
        const owner = typeof projectId === "string" ? projectOf(projectId) : undefined;
        if (owner === undefined || !can(viewer.accountId, owner.id, "BROWSE_PROJECTS")) throw answer(400, "project: valid project is required");
        if (!can(viewer.accountId, owner.id, "CREATE_ISSUES")) throw answer(403, "You do not have permission to create issues in this project");
        const summary = fields["summary"];
        if (typeof summary !== "string" || summary.trim() === "" || summary.length > 255) throw answer(400, "summary: You must specify a summary of the issue.");
        const typeRef: unknown = fields["issuetype"];
        const type = issueTypes.find((one) => prop(typeRef, "id") === one.id);
        if (type === undefined) throw answer(400, "issuetype: valid issue type is required");
        const parentRef: unknown = fields["parent"];
        const parentKey = prop(parentRef, "id") ?? prop(parentRef, "key");
        const parent = typeof parentKey === "string" ? issueOf(parentKey) : undefined;
        if (type.subtask && parent === undefined) throw answer(400, "parent: Given parent work item does not belong to appropriate hierarchy.");
        if (parent !== undefined && (parent.projectId !== owner.id || typeOf(parent.issueTypeId).subtask)) throw answer(400, "parent: Given parent work item does not belong to appropriate hierarchy.");
        const description = fields["description"] === undefined || fields["description"] === null ? null : docOrRefuse(fields["description"], "description");
        const issue = makeIssue({ projectId: owner.id, summary, description, issueTypeId: type.id, parentId: parent?.id ?? null });
        sendJson(response, 201, { id: issue.id, key: issue.key, self: `${base}/rest/api/3/issue/${issue.id}` });
        return;
      }
      case "PUT issue/:id": {
        needScope(call, "write:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        needPermission(call, issue, "EDIT_ISSUES");
        const body = await json(call);
        const fields: Record<string, unknown> = typeof body["fields"] === "object" && body["fields"] !== null ? Object.fromEntries(Object.entries(body["fields"])) : {};
        countWrite(issue);
        for (const [name, value] of Object.entries(fields)) {
          if (name === "description") issue.description = value === null ? null : docOrRefuse(value, "description");
          else if (name === "summary" && typeof value === "string") issue.summary = value;
          else if (customFields.has(name)) issue.fields.set(name, value === null ? null : docOrRefuse(value, name));
          else throw answer(400, `Field '${name}' cannot be set. It is not on the appropriate screen, or unknown.`);
        }
        touch(issue);
        response.writeHead(204);
        response.end();
        return;
      }
      case "GET issue/:id/comment": {
        needScope(call, "read:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        const startAt = Number(query.get("startAt") ?? "0");
        const maxResults = Math.min(Number(query.get("maxResults") ?? "50"), 100);
        const ordered = [...issue.comments].sort((a, b) => a.created - b.created);
        sendJson(response, 200, { startAt, maxResults, total: ordered.length, comments: ordered.slice(startAt, startAt + maxResults).map((comment) => commentJson(comment, viewer)) });
        return;
      }
      case "POST issue/:id/comment": {
        needScope(call, "write:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        needPermission(call, issue, "ADD_COMMENTS");
        const body = docOrRefuse((await json(call))["body"], "body");
        countWrite(issue);
        const now = clock.now();
        const comment: Comment = { id: nextId(), body, authorId: viewer.accountId, updateAuthorId: viewer.accountId, created: now, updated: now };
        issue.comments.push(comment);
        touch(issue);
        sendJson(response, 201, commentJson(comment, viewer));
        return;
      }
      case "GET issue/:id/comment/:id": {
        needScope(call, "read:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        const comment = issue.comments.find((one) => one.id === subId);
        if (comment === undefined) throw answer(404, "Can not find a comment for the id");
        sendJson(response, 200, commentJson(comment, viewer));
        return;
      }
      case "PUT issue/:id/comment/:id": {
        needScope(call, "write:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        const comment = issue.comments.find((one) => one.id === subId);
        if (comment === undefined) throw answer(404, "Can not find a comment for the id");
        needPermission(call, issue, comment.authorId === viewer.accountId ? "EDIT_OWN_COMMENTS" : "EDIT_ALL_COMMENTS");
        const body = docOrRefuse((await json(call))["body"], "body");
        countWrite(issue);
        comment.body = body;
        comment.updateAuthorId = viewer.accountId;
        comment.updated = clock.now();
        touch(issue);
        sendJson(response, 200, commentJson(comment, viewer));
        return;
      }
      case "GET issue/:id/transitions": {
        needScope(call, "read:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        const allowed = can(viewer.accountId, issue.projectId, "TRANSITION_ISSUES");
        sendJson(response, 200, {
          expand: "transitions",
          transitions: allowed
            ? availableTransitions(issue).map((transition) => ({ id: transition.id, name: transition.name, to: statusJson(transition.to), hasScreen: transition.screenRequires !== undefined, isGlobal: transition.from === "any", isInitial: false, isAvailable: true, isConditional: false, isLooped: false }))
            : [],
        });
        return;
      }
      case "POST issue/:id/transitions": {
        needScope(call, "write:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        needPermission(call, issue, "TRANSITION_ISSUES");
        const body = await json(call);
        const transitionRef: unknown = body["transition"];
        const wanted = prop(transitionRef, "id");
        const transition = availableTransitions(issue).find((one) => one.id === wanted);
        if (transition === undefined) throw answer(400, "Transition id is not valid for the current status");
        for (const field of transition.screenRequires ?? []) {
          if (prop(body["fields"], field) === undefined) throw answer(400, `Field '${field}' is required`);
        }
        countWrite(issue);
        issue.statusId = transition.to;
        touch(issue);
        response.writeHead(204);
        response.end();
        return;
      }
      case "GET issue/:id/remotelink": {
        needScope(call, "read:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        sendJson(
          response,
          200,
          issue.remoteLinks.map((link) => ({ id: Number(link.id), self: `${base}/rest/api/3/issue/${issue.id}/remotelink/${link.id}`, ...(link.globalId === null ? {} : { globalId: link.globalId }), ...(link.relationship === null ? {} : { relationship: link.relationship }), object: link.object })),
        );
        return;
      }
      case "POST issue/:id/remotelink": {
        needScope(call, "write:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        needPermission(call, issue, "LINK_ISSUES");
        const body = await json(call);
        const object: unknown = body["object"];
        const url = prop(object, "url");
        const title = prop(object, "title");
        const summary = prop(object, "summary");
        if (typeof url !== "string" || typeof title !== "string" || title === "") throw answer(400, "object: url and title are required");
        const globalId = typeof body["globalId"] === "string" ? body["globalId"] : null;
        const relationship = typeof body["relationship"] === "string" ? body["relationship"] : null;
        countWrite(issue);
        const existing = globalId === null ? undefined : issue.remoteLinks.find((link) => link.globalId === globalId);
        const value = { url, title, summary: typeof summary === "string" ? summary : null };
        if (existing !== undefined) {
          existing.object = value;
          existing.relationship = relationship;
          sendJson(response, 200, { id: Number(existing.id), self: `${base}/rest/api/3/issue/${issue.id}/remotelink/${existing.id}` });
          return;
        }
        const link: RemoteLink = { id: nextId(), globalId, object: value, relationship };
        issue.remoteLinks.push(link);
        touch(issue);
        sendJson(response, 201, { id: Number(link.id), self: `${base}/rest/api/3/issue/${issue.id}/remotelink/${link.id}` });
        return;
      }
      case "POST issue/:id/attachments": {
        needScope(call, "write:jira-work");
        const issue = visibleIssue(call, idOrKey ?? "");
        needPermission(call, issue, "CREATE_ATTACHMENTS");
        if (call.request.headers["x-atlassian-token"] !== "no-check") throw answer(403, "XSRF check failed");
        const file = multipartFile(await readBody(call.request), call.request.headers["content-type"] ?? "");
        if (file === null) throw answer(400, "no file in the upload");
        countWrite(issue);
        const attachment = attachTo(issue, { name: file.name, contentType: file.type, bytes: file.bytes, byAccountId: viewer.accountId });
        sendJson(response, 200, [attachmentJson(attachment, viewer)]);
        return;
      }
      case "GET attachment/content/:id": {
        needScope(call, "read:jira-work");
        const attachment = findAttachment(sub ?? "");
        const owner = attachment === undefined ? undefined : [...issues.values()].find((issue) => issue.attachments.includes(attachment));
        if (attachment === undefined || owner === undefined || !can(viewer.accountId, owner.projectId, "BROWSE_PROJECTS")) throw answer(404, "The attachment does not exist");
        if (query.get("redirect") !== "false") {
          // Jira's default: a redirect to its media host, which the adapter must never follow.
          response.writeHead(303, { location: `https://api.media.atlassian.com/file/${attachment.mediaId}/binary` });
          response.end();
          return;
        }
        if (attachment.bytes === null) {
          response.writeHead(200, { "content-type": attachment.mimeType });
          const chunk = Buffer.alloc(16 * 1024, 7);
          const pump = (): void => {
            if (response.destroyed || response.writableEnded) return;
            if (response.write(chunk)) setImmediate(pump);
            else response.once("drain", pump);
          };
          pump();
          return;
        }
        response.writeHead(200, { "content-type": attachment.mimeType, "content-length": String(attachment.bytes.length) });
        response.end(Buffer.from(attachment.bytes));
        return;
      }
      case "GET issue/:id/properties/:id":
      case "PUT issue/:id/properties/:id": {
        const issue = visibleIssue(call, idOrKey ?? "");
        const key = decodeURIComponent(subId ?? "");
        if (method === "GET") {
          needScope(call, "read:jira-work");
          if (!issue.properties.has(key)) throw answer(404, "The property was not found");
          sendJson(response, 200, { key, value: issue.properties.get(key) });
          return;
        }
        needScope(call, "write:jira-work");
        needPermission(call, issue, "EDIT_ISSUES");
        const value: unknown = JSON.parse((await readBody(call.request)).toString("utf8"));
        const existed = issue.properties.has(key);
        issue.properties.set(key, value);
        response.writeHead(existed ? 200 : 201);
        response.end();
        return;
      }
      case "GET workflowscheme/:id": {
        if (idOrKey !== "project") throw answer(404, "no such resource");
        needScope(call, "read:workflow:jira");
        const ids = query.getAll("projectId");
        sendJson(response, 200, { values: ids.filter((id) => projectOf(id) !== undefined).map((id) => ({ projectIds: [id], workflowScheme: { id: 10_100, name: "Software scheme", defaultWorkflow: workflow.name, issueTypeMappings: {} } })) });
        return;
      }
      case "GET workflow/:id": {
        if (idOrKey !== "search") throw answer(404, "no such resource");
        needScope(call, "read:workflow:jira");
        const names = query.getAll("workflowName");
        const listed = names.length === 0 || names.includes(workflow.name) ? [workflow] : [];
        const expand = (query.get("expand") ?? "").split(",");
        sendJson(response, 200, {
          startAt: 0,
          maxResults: 50,
          total: listed.length,
          isLast: true,
          values: listed.map((one) => ({
            id: { name: one.name, entityId: randomUUID() },
            description: "",
            ...(expand.includes("transitions")
              ? {
                  transitions: [
                    { id: "1", name: "Create", description: "", from: [], to: todo, type: "initial" },
                    ...one.transitions.map((transition) => ({ id: transition.id, name: transition.name, description: "", from: transition.from === "any" ? [] : [...transition.from], to: transition.to, type: transition.from === "any" ? "global" : "directed" })),
                  ],
                }
              : {}),
            ...(expand.includes("statuses") ? { statuses: one.statuses.map((id) => ({ id, name: statusOf(id).name, properties: {} })) } : {}),
          })),
        });
        return;
      }
      default:
        throw answer(404, `the fake Jira has no ${at}`);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://fake-jira.invalid");
    let path = url.pathname;
    let gateway = false;
    if (path.startsWith("/ex/jira/")) {
      const [, , , id, ...rest] = path.split("/");
      if (id !== cloudId) throw answer(404, "Site temporarily unavailable");
      gateway = true;
      path = `/${rest.join("/")}`;
    }
    if (!gateway && request.method === "GET" && path === "/_edge/tenant_info") {
      sendJson(response, 200, { cloudId });
      return;
    }
    const authorization = request.headers.authorization ?? "";
    const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization)?.[1];
    const [email, secret] = basic === undefined ? [] : Buffer.from(basic, "base64").toString("utf8").split(":");
    calls.push({
      route: `${request.method ?? "GET"} ${path}`,
      query: url.search,
      via: gateway ? "gateway" : "site",
      credential: secret === undefined ? null : createHash("sha256").update(secret).digest("hex").slice(0, 16),
    });
    const held = secret === undefined ? undefined : tokens.get(secret);
    const viewer = held === undefined ? undefined : accountOf(held.accountId);
    // A scoped token answers only at the gateway; a classic one only at the site.
    if (held === undefined || viewer === undefined || viewer.email !== email || !viewer.active || (held.scopes === null) === gateway) {
      throw answer(401, "Client must be authenticated to access this resource.");
    }
    const fault = faults.shift();
    if (fault !== undefined) {
      switch (fault.kind) {
        case "rate-limited": {
          const reset = new Date(clock.now() + (fault.resetInSeconds ?? fault.retryAfterSeconds ?? 60) * 1000).toISOString();
          throw answer(429, "Rate limit exceeded", { ...(fault.retryAfterSeconds === null ? {} : { "retry-after": String(fault.retryAfterSeconds) }), "x-ratelimit-reset": reset, "ratelimit-reason": "jira-burst-based" });
        }
        case "unavailable":
          throw answer(503, "Service unavailable");
        default:
          return fault satisfies never;
      }
    }
    for (const [name, value] of Object.entries(rateHeaders)) response.setHeader(name, value);
    await route({ method: request.method ?? "GET", path, query: url.searchParams, viewer, scopes: held.scopes, request, response });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = isAnswer(error) ? error : answer(500, "the fake Jira failed");
      sendJson(response, status.status, { errorMessages: [status.message], errors: {} }, status.headers);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake Jira has no TCP address");
  base = `http://127.0.0.1:${String(address.port)}`;

  const createIssue: FakeJira["createIssue"] = (input) => {
    const issue = makeIssue({
      projectId: input.projectId ?? project.id,
      summary: input.summary,
      description: input.description === undefined || input.description === null ? null : markdownToAdf(input.description),
      issueTypeId: input.issueTypeId ?? (input.parentId === undefined ? taskType.id : (issueTypes.find((type) => type.subtask)?.id ?? taskType.id)),
      parentId: input.parentId ?? null,
    });
    issue.labels = [...(input.labels ?? [])];
    if (input.priority !== undefined) issue.priority = input.priority;
    for (const [index, text] of (input.comments ?? []).entries()) {
      issue.comments.push({ id: nextId(), body: markdownToAdf(text), authorId: person.accountId, updateAuthorId: person.accountId, created: issue.created + index, updated: issue.created + index });
    }
    if (input.withImage === true) {
      const image = attachTo(issue, { name: "screenshot.png", contentType: "image/png", bytes: PNG_BYTES, byAccountId: person.accountId });
      const described: AdfNode = {
        type: "doc",
        attrs: { version: 1 },
        content: [...(issue.description?.content ?? []), { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { id: image.mediaId, type: "file", collection: "", alt: image.filename } }] }],
      };
      issue.description = described;
      issue.updated = issue.created;
    }
    return { id: issue.id, key: issue.key };
  };

  return {
    siteUrl: base,
    gatewayUrl: base,
    cloudId,
    clock,
    serviceAccount,
    token,
    person,
    project,
    statuses,
    workflow,
    issueTypes,
    webhookSecret,
    apiUrl: (mode) => (mode === "gateway" ? `${base}/ex/jira/${cloudId}` : base),
    addProject,
    addAccount,
    mintToken,
    revokePermissions: (accountId, projectId, permissions) => {
      const key = `${accountId}:${projectId}`;
      const held = revoked.get(key) ?? new Set<string>();
      for (const permission of permissions) held.add(permission);
      revoked.set(key, held);
    },
    createIssue,
    editIssue: (id, change) => {
      const issue = mustIssue(id);
      if (change.summary !== undefined) issue.summary = change.summary;
      touch(issue);
    },
    moveIssue: (id, projectId) => {
      const issue = mustIssue(id);
      issue.projectId = projectId;
      issue.key = nextKey(projectId);
      issue.keys.push(issue.key);
      touch(issue);
      return issue.key;
    },
    setStatus: (id, statusId) => {
      const issue = mustIssue(id);
      issue.statusId = statusId;
      touch(issue);
    },
    setDescription: (id, description) => {
      const issue = mustIssue(id);
      issue.description = description;
      touch(issue);
    },
    addComment: (id, body, byAccountId) => {
      const issue = mustIssue(id);
      const now = clock.now();
      const author = byAccountId ?? person.accountId;
      const comment: Comment = { id: nextId(), body: typeof body === "string" ? markdownToAdf(body) : body, authorId: author, updateAuthorId: author, created: now, updated: now };
      issue.comments.push(comment);
      touch(issue);
      return comment.id;
    },
    attach: (id, file) => {
      const attachment = attachTo(mustIssue(id), { name: file.name, contentType: file.contentType, bytes: new Uint8Array(file.bytes), byAccountId: file.byAccountId ?? person.accountId });
      return { id: attachment.id, mediaId: attachment.mediaId };
    },
    attachEndless: (id) => ({ id: attachTo(mustIssue(id), { name: "endless.bin", contentType: "application/octet-stream", bytes: null, byAccountId: person.accountId }).id }),
    addRemoteLink: (id, link) => {
      const issue = mustIssue(id);
      issue.remoteLinks.push({ id: nextId(), globalId: null, object: { url: link.url, title: link.title, summary: null }, relationship: null });
      touch(issue);
    },
    linkIssues: (type, outwardId, inwardId) => {
      links.push({ id: nextId(), type, outwardId, inwardId });
    },
    issueView: (id) => {
      const issue = mustIssue(id);
      return {
        key: issue.key,
        statusId: issue.statusId,
        description: issue.description,
        comments: issue.comments.map((comment) => ({ id: comment.id, body: comment.body, authorId: comment.authorId })),
        remoteLinks: issue.remoteLinks.map((link) => ({ id: link.id, globalId: link.globalId, url: link.object.url, relationship: link.relationship })),
        attachments: issue.attachments.map((attachment) => ({ id: attachment.id, filename: attachment.filename })),
        properties: new Map(issue.properties),
        fields: new Map(issue.fields),
      };
    },
    signedDelivery: (input) => {
      const issue = mustIssue(input.issueId);
      const event = input.event ?? "jira:issue_updated";
      const actor = accountOf(input.byAccountId);
      const owner = projects.find((one) => one.id === issue.projectId);
      const comment = input.commentId === undefined ? undefined : issue.comments.find((one) => one.id === input.commentId);
      const viewer = actor ?? person;
      const body = {
        timestamp: input.sentAt,
        webhookEvent: event,
        ...(event.startsWith("jira:issue_") ? { issue_event_type_name: event === "jira:issue_created" ? "issue_created" : "issue_generic" } : {}),
        // A comment event names the comment's author, not a `user`.
        ...(event.startsWith("comment_") || actor === undefined ? {} : { user: accountJson(actor, viewer) }),
        issue: { id: issue.id, key: issue.key, self: `${base}/rest/api/3/issue/${issue.id}`, fields: { summary: issue.summary, status: statusJson(issue.statusId), project: owner === undefined ? null : projectJson(owner, false) } },
        ...(comment === undefined ? {} : { comment: commentJson(comment, viewer) }),
        ...(event === "jira:issue_updated" ? { changelog: { id: nextId(), items: [{ field: "summary", fieldtype: "jira" }] } } : {}),
      };
      const rawBody = new TextEncoder().encode(JSON.stringify(body));
      return {
        rawBody,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-hub-signature": `sha256=${hmacSha256Hex(input.secret ?? webhookSecret, rawBody)}`,
          "x-atlassian-webhook-identifier": input.identifier ?? nextId(),
          "x-atlassian-webhook-flow": "Primary",
        },
      };
    },
    injectFaults: (list) => {
      faults.push(...list);
    },
    setRateHeaders: (headers) => {
      rateHeaders = { ...headers };
    },
    calls: () => [...calls],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
};
