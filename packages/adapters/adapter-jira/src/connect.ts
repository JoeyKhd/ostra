import type { z } from "zod";

import { JIRA_GATEWAY_URL } from "./jira-adapter.ts";
import { accountSchema, myPermissionsSchema, projectPageSchema, serverInfoSchema, tenantInfoSchema, workflowSearchSchema } from "./schemas.ts";
import { JIRA_WEBHOOK_EVENTS, webhookJql } from "./webhooks.ts";

// Connecting a Jira Cloud site (spec section 5.3, ticket 04; jira-connect.md; ADR 0047): the calls
// the connect steps make before anything is saved. Step 1 finds the site's cloud ID from its public
// tenant info; step 2 reads back what the service account's scoped token is and reaches; step 3
// shows what to paste into Jira's admin webhook. Each call takes `{ apiUrl, fetch, timeoutMs }` and
// answers in this package's own words: the API's `services/jira-connect.ts` (ticket 09) turns them
// into the domain's `JiraConnectKit` (ticket 06), as `services/linear-app.ts` does for Linear.
//
// The token is held in one local for the calls and goes in one header, nowhere else: no answer,
// error or thrown message holds it. Jira's error bodies are never read (they can quote what the
// token sees), so an answer carries IDs, names, keys and status codes only.

export type JiraConnectOptions = {
  /**
   * `OSTRA_JIRA_API_URL`: the fake Jira in tests, which then stands for Atlassian's gateway and
   * every site (a site is named to it in `X-Forwarded-Host`). `null`: Jira's own, the gateway at
   * `api.atlassian.com` and each site at `https://<site>.atlassian.net`.
   */
  readonly apiUrl: string | null;
  readonly fetch: typeof fetch;
  /** Each call's own limit, in ms. */
  readonly timeoutMs: number;
};

/** The scopes the service account's scoped token needs (jira-connect.md, choice 5). */
export const JIRA_TOKEN_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "read:workflow:jira"] as const;
export type JiraTokenScope = (typeof JIRA_TOKEN_SCOPES)[number];

/** The project permissions the read-back checks: browse, create, edit, transition and comment. */
export const JIRA_CONNECT_PERMISSIONS = ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS"] as const;
export type JiraConnectPermission = (typeof JIRA_CONNECT_PERMISSIONS)[number];

// ---------- step 1: the site ----------

/**
 * What step 1 finds at a site name:
 * - `found`: a Jira Cloud site, with its cloud ID (calls go through the gateway with it), its host
 *   and a title made from its name (`globex` is `Globex`, for the connection's default name);
 * - `not-found`: no Jira Cloud site answers there (`host: null` when the input isn't a site at all);
 * - `data-center`: Jira Server or Data Center answers there, or the host isn't an `atlassian.net`
 *   one: ostra connects to Jira Cloud only (ADR 0047);
 * - `unreachable`: the site didn't answer in time, or answered with a failure.
 */
export type JiraSiteLookup =
  | { readonly kind: "found"; readonly cloudId: string; readonly host: string; readonly title: string }
  | { readonly kind: "not-found"; readonly host: string | null }
  | { readonly kind: "data-center"; readonly host: string }
  | { readonly kind: "unreachable"; readonly host: string };

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CLOUD_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;

/**
 * The host a site name names: `globex` is `globex.atlassian.net`; a host or a pasted URL is read
 * for its host. `null` when it names no host.
 */
export const jiraSiteHost = (input: string): string | null => {
  const text = input.trim().toLowerCase();
  if (text === "") return null;
  let host: string;
  if (text.includes("/") || text.includes(":")) {
    const url = URL.canParse(text) && /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? new URL(text) : URL.canParse(`https://${text}`) ? new URL(`https://${text}`) : null;
    if (url?.username !== "" || url.password !== "") return null;
    host = url.hostname;
  } else {
    host = text.includes(".") ? text : `${text}.atlassian.net`;
  }
  host = host.replace(/\.$/, "");
  const labels = host.split(".");
  return host.length <= 253 && labels.length >= 2 && labels.every((label) => HOST_LABEL.test(label)) ? host : null;
};

