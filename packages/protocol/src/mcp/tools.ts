import { z } from "zod";

import { repoIdSchema } from "../ids.ts";
import type { RepoId } from "../ids.ts";
import { envNameSchema, repoFullNameSchema, serviceNameSchema } from "../common.ts";
import type { RepoFullName } from "../common.ts";
import { utf8ByteLength } from "../json.ts";
import type { DraftResponse, EnvironmentProposalResponse, ReviewRequestBody, ReviewResponse } from "../runner/http.ts";
import { runnerLimits } from "../runner/limits.ts";

// ostra's MCP tools of milestone 6 (ADR 0028, ADR 0038, ADR 0058, protocol minor 5): what a refine
// task's agent hands in (`submit_draft`), what a review task's agent hands in (`submit_review`),
// and what an onboarding task's agent proposes (`propose_environment`). Zod first, shared by the
// sidecar, which serves the tools and forwards each call to core over the runner's HTTP with the
// task's token (`runnerPaths.taskDraft`, `taskReview`, `taskEnvironmentProposal`), and by core,
// which parses the same shapes again at its endpoint (tickets 15, 17, 21, 22).
//
// The tools' input is the agent's output: untrusted. Every object refuses unknown fields, and
// every text is capped. A draft's text, a finding's text, a proposal's scripts and every refusal's
// input are never logged: counts and IDs only. The agent names a repo by its `owner/name`, as the
// task lists it; the sidecar turns it into the repo's ID (`toolRepoIds`).

export const SUBMIT_DRAFT_TOOL = "submit_draft";
export const SUBMIT_REVIEW_TOOL = "submit_review";
export const PROPOSE_ENVIRONMENT_TOOL = "propose_environment";

/** A text capped in UTF-8 bytes, since the limits are bytes and a character may be four. */
const bytesCapped = (maxBytes: number, what: string): z.ZodString =>
  z
    .string()
    .max(maxBytes)
    .refine((text) => utf8ByteLength(text) <= maxBytes, `${what} is at most ${String(maxBytes / 1024)} KiB`);

// ---------- submit_draft (F-099) ----------

/** One acceptance criterion, edge case or open question: one line or a short paragraph. */
const draftItemSchema = z.string().trim().min(1).max(runnerLimits.draftItemMaxChars);

/** A sub-ticket a refine draft proposes: written as a sub-issue under the ticket on "Update ticket". */
export const draftSubTicketSchema = z.strictObject({
  title: z.string().trim().min(1).max(runnerLimits.draftSubTicketTitleMaxChars),
  description: bytesCapped(runnerLimits.draftSubTicketMaxBytes, "a sub-ticket's description"),
});
export type DraftSubTicket = z.infer<typeof draftSubTicketSchema>;

/**
 * A refine draft (F-099, ADR 0028): the ticket as the agent would write it. A member reads it,
 * edits it and decides what goes to the ticket. Its text is never logged.
 */
export const refineDraftSchema = z
  .strictObject({
    /** The ticket's new description, in Markdown. */
    description: bytesCapped(runnerLimits.draftDescriptionMaxBytes, "the description"),
    acceptanceCriteria: z.array(draftItemSchema).max(runnerLimits.draftAcceptanceCriteriaMax),
    edgeCases: z.array(draftItemSchema).max(runnerLimits.draftEdgeCasesMax),
    openQuestions: z.array(draftItemSchema).max(runnerLimits.draftOpenQuestionsMax),
    subTickets: z.array(draftSubTicketSchema).max(runnerLimits.draftSubTicketsMax),
  })
  .describe("A refine draft. Its text is never logged.");
export type RefineDraft = z.infer<typeof refineDraftSchema>;

/** `submit_draft`'s input: the draft itself. */
export const submitDraftInputSchema = refineDraftSchema;
export type SubmitDraftInput = z.infer<typeof submitDraftInputSchema>;

