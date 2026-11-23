import { connectionIdSchema } from "@ostra/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventsRow, MadeWithoutNote, ShownOnceView } from "./github-events";
import type { EventsRowProps, ShownOnce } from "./github-events";
import type { GitHubApp } from "./github-orgs";
import { appSettingsLinks, eventsState, eventsToTick, sectionState } from "./github-orgs-words";

// F-006/c4 (app-targets/m10-gaps/github-events.md): an App made while ostra had no public address
// has no webhook and takes no events. The GitHub page says which state its events are in, offers
// Turn on once the address is public, and shows the webhook address, a secret once and the events
// to tick in the App's settings on GitHub. The browser flow is `e2e/28-github-events.spec.ts`.

const EVENTS = ["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "issue_comment", "check_run", "check_suite", "status", "push", "workflow_run"];
const connectionId = connectionIdSchema.parse("0d8f2a14-6b3e-4c71-9a2d-5e8b1c3f7a01");

const app = (overrides: Partial<Pick<GitHubApp, "webhook" | "missingEvents" | "slug" | "ownerLogin" | "ownerKind">> = {}): GitHubApp => ({
  connectionId,
  appId: "1184207",
  slug: "ostra-acme",
  ownerLogin: "acme",
  ownerKind: "organization",
  public: true,
  own: true,
  webhookUrl: `https://ostra.acme.dev/webhooks/github/${connectionId}`,
  webhook: { kind: "none" },
  missingEvents: [...EVENTS],
  installations: [],
  ...overrides,
});

const noop = () => undefined;
const row = (props: Partial<EventsRowProps> & Pick<EventsRowProps, "app">) =>
  renderToStaticMarkup(
    <EventsRow webhookPossible={true} eventCount={EVENTS.length} turningOn={false} error={null} checking={false} onTurnOn={noop} onWhichOnes={noop} onNewSecret={noop} onCheckAgain={noop} {...props} />,
  );
/** The markup as text, without its tags. */
const text = (html: string): string => html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

describe("an App's events, in words", () => {
  it("F-006/c4: the section line says Events off with no webhook, Waiting for events while some are missing, and the webhook's state once all are taken", () => {
    expect(sectionState(app())).toBe("off");
    expect(sectionState(app({ webhook: { kind: "receiving", lastDeliveryAt: null } }))).toBe("waiting");
    expect(sectionState(app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: [] }))).toBe("receiving");
    expect(sectionState(app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: null }))).toBe("receiving");
    expect(sectionState(app({ webhook: { kind: "failing", lastDeliveryAt: 1, lastError: "bad signature" }, missingEvents: [] }))).toBe("failing");
  });

  it("F-006/c4: the Events row's state follows the webhook, the public address and what GitHub lists", () => {
    expect(eventsState(app(), false)).toBe("no-public");
    expect(eventsState(app(), true)).toBe("off");
    expect(eventsState(app({ webhook: { kind: "receiving", lastDeliveryAt: null } }), false)).toBe("waiting");
    expect(eventsState(app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: [] }), true)).toBe("on");
    expect(eventsState(app({ webhook: { kind: "failing", lastDeliveryAt: 1, lastError: "x" }, missingEvents: [] }), true)).toBe("on");
    expect(eventsState(app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: null }), true)).toBe("unknown");
  });

  it("F-006/c4: the result lists only the missing events, every one when GitHub didn't say, and none for a new secret it didn't say about", () => {
    expect(eventsToTick(EVENTS, ["push", "pull_request"], false)).toEqual(["pull_request", "push"]);
    expect(eventsToTick(EVENTS, null, false)).toEqual(EVENTS);
    expect(eventsToTick(EVENTS, null, true)).toEqual([]);
    expect(eventsToTick(EVENTS, [], true)).toEqual([]);
  });

  it("F-006/c4: the settings links name the App's owner, an organization's or a user's own, and none without a slug", () => {
    expect(appSettingsLinks(app())).toEqual({
      general: "https://github.com/organizations/acme/settings/apps/ostra-acme",
      permissions: "https://github.com/organizations/acme/settings/apps/ostra-acme/permissions",
    });
    expect(appSettingsLinks(app({ ownerLogin: "dana", ownerKind: "user", slug: "dana-app" }))).toEqual({
      general: "https://github.com/settings/apps/dana-app",
      permissions: "https://github.com/settings/apps/dana-app/permissions",
    });
    expect(appSettingsLinks(app({ slug: null }))).toBeNull();
  });
});

