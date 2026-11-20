import { lineInRanges } from "@ostra/adapter-sdk";
import type { DiffFileLines, ReviewLineComment } from "@ostra/adapter-sdk";
import type { Finding } from "@ostra/protocol";

// Where an AI review's findings go on a PR (F-100, ADR 0058): one comment-type review per PR, each
// finding on a line the PR's diff covers as a line comment, the others listed in the review's body
// (GitHub refuses a line comment outside the diff). Pure. A finding's text is untrusted: it's posted
// to the code host as Markdown inside ostra's own words, and never logged.

/** At most this many findings a review (`OSTRA_REVIEW_FINDINGS_MAX`, the protocol's limit). */
export const REVIEW_FINDINGS_MAX = 30;

export type PlacedFindings = {
  /** Each line comment, with the index of its finding in the input. */
  readonly lineComments: readonly (ReviewLineComment & { readonly findingIndex: number })[];
  /** The indexes of the findings that go in the review's body. */
  readonly inBody: readonly number[];
};

/** A run of backticks longer than any the text holds, so a fence can't be closed from inside. */
const fenceFor = (text: string): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
};

const severityWords = (finding: Finding): string => (finding.severity === "blocking" ? "Blocking" : "Nit");

/** A line comment's body: ostra's words around the finding, its suggestion as a suggestion block. */
export const findingCommentBody = (finding: Finding): string => {
  const parts = [`**${severityWords(finding)}: ${finding.title.replaceAll(/[\r\n]+/g, " ")}**`, finding.body];
  if (finding.suggestion !== null) {
    const fence = fenceFor(finding.suggestion);
    parts.push(`${fence}suggestion\n${finding.suggestion}\n${fence}`);
  }
  parts.push("_From ostra's AI review. A member reads it too._");
  return parts.join("\n\n");
};

/** Places one PR's findings on its diff's lines; the rest go in the body. */
export const placeFindings = (findings: readonly Finding[], diffLines: readonly DiffFileLines[]): PlacedFindings => {
  const files = new Map(diffLines.map((file) => [file.path, file]));
  const lineComments: (ReviewLineComment & { readonly findingIndex: number })[] = [];
  const inBody: number[] = [];
  for (const [index, finding] of findings.slice(0, REVIEW_FINDINGS_MAX).entries()) {
    const file = files.get(finding.path);
    const ranges = file === undefined ? [] : finding.side === "new" ? file.new : file.old;
    if (lineInRanges(ranges, finding.line)) {
      lineComments.push({ findingIndex: index, path: finding.path, line: finding.line, side: finding.side, body: findingCommentBody(finding) });
    } else {
      inBody.push(index);
    }
  }
  return { lineComments, inBody };
};

/**
 * The most a review's body holds: GitHub refuses one over 65,536 characters, and 30 findings of
 * 4 KiB off the diff with an 8 KiB summary can reach twice that. Kept under it with room to spare.
 */
export const REVIEW_BODY_MAX_CHARS = 60_000;

/** The review's body: the counts, the summary as the agent wrote it, and the findings off the diff that fit. */
export const reviewBody = (input: { readonly summary: string; readonly findings: readonly Finding[]; readonly inBody: readonly number[] }): string => {
  const blocking = input.findings.filter((finding) => finding.severity === "blocking").length;
  const nits = input.findings.length - blocking;
  const counts =
    input.findings.length === 0
      ? "ostra's AI review found nothing to change."
      : `ostra's AI review: ${String(blocking)} blocking, ${String(nits)} nit${nits === 1 ? "" : "s"}.`;
  const closing = "_This review comments only: it doesn't approve or request changes._";
  const head = [counts, input.summary.trim()].filter((part) => part !== "").join("\n\n");
  const off = input.inBody.flatMap((index) => {
    const finding = input.findings[index];
    return finding === undefined ? [] : [finding];
  });
  if (off.length === 0) {
    return `${head}\n\n${closing}`;
  }
  const entries = off.map((finding) => `- \`${finding.path}:${String(finding.line)}\` ${severityWords(finding)}: ${finding.title.replaceAll(/[\r\n]+/g, " ")}\n\n${finding.body}`);
  // The findings that fit, in order; the rest are counted, and every one is on ostra's review screen.
  let length = head.length + closing.length + 400;
  const kept: string[] = [];
  for (const entry of entries) {
    if (length + entry.length + 2 > REVIEW_BODY_MAX_CHARS) {
      break;
    }
    kept.push(entry);
    length += entry.length + 2;
  }
  const left = entries.length - kept.length;
  const more = left === 0 ? [] : [`- And ${String(left)} more outside the diff, too long to list here: each is on the task's review screen in ostra.`];
  return [head, ["Outside the diff:", ...kept, ...more].join("\n\n"), closing].join("\n\n");
};