export const submitDraftDescription =
  "Hand in your refined version of the ticket. Call it once you have read the code and the ticket; " +
  "call it again to replace your draft with a better one (each call is a new version). " +
  `The description is Markdown, at most ${String(runnerLimits.draftDescriptionMaxBytes / 1024)} KiB. ` +
  `At most ${String(runnerLimits.draftAcceptanceCriteriaMax)} acceptance criteria, ` +
  `${String(runnerLimits.draftEdgeCasesMax)} edge cases and ${String(runnerLimits.draftOpenQuestionsMax)} open questions, ` +
  `each at most ${String(runnerLimits.draftItemMaxChars)} characters, and at most ${String(runnerLimits.draftSubTicketsMax)} ` +
  `sub-tickets, each with a title and a description of at most ${String(runnerLimits.draftSubTicketMaxBytes / 1024)} KiB. ` +
  "Put a question only a person can answer under open questions. Nothing is written to the ticket by this tool: " +
  "a member of the project reads the draft, checks it, edits it and decides what goes to the ticket.";

// ---------- submit_review (F-100) ----------

/** How much a finding matters (ADR 0058): a blocking one goes back to the coding agent; a nit is listed only. */
export const findingSeveritySchema = z.enum(["blocking", "nit"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

/** Which side of the diff a finding's line is on: the PR's head (`new`) or its base (`old`). */
export const diffSideSchema = z.enum(["new", "old"]);
export type DiffSide = z.infer<typeof diffSideSchema>;

/** A repo-relative path in a review, as the diff names it. */
const reviewPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/, "a relative path inside the repo");

const findingFields = {
  path: reviewPathSchema,
  /** The line, from 1, on `side`. A line outside the PR's diff goes in the review's body. */
  line: z.number().int().positive(),
  side: diffSideSchema,
  severity: findingSeveritySchema,
  title: z.string().trim().min(1).max(runnerLimits.findingTitleMaxChars),
  body: bytesCapped(runnerLimits.findingBodyMaxBytes, "a finding's body"),
  /** A replacement for the line, or `null`. */
  suggestion: bytesCapped(runnerLimits.findingSuggestionMaxBytes, "a suggestion").nullable(),
};

/** A finding as the agent writes it: its repo by `owner/name`. Its text is never logged. */
export const toolFindingSchema = z.strictObject({ repo: repoFullNameSchema, ...findingFields });
export type ToolFinding = z.infer<typeof toolFindingSchema>;

/** A finding as core receives it: its repo by ID. Its text is never logged. */
export const findingSchema = z.strictObject({ repoId: repoIdSchema, ...findingFields });
export type Finding = z.infer<typeof findingSchema>;

export const reviewSummarySchema = bytesCapped(runnerLimits.reviewSummaryMaxBytes, "the summary");

/** `submit_review`'s input: a summary and the findings. Their text is never logged. */
export const submitReviewInputSchema = z
  .strictObject({
    summary: reviewSummarySchema,
    findings: z.array(toolFindingSchema).max(runnerLimits.reviewFindingsMax),
  })
  .describe("A review. Its text is never logged.");
export type SubmitReviewInput = z.infer<typeof submitReviewInputSchema>;

export const submitReviewDescription =
  "Hand in your review of the pull requests. Call it once, when you have read every changed file. " +
  "Each finding names its repo (owner/name, as the task lists it), its path, its line on the PR's head (side `new`) " +
  "or base (side `old`), whether it's `blocking` (it must change before a merge) or a `nit`, a title, a body and an " +
  `optional suggested replacement for the line. At most ${String(runnerLimits.reviewFindingsMax)} findings, each body at most ` +
  `${String(runnerLimits.findingBodyMaxBytes / 1024)} KiB, and a summary of at most ${String(runnerLimits.reviewSummaryMaxBytes / 1024)} KiB. ` +
  "Your review is posted on the pull request as comments, never as an approval or a request for changes; " +
  "blocking findings go back to the coding agent, and a member reads every finding.";

// ---------- propose_environment (F-113) ----------

/** A check the environment runs after a turn: its name, the command line and its timeout. */
export const proposedCheckSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  command: z.string().min(1).max(8192),
  timeoutSeconds: z.number().int().positive().max(runnerLimits.checkTimeoutMaxSeconds),
});
export type ProposedCheck = z.infer<typeof proposedCheckSchema>;

