import { jiraConnect } from "@ostra/adapter-jira";
import type { JiraConnectOptions } from "@ostra/adapter-jira";
import type { JiraConnectKit } from "@ostra/domain";

// Milestone 11, ticket 09 (F-008, ADR 0047; spec section 5.3): the calls Jira's connect steps make,
// as the domain's `JiraConnectKit`, the way `linear-app.ts` serves `LinearAppKit`. Each call is
// `adapter-jira`'s own (`jiraConnect`), bound field by field to `OSTRA_JIRA_API_URL` (the fake Jira
// in tests; unset, Atlassian's gateway and each site's own address), a fetch and a timeout. The
// pasted token goes to the one call that checks it, and nowhere else; Jira's error bodies are
// never read, so an answer carries IDs, names, keys and status codes only.

/** How long each of Jira's connect calls may take: step 2 reads a few pages and each project's permissions. */
export const JIRA_CONNECT_TIMEOUT_MS = 15_000;

export type JiraConnectKitOptions = {
  /** `OSTRA_JIRA_API_URL` (`settings.jiraApiUrl`): `null` for Jira's own. */
  readonly apiUrl: string | null;
  /** Unset, the platform's. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
};

/** The kit the panel's Jira connect steps use, over Jira Cloud (or a fake's). */
export const createJiraConnectKit = (input: JiraConnectKitOptions): JiraConnectKit => {
  const options: JiraConnectOptions = { apiUrl: input.apiUrl, fetch: input.fetch ?? globalThis.fetch, timeoutMs: input.timeoutMs ?? JIRA_CONNECT_TIMEOUT_MS };
  return {
    findSite: (site) => jiraConnect.findSite(options, site),
    checkToken: (token) => jiraConnect.checkToken(options, token),
    scopes: jiraConnect.scopes,
    webhookEvents: jiraConnect.webhookEvents,
    suggestedJql: jiraConnect.suggestedJql,
    webhooksPage: jiraConnect.webhooksPage,
  };
};
