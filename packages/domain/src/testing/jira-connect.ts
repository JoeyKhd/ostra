import { randomUUID } from "node:crypto";

import { jiraProjectPermissions } from "../use-cases/tracker-connections.ts";
import type { JiraProjectPermission } from "../use-cases/tracker-connections.ts";
import { jiraTokenScopes } from "../use-cases/jira-connection.ts";
import type { JiraConnectKit, JiraProjectRef, JiraScopeCheck, JiraSiteLookup, JiraTokenChecks, JiraTokenReadBack } from "../use-cases/jira-connection.ts";

// A fake `JiraConnectKit` (spec section 9, "The connect kit"), for the domain's and the API's tests
// of the connect steps: sites by name with each of step 1's outcomes, and tokens with each of step
// 2's (a service account, a person, no project, short permissions, no workflows, refused,
// unreachable). It mirrors the kit's unions (`adapter-jira`'s `jiraConnect`, ticket 04) and
// records every call, so a test can say which token reached it, and when. Vitest only.

/** What step 1 finds at a registered site. */
export type FakeJiraSite =
  | { readonly kind: "found"; readonly cloudId: string; readonly title?: string }
  | { readonly kind: "data-center" }
  | { readonly kind: "unreachable" };

/**
 * What a token reads back:
 * - `service-account`: four green lines;
 * - `person`: a person's account (`fail`);
 * - `unknown-account`: Jira doesn't say what the account is (`warn`);
 * - `no-projects`: it sees none (`fail`);
 * - `short-permissions`: it can't transition or comment in the last project (`warn`);
 * - `no-workflows`: no `read:workflow:jira` (`warn`);
 * - `refused-401`, `refused-403`: Jira refuses the token itself;
 * - `unreachable`: Jira doesn't answer.
 */
export type FakeJiraTokenProfile =
  | "service-account"
  | "person"
  | "unknown-account"
  | "no-projects"
  | "short-permissions"
  | "no-workflows"
  | "refused-401"
  | "refused-403"
  | "unreachable";

/** One call the kit took: the token as it came, so a test can find it by value. */
export type FakeJiraConnectCall =
  | { readonly method: "findSite"; readonly site: string }
  | { readonly method: "checkToken"; readonly cloudId: string; readonly email: string; readonly token: string };

export type FakeJiraConnectKit = {
  readonly kit: JiraConnectKit;
  /** Registers a site under its name (`globex`): `found` with a cloud ID by default. */
  readonly site: (name: string, site?: FakeJiraSite | { readonly cloudId?: string; readonly title?: string }) => { readonly cloudId: string; readonly host: string };
  /** Registers a token for a site's cloud ID, with what it reads back. An unknown token is refused (401). */
  readonly token: (token: string, input: { readonly cloudId: string; readonly profile?: FakeJiraTokenProfile; readonly accountId?: string; readonly name?: string }) => void;
  /** Every call, in order. */
  readonly calls: readonly FakeJiraConnectCall[];
};

/** The projects every fake token sees. */
export const FAKE_JIRA_PROJECTS: readonly JiraProjectRef[] = [
  { id: "10000", key: "PROJ", name: "Project" },
  { id: "10001", key: "SHOP", name: "Shop" },
  { id: "10002", key: "OPS", name: "Operations" },
];

