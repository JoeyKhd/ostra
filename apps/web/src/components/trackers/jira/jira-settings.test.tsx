import { boardIdSchema, connectionIdSchema, projectIdSchema } from "@ostra/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { JiraSettingsBody, JiraSettingsPanel, jiraDisconnectBody } from "./jira-settings";
import type { JiraTokenOps, JiraRotate } from "./jira-settings";
import type { JiraDetail } from "./jira-words";

// Milestone 11, ticket 14 (F-008/c8, F-152/c5, F-152/c3; connection-settings.md): a Jira
// connection's settings in each state, drawn without a browser. The token's date warns from 14
// days before it and fails on the day; Rotate shows the new secret once; Disconnect names the
// boards it pauses; and a member's page has no URL, secret or action.

const now = Date.UTC(2026, 10, 23, 12, 0, 0);
const day = 86_400_000;
const connectionId = connectionIdSchema.parse("01a1f6b2-0000-7000-8000-00000000c001");
const calculator = projectIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000c1");
const shop = projectIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000c2");
const board = (n: number, name: string, key: string, project: { readonly id: typeof calculator; readonly name: string }) => ({
  id: boardIdSchema.parse(`01a1f6b2-0000-7000-8000-0000000000d${String(n)}`),
  name,
  key,
  project,
});

const capabilities = {
  agentSessions: false,
  subIssues: true,
  statusGraph: true,
  webhooks: true,
  commentEdit: true,
  attachments: true,
  transitions: true,
  mentions: true,
  agentScopes: [] as const,
  agentSessionLink: false,
  ticketFields: { acceptanceCriteria: false },
  ticketFiles: "all" as const,
  magicWords: false,
  richText: "adf" as const,
  jqlFilter: true,
};

