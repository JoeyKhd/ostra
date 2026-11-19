// The mails' shared parts (ADR 0050): the brand's colours and type, the dark-mode override and
// the text helpers, for the needs-you mails and the runner notices alike. Not exported from the
// package: each renderer is.

export const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** A line for a subject or a preheader: one line, no breaks. */
export const oneLine = (text: string): string => text.replaceAll(/[\r\n\t]+/g, " ").replaceAll(/\s{2,}/g, " ").trim();

export const cut = (text: string, max: number): string => {
  const flat = oneLine(text);
  const chars: string[] = [];
  for (const char of flat) {
    chars.push(char);
  }
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
};

export const hostOf = (value: string): string => {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
};

// The brand's colours (`brief.md`, the build spec's table).
export const C = {
  shell: "#F3F0E8",
  abyss: "#0C1D21",
  kelp: "#2F4A47",
  faint: "#5F6B68",
  mist: "#CFD8D4",
  hairline: "#E3E7E4",
  card: "#FFFFFF",
  amber: "#FFB224",
} as const;

export const FONT_HEADING = "Manrope, 'Helvetica Neue', Helvetica, Arial, sans-serif";
export const FONT_BODY = "'IBM Plex Sans', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const FONT_MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const DARK_STYLE = `@media (prefers-color-scheme: dark) {
  .o-outer { background-color: #0A0B0C !important; }
  .o-card { background-color: #131416 !important; border-color: #1F2023 !important; }
  .o-text { color: #EDEDEE !important; }
  .o-muted { color: #9A9DA3 !important; }
  .o-faint { color: #7E8187 !important; }
  .o-line { border-color: #1F2023 !important; }
  .o-code { background-color: #0D0E10 !important; }
  .o-button { background-color: #F3F0E8 !important; }
  .o-button a { color: #0C1D21 !important; }
  .o-link { color: #6FB8AA !important; text-decoration: none !important; }
  .o-logo-light { display: none !important; }
  .o-logo-dark { display: block !important; }
}
[data-ogsc] .o-outer { background-color: #0A0B0C !important; }
[data-ogsc] .o-card { background-color: #131416 !important; border-color: #1F2023 !important; }
[data-ogsc] .o-text { color: #EDEDEE !important; }
[data-ogsc] .o-muted { color: #9A9DA3 !important; }
[data-ogsc] .o-faint { color: #7E8187 !important; }
@media (max-width: 620px) {
  .o-column { width: 100% !important; }
  .o-pad { padding-left: 20px !important; padding-right: 20px !important; }
}`;

