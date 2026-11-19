import type { NotificationKind, RenderedEmail } from "@ostra/adapter-sdk";
import type { ApprovalSubject } from "@ostra/protocol";

import type { AudienceReason } from "./choices.ts";
import { C, cut, DARK_STYLE, escapeHtml, FONT_BODY, FONT_HEADING, FONT_MONO, hostOf, oneLine } from "./email-parts.ts";
import { momentHeading } from "./moments.ts";

// The needs-you mails (ADR 0050, F-115; the build spec `context/brand/app-targets/m3/email-needs-you.md`):
// one pure renderer for every moment, giving a subject, an HTML body (inline styles, a table layout,
// the brand's colours, the lockup served from the install's own address, a dark-mode override) and a
// text part with the same content. A mail carries the organization, the project, the task's title
// and key, the moment, one line about it and a link: never ticket text, agent output, a plan's
// text, a diff, check output or a comment. No action buttons: every answer is made signed in.

/** One line about the moment, per kind: never the moment's own text (a question's, a plan's). */
export type MomentDetail =
  | { readonly kind: "approval"; readonly subject: ApprovalSubject }
  | { readonly kind: "question"; readonly askedAt: string }
  | { readonly kind: "plan"; readonly steps: number }
  | { readonly kind: "pr_ready"; readonly pullRequests: number }
  | { readonly kind: "no_changes" }
  | { readonly kind: "stalled"; readonly minutes: number }
  | { readonly kind: "spend_cap"; readonly spent: string }
  | { readonly kind: "crashed" }
  | { readonly kind: "setup_failed" }
  | { readonly kind: "ticket_closed"; readonly status: string }
  | { readonly kind: "test" };

export type NeedsYouEmailInput = {
  readonly detail: MomentDetail;
  readonly organizationName: string;
  /** The project's name; for a test mail, `null`. */
  readonly projectName: string | null;
  /** The task: its title, its ticket's key or `null`, its page. For a test mail, `null`. */
  readonly task: { readonly title: string; readonly key: string | null; readonly url: string } | null;
  /** Why this member gets it, for the footer. */
  readonly reason: AudienceReason;
  /** `OSTRA_PUBLIC_URL`, without a trailing slash: the lockup and the links are served from it. */
  readonly publicUrl: string;
};

/** The longest the one line may be, before it's cut with `…` (ADR 0050). */
export const ONE_LINE_MAX_CHARS = 200;

/** The longest the mail's subject may be, before it's cut with `…` (the m3 email build spec). */
export const SUBJECT_MAX_CHARS = 120;

type Words = {
  readonly heading: string;
  readonly lede: (title: string) => { readonly before: string; readonly after: string };
  readonly line: { readonly verb: string; readonly subject: string } | null;
  readonly button: string;
  readonly note: (project: string) => string;
};

const approvalVerb = (subject: ApprovalSubject): { readonly verb: string; readonly lede: string } => {
  switch (subject.kind) {
    case "path":
      return { verb: "Edit", lede: "edits a file" };
    case "command":
      return { verb: "Run", lede: "runs a command" };
    case "url":
      return { verb: "Fetch", lede: "reaches a website" };
    case "tool":
      return { verb: "Use", lede: "uses a tool" };
    default:
      return subject.kind satisfies never;
  }
};

