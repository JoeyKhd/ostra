import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { defaultChoice, notificationChannels } from "@ostra/domain";

import { t } from "@/lib/messages";

import { MailOffNotice, MomentsFoot, MomentsTable, NotificationPanel } from "./notification-settings";
import type { NotificationFacts } from "./notification-settings";
import { MOMENTS, choicesOf, defaultGrid, delayText, isOn, lastChangeText, momentName, sameGrid, savedGrid, withBox } from "./notification-words";
import type { ChoiceCell } from "./notification-words";

// F-036, F-115: a member's notification choices (notification-settings.md): the grid against the
// saved choices and ADR 0050's defaults, the panel always on, and "Mail is off on this install".

/** The cells as ticket 37 returns them: every kind and channel, with the domain's defaults. */
const cells = (overrides: readonly { readonly kind: string; readonly channel: string; readonly enabled: boolean }[] = []): readonly ChoiceCell[] =>
  MOMENTS.flatMap((kind) =>
    notificationChannels.map((channel) => {
      const saved = overrides.find((o) => o.kind === kind && o.channel === channel);
      return { kind, channel, enabled: saved?.enabled ?? defaultChoice(kind, channel), defaultEnabled: defaultChoice(kind, channel) };
    }),
  );

const facts: NotificationFacts = { mailOn: false, tracker: { name: "Linear" }, delaySeconds: 120, savedAt: null, instanceAdmin: false };
const noop = () => undefined;
const tags = (html: string): readonly string[] => html.match(/<button[^>]*>/g) ?? [];
const box = (html: string, label: string): string => tags(html).find((tag) => tag.includes(`aria-label="${label}"`)) ?? "";

describe("the grid", () => {
  it("F-036: shows ADR 0050's defaults: the ticket for every moment, email for the first six", () => {
    const grid = savedGrid(cells());
    expect(MOMENTS.every((kind) => isOn(grid, kind, "tracker"))).toBe(true);
    expect(MOMENTS.filter((kind) => isOn(grid, kind, "email"))).toEqual(["approval", "question", "plan", "pr_ready", "crashed", "spend_cap"]);
  });

  it("F-036: a change differs from the saved choices, and saving sends every box", () => {
    const saved = savedGrid(cells());
    const edited = withBox(saved, "plan", "email", false);
    expect(sameGrid(edited, saved)).toBe(false);
    expect(sameGrid(withBox(edited, "plan", "email", true), saved)).toBe(true);
    const sent = choicesOf(edited);
    expect(sent).toHaveLength(MOMENTS.length * 2);
    expect(sent).toContainEqual({ kind: "plan", channel: "email", enabled: false });
    expect(new Set(sent.map((choice) => choice.channel))).toEqual(new Set(["tracker", "email"]));
  });

  it("F-036: reset goes back to the defaults, not to the saved choices", () => {
    const saved = savedGrid(cells([{ kind: "stalled", channel: "email", enabled: true }]));
    expect(isOn(saved, "stalled", "email")).toBe(true);
    const reset = defaultGrid(cells([{ kind: "stalled", channel: "email", enabled: true }]));
    expect(isOn(reset, "stalled", "email")).toBe(false);
    expect(sameGrid(reset, savedGrid(cells()))).toBe(true);
  });

  it("F-036: the table has a row per moment, never the test kind, with the panel checked and disabled", () => {
    const html = renderToStaticMarkup(<MomentsTable grid={savedGrid(cells())} mailOn onChange={noop} disabled={false} />);
    for (const kind of MOMENTS) expect(html).toContain(momentName(kind));
    expect(html).not.toContain('data-moment="test"');
    const panelBoxes = tags(html).filter((tag) => tag.includes('aria-label="Panel for'));
    expect(panelBoxes).toHaveLength(MOMENTS.length);
    expect(panelBoxes.every((tag) => tag.includes('disabled=""') && tag.includes('data-state="checked"'))).toBe(true);
    expect(html).toContain('aria-label="Email for Plans"');
    expect(html).not.toContain(t("notificationSettings.emailOff"));
  });

  it("F-036: the email box of a moment that's off renders unchecked", () => {
    const grid = withBox(savedGrid(cells()), "plan", "email", false);
    const html = renderToStaticMarkup(<MomentsTable grid={grid} mailOn onChange={noop} disabled={false} />);
    expect(box(html, "Email for Plans")).toContain('data-state="unchecked"');
    expect(box(html, "Email for Approvals")).toContain('data-state="checked"');
  });
});

describe("mail off", () => {
  it("F-115: without email the page says mail is off, and the email head reads off", () => {
    expect(renderToStaticMarkup(<MailOffNotice instanceAdmin={false} />)).toContain(t("notificationSettings.mailOff"));
    expect(renderToStaticMarkup(<MailOffNotice instanceAdmin={false} />)).not.toContain("/organization/email");
    expect(renderToStaticMarkup(<MailOffNotice instanceAdmin />)).toContain('href="/organization/email"');
    const table = renderToStaticMarkup(<MomentsTable grid={savedGrid(cells())} mailOn={false} onChange={noop} disabled={false} />);
    expect(table).toContain(t("notificationSettings.emailOff"));
    // The email boxes stay enabled: the choice is kept for when mail is on.
    expect(box(table, "Email for Plans")).not.toContain('disabled=""');
  });

  it("F-115: the panel says off on this install, or on, and never the provider", () => {
    const off = renderToStaticMarkup(<NotificationPanel email="alex.kim@acme.dev" facts={facts} />);
    expect(off).toContain(t("notificationSettings.mailOffShort"));
    expect(off).toContain("alex.kim@acme.dev");
    expect(off).toContain(t("notificationSettings.addressHintTracker", { tracker: "Linear" }));
    const on = renderToStaticMarkup(<NotificationPanel email="alex.kim@acme.dev" facts={{ ...facts, mailOn: true, tracker: null }} />);
    expect(on).toContain(`>${t("notificationSettings.mailOn")}<`);
    expect(on).toContain(t("notificationSettings.noTracker"));
    expect(on).not.toMatch(/Resend|SMTP/);
  });
});

describe("the panel's words", () => {
  it("F-115: the delay in minutes, seconds or none", () => {
    expect(delayText(120)).toBe("2 min");
    expect(delayText(30)).toBe("30 s");
    expect(delayText(0)).toBe("none");
  });

  it("F-036: last change: never, or the date it was saved", () => {
    expect(lastChangeText(null)).toBe(t("notificationSettings.neverChanged"));
    expect(lastChangeText(Date.UTC(2026, 10, 12, 12))).toBe("Changed 12 Nov");
  });

  it("F-036: the foot offers reset only when asked, and says saved or the error", () => {
    expect(renderToStaticMarkup(<MomentsFoot showReset={false} onReset={noop} saved={false} error={null} />)).not.toContain(t("notificationSettings.reset"));
    expect(renderToStaticMarkup(<MomentsFoot showReset onReset={noop} saved={false} error={null} />)).toContain(t("notificationSettings.reset"));
    expect(renderToStaticMarkup(<MomentsFoot showReset={false} onReset={noop} saved error={null} />)).toContain('role="status"');
    expect(renderToStaticMarkup(<MomentsFoot showReset={false} onReset={noop} saved={false} error="Nope" />)).toContain('role="alert"');
  });
});
