import { z } from "zod";

// F-030/c2 (the maintainer's report, 2026-11-22: "why does the PR title not explain what the pr is
// about?"): a PR's title is the agent's own summary of the change, set through `set_pull_request_text`.
// It's untrusted agent output, so the sidecar's tool and core's `pr.text_set` both read it through
// `prTitleSchema`: one line, its control characters gone, trimmed and cut to `PR_TITLE_MAX_CHARS`.
// It's sent to the code host as data in a JSON body, never put in a shell command.

/** The title's length the agent is asked to keep to: a commit subject's. */
export const PR_TITLE_TARGET_CHARS = 72;

/** The most an agent's PR title keeps (in characters, a surrogate pair counting once); a longer one is cut at a word. */
export const PR_TITLE_MAX_CHARS = 100;

/** What a `pr.text_set` title may be before it's cleaned: GitHub's limit, which an older runner capped it to. */
const RAW_TITLE_MAX = 1024;

/** Every line break git or a terminal reads as one. */
const LINE_BREAKS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/g;

/**
 * Control characters, and the format characters that reorder or hide text (bidi overrides and
 * isolates, the marks, and zero-width spaces), which would make a title read otherwise than it is.
 * The zero-width joiner stays: emoji sequences, a gitmoji's among them, are made with it.
 */
const HIDDEN = /[\p{Cc}\u061c\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/** One paragraph of a title as one line: its whitespace a single space, its hidden characters gone. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").replace(HIDDEN, "").replace(/ {2,}/g, " ").trim();

/** A line cut to `max` characters at a word, with an ellipsis; a line that fits is as it is. */
const cutAtWord = (line: string, max: number): string => {
  const characters = Array.from(line);
  if (characters.length <= max) {
    return line;
  }
  const head = characters.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  // A word boundary near the end, so the cut doesn't leave half a word; a single long word is cut where it must be.
  const kept = space >= Math.floor(max / 2) ? head.slice(0, space) : head;
  return `${kept.trimEnd()}…`;
};

/**
 * A PR title as ostra keeps it: git's subject of the text (its first paragraph, its lines joined
 * with spaces), with control and hidden characters stripped, trimmed, and cut at a word to
 * `PR_TITLE_MAX_CHARS`. Empty when the text holds nothing to show. Cleaning a clean title changes nothing.
 */
export const cleanPrTitle = (raw: string): string => {
  const paragraphs = raw.replace(LINE_BREAKS, "\n").split(/\n[ \t]*\n/);
  const first = paragraphs.map(oneLine).find((paragraph) => paragraph !== "") ?? "";
  return cutAtWord(first, PR_TITLE_MAX_CHARS);
};

/** An agent's PR title read at a boundary (F-030/c2): cleaned by `cleanPrTitle`, and never empty after. */
export const prTitleSchema = z.string().max(RAW_TITLE_MAX).transform(cleanPrTitle).pipe(z.string().min(1, "the title says nothing once it's one line"));
