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
import type { SeededTicket, SessionDelivery, TrackerFilesHooks, TrackerMilestone6Hooks, TrackerSessionFixture, TrackerSuiteFixture } from "../tracker-suite.ts";
import { readOperation } from "./graphql-lite.ts";
import type { GraphqlValue, TopLevelField } from "./graphql-lite.ts";

// A local stand-in for Linear's plain API (spec section 8), ported from
// spikes/linear-agent-mode/src/fake-linear/ and widened from agent mode to what milestone 2 uses:
// teams, workflow states, issues, comments with threads, attachments, integrations, `viewer` and
// `organization`, webhooks, the new-app form a manifest link opens (milestone 2's ticket 33: it
// registers the app at once), the OAuth endpoints with PKCE and rotating refresh tokens, signed
// deliveries with Linear's headers and retry schedule, and 429 with `Retry-After`.
//
// It's built from Linear's docs (context/research/trackers.md) and answers every field it knows,
// whatever the selection set asked: an adapter reads Linear's answers loosely, so the extra fields
// cost nothing, and the fake needn't parse selections. Where the docs don't say, the fake assumes,
// and says so where it does:
// - `orderBy: updatedAt` answers the most recently updated first ("To get most recently updated
//   resources, you can alternatively order by updatedAt", linear.app/developers/pagination).
// - `sort: [{ updatedAt: { order: Ascending } }]` answers oldest first. Both orders were checked
//   against ostra-test on 2026-11-19 (ticket 07's live suite pages with the ascending one).
// - An issue looked up by an identifier it had before it moved team is not found. Unverified.
// - A webhook retry is stamped afresh (the spike's assumption, research/spike-linear-agent-mode.md).
// - `users(filter: { email: { in } })` compares emails exactly, and leaves out deactivated users
//   unless `includeDisabled` is true (the schema's default). A comment mentions a user when its
//   markdown links the user's profile URL (github.com/linear/linear/issues/351); ticket 10's live
//   case checks that against ostra-test.
//
// Milestone 6 (ticket 02) adds agent sessions, ported from spike 5's fake (its `rules.ts`, the
// activity record): a delegation (`delegateId`) or a mention of the app makes a session and an
// `AgentSessionEvent` `created`; a reply in the session's thread is `prompted`; a stop is
// `prompted` with `signal: "stop"`; activities are recorded with their kind and ephemeral flag;
// a session goes stale after 30 minutes without an activity and recovers on the next; and a
// personal key's `agentActivityCreate` gets the 403 spike 5's real run saw. Its assumptions, as
// the spike's were: a repeated client-made activity ID is the same activity; a delegation needs
// `app:assignable` and a mention `app:mentionable` on the install; and re-consenting without
// `update_scopes_on_existing_token=true` keeps the install's scopes.

export type FakeLinearPerson = { readonly id: string; readonly name: string; readonly email: string };