const words = (detail: MomentDetail): Words => {
  const lede = (before: string, after: string) => () => ({ before, after });
  switch (detail.kind) {
    case "approval": {
      const verb = approvalVerb(detail.subject);
      return {
        heading: momentHeading.approval,
        lede: lede("The agent on ", ` asks before it ${verb.lede}.`),
        line: { verb: verb.verb, subject: detail.subject.kind === "url" ? hostOf(detail.subject.value) : detail.subject.value },
        button: "Open the approval",
        note: (project) => `Answer it signed in, on the task page. Any member of ${project} can answer.`,
      };
    }
    case "question":
      return {
        heading: momentHeading.question,
        lede: lede("The agent on ", " has a question, and waits for your answer."),
        line: { verb: `Asked at ${detail.askedAt}`, subject: "waits until answered" },
        button: "Answer the question",
        note: () => "Answer it signed in, on the task page.",
      };
    case "plan":
      return {
        heading: momentHeading.plan,
        lede: lede("The agent on ", " proposed a plan, and waits for it before it changes anything."),
        line: { verb: "Plan first", subject: `${String(detail.steps)} step${detail.steps === 1 ? "" : "s"}` },
        button: "Review the plan",
        note: () => "Approve it, edit it or ask for changes, signed in, on the task page.",
      };
    case "pr_ready":
      return {
        heading: momentHeading.pr_ready,
        lede: lede("The agent finished ", " and opened its pull request for review."),
        line: { verb: "Ready", subject: `${String(detail.pullRequests)} pull request${detail.pullRequests === 1 ? "" : "s"}` },
        button: "Open the task",
        note: () => "Review it on the code host, or ask for changes on the task page.",
      };
    case "no_changes":
      return {
        heading: momentHeading.no_changes,
        lede: lede("The agent on ", " ended without changes."),
        line: { verb: "No changes", subject: "nothing to open a pull request for" },
        button: "Open the task",
        note: () => "Read what it said, and reply or reopen it on the task page.",
      };
    case "stalled":
      return {
        heading: momentHeading.stalled,
        lede: lede("The agent on ", " stopped making progress, so ostra stopped it."),
        line: { verb: "Stalled", subject: `no progress for ${String(detail.minutes)} minutes` },
        button: "Open the task",
        note: () => "Reopen it with a message on the task page.",
      };
    case "spend_cap":
      return {
        heading: momentHeading.spend_cap,
        lede: lede("The agent on ", " used the task's whole budget, so ostra stopped it."),
        line: { verb: "Spent", subject: detail.spent },
        button: "Open the task",
        note: () => "Raise the cap or reopen it on the task page.",
      };
    case "crashed":
      return {
        heading: momentHeading.crashed,
        lede: lede("The agent on ", " stopped unexpectedly."),
        line: { verb: "Crashed", subject: "its work so far was saved" },
        button: "Open the task",
        note: () => "Reopen it on the task page to carry on.",
      };
    case "setup_failed":
      return {
        heading: momentHeading.setup_failed,
        lede: lede("The setup for ", " failed before the agent started."),
        line: { verb: "Setup", subject: "the environment's script failed" },
        button: "Open the task",
        note: () => "Fix the environment, then reopen the task.",
      };
    case "ticket_closed":
      return {
        heading: momentHeading.ticket_closed,
        lede: lede("The ticket of ", " was closed, so ostra paused the agent."),
        line: { verb: "Ticket", subject: cut(detail.status, 60) },
        button: "Open the task",
        note: () => "Stop the task, or keep it working, on the task page.",
      };
    case "test":
      return {
        heading: momentHeading.test,
        lede: lede("This is a test from ostra at ", ". Nothing needs you."),
        line: null,
        button: "Open ostra",
        note: () => "",
      };
    default:
      return detail satisfies never;
  }
};