/** Whether the host is a Jira Cloud site's own (`<name>.atlassian.net`). */
export const isJiraCloudHost = (host: string): boolean => CLOUD_HOST.test(host);

/** A title from the site's name, for the connection's default name: `acme-corp` is `Acme Corp`. */
const siteTitle = (host: string): string =>
  (host.split(".")[0] ?? host)
    .split("-")
    .filter((word) => word !== "")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");

type Answer = { readonly kind: "answered"; readonly status: number; readonly body: unknown } | { readonly kind: "unreachable" };

/**
 * One request. A body is read only from a success; a failure's body, which Jira may fill with
 * what the credential sees, is dropped unread. No redirect is followed.
 */
const send = async (options: JiraConnectOptions, url: URL, headers: Readonly<Record<string, string>>): Promise<Answer> => {
  let response: Response;
  try {
    response = await options.fetch(url, { headers: { accept: "application/json", "user-agent": "ostra-jira-adapter", ...headers }, redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs) });
  } catch {
    return { kind: "unreachable" };
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing to free.
    }
    return { kind: "answered", status: response.status, body: undefined };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { kind: "answered", status: response.status, body };
};

/** Jira failing, or asking to wait: the call can be tried again later. */
const isFailing = (status: number): boolean => status >= 500 || status === 429;

/**
 * Step 1: the site behind a name, from its public tenant info (`/_edge/tenant_info`), which needs
 * no credential. Without `apiUrl`, a host that isn't `<name>.atlassian.net` is `data-center`
 * without a call: ostra asks no other host. A site without tenant info is asked its server info,
 * which names Jira Server and Data Center.
 */
const findSite = async (options: JiraConnectOptions, siteName: string): Promise<JiraSiteLookup> => {
  const host = jiraSiteHost(siteName);
  if (host === null) {
    return { kind: "not-found", host: null };
  }
  if (options.apiUrl === null && !isJiraCloudHost(host)) {
    return { kind: "data-center", host };
  }
  const base = options.apiUrl === null ? `https://${host}` : options.apiUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = options.apiUrl === null ? {} : { "x-forwarded-host": host };
  const tenant = await send(options, new URL(`${base}/_edge/tenant_info`), headers);
  if (tenant.kind === "unreachable" || isFailing(tenant.status)) {
    return { kind: "unreachable", host };
  }
  const found = tenantInfoSchema.safeParse(tenant.body);
  if (tenant.status === 200 && found.success) {
    return { kind: "found", cloudId: found.data.cloudId, host, title: siteTitle(host) };
  }
  const info = await send(options, new URL(`${base}/rest/api/2/serverInfo`), headers);
  const deployment = info.kind === "answered" && info.status === 200 ? serverInfoSchema.safeParse(info.body).data?.deploymentType : undefined;
  return deployment === "Server" || deployment === "DataCenter" ? { kind: "data-center", host } : { kind: "not-found", host };
};

// ---------- step 2: the token's read-back ----------

export type JiraTokenInput = {
  /** The site's cloud ID, from step 1. */
  readonly cloudId: string;
  /** The service account's email, such as `ostra-bot@serviceaccount.atlassian.com`. */
  readonly email: string;
  /** Its scoped API token. Never stored here, never in an answer. */
  readonly token: string;
};

/** A project the token sees: Jira's ID, key and name. */
export type JiraProjectRef = { readonly id: string; readonly key: string; readonly name: string };

/**
 * Who the token signs in as (`/myself`): `ok` for a service account (`accountType` `app`), `fail`
 * for a person's account or a customer's (ostra writes as a bot and never holds a member's token),
 * `warn` when Jira doesn't say which it is.
 */
export type JiraAccountCheck = {
  readonly outcome: "ok" | "warn" | "fail";
  readonly accountId: string;
  readonly name: string;
  readonly accountType: string | null;
};

/** The projects it sees (`/project/search`): `fail` when it sees none, or can't search them. */
export type JiraProjectsCheck = { readonly outcome: "ok" | "fail"; readonly projects: readonly JiraProjectRef[] };

/**
 * The five permissions in each project (`/mypermissions`): every project with the ones it lacks
 * (none, for a project with all five). `warn` when any project is short, naming it.
 */