/** A service the environment starts, by image. Its variables by name only: never a value. */
export const proposedServiceSchema = z.strictObject({
  name: serviceNameSchema,
  image: z.string().min(1).max(512),
  port: z.number().int().min(1).max(65_535).nullable(),
  healthCheck: z.string().min(1).max(2048).nullable(),
  variableNames: z.array(envNameSchema).max(200),
});
export type ProposedService = z.infer<typeof proposedServiceSchema>;

const proposedRepoFields = {
  /** The setup script, or `null` for none. */
  setupScript: z.string().max(262_144).nullable(),
  checks: z.array(proposedCheckSchema).max(runnerLimits.checksMax),
  /** The variables the repo needs, by name only: a member fills in the values. */
  variableNames: z.array(envNameSchema).max(500),
};

/** One repo of a proposal as the agent writes it: by `owner/name`. */
export const toolProposedRepoSchema = z.strictObject({ repo: repoFullNameSchema, ...proposedRepoFields });

/** One repo of a proposal as core receives it: by ID. */
export const proposedRepoSchema = z.strictObject({ repoId: repoIdSchema, ...proposedRepoFields });
export type ProposedRepo = z.infer<typeof proposedRepoSchema>;

const proposalFields = {
  services: z.array(proposedServiceSchema).max(runnerLimits.servicesMax),
  /** What the agent found and changed, for the project admin. Never logged. */
  notes: bytesCapped(runnerLimits.environmentProposalNotesMaxBytes, "the notes"),
};

/** Whether a proposal's JSON fits `environmentProposalMaxBytes`. */
const proposalFits = (proposal: unknown): boolean =>
  utf8ByteLength(JSON.stringify(proposal)) <= runnerLimits.environmentProposalMaxBytes;
const PROPOSAL_TOO_LARGE = `a proposal is at most ${String(runnerLimits.environmentProposalMaxBytes / 1024)} KiB`;

/** `propose_environment`'s input. Its scripts and notes are never logged. */
export const proposeEnvironmentInputSchema = z
  .strictObject({ repos: z.array(toolProposedRepoSchema).min(1).max(runnerLimits.projectReposMax), ...proposalFields })
  .refine(proposalFits, PROPOSAL_TOO_LARGE)
  .describe("An environment proposal. Its scripts are never logged.");
export type ProposeEnvironmentInput = z.infer<typeof proposeEnvironmentInputSchema>;

/** An environment proposal as core receives it (F-113, ADR 0038). Its scripts are never logged. */
export const environmentProposalSchema = z
  .strictObject({ repos: z.array(proposedRepoSchema).min(1).max(runnerLimits.projectReposMax), ...proposalFields })
  .refine(proposalFits, PROPOSAL_TOO_LARGE)
  .describe("An environment proposal. Its scripts are never logged.");
export type EnvironmentProposal = z.infer<typeof environmentProposalSchema>;

export const proposeEnvironmentDescription =
  "Propose the project's corrected environment, once you have run its setup, its services and its checks in this box " +
  "and fixed what failed. Per repo (owner/name, as the task lists it): the setup script, the checks to run after a turn " +
  "and the names of the variables it needs. Never a variable's value, a token or a password: name it, and a project " +
  "admin fills in its value. Also the services, and notes on what you found and changed. " +
  `At most ${String(runnerLimits.environmentProposalMaxBytes / 1024)} KiB in all. ` +
  "Nothing is saved by this tool: a project admin reads the proposal and accepts, edits or rejects it.";

// ---------- the repos, from the agent's names to their IDs ----------

