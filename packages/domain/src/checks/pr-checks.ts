import type { CheckStatus } from "@ostra/protocol";

// The "Checks" section of a task's PR (F-054, ADR 0052): each check's name and status, and the
// failing ones' last lines in a code block, between the agent's text and ostra's trailers. Pure.
//
// Check output is untrusted: whatever a test printed, or an agent made it print. It goes in a
// fenced code block longer than any run of backticks inside it, so nothing in it closes the block,
// and GitHub renders it as text: no markdown, no HTML, no mention, no link. Control characters and
// terminal colours are dropped, and only its last 40 lines are kept. A check's name is the
// admin's, and is escaped as text. The section sits between two HTML comments, so a later turn
// edits it in place, and a person's edits elsewhere in the description stay.

export const CHECKS_SECTION_START = "<!-- ostra:checks -->";
export const CHECKS_SECTION_END = "<!-- /ostra:checks -->";

/** The most lines of a failing check's output the PR shows. */
export const PR_CHECK_OUTPUT_LINES = 40;

/** A check's latest result on a PR, as the section shows it. */
export type PrCheck = {
  readonly name: string;
  readonly status: CheckStatus;
  /** The end of its output, for a failing check; `null` when it wasn't kept. */
  readonly outputTail: string | null;
};

/** Whether a status fails the PR: a failure, a timeout or a check that couldn't run. */
export const isFailingCheck = (status: CheckStatus): boolean => status !== "passed";

const STATUS_WORDS: Readonly<Record<CheckStatus, string>> = {
  passed: "✅ passed",
  failed: "❌ failed",
  "timed-out": "⏱️ timed out",
  error: "⚠️ couldn't run",
};

/** Escapes text for a markdown line: no markup, no HTML, no mention, no autolink. */
export const escapeMarkdownText = (text: string): string =>
  text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+\-.!|~@:])/g, "\\$1");

// Terminal colours and cursor moves (CSI and OSC sequences), and every other control character
// but the newline and the tab.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** A check's output made inert for a code block, cut to its last `lines` lines. */
export const outputLines = (output: string, lines = PR_CHECK_OUTPUT_LINES): string => {
  const clean = output.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, "");
  const rows = clean.replace(/\n+$/, "").split("\n");
  return rows.slice(-lines).join("\n");
};

/** A fenced code block around text, its fence longer than any backtick run inside. */
export const codeBlock = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};

/** The section, markers included, or `null` when no check applies to the PR. */
export const checksSection = (checks: readonly PrCheck[]): string | null => {
  if (checks.length === 0) {
    return null;
  }
  const failing = checks.filter((check) => isFailingCheck(check.status));
  const lines = [
    CHECKS_SECTION_START,
    "### Checks",
    "",
    ...checks.map((check) => `- **${escapeMarkdownText(check.name)}**: ${STATUS_WORDS[check.status]}`),
  ];
  for (const check of failing) {
    if (check.outputTail === null || check.outputTail.trim() === "") {
      continue;
    }
    lines.push("", `${escapeMarkdownText(check.name)}, the last lines of its output:`, "", codeBlock(outputLines(check.outputTail)));
  }
  lines.push(CHECKS_SECTION_END);
  return lines.join("\n");
};

/** Where ostra's trailers start in a body it wrote: the magic line or the footer's rule. */
const trailersAt = (body: string, magicLine: string | null): number => {
  const candidates = [magicLine === null ? -1 : body.lastIndexOf(`\n${magicLine}\n`), body.lastIndexOf("\n---\nOpened by [ostra](")].filter((at) => at >= 0);
  return candidates.length === 0 ? -1 : Math.min(...candidates);
};

/**
 * A PR's description with its checks section replaced, added before ostra's trailers, or removed
 * (`section: null`). The first start marker and the last end marker bound it, so output quoted in
 * an earlier section can't move them. Everything else in the description is kept as it is.
 */
export const withChecksSection = (body: string, section: string | null, magicLine: string | null = null): string => {
  const start = body.indexOf(CHECKS_SECTION_START);
  const end = body.lastIndexOf(CHECKS_SECTION_END);
  if (start !== -1 && end > start) {
    const before = body.slice(0, start).replace(/\n+$/, "");
    const after = body.slice(end + CHECKS_SECTION_END.length).replace(/^\n+/, "");
    return section === null ? `${before}\n\n${after}` : `${before}\n\n${section}\n\n${after}`;
  }
  if (section === null) {
    return body;
  }
  const at = trailersAt(body, magicLine);
  if (at === -1) {
    return `${body.replace(/\n+$/, "")}\n\n${section}\n`;
  }
  return `${body.slice(0, at).replace(/\n+$/, "")}\n\n${section}\n${body.slice(at)}`;
};
