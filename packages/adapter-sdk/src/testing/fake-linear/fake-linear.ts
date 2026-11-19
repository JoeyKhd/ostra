import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { externalTicketIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { ExternalTicketId, TicketKey } from "@ostra/protocol";
import { z } from "zod";

import { hmacSha256Hex } from "../../plumbing/signature.ts";
import { manualClock } from "../memory.ts";
import type { ManualClock } from "../memory.ts";
import type { TrackerAdapter } from "../../tracker/base.ts";
import type { SeededTicket, TrackerSuiteFixture } from "../tracker-suite.ts";
import { readOperation } from "./graphql-lite.ts";
import type { GraphqlValue, TopLevelField } from "./graphql-lite.ts";

// A local stand-in for Linear's plain API (spec section 8), ported from
// spikes/linear-agent-mode/src/fake-linear/ and widened from agent mode to what milestone 2 uses:
// teams, workflow states, issues, comments with threads, attachments, integrations, `viewer` and
// `organization`, webhooks, the OAuth endpoints with PKCE and rotating refresh tokens, signed
// deliveries with Linear's headers and retry schedule, and 429 with `Retry-After`.
//
// It's built from Linear's docs (context/research/trackers.md) and answers every field it knows,
// whatever the selection set asked: an adapter reads Linear's answers loosely, so the extra fields
// cost nothing, and the fake needn't parse selections. Where the docs don't say, the fake assumes,
// and says so where it does:
// - `orderBy: updatedAt` answers the most recently updated first ("To get most recently updated
//   resources, you can alternatively order by updatedAt", linear.app/developers/pagination).
// - `sort: [{ updatedAt: { order: Ascending } }]` answers oldest first. Assumed from Linear's
//   `IssueSortInput`; not checked against Linear.
// - An issue looked up by an identifier it had before it moved team is not found. Unverified.
// - A webhook retry is stamped afresh (the spike's assumption, research/spike-linear-agent-mode.md).

export type FakeLinearPerson = { readonly id: string; readonly name: string; readonly email: string };

export type FakeLinearTeam = { readonly id: string; readonly key: string; readonly name: string };

export type FakeLinearState = {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  /** Linear's state types. */
  readonly type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";
  readonly position: number;
};

type Comment = {
  readonly id: string;
  readonly issueId: string;
  body: string;
  readonly userId: string;
  readonly parentId: string | null;
  readonly createdAt: number;
  updatedAt: number;
};

type Attachment = {
  readonly id: string;
  readonly issueId: string;
  readonly url: string;
  title: string;
  subtitle: string | null;
  readonly createdAt: number;
};

type Issue = {
  readonly id: ExternalTicketId;
  identifier: TicketKey;
  number: number;
  teamId: string;
  title: string;
  description: string | null;
  stateId: string;
  priority: number;
  labels: string[];
  parentId: string | null;
  readonly creatorId: string;
  readonly createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  readonly relations: { readonly id: string; readonly type: "blocks" | "related" | "duplicate"; readonly relatedId: string }[];
};

type Token = {
  readonly userId: string;
  readonly via: "oauth" | "apiKey";
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly app: boolean;
};

type Webhook = {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
  readonly teamId: string | null;
  readonly resourceTypes: readonly string[];
  readonly label: string;
};

export type FakeLinearDelivery = {
  readonly deliveryId: string;
  readonly webhookId: string;
  readonly type: string;
  readonly action: string;
  readonly attempts: readonly { readonly status: number | null }[];
  readonly delivered: boolean;
};

export type FakeLinearFault =
  /** 429 with `Retry-After`, Linear's `RATELIMITED`. */
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number }
  /** A mutation is applied, then answered 500: a retry must find it, not make it again (F-046). */
  | { readonly kind: "fail-after-write" }
  /** 500 before anything is applied. */
  | { readonly kind: "http500" };

export type FakeLinearApp = {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The app's webhook signing secret (one per app, as Linear's manifest gives). */
  readonly webhookSecret: string;
};

export type FakeLinearOptions = {
  /** The clock tickets and tokens are stamped with. Default: a manual clock at 2023-11-14. */
  readonly clock?: ManualClock;
  /** Waits between delivery attempts after a failure, in real ms. Linear's are 1 min, 1 h and 6 h. */
  readonly retryDelaysMs?: readonly number[];
  /** Access tokens' lifetime, in seconds. Linear's is 24 h. */
  readonly accessTokenSeconds?: number;
  /** The workspace's URL key. */
  readonly urlKey?: string;
};