/** A repo of the task, as the sidecar knows it from the spec. */
export type ToolRepo = { readonly repoId: RepoId; readonly fullName: RepoFullName };

export type ToolRepoMapping<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly unknownRepo: string };

const repoIdOf = (repos: readonly ToolRepo[], fullName: string): RepoId | null =>
  repos.find((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase())?.repoId ?? null;

/** A review's request from the tool's input: each finding's repo by ID, or the first repo the task lacks. */
export const reviewRequestFromTool = (
  input: SubmitReviewInput,
  repos: readonly ToolRepo[],
): ToolRepoMapping<ReviewRequestBody> => {
  const findings: Finding[] = [];
  for (const { repo, ...finding } of input.findings) {
    const repoId = repoIdOf(repos, repo);
    if (repoId === null) {
      return { ok: false, unknownRepo: repo };
    }
    findings.push({ repoId, ...finding });
  }
  return { ok: true, value: { summary: input.summary, findings } };
};

/** A proposal's request from the tool's input: each repo by ID, or the first repo the task lacks. */
export const environmentProposalRequestFromTool = (
  input: ProposeEnvironmentInput,
  repos: readonly ToolRepo[],
): ToolRepoMapping<EnvironmentProposal> => {
  const proposed: ProposedRepo[] = [];
  for (const { repo, ...fields } of input.repos) {
    const repoId = repoIdOf(repos, repo);
    if (repoId === null) {
      return { ok: false, unknownRepo: repo };
    }
    proposed.push({ repoId, ...fields });
  }
  return { ok: true, value: { repos: proposed, services: input.services, notes: input.notes } };
};

// ---------- what each tool returns to the agent ----------

/** The text `submit_draft` returns. */
export const draftResultText = (response: DraftResponse): string => {
  if ("draftId" in response) {
    return `Draft version ${String(response.version)} is saved. A member of the project reads it and decides what goes to the ticket.`;
  }
  switch (response.code) {
    case "wrong-kind":
      return "Only a refine task hands in a draft. This task can't.";
    case "invalid":
      return "The draft doesn't fit the tool's limits. Check each field's limit in the tool's description, and call it again.";
    case "limit-reached":
      return "This task has handed in as many drafts as it may. The last one saved stands.";
    default:
      return response.code satisfies never;
  }
};

/** The text `submit_review` returns. */
export const reviewResultText = (response: ReviewResponse): string => {
  if ("reviewRunId" in response) {
    return "The review is saved. ostra posts it on the pull requests as comments, and a member reads every finding.";
  }
  switch (response.code) {
    case "wrong-kind":
      return "Only a review task hands in a review. This task can't.";
    case "invalid":
      return "The review doesn't fit the tool's limits. Check each field's limit in the tool's description, and call it again.";
    case "limit-reached":
      return "This round's review is already handed in. It stands as it is.";
    case "not-in-review":
      return "The pull requests are no longer waiting for this review. Nothing was saved.";
    default:
      return response.code satisfies never;
  }
};

/** The text `propose_environment` returns. */
export const environmentProposalResultText = (response: EnvironmentProposalResponse): string => {
  if ("proposalId" in response) {
    return "The proposal is saved. A project admin reads it and accepts, edits or rejects it.";
  }
  switch (response.code) {
    case "secret-found":
      return (
        `The proposal holds what looks like a secret's value (${response.found.join(", ")}). Nothing was saved. ` +
        "Name the variable instead of giving its value, and call the tool again."
      );
    case "wrong-kind":
      return "Only an onboarding task proposes an environment. This task can't.";
    case "invalid":
      return "The proposal doesn't fit the tool's limits. Check each field's limit in the tool's description, and call it again.";
    default:
      return response satisfies never;
  }
};

/** The text a tool returns when the agent names a repo the task doesn't have. Names the repo as the agent wrote it. */
export const unknownRepoText = (repo: string): string =>
  `This task has no repo ${JSON.stringify(repo.slice(0, 201))}. Name each repo as owner/name, exactly as the task lists it.`;