export type JiraPermissionsCheck = {
  readonly outcome: "ok" | "warn";
  readonly projects: readonly (JiraProjectRef & { readonly missing: readonly JiraConnectPermission[] })[];
};

/**
 * Whether it reads the projects' workflows (`/workflows/search`), so the Boards mapping can check
 * each transition: `warn` when Jira refuses, or shows it none of a project's workflows, naming
 * those projects. The token still saves: moves then find their transitions per ticket.
 */
export type JiraWorkflowsCheck = { readonly outcome: "ok" | "warn"; readonly readable: boolean; readonly unreadable: readonly JiraProjectRef[] };

/**
 * A scope the token needs, as the read-back found it: `confirmed` by a read that needs it,
 * `refused` where that read was refused (the scope, or the permission behind it, is missing), or
 * `unchecked` when no read needs it (`write:jira-work`: nothing is written before the token saves).
 */
export type JiraScopeCheck = { readonly scope: JiraTokenScope; readonly state: "confirmed" | "refused" | "unchecked" };

/**
 * What step 2 reads back: the four checks and the scopes; `refused` when Jira refuses the token
 * itself (401 or 403 on `/myself`), with that status; `unreachable` when Jira can't be reached or
 * answers with a failure (`status` when it answered at all).
 */
export type JiraTokenReadBack =
  | {
      readonly kind: "checked";
      readonly account: JiraAccountCheck;
      readonly projects: JiraProjectsCheck;
      readonly permissions: JiraPermissionsCheck;
      readonly workflows: JiraWorkflowsCheck;
      readonly scopes: readonly JiraScopeCheck[];
    }
  | { readonly kind: "refused"; readonly status: 401 | 403 }
  | { readonly kind: "unreachable"; readonly status: number | null };

const CLOUD_ID = /^[A-Za-z0-9-]{1,64}$/;
/** Pages of 50 projects read at most: a service account is given the projects it works in. */
const MAX_PROJECT_PAGES = 20;
/** Projects checked at once. */
const PER_PROJECT_AT_ONCE = 4;

type Read<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "refused"; readonly status: number } | { readonly kind: "unreachable"; readonly status: number | null };

/** Calls `fn` on each item, a few at a time, in order. */
const eachFew = async <T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += PER_PROJECT_AT_ONCE) {
    results.push(...(await Promise.all(items.slice(index, index + PER_PROJECT_AT_ONCE).map(fn))));
  }
  return results;
};

/**
 * Step 2: who the token signs in as, which projects it sees, the five permissions in each, and
 * whether it reads their workflows, through the gateway with the cloud ID. Read-only: nothing is
 * written, and nothing is kept.
 */