export type FakeLinear = {
  readonly apiUrl: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  readonly clock: ManualClock;
  readonly organization: { readonly id: string; readonly name: string; readonly urlKey: string };
  /** A person: the workspace's admin. */
  readonly admin: FakeLinearPerson;
  /** The admin's personal API key, sent bare in `Authorization`, as Linear takes it. */
  readonly adminApiKey: string;
  /** The team every fake starts with, `OST`, with Linear's default states. */
  readonly team: FakeLinearTeam;
  readonly addTeam: (key: string, name: string) => FakeLinearTeam;
  readonly states: (teamId: string) => readonly FakeLinearState[];
  /** Registers the app, as "Create" on a manifest does. One app per fake. */
  readonly createApp: (input: { readonly name: string; readonly redirectUris: readonly string[]; readonly webhookUrl: string | null }) => FakeLinearApp;
  /** The app's own user, once a consent with `actor=app` made it. */
  readonly appUser: () => FakeLinearPerson | undefined;
  /** Whether the client-credentials grant answers (off by default, as on `ostra-test`). */
  readonly setClientCredentialsEnabled: (enabled: boolean) => void;
  /** A token without the consent flow, for tests of a saved token. */
  readonly mintToken: (kind: "app" | "person") => { readonly accessToken: string; readonly refreshToken: string };
  /** Expires every access token now, as a day passing does. Refresh tokens still work. */
  readonly expireAccessTokens: () => void;
  readonly setGithubIntegration: (installed: boolean) => void;
  /** A person creates an issue (and its webhook goes out). */
  readonly createIssue: (input: {
    readonly teamId?: string;
    readonly title: string;
    readonly description?: string | null;
    readonly labels?: readonly string[];
    readonly comments?: readonly string[];
    readonly withImage?: boolean;
    readonly parentId?: string;
  }) => Promise<{ readonly id: ExternalTicketId; readonly identifier: TicketKey }>;
  readonly editIssue: (id: ExternalTicketId, change: { readonly title?: string; readonly description?: string }) => Promise<void>;
  /** A person moves the issue to another team: its identifier changes. */
  readonly moveIssue: (id: ExternalTicketId, teamId: string) => Promise<TicketKey>;
  /** A person comments. */
  readonly addComment: (issueId: ExternalTicketId, body: string) => Promise<string>;
  readonly issueView: (id: ExternalTicketId) => {
    readonly identifier: TicketKey;
    readonly stateId: string;
    readonly comments: readonly { readonly id: string; readonly body: string; readonly userId: string }[];
    readonly attachments: readonly { readonly id: string; readonly url: string }[];
  };
  /** A delivery about an issue, signed with the app's (or a workspace webhook's) secret. Not sent. */
  readonly signedDelivery: (input: {
    readonly issueId: ExternalTicketId;
    readonly type?: "Issue" | "Comment";
    readonly action?: "create" | "update" | "remove";
    readonly byUserId: string;
    readonly sentAt: number;
    readonly secret?: string;
  }) => { readonly rawBody: Uint8Array; readonly headers: Readonly<Record<string, string>> };
  /** Webhooks sent so far, to the app's URL and to workspace webhooks. */
  readonly deliveries: () => readonly FakeLinearDelivery[];
  /** Workspace webhooks made with `webhookCreate` (the dev seed's, spec section 3). */
  readonly webhooks: () => readonly { readonly id: string; readonly url: string; readonly teamId: string | null }[];
  /** Stops sending webhooks, as an install Linear can't reach. */
  readonly setWebhooksPaused: (paused: boolean) => void;
  /** The next calls meet these faults, one per call. */
  readonly injectFaults: (faults: readonly FakeLinearFault[]) => void;
  /** Calls per root field and OAuth endpoint. */
  readonly apiCalls: () => Readonly<Record<string, number>>;
  readonly close: () => Promise<void>;
};

const STATE_TEMPLATE: readonly Omit<FakeLinearState, "id" | "teamId">[] = [
  { name: "Triage", type: "triage", position: 0 },
  { name: "Backlog", type: "backlog", position: 1 },
  { name: "Todo", type: "unstarted", position: 2 },
  { name: "In Progress", type: "started", position: 3 },
  { name: "In Review", type: "started", position: 4 },
  { name: "Done", type: "completed", position: 5 },
  { name: "Canceled", type: "canceled", position: 6 },
];

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

const iso = (ms: number): string => new Date(ms).toISOString();

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const graphqlError = (
  response: ServerResponse,
  status: number,
  code: string,
  type: string,
  message: string,
  headers: Record<string, string> = {},
): void => {
  sendJson(response, status, { errors: [{ message, extensions: { code, type, userError: status < 500 } }] }, headers);
};

