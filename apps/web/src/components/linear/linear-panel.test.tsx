import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { connectionIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { LinearBody, LinearProperties } from "./linear-panel";
import type { LinearActions } from "./linear-panel";
import { formatAgo, formatDay, formatLeft, middleTruncate } from "./linear-status";
import type { LinearConnection, LinearNone } from "./linear-types";

// F-005, F-042: the Linear page in each state of connect-linear.md, rendered without a browser.

const now = Date.UTC(2026, 10, 19, 14, 30);
const idle = { run: () => undefined, pending: false, error: null };
const actions: LinearActions = { start: idle, saveApp: idle, authorize: idle, startAgain: idle, disconnect: idle };

const common = {
  scopes: ["read", "write", "issues:create", "comments:create"],
  webhookEvents: ["Issue", "Comment", "Attachment", "IssueLabel", "OAuthAuthorization", "AgentSessionEvent"],
  pollSeconds: 60,
  reconcileMinutes: 5,
};

const none: LinearNone = { state: "none", mode: "webhooks", modeReason: null, lastRevoked: null, ...common };

const active: LinearConnection = {
  state: "active",
  connectionId: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c7"),
  mode: "webhooks",
  modeReason: null,
  credentialKind: "app_oauth",
  workspaceKey: "acme",
  workspaceName: "Acme",
  appUserName: "ostra",
  activatedAt: Date.UTC(2026, 10, 12, 9),
  stateSince: Date.UTC(2026, 10, 12, 9),
  webhookUrl: "https://ostra.acme.dev/webhooks/linear/c7f3a9e2",
  appSaved: true,
  manifestUrl: null,
  lastEvent: { at: now - 2 * 60_000, type: "Issue", ticketKey: "CALC-161" },
  lastPoll: null,
  accessTokenExpiresAt: now + 21 * 3_600_000,
  silentSince: null,
  startedAt: Date.UTC(2026, 10, 12, 8, 50),
  startedByName: "demo",
  ...common,
};

const body = (status: Parameters<typeof LinearBody>[0]["status"], extra: Partial<Parameters<typeof LinearBody>[0]> = {}) =>
  renderToStaticMarkup(<LinearBody status={status} actions={actions} now={now} justConnected={false} {...extra} />);

describe("the Linear page, not connected", () => {
  it("F-005: shows the three steps, the first one current, and the mode before the click", () => {
    const html = body(none);
    expect(html).toContain(t("linear.connect.title"));
    expect(html).toContain('data-step="1" data-look="current"');
    expect(html).toContain('data-step="2" data-look="later"');
    expect(html).toContain('data-step="3" data-look="later"');
    expect(html).toContain(t("linear.mode.sendsToServer"));
    expect(html).toContain(t("linear.connect.step1.action"));
    // No form until the app exists.
    expect(html).not.toContain(t("linear.connect.step2.clientId"));
  });

  it("F-042: in polling mode says why, names the setting, and asks for no signing secret", () => {
    const polling: LinearNone = { ...none, mode: "polling", modeReason: "a loopback host cannot be reached from Linear" };
    const html = body(polling);
    expect(html).toContain("a loopback host cannot be reached from Linear");
    expect(html).toContain("OSTRA_CORE_PUBLIC_URL");
    expect(html).toContain(t("linear.connect.step2.bodyPolling").trim());
    const panel = renderToStaticMarkup(<LinearProperties status={polling} />);
    expect(panel).toContain(t("linear.mode.polling"));
    expect(panel).toContain(t("linear.panel.webhookOff", { seconds: 60 }));
    expect(panel).not.toContain("AgentSessionEvent");
  });

  it("names the workspace it was disconnected from", () => {
    expect(body({ ...none, lastRevoked: { workspaceKey: "acme", at: Date.UTC(2026, 10, 18) } })).toContain("Disconnected from acme on 18 Nov.");
  });

  it("shows what the app will ask for in the panel", () => {
    const panel = renderToStaticMarkup(<LinearProperties status={none} />);
    expect(panel).toContain(t("linear.panel.asksFor"));
    for (const scope of common.scopes) expect(panel).toContain(scope);
    expect(panel).toContain("AgentSessionEvent");
  });
});

describe("the Linear page, pending", () => {
  const pending: LinearConnection = { ...active, state: "pending", appSaved: false, activatedAt: null, manifestUrl: "https://linear.app/settings/api/applications/new?x=1" };

  it("ticks step 1, asks for the three values in secret fields, and says who started it", () => {
    const html = body(pending);
    expect(html).toContain('data-step="1" data-look="done"');
    expect(html).toContain('data-step="2" data-look="current"');
    expect(html).toContain(t("linear.connect.step1.again"));
    expect(html).toContain('id="linear-client-secret" type="password"');
    expect(html).toContain('id="linear-webhook-secret" type="password"');
    expect(html).toContain("by demo");
    expect(html).toContain(t("linear.connect.startAgain"));
  });

  it("never shows a saved value: once saved, step 2 says so and step 3 is current", () => {
    const html = body({ ...pending, appSaved: true });
    expect(html).toContain(t("linear.connect.step2.saved"));
    expect(html).not.toContain('id="linear-client-secret"');
    expect(html).toContain('data-step="3" data-look="current"');
  });

  it("opens the manifest link in a new tab without an opener", () => {
    expect(body(pending)).toMatch(/target="_blank" rel="noopener noreferrer"/);
  });
});

describe("the Linear page, connected", () => {
  it("F-005: by webhooks: the workspace, receiving, the last event, a healthy token and Disconnect", () => {
    const html = body(active);
    expect(html).toContain(t("linear.connection.connected"));
    expect(html).toContain("acme");
    expect(html).toContain("since 12 Nov");
    expect(html).toContain(t("linear.events.receiving"));
    expect(html).toContain("CALC-161");
    expect(html).toContain("2 min ago");
    expect(html).toContain(t("linear.events.backstopBody", { minutes: 5 }));
    expect(html).toContain(t("linear.token.healthy"));
    expect(html).toContain("expires in 21 h");
    expect(html).toContain(t("linear.disconnect.action"));
  });

  it("says Just connected after the callback", () => {
    expect(body(active, { justConnected: true })).toContain(t("linear.connection.justConnected"));
  });

  it("F-042: by polling: the interval, why there's no webhook, the last poll, no backstop row", () => {
    const html = body({ ...active, mode: "polling", modeReason: "a private-network host cannot be reached from Linear", webhookUrl: null, lastPoll: { at: now - 60_000, changed: 3 } });
    expect(html).toContain(t("linear.events.polling", { seconds: 60 }));
    expect(html).toContain("a private-network host cannot be reached from Linear");
    expect(html).toContain("3 tickets changed");
    expect(html).not.toContain(t("linear.events.backstop"));
  });

  it("when webhooks went silent, says since when, in red on the icon only, and how to check", () => {
    const html = body({ ...active, silentSince: Date.UTC(2026, 10, 19, 14, 2) });
    expect(html).toMatch(/Webhooks: silent since \d\d:\d\d/);
    expect(html).toContain(t("linear.events.silentAfter").trim());
    expect(html).toContain("Check the app&#x27;s webhook in Linear");
    expect(html).not.toContain("text-amber");
  });

  it("when the token failed, says Linear refused it and offers Authorize again", () => {
    const html = body({ ...active, state: "failed", stateSince: Date.UTC(2026, 10, 19, 14, 2) });
    expect(html).toContain(t("linear.connection.failed"));
    expect(html).toContain(t("linear.token.failed"));
    expect(html).toContain(t("linear.token.authorizeAgain"));
    expect(html).not.toContain(t("linear.token.healthy"));
  });

  it("an api_key connection says Personal API key (development), with no refresh and no Authorize", () => {
    const apiKey: LinearConnection = { ...active, credentialKind: "api_key", appUserName: null, accessTokenExpiresAt: null };
    const panel = renderToStaticMarkup(<LinearProperties status={apiKey} />);
    expect(panel).toContain(t("linear.panel.personalKey"));
    const html = body({ ...apiKey, state: "failed" });
    expect(html).toContain("It never refreshes.");
    expect(html).not.toContain(t("linear.token.refresh"));
    expect(html).not.toContain(t("linear.token.authorizeAgain"));
  });

  it("the panel shows the app user and where the secrets are, never a client ID", () => {
    const panel = renderToStaticMarkup(<LinearProperties status={active} />);
    expect(panel).toContain("ostra");
    expect(panel).toContain(t("linear.token.inSecretStore"));
    expect(panel).not.toContain("Client ID");
  });
});

describe("loading", () => {
  it("shows skeleton rows, never a blank page", () => {
    expect(body(undefined)).toContain('aria-busy="true"');
  });
});

describe("the page's words", () => {
  it("formats days, ages and time left", () => {
    expect(formatDay(Date.UTC(2026, 10, 12), now)).toBe("12 Nov");
    expect(formatDay(Date.UTC(2025, 10, 12), now)).toBe("12 Nov 2025");
    expect(formatAgo(now - 30_000, now)).toBe("just now");
    expect(formatAgo(now - 2 * 60_000, now)).toBe("2 min ago");
    expect(formatLeft(now + 21 * 3_600_000, now)).toBe("21 h");
  });

  it("cuts a long URL in its middle", () => {
    const cut = middleTruncate("https://ostra.acme.dev/webhooks/linear/c7f3a9e2-aaaa-bbbb-cccc-dddddddddddd", 40);
    expect(cut).toHaveLength(40);
    expect(cut.startsWith("https://ostra")).toBe(true);
    expect(cut.endsWith("dddd")).toBe(true);
  });
});
