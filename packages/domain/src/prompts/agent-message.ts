import { CI_FILES_DIR, MARKED_BLOCK_TAG } from "@ostra/protocol";
import type { MessageIntent } from "@ostra/protocol";

import {
  approvedPlanPrompt,
  CLOSING_TURN_PROMPT,
  expiredApprovalAnswerPrompt,
  KEEP_WORKING_AFTER_CAP_PROMPT,
  KEEP_WORKING_PROMPT,
  lateQuestionAnswerPrompt,
} from "./index.ts";
import { refinePrompt, reviewPrompt } from "./m6.ts";
import type { ReviewRound } from "./m6.ts";

// The panel's reading of a member message ostra wrote for the agent (F-072's fix, generalised): the
// text is the agent's prompt, ostra's instructions with each piece of member, PR, check, finding or
// reviewer text in a marked block. The thread never draws that text: it draws what this returns,
// the blocks' data as it was quoted and the facts ostra's own lines carry (a count, a check's name,
// a line number), never an instruction or a fence. Pure, and client-safe (`@ostra/domain/agent-message`).
//
// A message is read by its intent; the reopens that carry none (an approved plan, a late answer to a
// question or an approval) and the closing turn by their fixed opening; a review or refine task's
// first prompt (F-100, F-099) only when it is that prompt word for word, rebuilt from what it read,
// so a member's text can't pass for one, nor hide words behind one. `null` is a member's own text,
// shown as typed: a message with no intent, a Linear follow-up (the member's own words), and a
// message whose intent was set by hand that holds no block (an older log's: a member's
// `tasks.send` and `tasks.reopen` take only plain words since 2026-11-21, and only ostra's server
// code sets another intent). A known intent whose blocks don't read as its prompt's (an older
// ostra's wording) is `quoted`: its blocks alone, so the fence still never shows. Diff comments are
// drawn from the comments they carried (`diff.comments.list`), never from here. A ticket task's
// first prompt and the onboarding prompt are member-visible task prompts, shown as written.

/** A check's result, as "Ask the agent to fix" words it. */
export type FixChecksStatus = "failed" | "timed-out" | "error";

/** The intents whose message is ostra's prompt, read from its blocks. */
export type QuotedIntent = Exclude<MessageIntent, "message" | "diff-comments" | "linear-follow-up" | "update-branch" | "keep-working">;

/** One marked block: its label and its text, as it was quoted. */
export type QuotedBlock = { readonly label: string; readonly text: string };

/** The ticket a review or refine task's prompt quotes: its key (`""` for a prompt task's), title and description. */
export type QuotedTicket = { readonly key: string; readonly title: string; readonly description: string };

/** A PR an AI review reads, as its prompt's line names it; the commits by their first 12 digits. */
export type ReviewedPullRequest = {
  readonly repo: string;
  readonly number: number;
  /** `null` when ostra had no web address for it. */
  readonly url: string | null;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
};

