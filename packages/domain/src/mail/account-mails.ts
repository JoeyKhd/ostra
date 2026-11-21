import type { RenderedEmail } from "@ostra/adapter-sdk";

import { C, DARK_STYLE, FONT_BODY, FONT_HEADING, FONT_MONO, escapeHtml, hostOf, oneLine } from "../notifications/email-parts.ts";

// Milestone 4's mails (F-115 grown, F-002, F-037; spec section 5.4): the account mails (an
// invitation, an address's verification, a password reset) and the budget mails (a warning and
// "reached"). Each is `{ subject, html, text }` in milestone 3's look, with its link in both parts.
// No task content: an account mail carries the organization, who acted, the link and its expiry;
// a budget mail the budget, the share, the month and a link. The link of an account mail is a
// bearer link: the caller never logs the result.

/** A run of the lede: plain, or a name in weight 600. */
type LedePart = { readonly text: string; readonly strong?: boolean };

type MailWords = {
  readonly organizationName: string;
  /** The top row's right: the organization, or the install's host for a reset. */
  readonly topRight?: string;
  /** The context line over the heading, in mono: `Invitation · Acme Corp`. */
  readonly context?: string;
  readonly heading: string;
  readonly lede: string | readonly LedePart[];
  /** The block under the lede: `For` · the address. */
  readonly block?: { readonly label: string; readonly value: string };
  readonly button: string;
  readonly link: string;
  /** Below the button: the expiry, or why they got it. */
  readonly note: string;
  /** The footer's first line: why they got it (email-account.md). */
  readonly reason?: string;
  /** The footer's last line; `ostra for {organization} · {host}` by default. */
  readonly signature?: string;
  /** The hidden preheader; the heading by default. */
  readonly preheader?: string;
  readonly publicUrl: string;
};

const ledeText = (lede: MailWords["lede"]): string => (typeof lede === "string" ? lede : lede.map((part) => part.text).join(""));

/**
 * One mail in milestone 3's layout (email-account.md): the logo and the organization, then a card
 * with the context line, the heading, the lede, the address block, the button, the note and the
 * link in full; then why they got it. The same `DARK_STYLE` as the needs-you mail carries dark mode.
 */
const layout = (words: MailWords, subject: string): RenderedEmail => {
  const publicUrl = words.publicUrl.replace(/\/+$/, "");
  const organization = oneLine(words.organizationName);
  const topRight = oneLine(words.topRight ?? organization);
  const signature = words.signature ?? `ostra for ${organization} · ${hostOf(publicUrl)}`;
  const lede = ledeText(words.lede);
  const text = [
    topRight,
    "",
    ...(words.context === undefined ? [] : [words.context, ""]),
    words.heading,
    "",
    lede,
    "",
    ...(words.block === undefined ? [] : [`${words.block.label}: ${words.block.value}`, ""]),
    `${words.button}: ${words.link}`,
    "",
    words.note,
    "",
    "--",
    ...(words.reason === undefined ? [] : [words.reason]),
    signature,
    "",
  ].join("\n");
  const e = escapeHtml;
  const ledeHtml =
    typeof words.lede === "string"
      ? e(words.lede)
      : words.lede.map((part) => (part.strong === true ? `<strong style="font-weight:600;">${e(part.text)}</strong>` : e(part.text))).join("");
  const preheader = oneLine(words.preheader ?? words.heading);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(subject)}</title>