const CLOUD_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The host a name, host or URL names, as the kit reads it; `null` when none. */
const hostOf = (input: string): string | null => {
  const text = input.trim().toLowerCase();
  if (text === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
  if (!URL.canParse(withScheme)) return null;
  const host = new URL(withScheme).hostname.replace(/\.$/, "");
  if (host.includes(".")) return host;
  return CLOUD_LABEL.test(host) ? `${host}.atlassian.net` : null;
};

const titleOf = (host: string): string =>
  (host.split(".")[0] ?? host)
    .split("-")
    .filter((word) => word !== "")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");

/** A read-back of a profile, as the kit answers it. */
export const fakeJiraReadBack = (profile: FakeJiraTokenProfile, account: { readonly accountId: string; readonly name: string } = { accountId: "ostra-bot-id", name: "ostra-bot" }): JiraTokenReadBack => {
  switch (profile) {
    case "refused-401":
      return { kind: "refused", status: 401 };
    case "refused-403":
      return { kind: "refused", status: 403 };
    case "unreachable":
      return { kind: "unreachable", status: 503 };
    case "service-account":
    case "person":
    case "unknown-account":
    case "no-projects":
    case "short-permissions":
    case "no-workflows":
      break;
    default:
      return profile satisfies never;
  }
  const projects = profile === "no-projects" ? [] : FAKE_JIRA_PROJECTS;
  const short = new Set<JiraProjectPermission>(["TRANSITION_ISSUES", "ADD_COMMENTS"]);
  const permissions = projects.map((project, index) => ({
    ...project,
    missing: profile === "short-permissions" && index === projects.length - 1 ? jiraProjectPermissions.filter((permission) => short.has(permission)) : [],
  }));
  const workflowsReadable = profile !== "no-workflows";
  const states: Readonly<Record<(typeof jiraTokenScopes)[number], JiraScopeCheck["state"]>> = {
    "read:jira-work": "confirmed",
    "write:jira-work": "unchecked",
    "read:jira-user": "confirmed",
    "read:workflow:jira": workflowsReadable ? "confirmed" : "refused",
  };
  const checks: JiraTokenChecks = {
    kind: "checked",
    account: {
      outcome: profile === "person" ? "fail" : profile === "unknown-account" ? "warn" : "ok",
      accountId: account.accountId,
      name: account.name,
      accountType: profile === "person" ? "atlassian" : profile === "unknown-account" ? null : "app",
    },
    projects: { outcome: projects.length === 0 ? "fail" : "ok", projects },
    permissions: { outcome: permissions.some((project) => project.missing.length > 0) ? "warn" : "ok", projects: permissions },
    workflows: { outcome: workflowsReadable ? "ok" : "warn", readable: workflowsReadable, unreadable: workflowsReadable ? [] : projects },
    scopes: jiraTokenScopes.map((scope) => ({ scope, state: states[scope] })),
  };
  return checks;
};

/** A fake connect kit with no site and no token yet: register them with `site` and `token`. */
export const createFakeJiraConnectKit = (): FakeJiraConnectKit => {
  const sites = new Map<string, FakeJiraSite>();
  const tokens = new Map<string, { readonly cloudId: string; readonly profile: FakeJiraTokenProfile; readonly accountId: string; readonly name: string }>();
  const calls: FakeJiraConnectCall[] = [];

  const findSite = (input: string): Promise<JiraSiteLookup> => {
    calls.push({ method: "findSite", site: input });
    const host = hostOf(input);
    if (host === null) {
      return Promise.resolve({ kind: "not-found", host: null });
    }
    const site = sites.get(host);
    if (site === undefined) {
      return Promise.resolve(host.endsWith(".atlassian.net") ? { kind: "not-found", host } : { kind: "data-center", host });
    }
    switch (site.kind) {
      case "found":
        return Promise.resolve({ kind: "found", cloudId: site.cloudId, host, title: site.title ?? titleOf(host) });
      case "data-center":
        return Promise.resolve({ kind: "data-center", host });
      case "unreachable":
        return Promise.resolve({ kind: "unreachable", host });
      default:
        return site satisfies never;
    }
  };

  const checkToken = (input: { readonly cloudId: string; readonly email: string; readonly token: string }): Promise<JiraTokenReadBack> => {
    calls.push({ method: "checkToken", cloudId: input.cloudId, email: input.email, token: input.token });
    const known = tokens.get(input.token);
    // A token of another site, or none, is refused as Jira's gateway refuses it.
    if (known?.cloudId !== input.cloudId) {
      return Promise.resolve({ kind: "refused", status: 401 });
    }
    return Promise.resolve(fakeJiraReadBack(known.profile, { accountId: known.accountId, name: known.name }));
  };

  const kit: JiraConnectKit = {
    findSite,
    checkToken,
    scopes: jiraTokenScopes,
    webhookEvents: ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"],
    suggestedJql: (keys) => {
      const valid = keys.filter((key) => /^[A-Z][A-Z0-9_]{0,254}$/.test(key));
      return valid.length === 0 ? null : `project in (${valid.join(", ")})`;
    },
    webhooksPage: (host) => {
      const site = hostOf(host);
      return site === null ? null : `https://${site}/plugins/servlet/webhooks`;
    },
  };

  return {
    kit,
    site: (name, site = {}) => {
      const host = hostOf(name) ?? `${name}.atlassian.net`;
      const entry: FakeJiraSite = "kind" in site ? site : { kind: "found", cloudId: site.cloudId ?? randomUUID(), ...(site.title === undefined ? {} : { title: site.title }) };
      sites.set(host, entry);
      return { cloudId: entry.kind === "found" ? entry.cloudId : "", host };
    },
    token: (token, input) => {
      tokens.set(token, { cloudId: input.cloudId, profile: input.profile ?? "service-account", accountId: input.accountId ?? "ostra-bot-id", name: input.name ?? "ostra-bot" });
    },
    calls,
  };
};