/** A message ostra wrote for the agent, as the thread draws it. */
export type AgentMessage =
  /** An `@ostra` comment on the PR (F-053): the comment's text, and the file and line of a line comment. */
  | { readonly kind: "pr-comment"; readonly path: string | null; readonly line: number | null; readonly text: string }
  /** "Ask the agent to fix" (F-054): each failing check, its command and the end of its output. */
  | { readonly kind: "fix-checks"; readonly checks: readonly { readonly name: string | null; readonly status: FixChecksStatus | null; readonly command: string; readonly output: string }[] }
  /** "Update branch" (F-070): each repo that's behind, and by how much. */
  | { readonly kind: "update-branch"; readonly repos: readonly { readonly repo: string; readonly base: string; readonly branch: string; readonly behindBy: number }[] }
  /** "Keep working" (F-066, F-101): after a closed ticket, or at a round limit. */
  | { readonly kind: "keep-working"; readonly afterCap: boolean }
  /** "Ask for changes" to a plan, sent as a reopen (F-063): the member's request. */
  | { readonly kind: "plan-revision"; readonly request: string }
  /** A CI round (F-035): each failing check and its conclusion. */
  | { readonly kind: "fix-ci"; readonly checks: readonly { readonly name: string; readonly conclusion: string | null }[] }
  /** A findings round (F-101): the blocking findings, then the nits. */
  | { readonly kind: "fix-findings"; readonly findings: readonly { readonly severity: "blocking" | "nit"; readonly location: string; readonly title: string; readonly body: string }[] }
  /** "Changes requested" on the PR (F-105): the review's comment and its line comments. */
  | { readonly kind: "changes-requested"; readonly review: string | null; readonly comments: readonly { readonly location: string; readonly body: string }[] }
  /** A plan approved while the box was gone, sent as the reopen (F-063): the plan as approved. */
  | { readonly kind: "plan-approved"; readonly edited: boolean; readonly plan: string }
  /** A question answered after its turn ended (F-024, Q168): the question and the answers. */
  | { readonly kind: "question-answer"; readonly question: string; readonly answers: string }
  /** An approval answered after it expired (F-026): the decision, what it asked, and a deny's reason. */
  | { readonly kind: "approval-answer"; readonly decision: "allow_once" | "allow_task" | "deny"; readonly request: string | null; readonly reason: string | null }
  /** The closing turn (F-111): ostra asks for memory proposals. */
  | { readonly kind: "closing-turn" }
  /**
   * A review task's first prompt for a round (F-100): the PRs it reads, which review this is, and
   * the ticket and acceptance criteria it reads them against (`null` for a task with no ticket).
   */
  | {
      readonly kind: "ai-review";
      readonly pullRequests: readonly ReviewedPullRequest[];
      readonly round: ReviewRound;
      readonly ticket: QuotedTicket | null;
      readonly acceptanceCriteria: string | null;
    }
  /** A refine task's first prompt (F-099): the ticket it refines and the repos it reads. */
  | { readonly kind: "refine"; readonly ticket: QuotedTicket; readonly repos: readonly string[] }
  /** A known intent whose prompt doesn't read as this version's: its blocks alone. */
  | { readonly kind: "quoted"; readonly intent: QuotedIntent; readonly blocks: readonly QuotedBlock[] };

/** A prompt in pieces: ostra's own words, or a marked block's text. */
type Segment = { readonly kind: "words"; readonly text: string } | ({ readonly kind: "block" } & QuotedBlock);

/** The prompt's segments, in order, by `markedBlock`'s grammar (`readMarkedBlocks`). A block cut off before its closing line stays words. */
const segmentsOf = (prompt: string): readonly Segment[] => {
  const segments: Segment[] = [];
  const opening = new RegExp(`<${MARKED_BLOCK_TAG} label="([a-z0-9-]+)" fence="(\\d+)">\\n`, "g");
  let cursor = 0;
  for (;;) {
    opening.lastIndex = cursor;
    const found = opening.exec(prompt);
    if (found === null) break;
    const [whole, label = "", fence = "0"] = found;
    const closing = `\n</${MARKED_BLOCK_TAG} fence="${fence}">`;
    const start = found.index + whole.length;
    const end = prompt.indexOf(closing, start);
    if (end === -1) break;
    if (found.index > cursor) segments.push({ kind: "words", text: prompt.slice(cursor, found.index) });
    segments.push({ kind: "block", label, text: prompt.slice(start, end) });
    cursor = end + closing.length;
  }
  if (cursor < prompt.length) segments.push({ kind: "words", text: prompt.slice(cursor) });
  return segments;
};

const blocksOf = (segments: readonly Segment[]): readonly QuotedBlock[] =>
  segments.flatMap((segment) => (segment.kind === "block" ? [{ label: segment.label, text: segment.text }] : []));

const blockText = (blocks: readonly QuotedBlock[], label: string): string | null => blocks.find((block) => block.label === label)?.text ?? null;

/** A prompt's first paragraph: ostra's opening line. */
const openingOf = (prompt: string): string => prompt.split("\n\n")[0] ?? prompt;

/** The last line of ostra's words before a block. */
const lastLineOf = (words: string): string => words.replace(/\n+$/, "").split("\n").at(-1) ?? "";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- the intents ----------