const jira: JiraDetail = {
  id: connectionId,
  kind: "jira",
  name: "Globex Jira",
  site: "globex.atlassian.net",
  state: "active",
  webhookMode: "webhooks",
  lastEventAt: now - 6 * 60_000,
  failedReason: null,
  silentSince: null,
  tokenExpiresAt: Date.UTC(2027, 8, 14),
  tokenExpiry: { state: "healthy" },
  signsInAs: "ostra-bot@serviceaccount.atlassian.com",
  agentModeAt: null,
  boards: [board(1, "Globex Calculator", "PROJ", { id: calculator, name: "calculator" }), board(2, "Globex Shop", "SHOP", { id: shop, name: "globex-shop" })],
  capabilities,
  createdAt: now - 30 * day,
  jira: {
    cloudId: "a3f9e0a1-0000-4000-8000-00000000c12e",
    email: "ostra-bot@serviceaccount.atlassian.com",
    reach: {
      projects: [
        { id: "10001", key: "PROJ", name: "calculator", permissions: ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS"], missing: [] },
        { id: "10002", key: "SHOP", name: "globex-shop", permissions: ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS"], missing: [] },
      ],
      checkedAt: now - 2 * 3_600_000,
    },
    workflowsReadable: true,
    scopes: ["read:jira-work", "write:jira-work", "read:jira-user", "read:workflow:jira"],
    neededScopes: ["read:jira-work", "write:jira-work", "read:jira-user", "read:workflow:jira"],
    webhookEvents: ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"],
    webhookUrl: "https://ostra.acme.dev/webhooks/jira/cn_4r8tz2",
    webhooksPage: "https://globex.atlassian.net/plugins/servlet/webhooks",
    firstDeliveryAt: now - 21 * day,
    badSignatureAt: null,
    modeReason: null,
    pollSeconds: 60,
    reconcileMinutes: 5,
    lastEvent: { at: now - 6 * 60_000, type: "jira:issue_updated", ticketKey: "PROJ-14" },
    lastPollAt: null,
    activatedAt: now - 21 * day,
    startedAt: now - 22 * day,
    startedByName: "Alex Kim",
  },
};

const idle = { run: () => undefined, pending: false, error: null };
const rotate: JiraRotate = { ...idle, secret: null };
const token: JiraTokenOps = { check: { ...idle, readBack: null, verdict: null }, save: idle, recheck: { ...idle, readBack: null, verdict: null }, reset: () => undefined };
type BodyExtra = { readonly canManage?: boolean; readonly rotate?: JiraRotate; readonly token?: JiraTokenOps; readonly detail?: JiraDetail };

const body = (extra: BodyExtra = {}): string =>
  renderToStaticMarkup(
    <JiraSettingsBody
      detail={extra.detail ?? jira}
      now={now}
      canManage={extra.canManage ?? true}
      justConnected={false}
      rotate={extra.rotate ?? rotate}
      token={extra.token ?? token}
      disconnect={idle}
    />,
  );

const member: JiraDetail = { ...jira, signsInAs: null, jira: { ...jira.jira, email: null, reach: null, scopes: [], webhookUrl: null, badSignatureAt: null } };

describe("a Jira connection's settings", () => {
  it("F-008/c8: a healthy token says where it signs in, when it expires, and what it reaches", () => {
    const html = body();
    expect(html).toContain(t("trackers.jira.settings.token.title"));
    expect(html).toContain(jira.jira.email ?? "");
    expect(html).toContain(t("trackers.jira.settings.token.healthy"));
    expect(html).toContain("14 Sep 2027");
    expect(html).toContain("2 projects");
    expect(html).toContain(t("trackers.jira.settings.token.checkAgain"));
    expect(html).toContain(t("trackers.jira.settings.token.replace"));
    expect(html).not.toContain("jira-token-expiring");
  });

  it("F-008/c8: from 14 days before its date the token is red and asks for a new one", () => {
    const html = body({ detail: { ...jira, tokenExpiry: { state: "expires-soon", days: 9 }, tokenExpiresAt: Date.UTC(2026, 11, 2) } });
    expect(html).toContain(t("trackers.jira.settings.token.expiresSoon", { days: 9, date: "2 Dec 2026" }));
    expect(html).toContain('data-testid="jira-token-expiring"');
    expect(html).not.toContain(t("trackers.jira.settings.token.healthy"));
  });

  it("F-008/c8: on the day the connection says Jira refused the token, and Replace is the page's one primary", () => {
    const html = body({ detail: { ...jira, state: "failed", failedReason: "token-expired", tokenExpiry: { state: "expired" }, tokenExpiresAt: Date.UTC(2026, 11, 2) } });
    expect(html).toContain(t("trackers.jira.settings.token.expired", { date: "2 Dec 2026" }));
    expect(html).toContain('data-testid="jira-replace-primary"');
    expect(html).toContain(t("trackers.jira.settings.token.replace"));
  });

  it("F-008/c8: Rotate answers the new secret once, in place of the store's line", () => {
    const html = body({ rotate: { ...idle, secret: "s3cr3t-n3w" } });
    expect(html).toContain('data-testid="jira-new-secret"');
    expect(html).toContain("s3cr3t-n3w");
    expect(html).toContain("Copy it into Jira");
    expect(html).toContain(t("common.copy"));
  });

  it("F-152/c5: Disconnect names the boards it pauses, by project", () => {
    expect(jiraDisconnectBody(jira)).toContain("Its 2 boards on calculator and globex-shop");
    expect(jiraDisconnectBody(jira)).toContain("Delete the webhook in Jira yourself");
    expect(body()).toContain(t("trackers.jira.settings.disconnect.action"));
    expect(body()).toContain(t("trackers.jira.settings.disconnect.body", { n: 2 }));
  });

  it("F-152/c3: a member's page has no webhook URL, secret, Rotate, Replace, Check again or Disconnect", () => {
    const html = body({ canManage: false, detail: member });
    expect(html).toContain(t("trackers.jira.settings.events.receiving"));
    expect(html).not.toContain("https://ostra.acme.dev");
    expect(html).not.toContain(t("trackers.jira.settings.events.inSecretStore"));
    expect(html).not.toContain(t("trackers.jira.settings.events.rotate"));
    expect(html).not.toContain(t("trackers.jira.settings.token.title"));
    expect(html).not.toContain(t("trackers.jira.settings.token.replace"));
    expect(html).not.toContain(t("trackers.jira.settings.token.checkAgain"));
    expect(html).not.toContain(t("trackers.jira.settings.disconnect.action"));
  });

  it("F-042: polling mode says why there is no webhook and shows the last poll instead", () => {
    const html = body({
      detail: {
        ...jira,
        webhookMode: "polling",
        jira: { ...jira.jira, webhookUrl: null, modeReason: "not-https", lastPollAt: now - 60_000, lastEvent: null },
      },
    });
    expect(html).toContain(t("trackers.jira.settings.events.polling", { seconds: 60 }));
    expect(html).toContain(t("trackers.jira.settings.events.lastPoll"));
    expect(html).not.toContain(t("trackers.jira.settings.events.backstop"));
    expect(html).not.toContain(t("trackers.jira.settings.events.rotate"));
  });
});

describe("a Jira connection's panel", () => {
  it("F-152/c1: the site, the scopes with their checks, the webhook's events and the boards on it", () => {
    const html = renderToStaticMarkup(<JiraSettingsPanel detail={jira} canManage />);
    expect(html).toContain(t("trackers.jira.settings.panel.cloudId"));
    expect(html).toContain("a3f9e0a1-0000-4000-8000-00000000c12e");
    expect(html).toContain(t("trackers.jira.settings.panel.readable"));
    expect(html).toContain("read:workflow:jira");
    expect(html).toContain(t("trackers.jira.settings.panel.webhookEvents"));
    expect(html).toContain("Issue created");
    expect(html).toContain(t("trackers.jira.settings.panel.boards"));
    expect(html).toContain("calculator");
    expect(html).toContain("PROJ");
  });

  it("F-152/c3: a member's panel leaves out the scopes and the workflow's reading", () => {
    const html = renderToStaticMarkup(<JiraSettingsPanel detail={member} canManage={false} />);
    expect(html).not.toContain(t("trackers.jira.settings.panel.scopes"));
    expect(html).toContain(t("trackers.jira.settings.panel.boards"));
  });
});