/** The mail of one moment: its subject, its HTML and its text part. */
export const renderNeedsYouEmail = (input: NeedsYouEmailInput): RenderedEmail => {
  const detail = input.detail;
  const w = words(detail);
  const publicUrl = input.publicUrl.replace(/\/+$/, "");
  const installHost = hostOf(publicUrl);
  const title = input.task === null ? "" : oneLine(input.task.title);
  const key = input.task?.key ?? null;
  const project = input.projectName === null ? "" : oneLine(input.projectName);
  const link = input.task?.url ?? publicUrl;
  const subjectTail = input.task === null ? installHost : key === null ? title : `${key} ${title}`;
  const subject = cut(`${w.heading} · ${subjectTail}`, SUBJECT_MAX_CHARS);
  const context = [project, key].filter((part): part is string => part !== null && part !== "").join(" · ");
  const lineText = w.line === null ? null : { verb: w.line.verb, subject: cut(w.line.subject, ONE_LINE_MAX_CHARS) };
  const preheader = cut([context, lineText === null ? null : `${lineText.verb} ${lineText.subject}`].filter((part) => part !== null && part !== "").join(" · "), 200);
  const ledeParts = w.lede(title);
  const ledeSubject = input.task === null ? installHost : title;
  const note = w.note(project);
  const why =
    detail.kind === "test"
      ? "You get this because you asked for a test mail."
      : input.reason === "driver"
        ? "You get this because you drive this task."
        : `You get this because you're a member of ${project}.`;
  const notificationsUrl = `${publicUrl}/account/notifications`;
  const install = `ostra for ${oneLine(input.organizationName)} · ${installHost}`;

  // ---------- the text part ----------
  const text = [
    oneLine(input.organizationName),
    context === "" ? null : context,
    "",
    w.heading,
    "",
    `${ledeParts.before}${ledeSubject}${ledeParts.after}`,
    lineText === null ? null : `${lineText.verb}: ${lineText.subject}`,
    "",
    `${w.button}: ${link}`,
    note === "" ? null : note,
    "",
    "--",
    `${why} Choose which moments mail you in Notifications: ${notificationsUrl}`,
    install,
    "",
  ]
    .filter((part): part is string => part !== null)
    .join("\n");

  // ---------- the HTML ----------
  const e = escapeHtml;
  const pill =
    detail.kind === "test"
      ? ""
      : `<span style="display:inline-block;background-color:${C.amber};color:${C.abyss};font-family:${FONT_BODY};font-size:11px;font-weight:600;line-height:20px;height:20px;padding:0 8px;border-radius:4px;">Needs you</span>`;
  const contextHtml =
    context === ""
      ? ""
      : `<span class="o-muted" style="font-family:${FONT_MONO};font-size:12px;color:${C.kelp};padding-left:${pill === "" ? "0" : "10px"};">${e(context)}</span>`;
  const lineHtml =
    lineText === null
      ? ""
      : `<tr><td style="padding-top:20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="o-code" style="background-color:${C.shell};border-left:3px solid ${C.amber};border-radius:0 7px 7px 0;padding:12px 14px;font-family:${FONT_MONO};font-size:13px;line-height:20px;word-break:break-all;"><span class="o-muted" style="color:${C.kelp};">${e(lineText.verb)}</span> <span class="o-text" style="color:${C.abyss};">${e(lineText.subject)}</span></td></tr></table></td></tr>`;
  const noteHtml =
    note === ""
      ? ""
      : `<tr><td class="o-muted" style="padding-top:16px;font-family:${FONT_BODY};font-size:13px;line-height:20px;color:${C.kelp};">${e(note)}</td></tr>`;
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
<body style="margin:0;padding:0;background-color:${C.shell};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${e(preheader)}${"&zwnj;&nbsp;".repeat(80)}</div>
<table role="presentation" class="o-outer" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.shell}" style="background-color:${C.shell};">
<tr><td align="center" style="padding:24px 0 40px 0;">
<table role="presentation" class="o-column" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 0 20px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left"><img class="o-logo-light" src="${e(publicUrl)}/email/logo-abyss@2x.png" alt="ostra" width="93" height="20" border="0" style="display:block;color:${C.abyss};font-family:${FONT_BODY};font-size:14px;font-weight:600;"><img class="o-logo-dark" src="${e(publicUrl)}/email/logo-shell@2x.png" alt="ostra" width="93" height="20" border="0" style="display:none;mso-hide:all;"></td>
<td align="right" class="o-muted" style="font-family:${FONT_BODY};font-size:12.5px;color:${C.kelp};">${e(oneLine(input.organizationName))}</td>
</tr></table>
</td></tr>
<tr><td class="o-card o-pad" style="background-color:${C.card};border:1px solid ${C.mist};border-radius:10px;padding:32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td>${pill}${contextHtml}</td></tr>
<tr><td class="o-text" style="padding-top:16px;font-family:${FONT_HEADING};font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.01em;color:${C.abyss};">${e(w.heading)}</td></tr>
<tr><td class="o-text" style="padding-top:10px;font-family:${FONT_BODY};font-size:15px;line-height:24px;color:${C.abyss};">${e(ledeParts.before)}<strong style="font-weight:600;">${e(ledeSubject)}</strong>${e(ledeParts.after)}</td></tr>
${lineHtml}
<tr><td style="padding-top:24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="o-button" bgcolor="${C.abyss}" style="background-color:${C.abyss};border-radius:7px;"><a href="${e(link)}" style="display:inline-block;padding:10px 20px;line-height:20px;font-family:${FONT_BODY};font-size:13.5px;font-weight:600;color:${C.shell};text-decoration:none;">${e(w.button)}</a></td></tr></table></td></tr>
${noteHtml}
<tr><td style="padding-top:24px;"><div class="o-line" style="border-top:1px solid ${C.hairline};height:0;line-height:0;font-size:0;">&nbsp;</div></td></tr>
<tr><td class="o-faint" style="padding-top:16px;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${C.faint};">If the button doesn't work, open this link:<br><a class="o-link" href="${e(link)}" style="font-family:${FONT_MONO};font-size:12px;color:${C.abyss};text-decoration:underline;word-break:break-all;">${e(link)}</a></td></tr>
</table>
</td></tr>
<tr><td class="o-faint o-pad" style="padding:24px 32px 0 32px;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${C.faint};">${e(why)} Choose which moments mail you in <a class="o-link" href="${e(notificationsUrl)}" style="color:${C.abyss};text-decoration:underline;">Notifications</a>.<br>${e(install)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  return { subject, html, text };
};

/** Every kind a mail renders, for tests and the template list. */
export const emailKinds: readonly NotificationKind[] = [
  "approval",
  "question",
  "plan",
  "pr_ready",
  "no_changes",
  "stalled",
  "spend_cap",
  "crashed",
  "setup_failed",
  "ticket_closed",
  "test",
];