/** A person added with `addUser` (milestone 3, F-036): their profile URL is the markdown mention. */
export type FakeLinearUser = FakeLinearPerson & {
  readonly displayName: string;
  /** `https://linear.app/<workspace>/profiles/<displayName>`, Linear's `User.url`. */
  readonly url: string;
};

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
  /** Milestone 6 (F-011): the Linear project the issue is in, if any. */
  project: { readonly id: string; readonly name: string } | null;
  readonly creatorId: string;
  readonly createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Milestone 6: who the issue is delegated to (Linear's `delegate`): the app's user starts a session. */
  delegateId: string | null;
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

/** Linear's rules for a session (spike 5's `rules.ts`): a session silent this long goes stale. */
export const LINEAR_SESSION_RULES = { staleAfterMs: 30 * 60 * 1000 } as const;

/** A session's status, as Linear derives it from its last activity (spike 5's `rules.ts`). */
export type FakeLinearSessionStatus = "pending" | "active" | "awaitingInput" | "complete" | "error" | "stale" | "stopping";

type TouchType = "thought" | "action" | "elicitation" | "response" | "error" | "prompt" | "update";

/** An activity in a session, as the fake records it: ostra's, or a person's prompt. */
export type FakeLinearActivity = {
  readonly id: string;
  readonly type: Exclude<TouchType, "update">;
  readonly signal: string | null;
  readonly ephemeral: boolean;
  /** The text; `null` for an action. */
  readonly body: string | null;
  /** The person who wrote a prompt; `null` for the app's own activities. */
  readonly userId: string | null;
  /** On the fake's clock. */
  readonly at: number;
};

export type FakeLinearSessionView = {
  readonly id: string;
  readonly issueId: ExternalTicketId;
  readonly creatorId: string;
  /** The mention's comment, for a session a mention started. */
  readonly commentId: string | null;
  /** The comment the session's thread hangs from: a reply to it is a follow-up. */
  readonly threadId: string;
  readonly status: FakeLinearSessionStatus;
  readonly activities: readonly FakeLinearActivity[];
  readonly externalUrls: readonly { readonly label: string; readonly url: string }[];
  /** Times an activity came after more than 30 minutes of silence while the session was working. */
  readonly staleEpisodes: number;
};

/** An `AgentSessionEvent` the fake made: sent to the app's URL when it has one, and kept here either way. */
export type FakeLinearSessionEvent = {
  readonly sessionId: string;
  readonly action: "created" | "prompted";
  /** The JSON body, as `verifyWebhook` hands it on. */
  readonly body: unknown;
};

const baseSessionStatus = (last: { readonly type: TouchType; readonly signal: string | null } | undefined): FakeLinearSessionStatus => {
  if (last === undefined) return "pending";
  switch (last.type) {
    case "thought":
    case "action":
    case "update":
      return "active";
    case "elicitation":
      return "awaitingInput";
    case "response":
      return last.signal === "continue" ? "active" : "complete";
    case "error":
      return "error";
    case "prompt":
      // Spike 5's guess: a follow-up leaves the session waiting for the agent until it answers.
      return last.signal === "stop" ? "stopping" : "pending";
    default:
      return last.type satisfies never;
  }
};

/** Spike 5's guess: only a session the agent should be working on goes stale. */
const goesStale = (status: FakeLinearSessionStatus): boolean => status === "active" || status === "pending";

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
  /**
   * The new-app form a manifest link opens (`/settings/api/applications/new?manifest=…`): the fake
   * registers the app from the manifest at once, as an admin pressing Create does, and its page
   * shows the client ID, the client secret and the webhook signing secret to copy back.
   */
  readonly newAppUrl: string;
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
  /** Milestone 6: the install's scopes, once the app is installed (`actor=app`); `null` before. */
  readonly installScopes: () => readonly string[] | null;
  /** Milestone 6: every consent asked for, with its scopes and whether it updates the install's. */
  readonly authorizations: () => readonly { readonly actor: string | null; readonly scopes: readonly string[]; readonly updateScopes: boolean }[];
  /** Milestone 6: a person delegates the issue to the app, as picking it in "Delegate" does. */
  readonly delegateToApp: (issueId: ExternalTicketId, byUserId?: string) => Promise<{ readonly sessionId: string }>;
  /** Milestone 6: a person mentions the app in a comment on the issue. */
  readonly mentionApp: (issueId: ExternalTicketId, body: string, byUserId?: string) => Promise<{ readonly sessionId: string; readonly commentId: string }>;
  /** Milestone 6: a person replies in the session's thread, or presses "Send stop request" (`stop`). */
  readonly promptSession: (sessionId: string, body: string, options?: { readonly stop?: boolean; readonly byUserId?: string }) => Promise<void>;
  readonly session: (sessionId: string) => FakeLinearSessionView | undefined;
  /** Every `AgentSessionEvent` made so far, oldest first. */
  readonly sessionEvents: () => readonly FakeLinearSessionEvent[];
  /** Whether the client-credentials grant answers (off by default, as on `ostra-test`). */
  readonly setClientCredentialsEnabled: (enabled: boolean) => void;
  /**
   * A token without the consent flow, for tests of a saved token. An app token's scopes default
   * to milestone 2's set; the first app token sets the install's scopes.
   */
  readonly mintToken: (kind: "app" | "person", scopes?: readonly string[]) => { readonly accessToken: string; readonly refreshToken: string };
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
    /** Milestone 6 (F-011): the Linear project it's in. */
    readonly project?: { readonly id: string; readonly name: string };
  }) => Promise<{ readonly id: ExternalTicketId; readonly identifier: TicketKey }>;
  readonly editIssue: (id: ExternalTicketId, change: { readonly title?: string; readonly description?: string }) => Promise<void>;
  /** A person moves the issue to another team: its identifier changes. */
  readonly moveIssue: (id: ExternalTicketId, teamId: string) => Promise<TicketKey>;
  /** A person comments (the admin, unless `byUserId` names another). */
  readonly addComment: (issueId: ExternalTicketId, body: string, byUserId?: string) => Promise<string>;
  /**
   * Milestone 9 (F-149): a person uploads a file, as dropping it into Linear's editor does: its URL
   * on the fake's file host, which a token fetches. A ticket shows it once its text links it, or
   * once it's attached.
   */
  readonly upload: (file: { readonly name: string; readonly contentType: string; readonly bytes: Uint8Array }) => string;
  /** Milestone 9: an upload whose body never ends and declares no length. */
  readonly uploadEndless: () => string;
  /** Milestone 9: the next download of this upload answers HTTP 500, once: a download that fails on demand. */
  readonly failNextDownload: (url: string) => void;
  /** Milestone 9: a person attaches a URL to the issue: an upload's (a file), or anything else (a link). */
  readonly attachToIssue: (issueId: ExternalTicketId, input: { readonly url: string; readonly title: string; readonly subtitle?: string | null }) => Promise<string>;
  /** Milestone 3: adds a person to the workspace, active unless `active` is false. */
  readonly addUser: (input: { readonly name: string; readonly email: string; readonly displayName?: string; readonly active?: boolean }) => FakeLinearUser;
  /** Deactivates (or reactivates) a person, as an admin suspending them does. */
  readonly setUserActive: (userId: string, active: boolean) => void;
  readonly issueView: (id: ExternalTicketId) => {
    readonly identifier: TicketKey;
    readonly stateId: string;
    /** `mentions`: the IDs of the users the comment's markdown mentions, as Linear reads it. */
    readonly comments: readonly { readonly id: string; readonly body: string; readonly userId: string; readonly mentions: readonly string[] }[];
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

/** Where Linear's new-app form is, on linear.app and here. */
const NEW_APP_PATH = "/settings/api/applications/new";

/** What the fake reads of an OAuth app manifest (linear.app/developers/oauth-app-manifests), loosely. */
const newAppManifestSchema = z.looseObject({
  oauth: z.looseObject({ client_name: z.string().min(1), redirect_uris: z.array(z.string().min(1)).min(1) }),
  webhook: z.looseObject({ url: z.string().min(1), enabled: z.boolean().optional() }).optional(),
});

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

export const createFakeLinear = async (options: FakeLinearOptions = {}): Promise<FakeLinear> => {
  const clock = options.clock ?? manualClock();
  const retryDelaysMs = options.retryDelaysMs ?? [];
  const accessTokenSeconds = options.accessTokenSeconds ?? 86_399;
  const lifetime = new AbortController();

  const organization = { id: `org-${randomUUID()}`, name: "ostra-test", urlKey: options.urlKey ?? "ostra-test" };
  const admin: FakeLinearPerson = { id: `user-${randomUUID()}`, name: "Test Admin", email: "admin@example.test" };
  const adminApiKey = `lin_api_${randomBytes(20).toString("hex")}`;
  const people = new Map<string, FakeLinearPerson>([[admin.id, admin]]);
  /** Each person's display name and whether they're active; a person without a row is active, named by `name`. */
  const profiles = new Map<string, { displayName: string; active: boolean }>();

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
  const codes = new Map<string, { readonly redirectUri: string; readonly challenge: string; readonly actor: string | null; readonly scopes: readonly string[]; readonly updateScopes: boolean }>();
  const consents: { readonly actor: string | null; readonly scopes: readonly string[]; readonly updateScopes: boolean }[] = [];
  let installScopes: readonly string[] | null = null;
  type Session = {
    readonly id: string;
    readonly issueId: ExternalTicketId;
    readonly appUserId: string;
    readonly creatorId: string;
    readonly commentId: string | null;
    readonly threadId: string;
    readonly createdAt: number;
    readonly activities: FakeLinearActivity[];
    externalUrls: { label: string; url: string }[];
    lastTouch: { readonly type: TouchType; readonly signal: string | null } | undefined;
    lastTouchAt: number;
    staleEpisodes: number;
    /** Client-made activity IDs already used, each with the activity it made. */
    readonly activityIds: Map<string, string>;
  };
  const sessions = new Map<string, Session>();
  const sessionEvents: FakeLinearSessionEvent[] = [];
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
  /**
   * Milestone 6: files put through `fileUpload`'s signed URL, by their asset path; milestone 9: a
   * person's uploads, and one whose body never ends.
   */
  const uploads = new Map<string, { readonly contentType: string; readonly size: number; bytes: Uint8Array | null; readonly endless?: boolean }>();
  /** Milestone 9: uploads whose next download fails, by their asset path. */
  const failingDownloads = new Set<string>();

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

  const profileOf = (person: FakeLinearPerson) => profiles.get(person.id) ?? { displayName: person.name, active: true };
  const profileUrl = (person: FakeLinearPerson): string => `https://linear.app/${organization.urlKey}/profiles/${encodeURIComponent(profileOf(person).displayName)}`;
  const userJson = (id: string) => {
    const person = people.get(id);
    if (person === undefined) return null;
    const profile = profileOf(person);
    return { id: person.id, name: person.name, displayName: profile.displayName, email: person.email, url: profileUrl(person), active: profile.active };
  };
  /** The users a comment's markdown mentions: a link to their profile URL. */
  const mentionsIn = (body: string): string[] =>
    [...people.values()].filter((person) => body.includes(`](${profileUrl(person)})`)).map((person) => person.id);
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
      project: issue.project === null ? null : { id: issue.project.id, name: issue.project.name },
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
    for (const target of targets(issue, type)) {
      deliver(target, type, action, (now) => payloadFor({ issue, type, action, byUserId, sentAt: now, webhookId: target.id, ...(comment === undefined ? {} : { comment }) }));
    }
  };

  /** Sends one delivery to one endpoint, with Linear's retries. */
  const deliver = (target: { readonly id: string; readonly url: string; readonly secret: string }, type: string, action: string, payloadAt: (now: number) => unknown): void => {
    if (webhooksPaused) return;
    {
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
          const request = signed(target.secret, type, payloadAt(now));
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

  // ---------- agent sessions (milestone 6, ported from spike 5) ----------

  const personJson = (id: string) => {
    const user = userJson(id);
    return user === null ? null : { id: user.id, name: user.name, email: user.email, url: user.url };
  };

  const sessionStatus = (session: Session): FakeLinearSessionStatus => {
    const base = baseSessionStatus(session.lastTouch);
    return goesStale(base) && clock.now() - session.lastTouchAt > LINEAR_SESSION_RULES.staleAfterMs ? "stale" : base;
  };

  const touchSession = (session: Session, type: TouchType, signal: string | null, ephemeral: boolean, body: string | null, userId: string | null): string => {
    const now = clock.now();
    if (goesStale(baseSessionStatus(session.lastTouch)) && now - session.lastTouchAt > LINEAR_SESSION_RULES.staleAfterMs) {
      session.staleEpisodes += 1;
    }
    session.lastTouch = { type, signal };
    session.lastTouchAt = now;
    const id = `activity-${randomUUID()}`;
    if (type !== "update") {
      session.activities.push({ id, type, signal, ephemeral, body, userId, at: now });
    }
    return id;
  };

  const sessionJson = (session: Session) => {
    const issue = issueOf(session.issueId);
    const comment = session.commentId === null ? undefined : comments.find((candidate) => candidate.id === session.commentId);
    return {
      __typename: "AgentSession",
      id: session.id,
      appUserId: session.appUserId,
      organizationId: organization.id,
      issueId: issue.id,
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title, url: issueUrl(issue), teamId: issue.teamId, team: teamJson(teamOf(issue.teamId)) },
      commentId: session.commentId,
      comment: comment === undefined ? null : { id: comment.id, body: comment.body },
      creatorId: session.creatorId,
      creator: personJson(session.creatorId),
      status: sessionStatus(session),
      type: "commentThread",
      url: `${issueUrl(issue)}#agent-session-${session.id}`,
      externalUrls: session.externalUrls,
      createdAt: iso(session.createdAt),
      updatedAt: iso(session.lastTouchAt),
      activities: connection(
        session.activities.map((activity) => ({
          id: activity.id,
          content: activity.type === "action" ? { type: "action", action: activity.body ?? "", parameter: "" } : { type: activity.type, body: activity.body ?? "" },
          signal: activity.signal,
          ephemeral: activity.ephemeral,
          createdAt: iso(activity.at),
          user: activity.userId === null ? null : personJson(activity.userId),
        })),
      ),
    };
  };

  const sessionEvent = (session: Session, action: "created" | "prompted", now: number, prompt?: { readonly activityId: string; readonly body: string; readonly stop: boolean; readonly userId: string; readonly commentId: string | null }) => {
    const issue = issueOf(session.issueId);
    const common = {
      type: "AgentSessionEvent",
      action,
      organizationId: organization.id,
      appUserId: session.appUserId,
      oauthClientId: app?.clientId ?? null,
      webhookId: `app-${app?.clientId ?? "none"}`,
      webhookTimestamp: now,
      createdAt: iso(now),
      agentSession: sessionJson(session),
    };
    if (prompt === undefined) {
      return {
        ...common,
        promptContext: `<issue identifier="${issue.identifier}"><title>${issue.title}</title></issue>`,
        guidance: [],
      };
    }
    return {
      ...common,
      agentActivity: {
        id: prompt.activityId,
        agentSessionId: session.id,
        content: { type: "prompt", body: prompt.body },
        ...(prompt.stop ? { signal: "stop" } : {}),
        sourceCommentId: prompt.commentId,
        createdAt: iso(now),
        updatedAt: iso(now),
        user: personJson(prompt.userId),
        userId: prompt.userId,
      },
    };
  };

  /** Records an `AgentSessionEvent`, and sends it to the app's URL when it has one. */
  const emitSessionEvent = (session: Session, action: "created" | "prompted", prompt?: Parameters<typeof sessionEvent>[3]): void => {
    sessionEvents.push({ sessionId: session.id, action, body: sessionEvent(session, action, clock.now(), prompt) });
    if (app?.webhookUrl === null || app?.webhookUrl === undefined) return;
    deliver({ id: `app-${app.clientId}`, url: app.webhookUrl, secret: app.webhookSecret }, "AgentSessionEvent", action, (now) => sessionEvent(session, action, now, prompt));
  };

  const startSession = (issue: Issue, creatorId: string, commentId: string | null): Session => {
    const owner = appUser;
    if (owner === undefined) throw invalid("No app is installed");
    const now = clock.now();
    const session: Session = {
      id: `session-${randomUUID()}`,
      issueId: issue.id,
      appUserId: owner.id,
      creatorId,
      commentId,
      threadId: commentId ?? `thread-${randomUUID()}`,
      createdAt: now,
      activities: [],
      externalUrls: [],
      lastTouch: undefined,
      lastTouchAt: now,
      staleEpisodes: 0,
      activityIds: new Map(),
    };
    sessions.set(session.id, session);
    emitSessionEvent(session, "created");
    return session;
  };

  /** A delegation to the app's user starts a session; it needs `app:assignable` on the install. */
  const delegate = (issue: Issue, delegateId: string | null, byUserId: string): void => {
    if (delegateId === issue.delegateId) return;
    if (delegateId !== null && delegateId === appUser?.id && !(installScopes ?? []).includes("app:assignable")) {
      throw invalid("The app can't be delegated issues: it lacks app:assignable");
    }
    issue.delegateId = delegateId;
    if (delegateId !== null && delegateId === appUser?.id) {
      startSession(issue, byUserId, null);
    }
  };

  /** A person's comment: a mention of the app starts a session, a reply in a session's thread is a follow-up. */
  const onPersonComment = (comment: Comment): void => {
    const session = comment.parentId === null ? undefined : [...sessions.values()].find((candidate) => candidate.threadId === comment.parentId);
    if (session !== undefined) {
      const activityId = touchSession(session, "prompt", null, false, comment.body, comment.userId);
      emitSessionEvent(session, "prompted", { activityId, body: comment.body, stop: false, userId: comment.userId, commentId: comment.id });
      return;
    }
    if (appUser !== undefined && comment.body.includes(`](${profileUrl(appUser)})`) && (installScopes ?? []).includes("app:mentionable")) {
      startSession(issueOf(comment.issueId), comment.userId, comment.id);
    }
  };

  const activityContentSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("thought"), body: z.string().min(1).max(250_000) }),
    z.object({ type: z.literal("response"), body: z.string().min(1).max(250_000) }),
    z.object({ type: z.literal("error"), body: z.string().min(1).max(250_000) }),
    z.object({ type: z.literal("elicitation"), body: z.string().min(1).max(250_000) }),
    z.object({ type: z.literal("action"), action: z.string().min(1), parameter: z.string(), result: z.string().max(250_000).optional() }),
  ]);

  const createActivity = (principal: Token, input: Readonly<Record<string, GraphqlValue>>) => {
    const session = sessions.get(stringArg(input["agentSessionId"]) ?? "");
    if (session === undefined) throw invalid("Entity not found: AgentSession");
    // Spike 5's real run: a personal API key can't post an agent activity.
    if (principal.via === "apiKey") {
      throw new FakeAnswer(403, "FORBIDDEN", "forbidden", "Using an unexpected authentication method (apiKey) for an operation");
    }
    if (!principal.app || principal.userId !== session.appUserId) {
      throw new FakeAnswer(403, "FORBIDDEN", "forbidden", "An app cannot publish activities to another agent's session");
    }
    const content = activityContentSchema.safeParse(input["content"]);
    if (!content.success) throw invalid("Invalid activity content");
    const type = content.data.type;
    const signal = stringArg(input["signal"]) ?? null;
    const ephemeral = input["ephemeral"] === true;
    if (signal === "stop") throw invalid("stop is reserved for user prompts");
    if (ephemeral && type !== "thought" && type !== "action") throw invalid("only thoughts and actions can be ephemeral");
    const clientId = stringArg(input["id"]);
    const repeated = clientId === undefined ? undefined : session.activityIds.get(clientId);
    if (repeated !== undefined) {
      return { success: true, agentActivity: { id: repeated } };
    }
    const id = touchSession(session, type, signal, ephemeral, "body" in content.data ? content.data.body : content.data.action, null);
    if (clientId !== undefined) session.activityIds.set(clientId, id);
    return { success: true, agentActivity: { id } };
  };

  const updateSession = (principal: Token, id: string, input: Readonly<Record<string, GraphqlValue>>) => {
    const session = sessions.get(id);
    if (session === undefined) throw invalid("Entity not found: AgentSession");
    if (!principal.app || principal.userId !== session.appUserId) {
      throw new FakeAnswer(403, "FORBIDDEN", "forbidden", "Only the owning app can update a session");
    }
    const urls = z.array(z.object({ label: z.string().min(1), url: z.url() })).safeParse(input["externalUrls"]);
    if (input["externalUrls"] !== undefined && !urls.success) throw invalid("Invalid AgentSessionUpdateInput");
    if (urls.success) session.externalUrls = urls.data.map(({ label, url }) => ({ label, url }));
    touchSession(session, "update", null, false, null, null);
    return { success: true, agentSession: { id: session.id } };
  };

  const sessionView = (session: Session): FakeLinearSessionView => ({
    id: session.id,
    issueId: session.issueId,
    creatorId: session.creatorId,
    commentId: session.commentId,
    threadId: session.threadId,
    status: sessionStatus(session),
    activities: [...session.activities],
    externalUrls: [...session.externalUrls],
    staleEpisodes: session.staleEpisodes,
  });

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

  /** Registers the app, as "Create" on a manifest does. One app per fake: a second replaces the first. */
  const registerApp = (input: { readonly name: string; readonly redirectUris: readonly string[]; readonly webhookUrl: string | null }): FakeLinearApp => {
    app = {
      clientId: randomBytes(16).toString("hex"),
      clientSecret: randomBytes(24).toString("hex"),
      webhookSecret: `lin_wh_${randomBytes(24).toString("hex")}`,
      name: input.name,
      redirectUris: [...input.redirectUris],
      webhookUrl: input.webhookUrl,
    };
    return { clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret };
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
      case "agentSession": {
        const found = sessions.get(stringArg(args["id"]) ?? "");
        if (found === undefined) throw notFound("AgentSession");
        return sessionJson(found);
      }
      case "user": {
        const found = userJson(stringArg(args["id"]) ?? "");
        if (found === null) throw notFound("User");
        return found;
      }
      case "comment": {
        const found = comments.find((comment) => comment.id === stringArg(args["id"]));
        if (found === undefined) throw notFound("Comment");
        return commentJson(found);
      }
      case "users": {
        const filter = objectArg(args["filter"]);
        const emailIn = listArg(nested(filter["email"], "in")).flatMap((value) => (typeof value === "string" ? [value] : []));
        const emailEq = stringArg(nested(filter["email"], "eq"));
        const activeEq = nested(filter["active"], "eq");
        const includeDisabled = args["includeDisabled"] === true;
        const list = [...people.values()].filter((person) => {
          const { active } = profileOf(person);
          if (!includeDisabled && !active) return false;
          if (typeof activeEq === "boolean" && active !== activeEq) return false;
          if ("email" in filter && emailIn.length === 0 && emailEq === undefined) return false;
          if (emailIn.length > 0 && !emailIn.includes(person.email)) return false;
          if (emailEq !== undefined && person.email !== emailEq) return false;
          return true;
        });
        return pageOf(list, args, (person) => userJson(person.id));
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
          ...(stringArg(input["parentId"]) === undefined ? {} : { parentId: issueOf(stringArg(input["parentId"]) ?? "").id }),
        });
        send(created, "Issue", "create", principal.userId);
        const delegateTo = stringArg(input["delegateId"]);
        if (delegateTo !== undefined) delegate(created, delegateTo, principal.userId);
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
        if ("delegateId" in input) delegate(issue, stringArg(input["delegateId"]) ?? null, principal.userId);
        return { success: true, issue: issueJson(issue) };
      }
      case "commentCreate": {
        const issue = issueOf(stringArg(input["issueId"]) ?? "");
        const body = stringArg(input["body"]);
        if (body === undefined || body === "") throw invalid("body is required");
        const parentId = stringArg(input["parentId"]) ?? null;
        const inThread = [...sessions.values()].some((session) => session.threadId === parentId && session.issueId === issue.id);
        if (parentId !== null && !inThread && !comments.some((comment) => comment.id === parentId && comment.issueId === issue.id)) throw notFound("Comment");
        const comment = { id: `comment-${randomUUID()}`, issueId: issue.id, body, userId: principal.userId, parentId, createdAt: clock.now(), updatedAt: clock.now() };
        comments.push(comment);
        touch(issue);
        send(issue, "Comment", "create", principal.userId, comment);
        if (!principal.app) onPersonComment(comment);
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
        // Unlike `attachmentCreate`, Linear refuses a second link of a URL the issue already has.
        const linkedIssue = issueOf(stringArg(args["issueId"]) ?? "");
        if (attachments.some((attachment) => attachment.issueId === linkedIssue.id && attachment.url === url)) {
          throw new FakeAnswer(400, "INPUT_ERROR", "invalid input", "Duplicate attachment for duplicate url");
        }
        return { success: true, attachment: attachmentJson(linkAttachment(stringArg(args["issueId"]) ?? "", url, "GitHub pull request", null)) };
      }
      case "fileUpload": {
        // Milestone 6 (ticket 07): Linear's upload: a signed URL to PUT the bytes to, with the
        // headers it must carry, and the asset URL the file is then read at
        // (linear.app/developers/how-to-upload-a-file-to-linear).
        const contentType = stringArg(args["contentType"]);
        const filename = stringArg(args["filename"]);
        const size = numberArg(args["size"]);
        if (contentType === undefined || filename === undefined || size === undefined || size < 0) throw invalid("contentType, filename and size are required");
        const id = randomUUID();
        const assetPath = `/uploads/${id}/${encodeURIComponent(filename)}`;
        uploads.set(assetPath, { contentType, size, bytes: null });
        return {
          success: true,
          uploadFile: {
            filename,
            contentType,
            size,
            uploadUrl: `${base}/upload-target${assetPath}`,
            assetUrl: `${base}${assetPath}`,
            headers: [{ key: "x-goog-meta-fake", value: id }],
          },
        };
      }
      case "agentActivityCreate":
        return createActivity(principal, input);
      case "agentSessionUpdate":
        return updateSession(principal, stringArg(args["id"]) ?? "", input);
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
      project: null,
      creatorId: input.creatorId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      delegateId: null,
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

  /**
   * The new-app form a manifest link opens. The admin presses Create at once: the app is registered
   * with the manifest's name, callbacks and webhook, and the page shows its three values.
   */
  const handleNewApp = (url: URL, response: ServerResponse): void => {
    countCall("new-app");
    let manifest: unknown;
    try {
      manifest = JSON.parse(url.searchParams.get("manifest") ?? "");
    } catch {
      manifest = undefined;
    }
    const parsed = newAppManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_manifest" });
      return;
    }
    const { oauth, webhook } = parsed.data;
    const made = registerApp({ name: oauth.client_name, redirectUris: oauth.redirect_uris, webhookUrl: webhook === undefined || webhook.enabled === false ? null : webhook.url });
    const row = (id: string, label: string, value: string): string => `<dt>${label}</dt><dd data-testid="${id}">${escapeHtml(value)}</dd>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(oauth.client_name)}</title></head><body><h1>${escapeHtml(oauth.client_name)}</h1><dl>` +
        row("client-id", "Client ID", made.clientId) +
        row("client-secret", "Client secret", made.clientSecret) +
        row("webhook-secret", "Webhook signing secret", made.webhookSecret) +
        row("callback-urls", "Callback URLs", oauth.redirect_uris.join(" ")) +
        row("webhook-url", "Webhook URL", webhook === undefined || webhook.enabled === false ? "" : webhook.url) +
        `</dl></body></html>`,
    );
  };

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
    const scopes = (params.get("scope") ?? "").split(/[\s,]+/).filter((scope) => scope !== "");
    const updateScopes = params.get("update_scopes_on_existing_token") === "true";
    consents.push({ actor: params.get("actor"), scopes, updateScopes });
    codes.set(code, { redirectUri, challenge, actor: params.get("actor"), scopes, updateScopes });
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
      let granted = code.scopes;
      if (asApp) {
        // An installed app keeps its scopes on a second consent, unless it asks to update them
        // (`update_scopes_on_existing_token=true`, with the full set): then every token of the
        // install gets the new set (research/trackers.md section 1).
        if (installScopes !== null && !code.updateScopes) {
          granted = installScopes;
        } else if (installScopes !== null) {
          for (const [key, token] of tokens) {
            if (token.app) tokens.set(key, { ...token, scopes: granted });
          }
          for (const record of refreshTokens.values()) {
            if (record.app) record.scopes = granted;
          }
        }
        installScopes = granted;
      }
      sendJson(response, 200, tokenAnswer(issueToken(user.id, asApp, granted), granted));
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
    const assetPath = new URL(request.url ?? "/", "http://fake-linear.invalid").pathname;
    if (failingDownloads.delete(assetPath)) {
      sendJson(response, 500, { error: "the file store failed" });
      return;
    }
    const uploaded = uploads.get(assetPath);
    if (uploaded?.endless === true) {
      // Chunked, with no length, until the client goes: only a reader that stops at its cap returns.
      response.writeHead(200, { "content-type": uploaded.contentType });
      const chunk = Buffer.alloc(64 * 1024, 7);
      const pump = (): void => {
        while (!response.destroyed && response.write(chunk)) {
          // The socket takes more: write on until it's full.
        }
        if (!response.destroyed) {
          response.once("drain", pump);
        }
      };
      pump();
      return;
    }
    if (uploaded?.bytes !== null && uploaded?.bytes !== undefined) {
      response.writeHead(200, { "content-type": uploaded.contentType, "content-length": String(uploaded.bytes.length) });
      response.end(Buffer.from(uploaded.bytes));
      return;
    }
    response.writeHead(200, { "content-type": "image/png", "content-length": String(PNG_BYTES.length) });
    response.end(Buffer.from(PNG_BYTES));
  };

  /**
   * Milestone 6: the signed upload URL (`fileUpload`'s `uploadUrl`): a PUT of exactly the declared
   * size, with the declared content type and the signed headers, and no Linear credential (it's a
   * storage bucket's URL, which the token must never reach).
   */
  const handleUploadTarget = async (request: IncomingMessage, response: ServerResponse, assetPath: string): Promise<void> => {
    countCall("upload-target");
    const target = uploads.get(assetPath);
    const bytes = await readBody(request);
    if (target?.bytes !== null) {
      sendJson(response, 404, { error: "no such upload" });
      return;
    }
    if (request.headers.authorization !== undefined) {
      sendJson(response, 400, { error: "a signed URL takes no Authorization header" });
      return;
    }
    const signedId = assetPath.split("/")[2] ?? "";
    if (request.headers["content-type"] !== target.contentType || request.headers["x-goog-meta-fake"] !== signedId || bytes.length !== target.size) {
      sendJson(response, 403, { error: "SignatureDoesNotMatch" });
      return;
    }
    target.bytes = new Uint8Array(bytes);
    response.writeHead(200);
    response.end();
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake-linear.invalid");
    const run = async (): Promise<void> => {
      if (request.method === "POST" && url.pathname === "/graphql") await handleGraphql(request, response);
      else if (request.method === "GET" && url.pathname === "/oauth/authorize") handleAuthorize(url, response);
      else if (request.method === "GET" && url.pathname === NEW_APP_PATH) handleNewApp(url, response);
      else if (request.method === "POST" && url.pathname === "/oauth/token") await handleToken(request, response);
      else if (request.method === "POST" && url.pathname === "/oauth/revoke") {
        countCall("oauth/revoke");
        const form = new URLSearchParams((await readBody(request)).toString("utf8"));
        tokens.delete(form.get("token") ?? "");
        refreshTokens.delete(form.get("token") ?? "");
        response.writeHead(200);
        response.end();
      } else if (request.method === "GET" && url.pathname.startsWith("/uploads/")) handleUpload(request, response);
      else if (request.method === "PUT" && url.pathname.startsWith("/upload-target/uploads/")) await handleUploadTarget(request, response, url.pathname.slice("/upload-target".length));
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
    newAppUrl: `${base}${NEW_APP_PATH}`,
    clock,
    organization,
    admin,
    adminApiKey,
    team,
    addTeam,
    states: (teamId) => states.filter((state) => state.teamId === teamId).sort((a, b) => a.position - b.position),
    createApp: registerApp,
    appUser: () => appUser,
    setClientCredentialsEnabled: (enabled) => {
      clientCredentials = enabled;
    },
    mintToken: (kind, scopes) => {
      if (kind === "person") return issueToken(admin.id, false, scopes ?? ["read", "write"]);
      const granted = scopes ?? ["read", "write", "issues:create", "comments:create"];
      installScopes ??= granted;
      return issueToken(ensureAppUser().id, true, granted);
    },
    installScopes: () => installScopes,
    authorizations: () => [...consents],
    delegateToApp: async (issueId, byUserId) => {
      const issue = issueOf(issueId);
      const owner = appUser;
      if (owner === undefined) throw new Error("the fake Linear has no app user: install first");
      const before = sessions.size;
      delegate(issue, owner.id, byUserId ?? admin.id);
      touch(issue);
      send(issue, "Issue", "update", byUserId ?? admin.id);
      await settle();
      const made = [...sessions.values()][before];
      if (made === undefined) throw new Error("the delegation made no session");
      return { sessionId: made.id };
    },
    mentionApp: async (issueId, body, byUserId) => {
      const issue = issueOf(issueId);
      const owner = appUser;
      if (owner === undefined) throw new Error("the fake Linear has no app user: install first");
      const before = sessions.size;
      const comment = { id: `comment-${randomUUID()}`, issueId: issue.id, body: `[@${owner.name}](${profileUrl(owner)}) ${body}`, userId: byUserId ?? admin.id, parentId: null, createdAt: clock.now(), updatedAt: clock.now() };
      comments.push(comment);
      touch(issue);
      send(issue, "Comment", "create", comment.userId, comment);
      onPersonComment(comment);
      await settle();
      const made = [...sessions.values()][before];
      if (made === undefined) throw new Error("the mention made no session: does the install have app:mentionable?");
      return { sessionId: made.id, commentId: comment.id };
    },
    promptSession: async (sessionId, body, promptOptions = {}) => {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new Error("the fake Linear has no such session");
      const userId = promptOptions.byUserId ?? admin.id;
      if (promptOptions.stop === true) {
        // "Send stop request" posts a prompt with the stop signal, not a comment.
        const activityId = touchSession(session, "prompt", "stop", false, body, userId);
        emitSessionEvent(session, "prompted", { activityId, body, stop: true, userId, commentId: null });
      } else {
        const issue = issueOf(session.issueId);
        const comment = { id: `comment-${randomUUID()}`, issueId: issue.id, body, userId, parentId: session.threadId, createdAt: clock.now(), updatedAt: clock.now() };
        comments.push(comment);
        touch(issue);
        send(issue, "Comment", "create", userId, comment);
        onPersonComment(comment);
      }
      await settle();
    },
    session: (sessionId) => {
      const found = sessions.get(sessionId);
      return found === undefined ? undefined : sessionView(found);
    },
    sessionEvents: () => [...sessionEvents],
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
      issue.project = input.project === undefined ? null : { id: input.project.id, name: input.project.name };
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
    addComment: async (issueId, body, byUserId) => {
      const issue = issueOf(issueId);
      const userId = byUserId ?? admin.id;
      const comment = { id: `comment-${randomUUID()}`, issueId: issue.id, body, userId, parentId: null, createdAt: clock.now(), updatedAt: clock.now() };
      comments.push(comment);
      touch(issue);
      send(issue, "Comment", "create", userId, comment);
      await settle();
      return comment.id;
    },
    upload: (file) => {
      const assetPath = `/uploads/${randomUUID()}/${encodeURIComponent(file.name)}`;
      uploads.set(assetPath, { contentType: file.contentType, size: file.bytes.length, bytes: new Uint8Array(file.bytes) });
      return `${base}${assetPath}`;
    },
    uploadEndless: () => {
      const assetPath = `/uploads/${randomUUID()}/endless.bin`;
      uploads.set(assetPath, { contentType: "application/octet-stream", size: 0, bytes: null, endless: true });
      return `${base}${assetPath}`;
    },
    failNextDownload: (url) => {
      failingDownloads.add(new URL(url).pathname);
    },
    attachToIssue: async (issueId, input) => {
      const issue = issueOf(issueId);
      const attachment = linkAttachment(issue.id, input.url, input.title, input.subtitle ?? null);
      send(issue, "Issue", "update", admin.id);
      await settle();
      return attachment.id;
    },
    addUser: (input) => {
      const person: FakeLinearPerson = { id: `user-${randomUUID()}`, name: input.name, email: input.email };
      people.set(person.id, person);
      const displayName = input.displayName ?? (input.email.split("@")[0] ?? input.name).replace(/[^A-Za-z0-9._-]/g, "");
      profiles.set(person.id, { displayName, active: input.active ?? true });
      return { ...person, displayName, url: profileUrl(person) };
    },
    setUserActive: (userId, active) => {
      const person = people.get(userId);
      if (person === undefined) throw new Error("the fake Linear has no such user");
      profiles.set(userId, { ...profileOf(person), active });
    },
    issueView: (id) => {
      const issue = issueOf(id);
      return {
        identifier: issue.identifier,
        stateId: issue.stateId,
        comments: comments
          .filter((comment) => comment.issueId === issue.id)
          .map((comment) => ({ id: comment.id, body: comment.body, userId: comment.userId, mentions: mentionsIn(comment.body) })),
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
  /**
   * Milestone 6: run the agent-session, people, sub-issue and draft cases too (ticket 07 turns
   * this on with Linear's implementation). The session hooks need the app installed.
   */
  readonly milestone6?: boolean;
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
    seedUser: (email) => {
      const user = fake.addUser({ name: `Seeded ${email.split("@")[0] ?? "user"}`, email });
      return Promise.resolve({ userId: user.id, mentionHolds: user.url });
    },
    ...(input.milestone6 === true ? { milestone6: milestone6Hooks(fake) } : {}),
    files: linearFilesHooks(fake),
  };
};

// ---------- milestone 9: a ticket's files, as people put them in Linear (F-149) ----------

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** A zip's first bytes: an Office file as far as the fake cares. */
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n%fake\n");

/**
 * The files cases' hooks on a fake Linear, as Linear's editor makes them: an upload dropped into a
 * description or a comment is markdown on the file host (`![name](url)` for an image, `[name](url)`
 * for anything else), and a file dropped on the issue is an attachment whose URL is the upload's.
 */
export const linearFilesHooks = (fake: FakeLinear): TrackerFilesHooks => ({
  seedTicketWithFiles: async () => {
    const mock = fake.upload({ name: "mock.png", contentType: "image/png", bytes: PNG_BYTES });
    const spec = fake.upload({ name: "spec.docx", contentType: DOCX_TYPE, bytes: ZIP_BYTES });
    const shot = fake.upload({ name: "broken.png", contentType: "image/png", bytes: PNG_BYTES });
    const design = fake.upload({ name: "design.pdf", contentType: "application/pdf", bytes: PDF_BYTES });
    const spareImage = fake.upload({ name: "progress.png", contentType: "image/png", bytes: PNG_BYTES });
    const created = await fake.createIssue({
      title: "With files",
      description: `Match the mock; the spec is attached. $(whoami)\n\n![mock.png](${mock})\n\n[spec.docx](${spec})`,
    });
    const commentId = await fake.addComment(created.id, `Here it breaks:\n\n![broken.png](${shot})`);
    await fake.attachToIssue(created.id, { url: design, title: "design.pdf" });
    const figma = "https://www.figma.com/file/0196f1a0/History?node-id=1-2";
    await fake.attachToIssue(created.id, { url: figma, title: "History panel (Figma)" });
    return {
      externalId: created.id,
      key: created.identifier,
      descriptionImage: mock,
      descriptionFile: spec,
      commentId,
      commentImage: shot,
      attachedFile: design,
      linkAttachment: figma,
      spareImage,
    };
  },
  followUpText: () => {
    const image = fake.upload({ name: "follow-up.png", contentType: "image/png", bytes: PNG_BYTES });
    const file = fake.upload({ name: "numbers.xlsx", contentType: XLSX_TYPE, bytes: ZIP_BYTES });
    const offHost = "https://files.example.test/uploads/0196f1a0/numbers.xlsx";
    return Promise.resolve({
      text: `Also look at these:\n\n![follow-up.png](${image})\n\n[numbers.xlsx](${file}) and [the old one](${offHost})`,
      image,
      file,
      offHost,
    });
  },
  seedFile: (size) => Promise.resolve(fake.upload({ name: "sized.bin", contentType: "application/octet-stream", bytes: new Uint8Array(size).fill(7) })),
  seedEndlessFile: () => Promise.resolve(fake.uploadEndless()),
});

const lastEvent = (fake: FakeLinear, sessionId: string): SessionDelivery => {
  const event = fake.sessionEvents().filter((one) => one.sessionId === sessionId).at(-1);
  if (event === undefined) throw new Error("the fake Linear sent no event for the session");
  return { sessionId, body: event.body };
};

/** The milestone 6 hooks on a fake Linear: people, and sessions once the app is installed. */
export const milestone6Hooks = (fake: FakeLinear): TrackerMilestone6Hooks => {
  const sessions: TrackerSessionFixture | undefined =
    fake.appUser() === undefined
      ? undefined
      : {
          person: { userId: fake.admin.id, name: fake.admin.name },
          delegate: async (ticket) => lastEvent(fake, (await fake.delegateToApp(ticket.externalId)).sessionId),
          mention: async (ticket, text) => {
            const made = await fake.mentionApp(ticket.externalId, text);
            return { ...lastEvent(fake, made.sessionId), commentId: made.commentId };
          },
          followUp: async (sessionId, text) => {
            await fake.promptSession(sessionId, text);
            return lastEvent(fake, sessionId);
          },
          stop: async (sessionId) => {
            await fake.promptSession(sessionId, "Stop", { stop: true });
            return lastEvent(fake, sessionId);
          },
          activities: (sessionId) =>
            Promise.resolve(
              (fake.session(sessionId)?.activities ?? []).flatMap((activity) =>
                activity.type === "prompt" ? [] : [{ kind: activity.type, body: activity.body, ephemeral: activity.ephemeral }],
              ),
            ),
          link: (sessionId) => Promise.resolve(fake.session(sessionId)?.externalUrls[0]?.url ?? null),
        };
  return {
    seedPerson: (person) => Promise.resolve({ userId: fake.addUser(person).id }),
    ...(sessions === undefined ? {} : { sessions }),
  };
};
