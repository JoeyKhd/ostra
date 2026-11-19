import { formatAge } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

import { shortDate } from "./notification-words";

// Account's pure parts (account.md, F-119, F-103, ADRs 0051 and 0052): the no-reply address, the
// link's return in words, and a CLI session's dates.

/** The verified link as ticket 39's `account.github.get` returns it. */
export type GitHubLinkView = {
  /** Whether GitHub is connected to this install at all. */
  readonly connected: boolean;
  readonly link: { readonly login: string; readonly githubUserId: string; readonly linkedAt: number } | null;
};

/** One CLI session (ticket 39's `account.cliSessions.list`). Revoked and expired ones aren't listed. */
export type CliSessionView = {
  readonly id: string;
  /** The machine's name the CLI sent, or `null` when it sent none. */
  readonly name: string | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number;
};

/** The address commits from the member's tasks credit (ADR 0052): `<id>+<login>@users.noreply.github.com`. */
export const noReplyAddress = (githubUserId: string, login: string): string => `${githubUserId}+${login}@users.noreply.github.com`;

/** `?github=…` after the link's callback, in words; the query is cleared once read. */
export type LinkReturn = "linked" | "taken" | "revoke-failed" | "failed";

const LINK_RETURNS: readonly LinkReturn[] = ["linked", "taken", "revoke-failed", "failed"];

export const linkReturnOf = (value: string | null): LinkReturn | null => LINK_RETURNS.find((known) => known === value) ?? null;

export const linkReturnText = (back: LinkReturn, login: string | null): string => {
  switch (back) {
    case "linked":
      return t("account.github.back.linked", { login: login ?? "" });
    case "taken":
      return t("account.github.back.taken");
    case "revoke-failed":
      return t("account.github.back.revokeFailed");
    case "failed":
      return t("account.github.back.failed");
    default:
      return back satisfies never;
  }
};

const DAY = 86_400_000;

/** `12 Dec`, or `in 2 days` within three days (in `--text`: never amber or red, nothing is wrong yet). */
export const expiresText = (expiresAt: number, now: number): { readonly text: string; readonly soon: boolean } => {
  const left = expiresAt - now;
  if (left > 3 * DAY) return { text: shortDate(expiresAt), soon: false };
  const days = Math.max(0, Math.ceil(left / DAY));
  return { text: days === 0 ? t("account.cli.today") : plural(days, "account.cli.inDays.one", "account.cli.inDays.other"), soon: true };
};

/** `4m ago`, `2d ago`, or `never`. */
export const lastUsedText = (lastUsedAt: number | null, now: number): string | null => (lastUsedAt === null ? null : t("account.cli.ago", { age: formatAge(lastUsedAt, now) }));

export const roleText = (role: "admin" | "member", organization: string): string =>
  t((role === "admin" ? "account.panel.admin" : "account.panel.member") satisfies MessageKey, { organization });
