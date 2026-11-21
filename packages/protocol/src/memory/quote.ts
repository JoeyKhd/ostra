import { MARKED_BLOCK_TAG } from "../agent/prompts.ts";

// A memory note's text as an agent reads it (F-110/c10; ADR 0044's 2026-11-21 note, borrowed from
// claude-mem: `context/research/claude-mem.md`). A note is approved by a member, but its text came
// from an agent or a person who read untrusted tickets, and it lands in the agent's instructions
// (the memory block) and in the memory tools' answers, both Markdown. So it's quoted where it's
// put there, as ostra quotes other text that isn't its own (`markedBlock`): a note can't close its
// quote, and a line of it can't pass for a heading of the block or for ostra's own markers. The
// text stays as it was approved otherwise, so an agent can still read and copy a command from it.
// Here, not in `packages/domain`, because the runner renders the tools' answers and can't import
// the domain (Q190). Pure.

/** The longest run of backticks in `text`: 0 when it holds none. */
const longestBacktickRun = (text: string): number => Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));

/** Every line break an agent may read as one, as `\n`. */
const LINE_BREAK = /\r\n|[\r\n\x85\p{Zl}\p{Zp}]/gu;

/** A line that reads as a Markdown heading (`#` to `######`, then a space or nothing), however indented. */
const HEADING_LINE = /^(\s*)(#{1,6})(?=\s|$)/;

/** ostra's own marked-block tags, opening or closing, wherever they are in a line. */
const MARKER = new RegExp(`<(?=/?${MARKED_BLOCK_TAG}\\b)`, "gi");

/**
 * One line of a note's text with what looks like the block's own delimiters neutralised: a heading
 * gets a backslash before its `#`s (`\## Memory`), and an `<ostra-data>` tag one before its `<`.
 */
const neutralLine = (line: string): string => line.replace(HEADING_LINE, "$1\\$2").replace(MARKER, "\\<");

/**
 * A note's body (or any text of several lines) in a fence of backticks longer than any run of
 * backticks in it, at least three, so no line of it closes the fence early, whatever it holds: a
 * fence of its own, a heading, HTML, a comment. Its headings and ostra's markers are neutralised
 * (`neutralLine`), its line breaks made `\n`, and blank lines at its ends dropped.
 */
export const fencedNoteText = (text: string): string => {
  const lines = text.replace(LINE_BREAK, "\n").split("\n").map(neutralLine);
  while (lines.length > 0 && lines[0]?.trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  const body = lines.map((line) => line.trimEnd()).join("\n");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  return `${fence}\n${body}\n${fence}`;
};

/**
 * One line of a note (its title, a matched line, a task's title) as an inline code span, its
 * backticks one more than any run in it, so Markdown, HTML and a heading's `#` inside it are text.
 * Line breaks and tabs become spaces first.
 */
export const quotedNoteLine = (text: string): string => {
  const line = text.replace(LINE_BREAK, " ").replaceAll("\t", " ").trim();
  if (line === "") {
    return "(none)";
  }
  const ticks = "`".repeat(longestBacktickRun(line) + 1);
  // A span that starts or ends with a backtick needs a space inside its delimiters (CommonMark).
  const pad = line.startsWith("`") || line.endsWith("`") ? " " : "";
  return `${ticks}${pad}${line}${pad}${ticks}`;
};
