import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { EmailForm, EmailPanel, LockBlock, TestSection } from "./email-settings";
import type { EmailFacts } from "./email-settings";
import { draftOf, isEdited, isLoopback, lastChangeText, problemsOf, saveInputOf, settingsList, whenText } from "./email-words";
import type { EmailDraft, EmailField, SavedEmail } from "./email-words";

// F-115: the instance's email settings (email-settings.md): off, Resend or SMTP, secrets shown only
// as set, the checks, what's saved, the test mail's result and the locked and read-only states.

const off: SavedEmail = { provider: "off", fromAddress: null, fromName: null, resendKeySet: false, smtp: { host: null, port: null, secure: null, user: null, passwordSet: false } };
const smtp: SavedEmail = {
  provider: "smtp",
  fromAddress: "ostra@acme.dev",
  fromName: "ostra",
  resendKeySet: false,
  smtp: { host: "smtp.resend.com", port: 587, secure: "starttls", user: "resend", passwordSet: true },
};
const facts: EmailFacts = {
  saved: smtp,
  lockedBy: [],
  settings: { provider: null, from: null },
  delaySeconds: 120,
  lastTest: { ok: true, by: "smtp.resend.com", at: Date.UTC(2026, 10, 19, 13, 2) },
  lastChange: { what: "smtp", by: "Alex Kim", at: Date.UTC(2026, 10, 19, 13) },
};
const noop = () => undefined;
const all: ReadonlySet<EmailField> = new Set(["host", "port", "security", "fromAddress", "apiKey"]);
const form = (draft: EmailDraft, saved: SavedEmail, extra: { readonly disabled?: boolean; readonly readOnly?: boolean } = {}) =>
  renderToStaticMarkup(<EmailForm draft={draft} saved={saved} problems={problemsOf(draft, saved)} shown={all} disabled={extra.disabled ?? false} readOnly={extra.readOnly ?? false} onDraft={noop} onTouch={noop} />);

describe("the form", () => {
  it("F-115: off by default: no provider section, no sender, the off line", () => {
    const html = form(draftOf(off), off);
    expect(html).toContain(t("email.offLine"));
    expect(html).not.toContain(t("email.sender"));
    expect(html).not.toContain(t("email.smtpTitle"));
  });

  it("F-115: SMTP shows its fields and a stored password only as set, never its value", () => {
    const html = form(draftOf(smtp), smtp);
    expect(html).toContain("smtp.resend.com");
    expect(html).toContain('value="587"');
    expect(html).toContain(`>${t("secret.set")}<`);
    expect(html).toContain(t("secret.replace"));
    expect(html).not.toContain('type="password"');
  });

  it("F-115: Resend asks for the key the first time, and refuses one that isn't re_", () => {
    const first: EmailDraft = { ...draftOf(off), provider: "resend", fromAddress: "ostra@acme.dev" };
    expect(problemsOf(first, off)).toEqual({ apiKey: "email.invalid.apiKeyMissing" });
    expect(problemsOf({ ...first, apiKey: "sk_live" }, off)).toEqual({ apiKey: "email.invalid.apiKey" });
    expect(problemsOf({ ...first, apiKey: "re_123" }, off)).toEqual({});
    const html = form({ ...first, apiKey: "sk_live" }, off);
    expect(html).toContain(t("email.invalid.apiKey"));
    expect(html).toContain('type="password"');
    expect(html).toContain(t("secret.notSet"));
  });

  it("F-115: SMTP's checks: host, port, an address, and no TLS only on this machine", () => {
    const draft = draftOf(smtp);
    expect(problemsOf(draft, smtp)).toEqual({});
    expect(problemsOf({ ...draft, host: "smtp://x" }, smtp)).toHaveProperty("host", "email.invalid.host");
    expect(problemsOf({ ...draft, port: "70000" }, smtp)).toHaveProperty("port", "email.invalid.port");
    expect(problemsOf({ ...draft, port: "0" }, smtp)).toHaveProperty("port", "email.invalid.port");
    expect(problemsOf({ ...draft, fromAddress: "ostra" }, smtp)).toHaveProperty("fromAddress", "email.invalid.fromAddress");
    expect(problemsOf({ ...draft, secure: "none" }, smtp)).toHaveProperty("security", "email.invalid.security");
    expect(problemsOf({ ...draft, secure: "none", host: "127.0.0.1" }, smtp)).toEqual({});
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("10.0.0.1")).toBe(false);
  });

  it("F-115: an untouched secret is sent as null, so the stored one stays; a typed one is sent", () => {
    const draft = draftOf(smtp);
    expect(isEdited(draft, smtp)).toBe(false);
    expect(saveInputOf(draft)).toEqual({ provider: "smtp", fromAddress: "ostra@acme.dev", fromName: "ostra", host: "smtp.resend.com", port: 587, secure: "starttls", user: "resend", password: null });
    const replaced = { ...draft, password: "hunter2" };
    expect(isEdited(replaced, smtp)).toBe(true);
    expect(saveInputOf(replaced)).toMatchObject({ password: "hunter2" });
    expect(isEdited({ ...draft, password: "" }, smtp)).toBe(false);
    expect(saveInputOf({ ...draft, provider: "off" })).toEqual({ provider: "off" });
    expect(saveInputOf({ ...draftOf(off), provider: "resend", fromAddress: "a@b.co", apiKey: "re_1" })).toEqual({ provider: "resend", fromAddress: "a@b.co", fromName: "", apiKey: "re_1" });
  });

  it("F-115: locked or read-only, the fields are disabled and a set secret has no Replace", () => {
    const html = form(draftOf(smtp), smtp, { readOnly: true });
    expect(html).not.toContain(t("secret.replace"));
    expect(html.match(/<input[^>]*>/g)?.every((input) => input.includes('disabled=""'))).toBe(true);
    expect(renderToStaticMarkup(<LockBlock lockedBy={["OSTRA_EMAIL_PROVIDER", "OSTRA_EMAIL_FROM", "OSTRA_SMTP_HOST"]} />)).toContain("OSTRA_EMAIL_PROVIDER, OSTRA_EMAIL_FROM and OSTRA_SMTP_HOST");
    expect(renderToStaticMarkup(<LockBlock lockedBy="read-only" />)).toContain(t("email.readOnly"));
    expect(settingsList(["A"])).toBe("A");
  });
});