const checkToken = async (options: JiraConnectOptions, input: JiraTokenInput): Promise<JiraTokenReadBack> => {
  if (!CLOUD_ID.test(input.cloudId)) {
    return { kind: "unreachable", status: null };
  }
  const api = `${(options.apiUrl ?? JIRA_GATEWAY_URL).replace(/\/+$/, "")}/ex/jira/${input.cloudId}/rest/api/3`;
  const authorization = `Basic ${Buffer.from(`${input.email}:${input.token}`, "utf8").toString("base64")}`;
  const read = async <S extends z.ZodType>(path: string, query: Readonly<Record<string, string>>, schema: S): Promise<Read<z.infer<S>>> => {
    const url = new URL(`${api}${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const answer = await send(options, url, { authorization });
    if (answer.kind === "unreachable") return { kind: "unreachable", status: null };
    if (isFailing(answer.status)) return { kind: "unreachable", status: answer.status };
    if (answer.status !== 200) return { kind: "refused", status: answer.status };
    const parsed = schema.safeParse(answer.body);
    return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "unreachable", status: answer.status };
  };

  const me = await read("/myself", {}, accountSchema);
  if (me.kind === "refused" && (me.status === 401 || me.status === 403)) {
    return { kind: "refused", status: me.status };
  }
  if (me.kind !== "ok") {
    return { kind: "unreachable", status: me.status };
  }
  const accountType = me.value.accountType ?? null;
  const account: JiraAccountCheck = {
    outcome: accountType === "app" ? "ok" : accountType === null ? "warn" : "fail",
    accountId: me.value.accountId,
    name: me.value.displayName ?? me.value.accountId,
    accountType,
  };

  const projects: JiraProjectRef[] = [];
  let projectsRead: "confirmed" | "refused" = "confirmed";
  for (let page = 0, startAt = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const listed = await read("/project/search", { startAt: String(startAt), maxResults: "50" }, projectPageSchema);
    if (listed.kind === "unreachable") return listed;
    if (listed.kind === "refused") {
      projectsRead = "refused";
      break;
    }
    projects.push(...listed.value.values.map((project) => ({ id: project.id, key: project.key, name: project.name })));
    startAt += listed.value.values.length;
    if (listed.value.isLast !== false || listed.value.values.length === 0) break;
  }

  const held = await eachFew(projects, async (project) => {
    const answer = await read("/mypermissions", { projectId: project.id, permissions: JIRA_CONNECT_PERMISSIONS.join(",") }, myPermissionsSchema);
    // A project whose permissions Jira won't say holds none ostra can count on.
    const missing = answer.kind === "ok" ? JIRA_CONNECT_PERMISSIONS.filter((permission) => answer.value.permissions[permission]?.havePermission !== true) : [...JIRA_CONNECT_PERMISSIONS];
    return { answer, value: { ...project, missing } };
  });
  const brokenPermissions = held.find(({ answer }) => answer.kind === "unreachable")?.answer;
  if (brokenPermissions?.kind === "unreachable") return brokenPermissions;

  // Each project's workflows, or (seeing none) whether the search answers at all.
  const workflowReads = await eachFew(projects.length === 0 ? [null] : projects, async (project) => {
    const answer = await read("/workflows/search", project === null ? { maxResults: "1" } : { projectId: project.id, maxResults: "1" }, workflowSearchSchema);
    return { project, answer, readable: answer.kind === "ok" && (project === null || answer.value.values.length > 0) };
  });
  const brokenWorkflows = workflowReads.find(({ answer }) => answer.kind === "unreachable")?.answer;
  if (brokenWorkflows?.kind === "unreachable") return brokenWorkflows;
  const unreadable = workflowReads.flatMap(({ project, readable }) => (readable || project === null ? [] : [project]));
  const workflowsReadable = workflowReads.every(({ readable }) => readable);

  const permissions = held.map(({ value }) => value);
  const states: Readonly<Record<JiraTokenScope, JiraScopeCheck["state"]>> = {
    "read:jira-work": projectsRead,
    "write:jira-work": "unchecked",
    "read:jira-user": "confirmed",
    "read:workflow:jira": workflowReads.some(({ answer }) => answer.kind === "ok") ? "confirmed" : "refused",
  };
  return {
    kind: "checked",
    account,
    projects: { outcome: projects.length === 0 ? "fail" : "ok", projects },
    permissions: { outcome: permissions.some((project) => project.missing.length > 0) ? "warn" : "ok", projects: permissions },
    workflows: { outcome: workflowsReadable ? "ok" : "warn", readable: workflowsReadable, unreadable },
    scopes: JIRA_TOKEN_SCOPES.map((scope) => ({ scope, state: states[scope] })),
  };
};

// ---------- step 3: the admin webhook ----------

/** Where a Jira admin makes the webhook: Settings › System › WebHooks. `null` for a host that isn't one. */
const webhooksPage = (host: string): string | null => {
  const site = jiraSiteHost(host);
  return site === null ? null : `https://${site}/plugins/servlet/webhooks`;
};

/**
 * The connect steps' calls (spec section 5.3): `findSite` (step 1), `checkToken` (step 2), and what
 * step 3 shows: the scopes the token needs, the six webhook events, the JQL that narrows the
 * webhook to the projects (`project in (PROJ, SHOP)`, or `null` for none), and Jira's WebHooks page.
 */
export const jiraConnect = {
  findSite,
  checkToken,
  scopes: JIRA_TOKEN_SCOPES,
  webhookEvents: JIRA_WEBHOOK_EVENTS,
  suggestedJql: webhookJql,
  webhooksPage,
} as const;