<style>
${DARK_STYLE}
</style>
</head>
<body class="o-outer" style="margin:0;padding:0;background-color:${C.shell};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${e(preheader)}${"&zwnj;&nbsp;".repeat(80)}</div>
<table class="o-outer" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.shell}" style="background-color:${C.shell};">
<tr><td align="center" style="padding:24px 16px 40px 16px;">
<table class="o-column" role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 0 20px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left"><img class="o-logo-light" src="${e(publicUrl)}/email/logo-abyss@2x.png" alt="ostra" width="93" height="20" border="0" style="display:block;color:${C.abyss};font-family:${FONT_BODY};font-size:14px;font-weight:600;"><img class="o-logo-dark" src="${e(publicUrl)}/email/logo-shell@2x.png" alt="ostra" width="93" height="20" border="0" style="display:none;mso-hide:all;"></td>
<td class="o-muted" align="right" style="font-family:${FONT_BODY};font-size:13px;color:${C.kelp};">${e(topRight)}</td>
</tr></table></td></tr>
<tr><td class="o-card o-pad" style="background-color:${C.card};border:1px solid ${C.mist};border-radius:10px;padding:32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${words.context === undefined ? "" : `<tr><td class="o-muted" style="padding-bottom:14px;font-family:${FONT_MONO};font-size:12.5px;line-height:18px;color:${C.kelp};">${e(words.context)}</td></tr>`}
<tr><td class="o-text" style="font-family:${FONT_HEADING};font-size:24px;line-height:30px;font-weight:700;color:${C.abyss};">${e(words.heading)}</td></tr>
<tr><td class="o-text" style="padding-top:10px;font-family:${FONT_BODY};font-size:15px;line-height:24px;color:${C.abyss};">${ledeHtml}</td></tr>
${
  words.block === undefined
    ? ""
    : `<tr><td style="padding-top:20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="o-code" style="background-color:${C.shell};border-left:3px solid ${C.mist};border-radius:0 7px 7px 0;padding:12px 18px;font-family:${FONT_MONO};font-size:14px;line-height:20px;word-break:break-all;"><span class="o-muted" style="color:${C.kelp};">${e(words.block.label)}</span>&nbsp;&nbsp;<span class="o-text" style="color:${C.abyss};">${e(words.block.value)}</span></td></tr></table></td></tr>`
}
<tr><td style="padding-top:24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="o-button" bgcolor="${C.abyss}" style="background-color:${C.abyss};border-radius:7px;"><a href="${e(words.link)}" style="display:inline-block;padding:10px 20px;line-height:20px;font-family:${FONT_BODY};font-size:14px;font-weight:600;color:${C.shell};text-decoration:none;">${e(words.button)}</a></td></tr></table></td></tr>
<tr><td class="o-muted" style="padding-top:16px;font-family:${FONT_BODY};font-size:13px;line-height:20px;color:${C.kelp};">${e(words.note)}</td></tr>
<tr><td style="padding-top:18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="o-line" style="border-top:1px solid ${C.hairline};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
<tr><td class="o-faint" style="padding-top:16px;font-family:${FONT_BODY};font-size:12.5px;line-height:18px;color:${C.faint};">If the button doesn't work, open this link:<br><a class="o-link" href="${e(words.link)}" style="font-family:${FONT_MONO};font-size:12.5px;color:${C.abyss};text-decoration:underline;word-break:break-all;">${e(words.link)}</a></td></tr>
</table>
</td></tr>
<tr><td class="o-faint o-pad" style="padding:24px 32px 0 32px;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${C.faint};">${words.reason === undefined ? "" : `${e(words.reason)}<br>`}${e(signature)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  return { subject, html, text };
};

/** A day as the account mails' notes write it, in UTC: "26 Nov 2026". */
const shortMailDay = (ms: number): string => {
  const date = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
  return `${String(date.getUTCDate())} ${months[date.getUTCMonth()] ?? ""} ${String(date.getUTCFullYear())}`;
};

/** A date as the mails write it, in UTC: "20 November 2026, 14:05 UTC". */
export const mailDate = (ms: number): string => {
  const date = new Date(ms);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
  const time = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return `${String(date.getUTCDate())} ${months[date.getUTCMonth()] ?? ""} ${String(date.getUTCFullYear())}, ${time} UTC`;
};

export type InvitationMailInput = {
  readonly organizationName: string;
  readonly inviterName: string;
  /** The invitation's address: the `For` block and the footer. */
  readonly address: string;
  /** The organization role it grants; `member` when not said. */
  readonly role?: "admin" | "member";
  /** The invitation's link: a bearer link. Never logged. */
  readonly link: string;
  readonly expiresAt: number;
  readonly publicUrl: string;
};

export const renderInvitationMail = (input: InvitationMailInput): RenderedEmail => {
  const organization = oneLine(input.organizationName);
  const inviter = oneLine(input.inviterName);
  const address = oneLine(input.address);
  return layout(
    {
      organizationName: organization,
      context: `Invitation · ${organization}`,
      heading: `Join ${organization} on ostra`,
      lede: [
        { text: inviter, strong: true },
        { text: " invited you to join " },
        { text: organization, strong: true },
        { text: `${input.role === "admin" ? " as an admin" : " as a member"}. ostra is where the team runs coding agents on its tickets.` },
      ],
      block: { label: "For", value: address },
      button: "Accept the invitation",
      link: input.link,
      note: `The link works once, until ${mailDate(input.expiresAt)}. Anyone who has it can join as you, so don't forward this mail.`,
      reason: `You get this because ${inviter} invited ${address}. If you didn't expect it, ignore it: nothing happens.`,
      preheader: `Join ${organization} on ostra · the link works until ${shortMailDay(input.expiresAt)}`,
      publicUrl: input.publicUrl,
    },
    `${inviter} invited you to ${organization} on ostra`,
  );
};

export type VerificationMailInput = {
  readonly organizationName: string;
  /** The address to confirm, and the username it signed up as. */
  readonly address: string;
  readonly username: string;
  /** The verification link: a bearer link. Never logged. */
  readonly link: string;
  readonly expiresAt: number;
  readonly publicUrl: string;
};

