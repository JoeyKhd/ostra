import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cliLine } from "@/lib/cli-line";
import { t } from "@/lib/messages";

import { TakeItLocalCard, gitLines } from "../tasks/take-it-local";
import type { LocalView } from "../tasks/take-it-local";
import { AccountPanel, CliSessionsSection, GitHubSection } from "./account";
import { expiresText, linkReturnOf, linkReturnText, noReplyAddress } from "./account-words";
import type { CliSessionView, GitHubLinkView } from "./account-words";

// F-028, F-103, F-119: take it local (take-it-local.md) and Account (account.md): the checkout line
// and the git commands, the login hint, the GitHub link and the CLI sessions.

const now = Date.UTC(2026, 10, 19, 12);
const day = 86_400_000;
const esc = (text: string): string => text.replaceAll("'", "&#x27;");
const noop = () => undefined;
const yes = () => Promise.resolve(true);

const local: LocalView = {
  checkoutLine: "ostra checkout OST-142",
  loginLine: cliLine("login --server https://ostra.acme.dev"),
  hasCliSession: false,
  repos: [
    { fullName: "acme/calculator-web", branch: "ostra/ost-142-4b7e", mergedPr: null },
    { fullName: "acme/calculator-api", branch: "ostra/ost-142-4b7e", mergedPr: 91 },
  ],
};

describe("take it local", () => {
  it("F-028: the checkout line, and per repo the plain git commands to copy", () => {
    const html = renderToStaticMarkup(<TakeItLocalCard load={{ kind: "ready", local }} />);
    expect(html).toContain("ostra checkout OST-142");
    expect(html).toContain('data-copy="ostra checkout OST-142"');
    expect(html).toContain("acme/calculator-web");
    expect(html).toContain("acme/calculator-api");
    expect(gitLines("ostra/ost-142-4b7e")).toBe("git fetch origin ostra/ost-142-4b7e\ngit switch ostra/ost-142-4b7e");
    expect(html).toContain(`data-copy="${gitLines("ostra/ost-142-4b7e")}"`);
    expect(html).toContain(t("takeLocal.git"));
    expect(html).toContain(t("takeLocal.merged", { n: 91 }));
    expect(html).toContain(t("takeLocal.reopen"));
  });

  it("F-103: the ostra login hint and its line show only without a CLI session", () => {
    const without = renderToStaticMarkup(<TakeItLocalCard load={{ kind: "ready", local }} />);
    expect(without).toContain("ostra login");
    expect(without).toContain("pnpm ostra login --server https://ostra.acme.dev");
    const withSession = renderToStaticMarkup(<TakeItLocalCard load={{ kind: "ready", local: { ...local, hasCliSession: true, repos: [local.repos[0] ?? local.repos[1] ?? { fullName: "x", branch: "y", mergedPr: null }] } }} />);
    expect(withSession).not.toContain("--server");
    expect(withSession).toContain(`>${t("takeLocal.gitOne")}<`);
  });

  it("F-028: loading shows skeletons with copy disabled; an error says why and nothing else", () => {
    const loading = renderToStaticMarkup(<TakeItLocalCard load={{ kind: "loading" }} />);
    expect(loading).toContain('disabled=""');
    const error = renderToStaticMarkup(<TakeItLocalCard load={{ kind: "error", message: "No access." }} />);
    expect(error).toContain('role="alert"');
    expect(error).not.toContain(t("takeLocal.cli"));
  });
});

const linked: GitHubLinkView = { connected: true, link: { login: "alexkim", githubUserId: "5829104", linkedAt: Date.UTC(2026, 10, 12, 10) } };
const section = (github: GitHubLinkView | undefined, extra: { readonly admin?: boolean; readonly back?: Parameters<typeof GitHubSection>[0]["back"] } = {}) =>
  renderToStaticMarkup(<GitHubSection github={github} admin={extra.admin ?? false} back={extra.back ?? null} unlinked={false} unlink={{ kind: "idle" }} onUnlink={yes} onUnlinkReset={noop} />);

