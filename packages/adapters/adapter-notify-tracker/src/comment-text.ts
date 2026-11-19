import type { NotificationMomentState } from "@ostra/adapter-sdk";

// The text of the ticket's comment (ADR 0050): a pure renderer, so what lands on a ticket is
// decided here and nowhere else, and never from agent output. It carries the moment in one
// sentence, the mentions of the recipients the tracker knows, the task's title inside quotes and
// the link to the task. Everything that isn't ostra's own words (the task's title above all, which
// comes from a ticket or a prompt) is untrusted text: it's flattened to one line, cut, and has
// every markdown character escaped, so it can't make a link, a mention, a heading or a code block
// on the ticket.

/** The longest a task's title may be in the comment, in characters, before it's cut with `…`. */
export const SUBJECT_MAX_CHARS = 120;
/** The longest the moment's line (core's words) may be, in characters. */
export const BODY_MAX_CHARS = 300;
/** The longest a mention may be: one the tracker made is far shorter. */
const MENTION_MAX_CHARS = 200;

// ASCII punctuation CommonMark lets a backslash escape, picked for what could turn text into
// something else: emphasis, code, links and images, HTML, headings, strikethrough, tables, mentions.
const ESCAPED = /[\\`*_[\]<>#~|@!&]/g;

const flatten = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/** The characters of a text, one per code point: a cut never splits an emoji. */
const codePoints = (text: string): string[] => {
  const chars: string[] = [];
  for (const char of text) {
    chars.push(char);
  }
  return chars;
};

const cut = (text: string, max: number): string => {
  const chars = codePoints(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
};

/** Text as one escaped line, cut to `max` characters: safe to put in a comment as data. */
export const markdownLine = (text: string, max: number): string =>
  cut(flatten(text), max)
    .replaceAll(ESCAPED, (char) => `\\${char}`)
    // A bare web address would link itself on the ticket.
    .replaceAll("://", ":\\/\\/");

/** The link of the task, made safe for `[text](url)`: a web address only, with its brackets encoded. */
export const safeLink = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  return parsed.href.replaceAll("(", "%28").replaceAll(")", "%29");
};

export type TrackerCommentInput = {
  /** Core's one sentence for the moment, such as "An approval needs you". */
  readonly title: string;
  /** The task's title. Untrusted. */
  readonly subject: string;
  /** Core's line about the moment, or empty. */
  readonly body: string;
  /** The task's page. Must be a web address. */
  readonly url: string;
  readonly state: NotificationMomentState;
  /** The tracker's mentions of the recipients that have one (`@ada`, `[~accountid:...]`). */
  readonly mentions: readonly string[];
};

/** The mentions worth writing: the tracker's own markdown, one line each, each once. */
export const usableMentions = (mentions: readonly (string | null)[]): readonly string[] => {
  const seen = new Set<string>();
  for (const mention of mentions) {
    if (mention === null) {
      continue;
    }
    const line = mention.trim();
    if (line !== "" && !/[\r\n]/.test(line) && codePoints(line).length <= MENTION_MAX_CHARS) {
      seen.add(line);
    }
  }
  return [...seen];
};

const STATE_WORDS: Readonly<Record<NotificationMomentState, string>> = {
  open: "",
  answered: " (answered)",
  dismissed: " (dismissed)",
};

/** The comment, as markdown, or `undefined` when the task's link isn't a web address. */
export const renderTrackerComment = (input: TrackerCommentInput): string | undefined => {
  const link = safeLink(input.url);
  if (link === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  if (input.mentions.length > 0) {
    lines.push(input.mentions.join(" "), "");
  }
  const title = markdownLine(input.title, BODY_MAX_CHARS);
  const subject = markdownLine(input.subject, SUBJECT_MAX_CHARS);
  lines.push(`**${title}${STATE_WORDS[input.state]}** on "${subject}"`);
  const body = markdownLine(input.body, BODY_MAX_CHARS);
  if (body !== "" && body !== title) {
    lines.push("", body);
  }
  lines.push("", `[Open the task](${link})`);
  return lines.join("\n");
};
