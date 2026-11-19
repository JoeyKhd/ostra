import type { RenderedEmail, RunnerNoticeSubject, RunnerNotificationKind } from "@ostra/adapter-sdk";
import type { ExecutorKind } from "@ostra/protocol";

import { C, cut, DARK_STYLE, escapeHtml, FONT_BODY, FONT_HEADING, FONT_MONO, hostOf, oneLine } from "./email-parts.ts";

// The runner notices (F-091, milestone 5's ticket 03): a runner joined a pool, or joined one that
// requires approval and waits for an admin. One pure renderer gives the panel's words and the mail's
// three parts, so they never say it differently. They name the runner, its pool, its executor, the
// join token's label and the runner's page: never the token, the runner's key or a credential,
// which the input has no field for.

export type RunnerNoticeInput = {
  readonly kind: RunnerNotificationKind;
  readonly runner: RunnerNoticeSubject;
  readonly organizationName: string;
  /** `OSTRA_PUBLIC_URL`, without a trailing slash: the lockup and the links are served from it. */
  readonly publicUrl: string;
};

/** What the panel shows for the notice: its title, one line, and where it opens. */
export type RunnerNoticePanel = { readonly title: string; readonly line: string; readonly url: string };

export type RenderedRunnerNotice = { readonly panel: RunnerNoticePanel; readonly email: RenderedEmail };

/** Each notice's heading: the mail's title and the panel's. */
export const runnerNoticeHeading: Readonly<Record<RunnerNotificationKind, string>> = {
  runner_joined: "A runner joined",
  runner_awaiting_approval: "A runner waits for approval",
};

const executorWords = (executor: ExecutorKind): string => {
  switch (executor) {
    case "docker":
      return "Docker";
    case "kubernetes":
      return "Kubernetes";
    case "host":
      return "host, not isolated";
    default:
      return executor satisfies never;
  }
};

type Words = { readonly after: string; readonly button: string; readonly note: string };

const words = (kind: RunnerNotificationKind, pool: string): Words => {
  switch (kind) {
    case "runner_joined":
      return {
        after: ` joined the ${pool} pool, and takes its tasks.`,
        button: "Open the runner",
        note: "Drain or revoke it on the Runners page if you don't know it.",
      };
    case "runner_awaiting_approval":
      return {
        after: ` joined the ${pool} pool, which requires approval. It takes no task until an admin approves it.`,
        button: "Review the runner",
        note: "Approve or reject it, signed in, on the runner's page. Any admin can answer.",
      };
    default:
      return kind satisfies never;
  }
};

/** The panel's words and the mail of one runner notice. */
export const renderRunnerNotice = (input: RunnerNoticeInput): RenderedRunnerNotice => {
  const publicUrl = input.publicUrl.replace(/\/+$/, "");
  const installHost = hostOf(publicUrl);
  const heading = runnerNoticeHeading[input.kind];
  const name = cut(input.runner.runnerName, 80);
  const pool = cut(input.runner.poolName, 80);
  const executor = executorWords(input.runner.executor);
  const token = input.runner.tokenLabel === null ? "a token without a label" : `the token “${cut(input.runner.tokenLabel, 80)}”`;
  const link = input.runner.url;
  const w = words(input.kind, pool);
  const facts = `${executor} · joined with ${token}`;
  const organization = oneLine(input.organizationName);
  const subject = cut(`${heading} · ${name} in ${pool}`, 200);
  const why = `You get this because you're an admin of ${organization}.`;
  const notificationsUrl = `${publicUrl}/account/notifications`;
  const install = `ostra for ${organization} · ${installHost}`;

  const panel: RunnerNoticePanel = { title: heading, line: `${name}${w.after} ${facts}.`, url: link };

  const text = [
    organization,
    `Runners · ${pool}`,
    "",
    heading,
    "",
    `${name}${w.after}`,
    `Executor: ${executor}`,
    `Joined with: ${token}`,
    "",
    `${w.button}: ${link}`,
    w.note,
    "",
    "--",
    `${why} Choose which moments mail you in Notifications: ${notificationsUrl}`,
    install,
    "",
  ].join("\n");

  const e = escapeHtml;
  const row = (label: string, value: string): string =>
    `<span class="o-muted" style="color:${C.kelp};">${e(label)}</span> <span class="o-text" style="color:${C.abyss};">${e(value)}</span>`;
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
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${e(cut(`${pool} · ${facts}`, 200))}${"&zwnj;&nbsp;".repeat(80)}</div>
<table role="presentation" class="o-outer" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.shell}" style="background-color:${C.shell};">
<tr><td align="center" style="padding:24px 0 40px 0;">
<table role="presentation" class="o-column" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 0 20px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left"><img class="o-logo-light" src="${e(publicUrl)}/email/logo-abyss@2x.png" alt="ostra" width="93" height="20" border="0" style="display:block;color:${C.abyss};font-family:${FONT_BODY};font-size:14px;font-weight:600;"><img class="o-logo-dark" src="${e(publicUrl)}/email/logo-shell@2x.png" alt="ostra" width="93" height="20" border="0" style="display:none;mso-hide:all;"></td>
<td align="right" class="o-muted" style="font-family:${FONT_BODY};font-size:12.5px;color:${C.kelp};">${e(organization)}</td>
</tr></table>
</td></tr>
<tr><td class="o-card o-pad" style="background-color:${C.card};border:1px solid ${C.mist};border-radius:10px;padding:32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td><span class="o-muted" style="font-family:${FONT_MONO};font-size:12px;color:${C.kelp};">${e(`Runners · ${pool}`)}</span></td></tr>
<tr><td class="o-text" style="padding-top:16px;font-family:${FONT_HEADING};font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.01em;color:${C.abyss};">${e(heading)}</td></tr>
<tr><td class="o-text" style="padding-top:10px;font-family:${FONT_BODY};font-size:15px;line-height:24px;color:${C.abyss};"><strong style="font-weight:600;">${e(name)}</strong>${e(w.after)}</td></tr>
<tr><td style="padding-top:20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="o-code" style="background-color:${C.shell};border-left:3px solid ${C.amber};border-radius:0 7px 7px 0;padding:12px 14px;font-family:${FONT_MONO};font-size:13px;line-height:20px;word-break:break-all;">${row("Executor", executor)}<br>${row("Joined with", token)}</td></tr></table></td></tr>
<tr><td style="padding-top:24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="o-button" bgcolor="${C.abyss}" style="background-color:${C.abyss};border-radius:7px;"><a href="${e(link)}" style="display:inline-block;padding:10px 20px;line-height:20px;font-family:${FONT_BODY};font-size:13.5px;font-weight:600;color:${C.shell};text-decoration:none;">${e(w.button)}</a></td></tr></table></td></tr>
<tr><td class="o-muted" style="padding-top:16px;font-family:${FONT_BODY};font-size:13px;line-height:20px;color:${C.kelp};">${e(w.note)}</td></tr>
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
  return { panel, email: { subject, html, text } };
};
