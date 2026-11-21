import type { PreviewNoticeSubject, RenderedEmail } from "@ostra/adapter-sdk";

import { C, cut, DARK_STYLE, escapeHtml, FONT_BODY, FONT_HEADING, FONT_MONO, hostOf, oneLine } from "./email-parts.ts";

// The preview notice (milestone 8, F-142, ADR 0068): a member named a person on a preview's
// `named` level, so they're told where to watch it. One pure renderer gives the panel's words and the
// mail's three parts, so they never say it differently. They name the preview's label and port, the
// organization, who shared it and the preview's own page: never the task's title, key, project or
// thread, which the input has no field for, since the person may not see the task at all.

export type PreviewNoticeInput = {
  readonly preview: PreviewNoticeSubject;
  /** `OSTRA_PUBLIC_URL`, without a trailing slash: the lockup and the links are served from it. */
  readonly publicUrl: string;
};

/** What the panel shows for the notice: its title, one line, and where it opens. */
export type PreviewNoticePanel = { readonly title: string; readonly line: string; readonly url: string };

export type RenderedPreviewNotice = { readonly panel: PreviewNoticePanel; readonly email: RenderedEmail };

/** The notice's heading: the mail's title and the panel's. */
export const previewNoticeHeading = "A preview was shared with you";

/** The preview as the page names it: `web :5173`. */
export const previewNoticeName = (preview: Pick<PreviewNoticeSubject, "label" | "port">): string =>
  preview.port === null ? cut(preview.label, 80) : `${cut(preview.label, 80)} :${String(preview.port)}`;

/** The preview's own page in the panel, where a named person watches it. */
export const sharedPreviewUrl = (publicUrl: string, previewId: string): string => `${publicUrl.replace(/\/+$/, "")}/previews/${encodeURIComponent(previewId)}`;

/** The panel's words and the mail of one preview notice. */
export const renderPreviewNotice = (input: PreviewNoticeInput): RenderedPreviewNotice => {
  const publicUrl = input.publicUrl.replace(/\/+$/, "");
  const installHost = hostOf(publicUrl);
  const heading = previewNoticeHeading;
  const name = previewNoticeName(input.preview);
  const by = input.preview.sharedBy === null ? "A member" : cut(input.preview.sharedBy, 80);
  const organization = oneLine(input.preview.organizationName);
  const link = input.preview.url;
  const after = " with you, to watch.";
  const note = "You see this preview and nothing else of its task. It stays here while it's shared with you; sign in to watch.";
  const button = "Watch the preview";
  const subject = cut(`${heading} · ${name}`, 200);
  const why = `You get this because ${by} named you on a preview in ${organization}.`;
  const notificationsUrl = `${publicUrl}/account/notifications`;
  const install = `ostra for ${organization} · ${installHost}`;

  const panel: PreviewNoticePanel = { title: heading, line: `${by} shared ${name}${after}`, url: link };

  const text = [
    organization,
    "Previews",
    "",
    heading,
    "",
    `${by} shared ${name}${after}`,
    "",
    `${button}: ${link}`,
    note,
    "",
    "--",
    `${why} Choose which moments mail you in Notifications: ${notificationsUrl}`,
    install,
    "",
  ].join("\n");

  const e = escapeHtml;
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
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${e(cut(`${by} shared ${name}${after}`, 200))}${"&zwnj;&nbsp;".repeat(80)}</div>
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
<tr><td><span class="o-muted" style="font-family:${FONT_MONO};font-size:12px;color:${C.kelp};">Previews</span></td></tr>
<tr><td class="o-text" style="padding-top:16px;font-family:${FONT_HEADING};font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.01em;color:${C.abyss};">${e(heading)}</td></tr>
<tr><td class="o-text" style="padding-top:10px;font-family:${FONT_BODY};font-size:15px;line-height:24px;color:${C.abyss};">${e(by)} shared <strong style="font-family:${FONT_MONO};font-weight:600;">${e(name)}</strong>${e(after)}</td></tr>
<tr><td style="padding-top:24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="o-button" bgcolor="${C.abyss}" style="background-color:${C.abyss};border-radius:7px;"><a href="${e(link)}" style="display:inline-block;padding:10px 20px;line-height:20px;font-family:${FONT_BODY};font-size:13.5px;font-weight:600;color:${C.shell};text-decoration:none;">${e(button)}</a></td></tr></table></td></tr>
<tr><td class="o-muted" style="padding-top:16px;font-family:${FONT_BODY};font-size:13px;line-height:20px;color:${C.kelp};">${e(note)}</td></tr>
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