describe("the test mail", () => {
  it("F-115: the result says who accepted it, or the provider's reason", () => {
    const at = Date.UTC(2026, 10, 19, 13, 2);
    const ok = renderToStaticMarkup(<TestSection address="alex@acme.dev" edited={false} sending={false} outcome={{ ok: true, by: "smtp.resend.com", at }} error={null} onSend={noop} />);
    expect(ok).toMatch(/Accepted by smtp\.resend\.com at \d\d:02\. Check alex@acme\.dev for it\./);
    const failed = renderToStaticMarkup(<TestSection address="alex@acme.dev" edited={false} sending={false} outcome={{ ok: false, message: "The server refused the login (535).", at }} error={null} onSend={noop} />);
    expect(failed).toContain("The server refused the login (535).");
    expect(failed).toContain("text-red");
  });

  it("F-115: unsaved changes or no address disable the test", () => {
    const edited = renderToStaticMarkup(<TestSection address="alex@acme.dev" edited sending={false} outcome={null} error={null} onSend={noop} />);
    expect(edited).toContain(t("email.saveToTest"));
    expect(/<button[^>]*>/.exec(edited)?.[0]).toContain('disabled=""');
    expect(renderToStaticMarkup(<TestSection address={null} edited={false} sending={false} outcome={null} error={null} onSend={noop} />)).toContain(t("email.noAddress"));
    expect(/<button[^>]*>/.exec(renderToStaticMarkup(<TestSection address="a@b.co" edited={false} sending={false} outcome={null} error={null} onSend={noop} />))?.[0]).not.toContain('disabled=""');
  });
});

describe("the panel", () => {
  it("F-115: status, the two settings, the last test and the last change", () => {
    const now = Date.UTC(2026, 10, 19, 15);
    const html = renderToStaticMarkup(<EmailPanel facts={facts} now={now} />);
    expect(html).toContain("On, through SMTP");
    expect(html).toContain("2 min");
    expect(html).toContain("OSTRA_EMAIL_PROVIDER");
    expect(html).toContain(t("email.unset"));
    expect(html).toContain(t("email.acceptedShort"));
    expect(html).toContain("Switched to SMTP by Alex Kim, 19 Nov");
    const locked = renderToStaticMarkup(<EmailPanel facts={{ ...facts, settings: { provider: "smtp", from: "ostra@acme.dev" }, lastTest: null, lastChange: null, saved: off }} now={now} />);
    expect(locked).toContain(">smtp<");
    expect(locked).toContain(t("email.noTest"));
    expect(locked).toContain(t("email.neverChanged"));
    expect(locked).toContain(`>${t("email.offStatus")}<`);
    expect(whenText(now - 3_600_000, now)).toMatch(/^today, /);
    expect(whenText(Date.UTC(2026, 10, 12, 12), now)).toMatch(/^12 Nov, /);
    expect(lastChangeText({ what: "off", by: "Sam Rivera", at: now })).toBe("Turned off by Sam Rivera, 19 Nov");
  });
});