/** A thrown answer, unwound by the request handler. */
class FakeAnswer extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  constructor(status: number, code: string, type: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

const notFound = (what: string): FakeAnswer => new FakeAnswer(200, "INVALID_INPUT", "invalid input", `Entity not found: ${what}`);
const invalid = (message: string): FakeAnswer => new FakeAnswer(400, "INVALID_INPUT", "invalid input", message);

// Arguments, read loosely.
const isList = (value: GraphqlValue | undefined): value is readonly GraphqlValue[] => Array.isArray(value);
const objectArg = (value: GraphqlValue | undefined): Readonly<Record<string, GraphqlValue>> =>
  value === null || value === undefined || typeof value !== "object" || isList(value) ? {} : value;
const stringArg = (value: GraphqlValue | undefined): string | undefined => (typeof value === "string" ? value : undefined);
const numberArg = (value: GraphqlValue | undefined): number | undefined => (typeof value === "number" ? value : undefined);
const listArg = (value: GraphqlValue | undefined): readonly GraphqlValue[] => (isList(value) ? value : []);
const nested = (value: GraphqlValue | undefined, ...path: readonly string[]): GraphqlValue | undefined => {
  let at: GraphqlValue | undefined = value;
  for (const key of path) {
    at = objectArg(at)[key];
  }
  return at;
};
const timeArg = (value: GraphqlValue | undefined): number | undefined => {
  const text = stringArg(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
};

const tokenFormSchema = z.looseObject({ grant_type: z.string() });

export const createFakeLinear = async (options: FakeLinearOptions = {}): Promise<FakeLinear> => {
  const clock = options.clock ?? manualClock();
  const retryDelaysMs = options.retryDelaysMs ?? [];
  const accessTokenSeconds = options.accessTokenSeconds ?? 86_399;
  const lifetime = new AbortController();

  const organization = { id: `org-${randomUUID()}`, name: "ostra-test", urlKey: options.urlKey ?? "ostra-test" };
  const admin: FakeLinearPerson = { id: `user-${randomUUID()}`, name: "Test Admin", email: "admin@example.test" };
  const adminApiKey = `lin_api_${randomBytes(20).toString("hex")}`;
  const people = new Map<string, FakeLinearPerson>([[admin.id, admin]]);

  const teams: FakeLinearTeam[] = [];
  const states: FakeLinearState[] = [];
  const issues = new Map<string, Issue>();
  const comments: Comment[] = [];
  const attachments: Attachment[] = [];
  const counters = new Map<string, number>();
  const tokens = new Map<string, Token>([
    [adminApiKey, { userId: admin.id, via: "apiKey", scopes: ["read", "write", "admin"], expiresAt: Number.POSITIVE_INFINITY, app: false }],
  ]);
  const refreshTokens = new Map<string, { userId: string; app: boolean; scopes: readonly string[]; rotatedAt: number | null; next: { accessToken: string; refreshToken: string } | null }>();
  const codes = new Map<string, { readonly redirectUri: string; readonly challenge: string; readonly actor: string | null; readonly scopes: readonly string[] }>();
  const webhooks: Webhook[] = [];
  const deliveries: { deliveryId: string; webhookId: string; type: string; action: string; attempts: { status: number | null }[]; delivered: boolean }[] = [];
  const faults: FakeLinearFault[] = [];
  const calls = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  let app: (FakeLinearApp & { readonly name: string; readonly redirectUris: readonly string[]; webhookUrl: string | null }) | undefined;
  let appUser: FakeLinearPerson | undefined;
  let clientCredentials = false;
  let githubIntegration = false;
  let webhooksPaused = false;
  let base = "";

  const countCall = (name: string): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
  };

  const addTeam = (key: string, name: string): FakeLinearTeam => {
    const team = { id: `team-${randomUUID()}`, key, name };
    teams.push(team);
    for (const template of STATE_TEMPLATE) {
      states.push({ ...template, id: `state-${randomUUID()}`, teamId: team.id });
    }
    return team;
  };
  const team = addTeam("OST", "ostra-test");

  const teamOf = (id: string): FakeLinearTeam => {
    const found = teams.find((candidate) => candidate.id === id);
    if (found === undefined) throw notFound("Team");
    return found;
  };
  const stateOf = (id: string): FakeLinearState => {
    const found = states.find((candidate) => candidate.id === id);
    if (found === undefined) throw notFound("WorkflowState");
    return found;
  };
  const firstState = (teamId: string, type: FakeLinearState["type"]): FakeLinearState => {
    const found = states.find((candidate) => candidate.teamId === teamId && candidate.type === type);
    if (found === undefined) throw new Error("the fake Linear lost a team's states");
    return found;
  };
  const nextIdentifier = (teamId: string): { readonly identifier: TicketKey; readonly number: number } => {
    const count = (counters.get(teamId) ?? 0) + 1;
    counters.set(teamId, count);
    return { identifier: ticketKeySchema.parse(`${teamOf(teamId).key}-${String(count)}`), number: count };
  };
  const issueOf = (idOrIdentifier: string): Issue => {
    const found = issues.get(idOrIdentifier) ?? [...issues.values()].find((candidate) => candidate.identifier === idOrIdentifier);
    if (found === undefined) throw notFound("Issue");
    return found;
  };
  const issueUrl = (issue: Issue): string => `https://linear.app/${organization.urlKey}/issue/${issue.identifier}`;

  // ---------- JSON shapes, as Linear names its fields ----------

  const userJson = (id: string) => {
    const person = people.get(id);
    return person === undefined ? null : { id: person.id, name: person.name, displayName: person.name, email: person.email };
  };
  const teamJson = (found: FakeLinearTeam) => ({ __typename: "Team", id: found.id, key: found.key, name: found.name });
  const stateJson = (state: FakeLinearState) => ({
    __typename: "WorkflowState",
    id: state.id,
    name: state.name,
    type: state.type,
    position: state.position,
    color: "#95a2b3",
    team: teamJson(teamOf(state.teamId)),
  });
  const summaryJson = (issue: Issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issueUrl(issue),
    state: stateJson(stateOf(issue.stateId)),
  });
  const commentJson = (comment: Comment) => ({
    __typename: "Comment",
    id: comment.id,
    body: comment.body,
    createdAt: iso(comment.createdAt),
    updatedAt: iso(comment.updatedAt),
    user: userJson(comment.userId),
    parent: comment.parentId === null ? null : { id: comment.parentId },
    issue: { id: comment.issueId },
  });
  const attachmentJson = (attachment: Attachment) => ({
    __typename: "Attachment",
    id: attachment.id,
    url: attachment.url,
    title: attachment.title,
    subtitle: attachment.subtitle,
    createdAt: iso(attachment.createdAt),
  });
  const connection = <T,>(nodes: readonly T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const issueJson = (issue: Issue) => {
    const parent = issue.parentId === null ? undefined : issues.get(issue.parentId);
    return {
      __typename: "Issue",
      id: issue.id,
      identifier: issue.identifier,
      number: issue.number,
      title: issue.title,
      description: issue.description,
      url: issueUrl(issue),
      priority: issue.priority,
      priorityLabel: ["No priority", "Urgent", "High", "Medium", "Low"][issue.priority] ?? "No priority",
      createdAt: iso(issue.createdAt),
      updatedAt: iso(issue.updatedAt),
      archivedAt: issue.archivedAt === null ? null : iso(issue.archivedAt),
      state: stateJson(stateOf(issue.stateId)),
      team: teamJson(teamOf(issue.teamId)),
      labels: connection(issue.labels.map((name) => ({ id: `label-${name}`, name }))),
      parent: parent === undefined ? null : summaryJson(parent),
      children: connection([...issues.values()].filter((other) => other.parentId === issue.id).map(summaryJson)),
      relations: connection(
        issue.relations.flatMap((relation) => {
          const related = issues.get(relation.relatedId);
          return related === undefined ? [] : [{ id: relation.id, type: relation.type, relatedIssue: summaryJson(related) }];
        }),
      ),
      inverseRelations: connection(
        [...issues.values()].flatMap((other) =>
          other.relations
            .filter((relation) => relation.relatedId === issue.id)
            .map((relation) => ({ id: relation.id, type: relation.type, issue: summaryJson(other) })),
        ),
      ),
      comments: connection(comments.filter((comment) => comment.issueId === issue.id).sort((a, b) => a.createdAt - b.createdAt).map(commentJson)),
      attachments: connection(attachments.filter((attachment) => attachment.issueId === issue.id).map(attachmentJson)),
      creator: userJson(issue.creatorId),
      assignee: null,
    };
  };

  // ---------- webhooks ----------

  const webhookData = (issue: Issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    number: issue.number,
    teamId: issue.teamId,
    team: { id: issue.teamId, key: teamOf(issue.teamId).key },
    stateId: issue.stateId,
    priority: issue.priority,
    updatedAt: iso(issue.updatedAt),
    url: issueUrl(issue),
  });

  const payloadFor = (input: { readonly issue: Issue; readonly type: "Issue" | "Comment"; readonly action: string; readonly byUserId: string; readonly comment?: Comment; readonly sentAt: number; readonly webhookId: string }) => {
    const actor = people.get(input.byUserId);
    return {
      action: input.action,
      type: input.type,
      actor: actor === undefined ? null : { id: actor.id, name: actor.name, type: "user" },
      createdAt: iso(input.sentAt),
      data:
        input.type === "Issue"
          ? webhookData(input.issue)
          : {
              id: input.comment?.id ?? randomUUID(),
              body: input.comment?.body ?? "",
              issueId: input.issue.id,
              userId: input.byUserId,
              issue: webhookData(input.issue),
            },
      url: issueUrl(input.issue),
      organizationId: organization.id,
      webhookId: input.webhookId,
      webhookTimestamp: input.sentAt,
    };
  };

  const signed = (secret: string, type: string, body: unknown): { readonly rawBody: Uint8Array; readonly headers: Readonly<Record<string, string>> } => {
    const rawBody = new TextEncoder().encode(JSON.stringify(body));
    return {
      rawBody,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "linear-delivery": randomUUID(),
        "linear-event": type,
        "linear-signature": hmacSha256Hex(secret, rawBody),
        "linear-timestamp": String(Date.now()),
      },
    };
  };

  /** Every endpoint a change goes to: the app's URL, and workspace webhooks on the issue's team. */
  const targets = (issue: Issue, type: string): readonly { readonly id: string; readonly url: string; readonly secret: string }[] => [
    ...(app?.webhookUrl === null || app?.webhookUrl === undefined ? [] : [{ id: `app-${app.clientId}`, url: app.webhookUrl, secret: app.webhookSecret }]),
    ...webhooks.filter((hook) => (hook.teamId === null || hook.teamId === issue.teamId) && hook.resourceTypes.includes(type)),
  ];

  const send = (issue: Issue, type: "Issue" | "Comment", action: string, byUserId: string, comment?: Comment): void => {
    if (webhooksPaused) return;
    for (const target of targets(issue, type)) {
      const attempts: { status: number | null }[] = [];
      const record = { deliveryId: randomUUID(), webhookId: target.id, type, action, attempts, delivered: false };
      deliveries.push(record);
      const run = async (): Promise<void> => {
        for (const wait of [0, ...retryDelaysMs]) {
          if (wait > 0) {
            try {
              await delay(wait, undefined, { signal: lifetime.signal });
            } catch {
              return;
            }
          }
          // A retry is stamped afresh (assumed, as spike 5 did).
          const now = clock.now();
          const request = signed(target.secret, type, payloadFor({ issue, type, action, byUserId, sentAt: now, webhookId: target.id, ...(comment === undefined ? {} : { comment }) }));
          try {
            const response = await fetch(target.url, {
              method: "POST",
              headers: { ...request.headers, "linear-delivery": record.deliveryId },
              // The JSON text: the same bytes the signature covers.
              body: new TextDecoder().decode(request.rawBody),
              signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
            });
            await response.text();
            record.attempts.push({ status: response.status });
            if (response.ok) {
              record.delivered = true;
              return;
            }
          } catch {
            record.attempts.push({ status: null });
            if (lifetime.signal.aborted) return;
          }
        }
      };
      const promise = run().finally(() => {
        pending.delete(promise);
      });
      pending.add(promise);
    }
  };

  // ---------- auth ----------

  const principalOf = (authorization: string | undefined): Token => {
    const value = authorization ?? "";
    const token = value.startsWith("Bearer ") ? tokens.get(value.slice("Bearer ".length)) : tokens.get(value);
    if (token?.via === "oauth" && !value.startsWith("Bearer ")) {
      throw new FakeAnswer(401, "AUTHENTICATION_ERROR", "authentication error", "Authentication required, not authenticated");
    }
    if (token === undefined || token.expiresAt <= clock.now()) {
      throw new FakeAnswer(401, "AUTHENTICATION_ERROR", "authentication error", "Authentication required, not authenticated");
    }
    return token;
  };

  const issueToken = (userId: string, isApp: boolean, scopes: readonly string[]) => {
    const accessToken = `lin_oauth_${randomBytes(20).toString("hex")}`;
    const refreshToken = `lin_refresh_${randomBytes(20).toString("hex")}`;
    tokens.set(accessToken, { userId, via: "oauth", scopes, expiresAt: clock.now() + accessTokenSeconds * 1000, app: isApp });
    refreshTokens.set(refreshToken, { userId, app: isApp, scopes, rotatedAt: null, next: null });
    return { accessToken, refreshToken };
  };

  const ensureAppUser = (): FakeLinearPerson => {
    if (app === undefined) throw new Error("the fake Linear has no app yet");
    if (appUser === undefined) {
      appUser = { id: `app-user-${randomUUID()}`, name: app.name, email: `${app.clientId}@oauthapp.linear.app` };
      people.set(appUser.id, appUser);
    }
    return appUser;
  };

  // ---------- GraphQL resolvers ----------

  const pageOf = <T extends { readonly id: string }>(items: readonly T[], args: Readonly<Record<string, GraphqlValue>>, json: (item: T) => unknown) => {
    const first = Math.max(1, Math.min(numberArg(args["first"]) ?? 50, 250));
    const after = stringArg(args["after"]);
    let start = 0;
    if (after !== undefined) {
      const index = items.findIndex((item) => item.id === after);
      if (index < 0) throw invalid("Invalid cursor");
      start = index + 1;
    }
    const page = items.slice(start, start + first);
    const last = page.at(-1);
    return {
      nodes: page.map(json),
      pageInfo: { hasNextPage: start + first < items.length, endCursor: last === undefined ? null : last.id },
    };
  };

  const filterIssues = (filter: Readonly<Record<string, GraphqlValue>>, includeArchived: boolean): Issue[] =>
    [...issues.values()].filter((issue) => {
      if (!includeArchived && issue.archivedAt !== null) return false;
      const teamId = stringArg(nested(filter["team"], "id", "eq"));
      if (teamId !== undefined && issue.teamId !== teamId) return false;
      const stateIds = listArg(nested(filter["state"], "id", "in"));
      if (stateIds.length > 0 && !stateIds.includes(issue.stateId)) return false;
      const stateTypes = listArg(nested(filter["state"], "type", "in"));
      if (stateTypes.length > 0 && !stateTypes.includes(stateOf(issue.stateId).type)) return false;
      const gt = timeArg(nested(filter["updatedAt"], "gt"));
      if (gt !== undefined && !(issue.updatedAt > gt)) return false;
      const gte = timeArg(nested(filter["updatedAt"], "gte"));
      if (gte !== undefined && !(issue.updatedAt >= gte)) return false;
      const idEq = stringArg(nested(filter["id"], "eq"));
      if (idEq !== undefined && issue.id !== idEq) return false;
      const idIn = listArg(nested(filter["id"], "in"));
      if (idIn.length > 0 && !idIn.includes(issue.id)) return false;
      return true;
    });

  const sortIssues = (list: Issue[], args: Readonly<Record<string, GraphqlValue>>): Issue[] => {
    const sort = listArg(args["sort"]);
    const updatedSort = stringArg(nested(sort[0], "updatedAt", "order"));
    if (updatedSort !== undefined) {
      const direction = updatedSort === "Ascending" ? 1 : -1;
      return list.sort((a, b) => direction * (a.updatedAt - b.updatedAt || a.createdAt - b.createdAt));
    }
    const orderBy = stringArg(args["orderBy"]) ?? "createdAt";
    // Newest first, as the docs read ("most recently updated").
    return list.sort((a, b) => (orderBy === "updatedAt" ? b.updatedAt - a.updatedAt : b.createdAt - a.createdAt) || b.number - a.number);
  };

  const requireWrite = (principal: Token): void => {
    if (principal.via === "oauth" && !principal.scopes.includes("write") && !principal.scopes.includes("admin")) {
      throw new FakeAnswer(403, "FORBIDDEN", "forbidden", "Invalid scope: write required");
    }
  };

  const touch = (issue: Issue): void => {
    issue.updatedAt = Math.max(clock.now(), issue.updatedAt + 1);
  };

  const linkAttachment = (issueId: string, url: string, title: string, subtitle: string | null) => {
    const issue = issueOf(issueId);
    // Linear's attachments are idempotent on the URL per issue: a second create updates the first.
    const existing = attachments.find((attachment) => attachment.issueId === issue.id && attachment.url === url);
    if (existing !== undefined) {
      existing.title = title;
      existing.subtitle = subtitle;
      return existing;
    }
    const attachment = { id: `attachment-${randomUUID()}`, issueId: issue.id, url, title, subtitle, createdAt: clock.now() };
    attachments.push(attachment);
    touch(issue);
    return attachment;
  };

  const resolveQuery = (field: TopLevelField, principal: Token): unknown => {
    const args = field.args;
    switch (field.name) {
      case "viewer": {
        const user = userJson(principal.userId);
        return { ...user, app: principal.app, organization: { id: organization.id, name: organization.name, urlKey: organization.urlKey } };
      }
      case "organization":
        return { id: organization.id, name: organization.name, urlKey: organization.urlKey };
      case "teams":
        return pageOf(teams, args, (found) => ({ ...teamJson(found), states: connection(states.filter((state) => state.teamId === found.id).map(stateJson)) }));
      case "team": {
        const found = teamOf(stringArg(args["id"]) ?? "");
        return { ...teamJson(found), states: connection(states.filter((state) => state.teamId === found.id).map(stateJson)) };
      }
      case "workflowStates": {
        const teamId = stringArg(nested(args["filter"], "team", "id", "eq"));
        const list = states.filter((state) => teamId === undefined || state.teamId === teamId).sort((a, b) => a.position - b.position);
        return pageOf(list, args, stateJson);
      }
      case "issue":
        return issueJson(issueOf(stringArg(args["id"]) ?? ""));
      case "issues": {
        const list = sortIssues(filterIssues(objectArg(args["filter"]), args["includeArchived"] === true), args);
        return pageOf(list, args, issueJson);
      }
      case "comment": {
        const found = comments.find((comment) => comment.id === stringArg(args["id"]));
        if (found === undefined) throw notFound("Comment");
        return commentJson(found);
      }
      case "integrations":
        return connection(githubIntegration ? [{ id: "integration-github", service: "github", createdAt: iso(0) }] : []);
      case "attachmentsForURL":
        return connection(attachments.filter((attachment) => attachment.url === stringArg(args["url"])).map(attachmentJson));
      case "webhooks":
        return connection(webhooks.map((hook) => ({ id: hook.id, url: hook.url, enabled: true, label: hook.label, team: hook.teamId === null ? null : { id: hook.teamId } })));
      default:
        throw new FakeAnswer(400, "GRAPHQL_VALIDATION_FAILED", "graphql error", `The fake Linear doesn't implement the query field ${field.name}`);
    }
  };

  const resolveMutation = (field: TopLevelField, principal: Token): unknown => {
    requireWrite(principal);
    const args = field.args;
    const input = objectArg(args["input"]);
    switch (field.name) {
      case "issueCreate": {
        const teamId = stringArg(input["teamId"]);
        const title = stringArg(input["title"]);
        if (teamId === undefined || title === undefined || title === "") throw invalid("teamId and title are required");
        teamOf(teamId);
        const created = makeIssue({
          teamId,
          title,
          description: stringArg(input["description"]) ?? null,
          stateId: stringArg(input["stateId"]),
          creatorId: principal.userId,
        });
        send(created, "Issue", "create", principal.userId);
        return { success: true, issue: issueJson(created) };
      }
      case "issueUpdate": {
        const issue = issueOf(stringArg(args["id"]) ?? "");
        const stateId = stringArg(input["stateId"]);
        if (stateId !== undefined) {
          const state = stateOf(stateId);
          if (state.teamId !== issue.teamId) throw invalid("The state is on another team");
          issue.stateId = stateId;
        }
        const title = stringArg(input["title"]);
        if (title !== undefined) issue.title = title;
        const description = stringArg(input["description"]);
        if (description !== undefined) issue.description = description;
        const teamId = stringArg(input["teamId"]);
        if (teamId !== undefined && teamId !== issue.teamId) {
          moveTo(issue, teamId);
        }
        touch(issue);
        send(issue, "Issue", "update", principal.userId);
        return { success: true, issue: issueJson(issue) };
      }
      case "commentCreate": {
        const issue = issueOf(stringArg(input["issueId"]) ?? "");
        const body = stringArg(input["body"]);
        if (body === undefined || body === "") throw invalid("body is required");
        const parentId = stringArg(input["parentId"]) ?? null;
        if (parentId !== null && !comments.some((comment) => comment.id === parentId && comment.issueId === issue.id)) throw notFound("Comment");
        const comment = { id: `comment-${randomUUID()}`, issueId: issue.id, body, userId: principal.userId, parentId, createdAt: clock.now(), updatedAt: clock.now() };
        comments.push(comment);
        touch(issue);
        send(issue, "Comment", "create", principal.userId, comment);
        return { success: true, comment: commentJson(comment) };
      }
      case "commentUpdate": {
        const comment = comments.find((candidate) => candidate.id === stringArg(args["id"]));
        if (comment === undefined) throw notFound("Comment");
        if (comment.userId !== principal.userId) throw new FakeAnswer(403, "FORBIDDEN", "forbidden", "Only the author can edit a comment");
        const body = stringArg(input["body"]);
        if (body === undefined || body === "") throw invalid("body is required");
        comment.body = body;
        comment.updatedAt = clock.now();
        const issue = issueOf(comment.issueId);
        touch(issue);
        send(issue, "Comment", "update", principal.userId, comment);
        return { success: true, comment: commentJson(comment) };
      }
      case "attachmentCreate": {
        const url = stringArg(input["url"]);
        const title = stringArg(input["title"]);
        if (url === undefined || title === undefined) throw invalid("url and title are required");
        return { success: true, attachment: attachmentJson(linkAttachment(stringArg(input["issueId"]) ?? "", url, title, stringArg(input["subtitle"]) ?? null)) };
      }
      case "attachmentLinkURL": {
        const url = stringArg(args["url"]);
        if (url === undefined) throw invalid("url is required");
        return { success: true, attachment: attachmentJson(linkAttachment(stringArg(args["issueId"]) ?? "", url, stringArg(args["title"]) ?? url, null)) };
      }
      case "attachmentLinkGitHubPR": {
        const url = stringArg(args["url"]);
        if (url === undefined) throw invalid("url is required");
        return { success: true, attachment: attachmentJson(linkAttachment(stringArg(args["issueId"]) ?? "", url, "GitHub pull request", null)) };
      }
      case "webhookCreate": {
        const url = stringArg(input["url"]);
        if (url === undefined) throw invalid("url is required");
        const hook: Webhook = {
          id: `webhook-${randomUUID()}`,
          url,
          secret: stringArg(input["secret"]) ?? `lin_wh_${randomBytes(16).toString("hex")}`,
          teamId: stringArg(input["teamId"]) ?? null,
          resourceTypes: listArg(input["resourceTypes"]).flatMap((type) => (typeof type === "string" ? [type] : [])),
          label: stringArg(input["label"]) ?? "",
        };
        webhooks.push(hook);
        return { success: true, webhook: { id: hook.id, url: hook.url, enabled: true, secret: hook.secret } };
      }
      case "webhookDelete": {
        const index = webhooks.findIndex((hook) => hook.id === stringArg(args["id"]));
        if (index < 0) throw notFound("Webhook");
        webhooks.splice(index, 1);
        return { success: true };
      }
      default:
        throw new FakeAnswer(400, "GRAPHQL_VALIDATION_FAILED", "graphql error", `The fake Linear doesn't implement the mutation ${field.name}`);
    }
  };

  const makeIssue = (input: { readonly teamId: string; readonly title: string; readonly description: string | null; readonly stateId?: string | undefined; readonly creatorId: string; readonly parentId?: string }): Issue => {
    const { identifier, number } = nextIdentifier(input.teamId);
    const now = clock.now();
    const issue: Issue = {
      id: externalTicketIdSchema.parse(randomUUID()),
      identifier,
      number,
      teamId: input.teamId,
      title: input.title,
      description: input.description,
      stateId: input.stateId ?? firstState(input.teamId, "triage").id,
      priority: 0,
      labels: [],
      parentId: input.parentId ?? null,
      creatorId: input.creatorId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      relations: [],
    };
    issues.set(issue.id, issue);
    return issue;
  };

  const moveTo = (issue: Issue, teamId: string): void => {
    teamOf(teamId);
    const next = nextIdentifier(teamId);
    const oldState = stateOf(issue.stateId);
    issue.teamId = teamId;
    issue.identifier = next.identifier;
    issue.number = next.number;
    issue.stateId = firstState(teamId, oldState.type).id;
  };

  const handleGraphql = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const text = (await readBody(request)).toString("utf8");
    const body = z.looseObject({ query: z.string(), variables: z.record(z.string(), z.unknown()).nullish() }).safeParse(JSON.parse(text));
    if (!body.success) {
      graphqlError(response, 400, "INVALID_INPUT", "invalid input", "Not a GraphQL request");
      return;
    }
    const principal = principalOf(request.headers.authorization);
    const operation = readOperation(body.data.query, body.data.variables ?? {});
    const fault = faults.shift();
    if (fault?.kind === "rate-limited") {
      graphqlError(response, 429, "RATELIMITED", "ratelimited", "Rate limit exceeded", { "retry-after": String(fault.retryAfterSeconds) });
      return;
    }
    if (fault?.kind === "http500") {
      graphqlError(response, 500, "INTERNAL_SERVER_ERROR", "internal error", "Internal server error");
      return;
    }
    if (fault?.kind === "fail-after-write" && operation.type === "query") {
      faults.unshift(fault);
    }
    const data: Record<string, unknown> = {};
    for (const field of operation.fields) {
      countCall(field.name);
      data[field.responseKey] = operation.type === "query" ? resolveQuery(field, principal) : resolveMutation(field, principal);
    }
    if (fault?.kind === "fail-after-write" && operation.type === "mutation") {
      graphqlError(response, 500, "INTERNAL_SERVER_ERROR", "internal error", "Internal server error");
      return;
    }
    sendJson(response, 200, { data }, { "x-ratelimit-requests-remaining": "4999", "x-ratelimit-requests-limit": "5000" });
  };

  // ---------- OAuth ----------

  const handleAuthorize = (url: URL, response: ServerResponse): void => {
    countCall("oauth/authorize");
    const params = url.searchParams;
    const redirectUri = params.get("redirect_uri");
    const state = params.get("state");
    const challenge = params.get("code_challenge");
    if (app?.clientId !== params.get("client_id")) {
      sendJson(response, 400, { error: "invalid_client" });
      return;
    }
    if (redirectUri === null || !app.redirectUris.includes(redirectUri)) {
      sendJson(response, 400, { error: "invalid_redirect_uri" });
      return;
    }
    if (params.get("response_type") !== "code" || state === null || challenge === null || params.get("code_challenge_method") !== "S256") {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    // The admin presses Authorize at once.
    const code = randomBytes(16).toString("hex");
    codes.set(code, { redirectUri, challenge, actor: params.get("actor"), scopes: (params.get("scope") ?? "").split(/[\s,]+/).filter((scope) => scope !== "") });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state);
    response.writeHead(302, { location: target.toString() });
    response.end();
  };

  const tokenAnswer = (pair: { readonly accessToken: string; readonly refreshToken: string }, scopes: readonly string[]) => ({
    access_token: pair.accessToken,
    token_type: "Bearer",
    expires_in: accessTokenSeconds,
    scope: scopes.join(" "),
    refresh_token: pair.refreshToken,
  });

  const handleToken = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    countCall("oauth/token");
    const form = new URLSearchParams((await readBody(request)).toString("utf8"));
    const basic = request.headers.authorization?.startsWith("Basic ") === true
      ? Buffer.from(request.headers.authorization.slice("Basic ".length), "base64").toString("utf8").split(":")
      : [];
    const clientId = form.get("client_id") ?? basic[0];
    const clientSecret = form.get("client_secret") ?? basic[1];
    if (!tokenFormSchema.safeParse(Object.fromEntries(form)).success || app === undefined || clientId !== app.clientId || clientSecret !== app.clientSecret) {
      sendJson(response, 400, { error: "invalid_client" });
      return;
    }
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (code?.redirectUri !== form.get("redirect_uri") || challenge !== code.challenge) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      codes.delete(form.get("code") ?? "");
      const asApp = code.actor === "app";
      const user = asApp ? ensureAppUser() : admin;
      sendJson(response, 200, tokenAnswer(issueToken(user.id, asApp, code.scopes), code.scopes));
      return;
    }
    if (grant === "refresh_token") {
      const old = form.get("refresh_token") ?? "";
      const record = refreshTokens.get(old);
      if (record === undefined) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      if (record.rotatedAt !== null) {
        // A rotated refresh token can be retried for 30 minutes, if its answer was lost.
        if (clock.now() - record.rotatedAt > 30 * 60_000 || record.next === null) {
          sendJson(response, 400, { error: "invalid_grant" });
          return;
        }
        sendJson(response, 200, tokenAnswer(record.next, record.scopes));
        return;
      }
      const next = issueToken(record.userId, record.app, record.scopes);
      record.rotatedAt = clock.now();
      record.next = next;
      sendJson(response, 200, tokenAnswer(next, record.scopes));
      return;
    }
    if (grant === "client_credentials") {
      if (!clientCredentials) {
        sendJson(response, 400, { error: "unauthorized_client" });
        return;
      }
      const scopes = (form.get("scope") ?? "").split(",").filter((scope) => scope !== "");
      const accessToken = `lin_oauth_${randomBytes(20).toString("hex")}`;
      tokens.set(accessToken, { userId: ensureAppUser().id, via: "oauth", scopes, expiresAt: clock.now() + 30 * 86_400_000, app: true });
      sendJson(response, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 30 * 86_400, scope: scopes.join(" ") });
      return;
    }
    sendJson(response, 400, { error: "unsupported_grant_type" });
  };

  const handleUpload = (request: IncomingMessage, response: ServerResponse): void => {
    countCall("uploads");
    try {
      principalOf(request.headers.authorization);
    } catch {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    response.writeHead(200, { "content-type": "image/png", "content-length": String(PNG_BYTES.length) });
    response.end(Buffer.from(PNG_BYTES));
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake-linear.invalid");
    const run = async (): Promise<void> => {
      if (request.method === "POST" && url.pathname === "/graphql") await handleGraphql(request, response);
      else if (request.method === "GET" && url.pathname === "/oauth/authorize") handleAuthorize(url, response);
      else if (request.method === "POST" && url.pathname === "/oauth/token") await handleToken(request, response);
      else if (request.method === "POST" && url.pathname === "/oauth/revoke") {
        countCall("oauth/revoke");
        const form = new URLSearchParams((await readBody(request)).toString("utf8"));
        tokens.delete(form.get("token") ?? "");
        refreshTokens.delete(form.get("token") ?? "");
        response.writeHead(200);
        response.end();
      } else if (request.method === "GET" && url.pathname.startsWith("/uploads/")) handleUpload(request, response);
      else sendJson(response, 404, { error: "not-found" });
    };
    run().catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof FakeAnswer) {
        graphqlError(response, error.status, error.code, error.type, error.message);
        return;
      }
      if (error instanceof SyntaxError) {
        graphqlError(response, 400, "INVALID_INPUT", "invalid input", "Body is not JSON");
        return;
      }
      graphqlError(response, 400, "GRAPHQL_PARSE_FAILED", "graphql error", error instanceof Error ? error.message : "a bad request");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake Linear has no TCP address");
  base = `http://127.0.0.1:${String(address.port)}`;

  const imageMarkdown = (): string => `\n\n![screenshot.png](${base}/uploads/${randomUUID()}/screenshot.png)`;

  /** Waits for the webhooks a change sent, so a test sees them arrive in order. */
  const settle = async (): Promise<void> => {
    await Promise.allSettled([...pending]);
  };

  return {
    apiUrl: `${base}/graphql`,
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    revokeUrl: `${base}/oauth/revoke`,
    clock,
    organization,
    admin,
    adminApiKey,
    team,
    addTeam,
    states: (teamId) => states.filter((state) => state.teamId === teamId).sort((a, b) => a.position - b.position),
    createApp: (input) => {
      app = {
        clientId: randomBytes(16).toString("hex"),
        clientSecret: randomBytes(24).toString("hex"),
        webhookSecret: `lin_wh_${randomBytes(24).toString("hex")}`,
        name: input.name,
        redirectUris: [...input.redirectUris],
        webhookUrl: input.webhookUrl,
      };
      return { clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret };
    },
    appUser: () => appUser,
    setClientCredentialsEnabled: (enabled) => {
      clientCredentials = enabled;
    },
    mintToken: (kind) =>
      kind === "app" ? issueToken(ensureAppUser().id, true, ["read", "write", "issues:create", "comments:create"]) : issueToken(admin.id, false, ["read", "write"]),
    expireAccessTokens: () => {
      for (const [key, token] of tokens) {
        if (token.via === "oauth") tokens.set(key, { ...token, expiresAt: clock.now() });
      }
    },
    setGithubIntegration: (installed) => {
      githubIntegration = installed;
    },
    createIssue: async (input) => {
      const issue = makeIssue({
        teamId: input.teamId ?? team.id,
        title: input.title,
        description: input.withImage === true ? `${input.description ?? ""}${imageMarkdown()}` : (input.description ?? null),
        creatorId: admin.id,
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      });
      issue.labels = [...(input.labels ?? [])];
      for (const [index, body] of (input.comments ?? []).entries()) {
        comments.push({ id: `comment-${randomUUID()}`, issueId: issue.id, body, userId: admin.id, parentId: null, createdAt: issue.createdAt + index, updatedAt: issue.createdAt + index });
      }
      send(issue, "Issue", "create", admin.id);
      await settle();
      return { id: issue.id, identifier: issue.identifier };
    },
    editIssue: async (id, change) => {
      const issue = issueOf(id);
      if (change.title !== undefined) issue.title = change.title;
      if (change.description !== undefined) issue.description = change.description;
      touch(issue);
      send(issue, "Issue", "update", admin.id);
      await settle();
    },
    moveIssue: async (id, teamId) => {
      const issue = issueOf(id);
      moveTo(issue, teamId);
      touch(issue);
      send(issue, "Issue", "update", admin.id);
      await settle();
      return issue.identifier;
    },
    addComment: async (issueId, body) => {
      const issue = issueOf(issueId);
      const comment = { id: `comment-${randomUUID()}`, issueId: issue.id, body, userId: admin.id, parentId: null, createdAt: clock.now(), updatedAt: clock.now() };
      comments.push(comment);
      touch(issue);
      send(issue, "Comment", "create", admin.id, comment);
      await settle();
      return comment.id;
    },
    issueView: (id) => {
      const issue = issueOf(id);
      return {
        identifier: issue.identifier,
        stateId: issue.stateId,
        comments: comments.filter((comment) => comment.issueId === issue.id).map((comment) => ({ id: comment.id, body: comment.body, userId: comment.userId })),
        attachments: attachments.filter((attachment) => attachment.issueId === issue.id).map((attachment) => ({ id: attachment.id, url: attachment.url })),
      };
    },
    signedDelivery: (input) => {
      const issue = issueOf(input.issueId);
      const secret = input.secret ?? app?.webhookSecret;
      if (secret === undefined) throw new Error("the fake Linear has no app, and no secret was given");
      const type = input.type ?? "Issue";
      return signed(secret, type, payloadFor({ issue, type, action: input.action ?? "update", byUserId: input.byUserId, sentAt: input.sentAt, webhookId: "manual" }));
    },
    deliveries: () => deliveries.map((record) => ({ ...record, attempts: [...record.attempts] })),
    webhooks: () => webhooks.map((hook) => ({ id: hook.id, url: hook.url, teamId: hook.teamId })),
    setWebhooksPaused: (paused) => {
      webhooksPaused = paused;
    },
    injectFaults: (list) => {
      faults.push(...list);
    },
    apiCalls: () => Object.fromEntries(calls),
    close: async () => {
      lifetime.abort();
      await settle();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
};

/**
 * The tracker suite's fixture on a fake Linear, for ticket 07's Linear adapter: this workspace's
 * fake with a second team, and an adapter on another workspace. The adapter under test must be
 * built with `fake.apiUrl` and a token of `fake` (an app token makes `ownUserId` the app user).
 */
export const fakeLinearSuiteFixture = (input: {
  readonly fake: FakeLinear;
  readonly other: TrackerAdapter;
  readonly ownUserId: string | null;
  readonly webhookSecret: string;
}): TrackerSuiteFixture => {
  const { fake } = input;
  const otherTeam = fake.addTeam("OPS", "Operations");
  const states = fake.states(fake.team.id);
  const stateId = (name: string): string => {
    const state = states.find((candidate) => candidate.name === name);
    if (state === undefined) throw new Error(`the fake Linear has no state ${name}`);
    return state.id;
  };
  const seeded = (issue: { readonly id: ExternalTicketId; readonly identifier: TicketKey }): SeededTicket => ({ externalId: issue.id, key: issue.identifier });
  return {
    board: { externalId: fake.team.id },
    boardKey: fake.team.key,
    otherBoard: { externalId: otherTeam.id },
    mapping: { started: stateId("In Progress"), inReview: stateId("In Review"), done: stateId("Done") },
    other: input.other,
    webhookSecret: input.webhookSecret,
    ownUserId: input.ownUserId,
    integrationInstalled: false,
    now: () => fake.clock.now(),
    advance: (ms) => {
      fake.clock.advance(ms);
      return Promise.resolve();
    },
    seedTicket: async (ticket) =>
      seeded(
        await fake.createIssue({
          title: ticket.title,
          ...(ticket.description === undefined ? {} : { description: ticket.description }),
          ...(ticket.labels === undefined ? {} : { labels: ticket.labels }),
          ...(ticket.comments === undefined ? {} : { comments: ticket.comments }),
          ...(ticket.withImage === undefined ? {} : { withImage: ticket.withImage }),
        }),
      ),
    editTicket: (externalId, title) => fake.editIssue(externalId, { title }),
    moveToOtherBoard: (externalId) => fake.moveIssue(externalId, otherTeam.id),
    signedDelivery: (delivery) =>
      Promise.resolve(
        fake.signedDelivery({
          issueId: delivery.ticket.externalId,
          byUserId: delivery.byOwnUser ? (input.ownUserId ?? fake.admin.id) : fake.admin.id,
          sentAt: delivery.sentAt,
          secret: input.webhookSecret,
        }),
      ),
    rateLimitNext: (retryAfterSeconds) => {
      fake.injectFaults([{ kind: "rate-limited", retryAfterSeconds }]);
      return Promise.resolve();
    },
  };
};