export const renderVerificationMail = (input: VerificationMailInput): RenderedEmail => {
  const organization = oneLine(input.organizationName);
  const address = oneLine(input.address);
  return layout(
    {
      organizationName: organization,
      context: `Verification · ${organization}`,
      heading: "Confirm your address",
      lede: [
        { text: "You signed up as " },
        { text: oneLine(input.username), strong: true },
        { text: " to join " },
        { text: organization, strong: true },
        { text: ". Confirm that this address is yours, and your membership starts." },
      ],
      block: { label: "For", value: address },
      button: "Confirm my address",
      link: input.link,
      note: `The link works once, until ${mailDate(input.expiresAt)}. Until then you can sign in, but you won't see ${organization}.`,
      reason: `You get this because ${address} signed up through an invitation to ${organization}. If it wasn't you, ignore it: nothing happens.`,
      preheader: `One click and you're in ${organization}`,
      publicUrl: input.publicUrl,
    },
    `Confirm your address to join ${organization}`,
  );
};

export type ResetMailInput = {
  readonly organizationName: string;
  /** The account's address. */
  readonly address: string;
  /** The reset link: a bearer link. Never logged. */
  readonly link: string;
  readonly expiresAt: number;
  /** `OSTRA_RESET_LINK_HOURS`, written from the setting. */
  readonly hours?: number;
  readonly publicUrl: string;
};

export const renderPasswordResetMail = (input: ResetMailInput): RenderedEmail => {
  const organization = oneLine(input.organizationName);
  const address = oneLine(input.address);
  const host = hostOf(input.publicUrl.replace(/\/+$/, ""));
  const hours = input.hours ?? 24;
  return layout(
    {
      organizationName: organization,
      // An account may belong to several organizations: the reset names the install.
      topRight: host,
      context: `Password reset · ${host}`,
      heading: "Reset your password",
      lede: `Someone asked to reset the password of your ostra account at ${host}.`,
      block: { label: "For", value: address },
      button: "Choose a new password",
      link: input.link,
      note: `The link works once, for ${String(hours)} hours. A new password signs you out everywhere else, the CLI included.`,
      reason: `You get this because a reset was asked for ${address}. If it wasn't you, ignore it: your password stays as it is.`,
      signature: `ostra · ${host}`,
      preheader: `For ${address} on ${host} · the link works for ${String(hours)} hours`,
      publicUrl: input.publicUrl,
    },
    "Reset your ostra password",
  );
};

export type BudgetMailInput = {
  readonly organizationName: string;
  /** The budget's name: the organization's, or the project's name. */
  readonly budgetName: string;
  /** `YYYY-MM`. */
  readonly month: string;
  /** The month's spend so far, as a share of the budget, in whole percent. */
  readonly percent: number;
  readonly spent: string;
  readonly budget: string;
  /** The budget page. */
  readonly link: string;
  readonly publicUrl: string;
};

const monthName = (month: string): string => {
  const [year, index] = month.split("-");
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
  return `${names[Number(index) - 1] ?? month} ${year ?? ""}`.trim();
};

export const renderBudgetWarningMail = (input: BudgetMailInput): RenderedEmail => {
  const name = oneLine(input.budgetName);
  const month = monthName(input.month);
  return layout(
    {
      organizationName: input.organizationName,
      heading: `${name} is at ${String(input.percent)}% of its budget`,
      lede: `${name} has spent ${input.spent} of its ${input.budget} budget for ${month}. At 100%, no new task or turn starts in it until the budget is raised or the month ends.`,
      button: "Open Spend",
      link: input.link,
      note: `Budgets count every task's tokens at the model's prices, in UTC months. You get this because you're an admin of ${name}.`,
      publicUrl: input.publicUrl,
    },
    `${name} is at ${String(input.percent)}% of its budget`,
  );
};

export const renderBudgetReachedMail = (input: BudgetMailInput): RenderedEmail => {
  const name = oneLine(input.budgetName);
  const month = monthName(input.month);
  return layout(
    {
      organizationName: input.organizationName,
      heading: `${name} reached its budget`,
      lede: `${name} has spent ${input.spent} of its ${input.budget} budget for ${month}. New tasks wait and new turns are held, in order; running turns finish.`,
      // Decided 2026-11-19 (ticket 13): only admins of the budget's scope get it, so they can raise it.
      button: "Raise the budget",
      link: input.link,
      note: `Raising it lets the held turns go in the order they were held. You get this because you're an admin of ${name}.`,
      publicUrl: input.publicUrl,
    },
    `${name} reached its budget`,
  );
};