describe("the GitHub link", () => {
  it("F-119: linked shows the login, the ID and the no-reply address commits credit", () => {
    const html = section(linked);
    expect(html).toContain("@alexkim");
    expect(html).toContain("ID 5829104 · 12 Nov");
    expect(noReplyAddress("5829104", "alexkim")).toBe("5829104+alexkim@users.noreply.github.com");
    expect(html).toContain("5829104+alexkim@users.noreply.github.com");
    expect(html).toContain(t("account.github.unlink"));
  });

  it("F-119: not linked offers the link through /api/github/link/start", () => {
    const html = section({ connected: true, link: null });
    expect(html).toContain('href="/api/github/link/start"');
    expect(html).toContain(esc(t("account.github.helpNotLinked")));
  });

  it("F-119: GitHub not connected: admins get Connect GitHub, members are told to ask", () => {
    expect(section({ connected: false, link: null }, { admin: true })).toContain('href="/organization/github"');
    expect(section({ connected: false, link: null })).toContain(t("account.github.askAdmin"));
  });

  it("F-119: the callback's return reads in words: linked, taken, revoke failed, failed", () => {
    expect(linkReturnOf("taken")).toBe("taken");
    expect(linkReturnOf("anything")).toBeNull();
    expect(linkReturnOf(null)).toBeNull();
    expect(linkReturnText("linked", "alexkim")).toBe("Linked as @alexkim.");
    expect(section(linked, { back: "linked" })).toContain('role="status"');
    expect(section({ connected: true, link: null }, { back: "taken" })).toContain(t("account.github.back.taken"));
    expect(section({ connected: true, link: null }, { back: "revoke-failed" })).toContain('role="alert"');
  });
});

const sessions: readonly CliSessionView[] = [
  { id: "s1", name: "alex-mbp", createdAt: Date.UTC(2026, 10, 12), lastUsedAt: now - 4 * 60_000, expiresAt: Date.UTC(2026, 11, 12) },
  { id: "s2", name: null, createdAt: Date.UTC(2026, 9, 21), lastUsedAt: null, expiresAt: now + 2 * day - 1000 },
];

describe("CLI sessions", () => {
  const render = (list: readonly CliSessionView[] | undefined) =>
    renderToStaticMarkup(<CliSessionsSection sessions={list} days={30} loginLine={cliLine("login --server https://ostra.acme.dev")} now={now} revoke={{ kind: "idle" }} revoked={false} onRevoke={yes} onRevokeReset={noop} />);

  it("F-103: each session with its machine, created, last used, expiry and Revoke", () => {
    const html = render(sessions);
    expect(html).toContain("alex-mbp");
    expect(html).toContain(t("account.cli.unnamed"));
    expect(html).toContain("4m ago");
    expect(html).toContain(t("account.cli.never"));
    expect(html).toContain("12 Dec");
    expect(html).toContain("in 2 days");
    expect(html.match(new RegExp(t("account.cli.revoke"), "g"))?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("made by ostra login, valid for 30 days");
    expect(html).toContain("pnpm ostra login --server https://ostra.acme.dev");
  });

  it("F-103: none: the empty line, and the line to sign in a first machine", () => {
    const html = render([]);
    expect(html).toContain(t("account.cli.none"));
    expect(html).toContain(t("account.cli.first"));
    expect(expiresText(now + 10 * day, now)).toEqual({ text: "29 Nov", soon: false });
    expect(expiresText(now + 3600_000, now)).toEqual({ text: "in 1 day", soon: true });
  });

  it("F-103: the panel counts the active sessions and their length", () => {
    const html = renderToStaticMarkup(<AccountPanel me={{ name: "Alex Kim", email: "alex@acme.dev", role: "admin", organization: "Acme Corp" }} github={linked} sessions={2} days={30} />);
    expect(html).toContain("Admin of Acme Corp");
    expect(html).toContain(">2<");
    expect(html).toContain("30 days");
    expect(html).toContain("@alexkim");
    expect(renderToStaticMarkup(<AccountPanel me={{ name: "Sam", email: null, role: "member", organization: "Acme Corp" }} github={{ connected: true, link: null }} sessions={0} days={1} />)).not.toContain(t("account.panel.githubLink"));
  });
});
