import type { RenderedEmail } from "@ostra/adapter-sdk";

// Milestone 4's mails (F-115 grown, F-002, F-037; spec section 5.4): the account mails (an
// invitation, an address's verification, a password reset) and the budget mails (a warning and
// "reached"). Each is `{ subject, html, text }` in milestone 3's look, with its link in both parts.
// No task content: an account mail carries the organization, who acted, the link and its expiry;
// a budget mail the budget, the share, the month and a link. The link of an account mail is a
// bearer link: the caller never logs the result.

/** The brand's colours, as milestone 3's needs-you mail uses them (`brief.md`). */
const C = { shell: "#F3F0E8", abyss: "#0C1D21", kelp: "#2F4A47", faint: "#5F6B68", mist: "#CFD8D4", card: "#FFFFFF", amber: "#FFB224" } as const;
const FONT_HEADING = "Manrope, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const FONT_BODY = "'IBM Plex Sans', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const oneLine = (text: string): string => text.replaceAll(/[\r\n\t]+/g, " ").replaceAll(/\s{2,}/g, " ").trim();

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

type MailWords = {
  readonly organizationName: string;
  readonly heading: string;
  readonly lede: string;
  readonly button: string;
  readonly link: string;
  /** Below the button: the expiry, or why they got it. */
  readonly note: string;
  readonly publicUrl: string;
};

/** One mail in milestone 3's layout: a card with a heading, a lede, a button and the link in full. */
const layout = (words: MailWords, subject: string): RenderedEmail => {
  const publicUrl = words.publicUrl.replace(/\/+$/, "");
  const organization = oneLine(words.organizationName);
  const text = [
    organization,
    "",
    words.heading,
    "",
    words.lede,
    "",
    `${words.button}: ${words.link}`,
    "",
    words.note,
    "",
    "--",
    `ostra for ${organization} · ${hostOf(publicUrl)}`,
    "",
  ].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${e(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${C.shell};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.shell}" style="background-color:${C.shell};">
<tr><td align="center" style="padding:24px 0 40px 0;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 0 20px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left"><img src="${e(publicUrl)}/email/logo-abyss@2x.png" alt="ostra" width="93" height="20" border="0" style="display:block;color:${C.abyss};font-family:${FONT_BODY};font-size:14px;font-weight:600;"></td>
<td align="right" style="font-family:${FONT_BODY};font-size:12.5px;color:${C.kelp};">${e(organization)}</td>
</tr></table></td></tr>
<tr><td style="background-color:${C.card};border:1px solid ${C.mist};border-radius:10px;padding:32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="font-family:${FONT_HEADING};font-size:24px;line-height:30px;font-weight:700;color:${C.abyss};">${e(words.heading)}</td></tr>
<tr><td style="padding-top:10px;font-family:${FONT_BODY};font-size:15px;line-height:24px;color:${C.abyss};">${e(words.lede)}</td></tr>
<tr><td style="padding-top:24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.abyss}" style="background-color:${C.abyss};border-radius:7px;"><a href="${e(words.link)}" style="display:inline-block;padding:10px 20px;line-height:20px;font-family:${FONT_BODY};font-size:13.5px;font-weight:600;color:${C.shell};text-decoration:none;">${e(words.button)}</a></td></tr></table></td></tr>
<tr><td style="padding-top:16px;font-family:${FONT_BODY};font-size:13px;line-height:20px;color:${C.kelp};">${e(words.note)}</td></tr>
<tr><td style="padding-top:16px;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${C.faint};">If the button doesn't work, open this link:<br><a href="${e(words.link)}" style="font-family:${FONT_MONO};font-size:12px;color:${C.abyss};text-decoration:underline;word-break:break-all;">${e(words.link)}</a></td></tr>
</table>
</td></tr>
<tr><td style="padding:24px 32px 0 32px;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${C.faint};">${e(`ostra for ${organization} · ${hostOf(publicUrl)}`)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  return { subject, html, text };
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
  /** The invitation's link: a bearer link. Never logged. */
  readonly link: string;
  readonly expiresAt: number;
  readonly publicUrl: string;
};

export const renderInvitationMail = (input: InvitationMailInput): RenderedEmail => {
  const organization = oneLine(input.organizationName);
  const inviter = oneLine(input.inviterName);
  return layout(
    {
      organizationName: organization,
      heading: `Join ${organization} on ostra`,
      lede: `${inviter} invited you to ${organization} on ostra, where the team's coding agents work its tickets.`,
      button: "Accept the invitation",
      link: input.link,
      note: `The link works once, until ${mailDate(input.expiresAt)}. If you didn't expect it, ignore this mail.`,
      publicUrl: input.publicUrl,
    },
    `${inviter} invited you to ${organization} on ostra`,
  );
};

export type VerificationMailInput = {
  readonly organizationName: string;
  /** The verification link: a bearer link. Never logged. */
  readonly link: string;
  readonly expiresAt: number;
  readonly publicUrl: string;
};

export const renderVerificationMail = (input: VerificationMailInput): RenderedEmail => {
  const organization = oneLine(input.organizationName);
  return layout(
    {
      organizationName: organization,
      heading: "Confirm your address",
      lede: `Confirm this address to finish joining ${organization} on ostra.`,
      button: "Confirm the address",
      link: input.link,
      note: `The link works once, until ${mailDate(input.expiresAt)}.`,
      publicUrl: input.publicUrl,
    },
    `Confirm your address for ${organization} on ostra`,
  );
};

export type ResetMailInput = {
  readonly organizationName: string;
  /** The reset link: a bearer link. Never logged. */
  readonly link: string;
  readonly expiresAt: number;
  readonly publicUrl: string;
};

export const renderPasswordResetMail = (input: ResetMailInput): RenderedEmail => {
  const organization = oneLine(input.organizationName);
  return layout(
    {
      organizationName: organization,
      heading: "Reset your password",
      lede: "Someone asked to reset the password of your ostra account. Choose a new one with the button below; it signs you out everywhere else.",
      button: "Choose a new password",
      link: input.link,
      note: `The link works once, until ${mailDate(input.expiresAt)}. If you didn't ask, ignore this mail: your password stays as it is.`,
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