describe("the Events row", () => {
  it("F-006/c4: with no public address it names the setting and offers nothing", () => {
    const html = row({ app: app(), webhookPossible: false });
    expect(text(html)).toContain("EventsOff · no public address");
    expect(text(html)).toContain("GitHub can't reach this server. Set OSTRA_CORE_PUBLIC_URL to a public address and restart core, then turn them on here.");
    expect(html).toContain("<code");
    expect(html).not.toContain("<button");
  });

  it("F-006/c4: with a public address and no webhook it offers Turn on, and says what the App misses without events", () => {
    const html = row({ app: app() });
    expect(text(html)).toContain("Turn on");
    expect(text(html)).toContain("Without them, ostra learns of PR changes only on its periodic check, and never sees @ostra in a PR comment.");
    expect(text(row({ app: app(), turningOn: true }))).toContain("Turning on…");
    expect(row({ app: app(), turningOn: true })).toContain("disabled");
  });

  it("F-006/c4: waiting, it counts the missing events, links to Which ones and GitHub's page, and offers a new secret", () => {
    const html = row({ app: app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: EVENTS.slice(1) }) });
    expect(text(html)).toContain("Waiting for events");
    expect(text(html)).toContain("Subscribe to 9 events in the App's settings on GitHub. Which ones · Permissions and events");
    expect(html).toContain('href="https://github.com/organizations/acme/settings/apps/ostra-acme/permissions"');
    expect(html).toContain('target="_blank" rel="noreferrer"');
    expect(text(html)).toContain("New webhook secret");
    expect(text(row({ app: app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: ["push"] }) }))).toContain("Subscribe to 1 event in the App's settings on GitHub.");
  });

  it("F-006/c4: on, it counts the events and offers a new secret; unknown, it offers Check again", () => {
    const on = text(row({ app: app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: [] }) }));
    expect(on).toContain("EventsOn· 10 events");
    expect(on).toContain("New webhook secret");
    const unknown = text(row({ app: app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: null }) }));
    expect(unknown).toContain("Couldn't check");
    expect(unknown).toContain("GitHub didn't say which events the App takes. Check again");
  });

  it("F-006/c4: Turn on's refusal shows under the row as an alert; while the address is unknown the row is a skeleton", () => {
    const refused = "This server's address isn't public, so GitHub can't deliver to it. Set OSTRA_CORE_PUBLIC_URL to a public address first.";
    const html = row({ app: app(), webhookPossible: false, error: refused });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(refused);
    expect(text(row({ app: app(), webhookPossible: undefined }))).toBe("Events");
  });

  it("F-006/c4: the note under the App offers Turn them on only while the address is public", () => {
    expect(text(renderToStaticMarkup(<MadeWithoutNote webhookPossible={true} busy={false} onTurnOn={noop} />))).toBe("Made while this server had no public address, so GitHub sends it no events. Turn them on");
    expect(text(renderToStaticMarkup(<MadeWithoutNote webhookPossible={false} busy={false} onTurnOn={noop} />))).toBe("Made while this server had no public address, so GitHub sends it no events.");
  });
});

describe("Turn on's result, shown once", () => {
  const view = (shown: ShownOnce, of: GitHubApp = app(), phone = false) => renderToStaticMarkup(<ShownOnceView app={of} shown={shown} events={EVENTS} phone={phone} onDone={noop} onEscape={noop} />);
  const secret = "9f2c41d07a6b8e35c1f0d4a92b7e6c58";
  const turnedOn: ShownOnce = { kind: "secret", connectionId, replaced: false, webhookUrl: `https://ostra.acme.dev/webhooks/github/${connectionId}`, webhookSecret: secret, events: EVENTS };

  it("F-006/c4: gives the App's webhook address and the secret under General, the ten events under Permissions, and Done", () => {
    const html = view(turnedOn);
    const words = text(html);
    expect(words).toContain("Turn on eventsostra-acmeSet these in the App's settings on GitHub: it has no call that does it for ostra.");
    expect(words).toContain("Webhook, under GeneralTick Active, then paste both.");
    expect(html).toContain(`>https://ostra.acme.dev/webhooks/github/${connectionId}</span>`);
    expect(html).toContain(`>${secret}</span>`);
    expect(words).toContain("The secret is shown once. Copy it now: ostra keeps it in the secret store and never shows it again.");
    expect(html).toContain('href="https://github.com/organizations/acme/settings/apps/ostra-acme"');
    expect(html).toContain('href="https://github.com/organizations/acme/settings/apps/ostra-acme/permissions"');
    expect(words).toContain("Events, under PermissionsTick these 10 under Subscribe to events, then save.");
    expect(words).toContain(EVENTS.join(""));
    // Tab reaches the values to copy first, then GitHub's two pages, then Done (github-events.md, "Keyboard").
    expect(words).toContain("never shows it again.General2Events");
    expect(words).toContain(`${EVENTS.join("")}PermissionsDone`);
    expect(words).toContain("DoneEvents reads On once GitHub lists all 10.");
  });

  it("F-006/c4: lists only the events still missing, and a user's App links to the user's own settings", () => {
    const words = text(view(turnedOn, app({ missingEvents: ["check_run", "workflow_run"], ownerLogin: "dana", ownerKind: "user", slug: "dana-app" })));
    expect(words).toContain("Tick these 2 under Subscribe to events, then save.check_runworkflow_run");
    expect(view(turnedOn, app({ ownerLogin: "dana", ownerKind: "user", slug: "dana-app" }))).toContain('href="https://github.com/settings/apps/dana-app/permissions"');
  });

  it("F-006/c4: a new secret shows the first step only, unless events are missing, in its own words", () => {
    const words = text(view({ ...turnedOn, replaced: true }, app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: [] })));
    expect(words).toContain("New webhook secretostra-acmePaste it in the App's settings on GitHub. Until you do, deliveries fail.");
    expect(words).not.toContain("Events, under Permissions");
    expect(words).toContain("Done once it's pasted and saved on GitHub.");
    expect(text(view({ ...turnedOn, replaced: true }, app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: ["push"] })))).toContain("Tick this one under Subscribe to events, then save.push");
  });

  it("F-006/c4: Which ones lists the missing events again without a secret", () => {
    const html = view({ kind: "which-ones", connectionId }, app({ webhook: { kind: "receiving", lastDeliveryAt: null }, missingEvents: ["status", "push"] }));
    expect(text(html)).toContain("Tick these 2 under Subscribe to events, then save.statuspush");
    expect(html).not.toContain("webhook-secret");
    expect(html).not.toContain("webhook-url");
  });

  it("F-006/c4: on a phone its fields, copy buttons and Done are 44px", () => {
    const html = view(turnedOn, app(), true);
    expect(html).toContain("h-11");
    expect(html).toContain("size-11");
    expect(text(html)).not.toContain("Events reads On");
  });
});