const prComment = (segments: readonly Segment[], blocks: readonly QuotedBlock[]): AgentMessage | null => {
  const text = blockText(blocks, "pr-comment");
  if (text === null) return null;
  const first = segments[0];
  const line = first?.kind === "words" ? / on the file in the first block, line (\d+) \(/.exec(openingOf(first.text)) : null;
  return { kind: "pr-comment", path: blockText(blocks, "pr-comment-location"), line: line?.[1] === undefined ? null : Number(line[1]), text };
};

const statusOf = (word: string | undefined): FixChecksStatus | null => {
  switch (word) {
    case "failed":
      return "failed";
    case "timed out":
      return "timed-out";
    case "couldn't run":
      return "error";
    case undefined:
    default:
      return null;
  }
};

const fixChecks = (segments: readonly Segment[]): AgentMessage | null => {
  type Check = Extract<AgentMessage, { readonly kind: "fix-checks" }>["checks"][number];
  const checks: Check[] = [];
  let words = "";
  let pending: Omit<Check, "output"> | null = null;
  for (const segment of segments) {
    if (segment.kind === "words") {
      words = segment.text;
      continue;
    }
    if (segment.label === "check-command") {
      if (pending !== null) checks.push({ ...pending, output: "" });
      // ostra's line before the command: `{name}: failed.`, `{name}: timed out.` or `{name}: couldn't run.`
      const named = /^(.*): (failed|timed out|couldn't run)\.$/.exec(lastLineOf(words));
      pending = { name: named?.[1] ?? null, status: statusOf(named?.[2]), command: segment.text };
    } else if (segment.label === "check-output" && pending !== null) {
      checks.push({ ...pending, output: segment.text });
      pending = null;
    }
    words = "";
  }
  if (pending !== null) checks.push({ ...pending, output: "" });
  return checks.length === 0 ? null : { kind: "fix-checks", checks };
};

/** One repo's line of "Update branch": `- {repo}: merge `{base}` into `{branch}` ({n} commits behind)`. */
const UPDATE_BRANCH_LINE = /^- (.+): merge `(.+)` into `(.+)` \((\d+) commits? behind\)$/;

const updateBranch = (text: string): AgentMessage | null => {
  const repos = text.split("\n").flatMap((line) => {
    const found = UPDATE_BRANCH_LINE.exec(line);
    if (found === null) return [];
    const [, repo = "", base = "", branch = "", behind = "0"] = found;
    return [{ repo, base, branch, behindBy: Number(behind) }];
  });
  return repos.length === 0 ? null : { kind: "update-branch", repos };
};

const keepWorking = (text: string): AgentMessage | null =>
  text === KEEP_WORKING_PROMPT ? { kind: "keep-working", afterCap: false } : text === KEEP_WORKING_AFTER_CAP_PROMPT ? { kind: "keep-working", afterCap: true } : null;

const planRevision = (blocks: readonly QuotedBlock[]): AgentMessage | null => {
  const request = blockText(blocks, "plan-revision-request");
  return request === null ? null : { kind: "plan-revision", request };
};

/** A CI round's quote: `{name} ({conclusion}): ci/{file}.log`, or `: no log`. */
const FAILING_CHECK = new RegExp(`^([\\s\\S]*) \\(([^()\\n]*)\\): (?:no log|${escapeRegExp(CI_FILES_DIR)}/\\S+)$`);

const fixCi = (blocks: readonly QuotedBlock[]): AgentMessage | null => {
  const checks = blocks.flatMap((block) => {
    if (block.label !== "failing-check") return [];
    const found = FAILING_CHECK.exec(block.text);
    return [found === null ? { name: block.text, conclusion: null } : { name: found[1] ?? block.text, conclusion: found[2] ?? null }];
  });
  return checks.length === 0 ? null : { kind: "fix-ci", checks };
};

/** A finding's quote: `{repo} {path}:{line} ({side})`, its title, a blank line and its body. */
const findingOf = (severity: "blocking" | "nit", text: string) => {
  const end = text.indexOf("\n");
  const location = end === -1 ? text : text.slice(0, end);
  const rest = end === -1 ? "" : text.slice(end + 1);
  const gap = rest.indexOf("\n\n");
  return { severity, location, title: gap === -1 ? rest : rest.slice(0, gap), body: gap === -1 ? "" : rest.slice(gap + 2) };
};

const fixFindings = (blocks: readonly QuotedBlock[]): AgentMessage | null => {
  const findings = blocks.flatMap((block) => (block.label === "finding" ? [findingOf("blocking", block.text)] : block.label === "nit" ? [findingOf("nit", block.text)] : []));
  return findings.length === 0 ? null : { kind: "fix-findings", findings };
};

const changesRequested = (blocks: readonly QuotedBlock[]): AgentMessage | null => {
  const review = blockText(blocks, "review");
  // A line comment's quote: `{path}:{line}`, a blank line and its body.
  const comments = blocks.flatMap((block) => {
    if (block.label !== "review-comment") return [];
    const gap = block.text.indexOf("\n\n");
    return [{ location: gap === -1 ? "" : block.text.slice(0, gap), body: gap === -1 ? block.text : block.text.slice(gap + 2) }];
  });
  return review === null && comments.length === 0 ? null : { kind: "changes-requested", review, comments };
};

// ---------- the messages without an intent: the reopens by their fixed opening ----------

/** The builders' own openings, so a change of wording reaches the reading. */
const openings = {
  planApproved: openingOf(approvedPlanPrompt({ text: "", edited: false })),
  planApprovedEdited: openingOf(approvedPlanPrompt({ text: "", edited: true })),
  questionAnswer: openingOf(lateQuestionAnswerPrompt({ question: "", fields: [], answers: {} })),
  approval: {
    allow_once: openingOf(expiredApprovalAnswerPrompt({ decision: "allow_once", subject: null, reason: null })),
    allow_task: openingOf(expiredApprovalAnswerPrompt({ decision: "allow_task", subject: null, reason: null })),
    deny: openingOf(expiredApprovalAnswerPrompt({ decision: "deny", subject: null, reason: null })),
  },
  refine: openingOf(refinePrompt({ ticket: { key: "", title: "", description: null }, repos: [] })),
} as const;

// ---------- a review or refine task's first prompt, rebuilt word for word ----------

/** ostra's line before the ticket's blocks (`ticketBlocks`). */
const TICKET_LINE = /^The ticket is (.*)\. Its title and description are below\.$/m;

/** The ticket a prompt quotes: its key from ostra's line, its title and description from their blocks. */
const quotedTicketOf = (segments: readonly Segment[], blocks: readonly QuotedBlock[]): QuotedTicket | null => {
  const title = blockText(blocks, "ticket-title");
  const description = blockText(blocks, "ticket-description");
  const line = segments.flatMap((segment) => (segment.kind === "words" ? [TICKET_LINE.exec(segment.text)] : [])).find((found) => found !== null);
  const key = line?.[1];
  return title === null || description === null || key === undefined ? null : { key, title, description };
};

/** The lines of ostra's words before the first block: where a review's PRs and a refine's repos are. */
const leadingLines = (segments: readonly Segment[]): readonly string[] => {
  const first = segments[0];
  return first?.kind === "words" ? first.text.split("\n") : [];
};

/** The review prompt's opening (`reviewPrompt`): which review this is, of how many. */
const REVIEW_OPENING = /^Your task is to review a coding agent's pull requests?, round (\d+) of (\d+): /;

/** A PR's line in the review prompt (`reviewPullRequestLine`). */
const REVIEW_PR_LINE = /^- (\S+)#(\d+) \((\S*)\) on (\S+): base ([0-9a-f]+), head ([0-9a-f]+); (\d+) files? changed, \+(\d+) -(\d+)$/;

const aiReview = (text: string, segments: readonly Segment[], blocks: readonly QuotedBlock[]): AgentMessage | null => {
  const opening = REVIEW_OPENING.exec(text);
  if (opening === null) return null;
  const pullRequests = leadingLines(segments).flatMap((line): ReviewedPullRequest[] => {
    const found = REVIEW_PR_LINE.exec(line);
    if (found === null) return [];
    const [, repo = "", number = "", url = "", branch = "", base = "", head = "", files = "", additions = "", deletions = ""] = found;
    return [{ repo, number: Number(number), url: url === "" ? null : url, branch, base, head, files: Number(files), additions: Number(additions), deletions: Number(deletions) }];
  });
  if (pullRequests.length === 0) return null;
  const round = { number: Number(opening[1]), of: Number(opening[2]) };
  const ticket = quotedTicketOf(segments, blocks);
  const acceptanceCriteria = blockText(blocks, "acceptance-criteria");
  const rebuilt = reviewPrompt({
    ticket,
    acceptanceCriteria,
    round,
    pullRequests: pullRequests.map((pr) => ({ ...pr, url: pr.url ?? "", baseSha: pr.base, headSha: pr.head })),
  });
  return rebuilt === text ? { kind: "ai-review", pullRequests, round, ticket, acceptanceCriteria } : null;
};

/** A repo's line in the refine prompt (`repoLines`). */
const REFINE_REPO_LINE = /^- (\S+), checked out in (.+)\/$/;

const refine = (text: string, segments: readonly Segment[], blocks: readonly QuotedBlock[]): AgentMessage | null => {
  if (openingOf(text) !== openings.refine) return null;
  const ticket = quotedTicketOf(segments, blocks);
  if (ticket === null) return null;
  const repos = leadingLines(segments).flatMap((line) => {
    const found = REFINE_REPO_LINE.exec(line);
    return found === null ? [] : [{ fullName: found[1] ?? "", checkoutDir: found[2] ?? "" }];
  });
  return refinePrompt({ ticket, repos }) === text ? { kind: "refine", ticket, repos: repos.map((repo) => repo.fullName) } : null;
};

// ---------- a message without an intent ----------

const withoutIntent = (text: string, segments: readonly Segment[], blocks: readonly QuotedBlock[]): AgentMessage | null => {
  if (text === CLOSING_TURN_PROMPT) return { kind: "closing-turn" };
  const firstPrompt = aiReview(text, segments, blocks) ?? refine(text, segments, blocks);
  if (firstPrompt !== null) return firstPrompt;
  const opening = openingOf(text);
  const plan = blockText(blocks, "approved-plan");
  if (plan !== null && (opening === openings.planApproved || opening === openings.planApprovedEdited)) {
    return { kind: "plan-approved", edited: opening === openings.planApprovedEdited, plan };
  }
  const question = blockText(blocks, "question");
  const answers = blockText(blocks, "answers");
  if (question !== null && answers !== null && opening === openings.questionAnswer) {
    return { kind: "question-answer", question, answers };
  }
  for (const decision of ["allow_once", "allow_task", "deny"] as const) {
    if (opening === openings.approval[decision]) {
      return { kind: "approval-answer", decision, request: blockText(blocks, "request"), reason: blockText(blocks, "deny-reason") };
    }
  }
  return null;
};

/** Its blocks alone, when a known intent's prompt doesn't read as this version's; `null` when it holds none. */
const quotedOr = (intent: QuotedIntent, blocks: readonly QuotedBlock[], read: AgentMessage | null): AgentMessage | null =>
  read ?? (blocks.length === 0 ? null : { kind: "quoted", intent, blocks });

/**
 * A member message as the thread draws it: what ostra wrote for the agent, read from the message's
 * text, or `null` for a member's own text, which the thread shows as typed.
 */
export const readAgentMessage = (message: { readonly text: string; readonly intent: MessageIntent | undefined }): AgentMessage | null => {
  const segments = segmentsOf(message.text);
  const blocks = blocksOf(segments);
  const intent = message.intent ?? "message";
  switch (intent) {
    case "message":
      return withoutIntent(message.text, segments, blocks);
    case "diff-comments":
    case "linear-follow-up":
      return null;
    case "update-branch":
      return updateBranch(message.text);
    case "keep-working":
      return keepWorking(message.text);
    case "pr-comment":
      return quotedOr(intent, blocks, prComment(segments, blocks));
    case "fix-checks":
      return quotedOr(intent, blocks, fixChecks(segments));
    case "plan-revision":
      return quotedOr(intent, blocks, planRevision(blocks));
    case "fix-ci":
      return quotedOr(intent, blocks, fixCi(blocks));
    case "fix-findings":
      return quotedOr(intent, blocks, fixFindings(blocks));
    case "changes-requested":
      return quotedOr(intent, blocks, changesRequested(blocks));
    default:
      return intent satisfies never;
  }
};
