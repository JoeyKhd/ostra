import { z } from "zod";

import { attachmentIdSchema, repoIdSchema } from "../ids.ts";
import type { RepoId } from "../ids.ts";
import { envNameSchema, repoFullNameSchema, serviceNameSchema } from "../common.ts";
import type { RepoFullName } from "../common.ts";
import { utf8ByteLength } from "../json.ts";
import { ONE_ORIGIN_RULE } from "../agent/prompts.ts";
import type { DraftResponse, EnvironmentProposalResponse, ReviewRequestBody, ReviewResponse } from "../runner/http.ts";
import { portRefusal, runnerLimits } from "../runner/limits.ts";
import type { PortRefusal, ReservedPorts } from "../runner/limits.ts";
import {
  anyPortSchema,
  appLabelSchema,
  appPathSchema,
  appProcessNameSchema,
  appProcessReasonSchema,
  appProcessStateSchema,
  captionSchema,
  screenshotSizeSchema,
  viewportPresetSchema,
  viewportPresetSizes,
} from "../task/app.ts";
import { appProcessRuleIssues, appProcessRuleWords, servicePreviewSchema, taskSpecAppProcessSchema } from "../task/spec.ts";

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
  /**
   * Minor 7 (F-121): the task's screenshots or recordings that show the finding, by the IDs
   * `take_screenshot` and `record_app` returned, at most `findingAttachmentsMax`. A minor-6 core is
   * never sent them (`encodeReviewRequestForMinor`).
   */
  attachmentIds: z.array(attachmentIdSchema).max(runnerLimits.findingAttachmentsMax).optional(),
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
  /** Minor 7 (F-140): the service has a web UI, shown as a preview under this label. Missing or `null`: none. */
  preview: servicePreviewSchema.nullable().optional(),
});
export type ProposedService = z.infer<typeof proposedServiceSchema>;

/** An app process the onboarding task proposes, as the agent writes it: its repo by `owner/name`. Its command is never logged. */
export const toolProposedAppProcessSchema = taskSpecAppProcessSchema.omit({ repoId: true }).extend({ repo: repoFullNameSchema });
export type ToolProposedAppProcess = z.infer<typeof toolProposedAppProcessSchema>;

/** An app process of a proposal as core receives it: its repo by ID. Its command is never logged. */
export const proposedAppProcessSchema = taskSpecAppProcessSchema;
export type ProposedAppProcess = z.infer<typeof proposedAppProcessSchema>;

/** The rules over a proposal's app processes, as the environment's: one primary, names and ports once. */
const appProcessRules = (
  processes: readonly { readonly name: string; readonly port: number; readonly primary: boolean }[],
  context: z.RefinementCtx,
): void => {
  for (const issue of appProcessRuleIssues(processes)) {
    context.addIssue({ code: "custom", message: appProcessRuleWords(issue) });
  }
};

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

/** `propose_environment`'s input. Its scripts, commands and notes are never logged. */
export const proposeEnvironmentInputSchema = z
  .strictObject({
    repos: z.array(toolProposedRepoSchema).min(1).max(runnerLimits.projectReposMax),
    ...proposalFields,
    /** Minor 7 (F-140): the app's processes, in the order they start, each tested in this box. */
    appProcesses: z.array(toolProposedAppProcessSchema).max(runnerLimits.appProcessesMax).superRefine(appProcessRules).optional(),
  })
  .refine(proposalFits, PROPOSAL_TOO_LARGE)
  .describe("An environment proposal. Its scripts and commands are never logged.");
export type ProposeEnvironmentInput = z.infer<typeof proposeEnvironmentInputSchema>;

/** An environment proposal as core receives it (F-113, ADR 0038). Its scripts and commands are never logged. */
export const environmentProposalSchema = z
  .strictObject({
    repos: z.array(proposedRepoSchema).min(1).max(runnerLimits.projectReposMax),
    ...proposalFields,
    /** Minor 7 (F-140): the app's processes. A minor-6 core is never sent them (`encodeEnvironmentProposalForMinor`). */
    appProcesses: z.array(proposedAppProcessSchema).max(runnerLimits.appProcessesMax).superRefine(appProcessRules).optional(),
  })
  .refine(proposalFits, PROPOSAL_TOO_LARGE)
  .describe("An environment proposal. Its scripts and commands are never logged.");
export type EnvironmentProposal = z.infer<typeof environmentProposalSchema>;

export const proposeEnvironmentDescription =
  "Propose the project's corrected environment, once you have run its setup, its services and its checks in this box " +
  "and fixed what failed. Per repo (owner/name, as the task lists it): the setup script, the checks to run after a turn " +
  "and the names of the variables it needs. Never a variable's value, a token or a password: name it, and a project " +
  "admin fills in its value. Also the services, and notes on what you found and changed. " +
  "If the project has an app to look at, also its app processes, each started and checked in this box: a name " +
  "(lower-case letters, digits and dashes), its repo and folder, the command that starts it and keeps running, its port " +
  "(1024 or above), a ready check (an HTTP path, a command, or the port), a label such as Web or API, at most one marked " +
  "primary (the one people open first), and hostRewrite (true unless the app builds URLs from its host). Keep the browser " +
  "on the primary's origin: put an API behind the frontend's dev-server proxy (Vite's server.proxy, Next.js rewrites). " +
  "A service with a web UI may carry a preview label. " +
  `At most ${String(runnerLimits.appProcessesMax)} app processes and ${String(runnerLimits.environmentProposalMaxBytes / 1024)} KiB in all. ` +
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
  if (input.appProcesses === undefined) {
    return { ok: true, value: { repos: proposed, services: input.services, notes: input.notes } };
  }
  const appProcesses: ProposedAppProcess[] = [];
  for (const { repo, ...fields } of input.appProcesses) {
    const repoId = repoIdOf(repos, repo);
    if (repoId === null) {
      return { ok: false, unknownRepo: repo };
    }
    appProcesses.push({ repoId, ...fields });
  }
  return { ok: true, value: { repos: proposed, services: input.services, notes: input.notes, appProcesses } };
};

// ---------- what a sidecar sends a core one minor behind (ADR 0034's window) ----------

/** A review as a core at `minor` reads it: below minor 7, its findings lose their attachments. */
export const encodeReviewRequestForMinor = (body: ReviewRequestBody, minor: number): ReviewRequestBody => {
  if (minor >= 7) {
    return body;
  }
  return {
    ...body,
    findings: body.findings.map((finding) => {
      if (finding.attachmentIds === undefined) {
        return finding;
      }
      const minor6 = { ...finding };
      Reflect.deleteProperty(minor6, "attachmentIds");
      return minor6;
    }),
  };
};

/** A proposal as a core at `minor` reads it: below minor 7, no app processes and no service's preview. */
export const encodeEnvironmentProposalForMinor = (proposal: EnvironmentProposal, minor: number): EnvironmentProposal => {
  if (minor >= 7) {
    return proposal;
  }
  return {
    repos: proposal.repos,
    notes: proposal.notes,
    services: proposal.services.map((service) => {
      if (service.preview === undefined) {
        return service;
      }
      const withoutPreview = { ...service };
      Reflect.deleteProperty(withoutPreview, "preview");
      return withoutPreview;
    }),
  };
};

// ---------- the app tools (minor 7, F-121, F-140, F-141, ADR 0068) ----------

export const START_APP_TOOL = "start_app";
export const SHOW_PREVIEW_TOOL = "show_preview";
export const TAKE_SCREENSHOT_TOOL = "take_screenshot";
export const RECORD_APP_TOOL = "record_app";

/** The app tools' names, in the order the agent's list shows them. */
export const appToolNames = [START_APP_TOOL, SHOW_PREVIEW_TOOL, TAKE_SCREENSHOT_TOOL, RECORD_APP_TOOL] as const;
export type AppToolName = (typeof appToolNames)[number];

/** What a picture shows, as the agent names it: one of the environment's app processes, or a port it started. */
export const appToolTargetSchema = z.union([
  z.strictObject({ process: appProcessNameSchema }),
  z.strictObject({ port: anyPortSchema }),
]);
export type AppToolTarget = z.infer<typeof appToolTargetSchema>;

/** `start_app`'s input: these processes, or all of them. */
export const startAppInputSchema = z.strictObject({
  names: z.array(appProcessNameSchema).min(1).max(runnerLimits.appProcessesMax).optional(),
});
export type StartAppInput = z.infer<typeof startAppInputSchema>;

/** `show_preview`'s input: a port the agent started, for members to open in the task's pane. */
export const showPreviewInputSchema = z.strictObject({
  port: anyPortSchema,
  label: appLabelSchema,
  path: appPathSchema.optional(),
  primary: z.boolean().optional(),
});
export type ShowPreviewInput = z.infer<typeof showPreviewInputSchema>;

/** `take_screenshot`'s input. The caption is never logged. */
export const takeScreenshotInputSchema = z
  .strictObject({
    target: appToolTargetSchema,
    path: appPathSchema.optional(),
    width: viewportPresetSchema.optional(),
    size: screenshotSizeSchema.optional(),
    fullPage: z.boolean().optional(),
    caption: captionSchema.optional(),
  })
  .refine((input) => input.width === undefined || input.size === undefined, "a width preset or a size, not both")
  .describe("A screenshot. Its caption is never logged.");
export type TakeScreenshotInput = z.infer<typeof takeScreenshotInputSchema>;

/** A CSS selector a step acts on. */
const selectorSchema = z.string().min(1).max(1000);

/**
 * One step of a recording, from a closed list (ADR 0068): open a path, click on a selector or a
 * text, fill a field, press a key, scroll by some pixels, or wait for a selector or a time. The
 * steps are the agent's words: data the box's own client acts on, never a script, and never logged.
 */
export const recordStepSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("goto"), path: appPathSchema }),
  z.strictObject({
    action: z.literal("click"),
    target: z.union([z.strictObject({ selector: selectorSchema }), z.strictObject({ text: z.string().min(1).max(500) })]),
  }),
  z.strictObject({ action: z.literal("fill"), selector: selectorSchema, value: z.string().max(10_000) }),
  z.strictObject({ action: z.literal("press"), key: z.string().min(1).max(64) }),
  z.strictObject({ action: z.literal("scroll"), deltaX: z.number().min(-20_000).max(20_000), deltaY: z.number().min(-20_000).max(20_000) }),
  z.strictObject({
    action: z.literal("wait"),
    until: z.union([z.strictObject({ selector: selectorSchema }), z.strictObject({ ms: z.number().int().min(1).max(10_000) })]),
  }),
]);
export type RecordStep = z.infer<typeof recordStepSchema>;
export type RecordStepAction = RecordStep["action"];

/** A recording's steps: at least one, at most `recordingStepsMax`. Never logged. */
export const recordStepsSchema = z
  .array(recordStepSchema)
  .min(1)
  .max(runnerLimits.recordingStepsMax)
  .describe("A recording's steps. Never logged.");

/** `record_app`'s input. The steps and the caption are never logged. */
export const recordAppInputSchema = z
  .strictObject({
    target: appToolTargetSchema,
    steps: recordStepsSchema,
    /** The longest it records, from 1 to `recordingMaxSeconds`; it ends sooner when the steps are done. */
    seconds: z.number().int().min(1).max(runnerLimits.recordingMaxSeconds).optional(),
    caption: captionSchema.optional(),
  })
  .describe("A recording. Its steps and caption are never logged.");
export type RecordAppInput = z.infer<typeof recordAppInputSchema>;

const widthWords = viewportPresetSchema.options
  .map((preset) => `${preset} ${String(viewportPresetSizes[preset].width)}×${String(viewportPresetSizes[preset].height)}`)
  .join(", ");

export const startAppDescription =
  "Start the project's app processes in this box (all of them, or the names you give), in the environment's order, " +
  "each after the one before it is ready, and wait until each passes its ready check " +
  `(at most ${String(runnerLimits.appReadyTimeoutSeconds)} s each). Those already running are left as they are. ` +
  "It returns each process's state, its address in this box (also in OSTRA_APP_<NAME>_URL) and the path of its log, " +
  `which you can read to see why one failed. ${ONE_ORIGIN_RULE}`;

export const showPreviewDescription =
  "Show a port you started yourself in the task's preview pane, with a label such as Docs, and the path it opens on. " +
  `Members of the project can then open it. The port is 1024 or above, and at most ${String(runnerLimits.announcedPreviewsMax)} ` +
  "ports are shown in one task. Mark it primary only when no environment process is the primary. " +
  "A member may keep it in the project's environment. Never show a port that serves secrets or files outside the app.";

export const takeScreenshotDescription =
  "Take a screenshot of the running app in this box's browser, for the members of the project to see in the task's thread " +
  "and on the pull request: an app process by its name, or a port you started; a path (default /); a width preset " +
  `(${widthWords}) or a size; the full page or the viewport; and a caption of at most ` +
  `${String(runnerLimits.captionMaxBytes / 1024)} KiB saying what it shows. It waits for the page to go quiet ` +
  `(at most ${String(runnerLimits.screenshotSettleMaxMs / 1000)} s). At most ${String(runnerLimits.attachmentsPerTurnMax)} ` +
  `pictures a turn. A member reads every caption. ${ONE_ORIGIN_RULE}`;

export const recordAppDescription =
  "Record the running app in this box's browser while it runs your steps, for the members of the project to play in " +
  "the task's thread: an app process by its name, or a port you started, then up to " +
  `${String(runnerLimits.recordingStepsMax)} steps, each one of goto (a path), click (a CSS selector or a text), ` +
  "fill (a selector and a value), press (a key), scroll (by pixels) and wait (for a selector or some ms). " +
  `At most ${String(runnerLimits.recordingMaxSeconds)} s at ${String(runnerLimits.recordingFramesPerSecond)} frames a second, ` +
  `and a caption of at most ${String(runnerLimits.captionMaxBytes / 1024)} KiB. A member reads every caption and sees ` +
  `every step. ${ONE_ORIGIN_RULE}`;

/** One process in `start_app`'s answer: its state, its address in the box and its log's path. */
export const startAppProcessResultSchema = z.strictObject({
  name: appProcessNameSchema,
  label: appLabelSchema,
  state: appProcessStateSchema,
  /** Its address in this box, such as `http://localhost:5173`. */
  address: z.url({ protocol: /^http$/ }),
  /**
   * Its log in the task's folder (`appLogPath`), as the agent's process reads it: the runner gives
   * the full path, since the agent works in a repo's checkout below that folder. Its content is
   * never logged.
   */
  logPath: z.string().min(1).max(1024),
  /** Ticket 12: why it failed or stopped, in ostra's words (`appProcessReasonText`); absent or `null` when it runs. */
  reason: appProcessReasonSchema.nullable().optional(),
  /** Ticket 12: the code it exited with, when it did. */
  exitCode: z.number().int().nullable().optional(),
});
export type StartAppProcessResult = z.infer<typeof startAppProcessResultSchema>;

export const startAppResultSchema = z.strictObject({
  processes: z.array(startAppProcessResultSchema).max(runnerLimits.appProcessesMax),
});
export type StartAppResult = z.infer<typeof startAppResultSchema>;

/** What an app tool refused, for its words to the agent (`appToolRefusalText`). Names and numbers only. */
export type AppToolRefusal =
  /** A port below `appPortMin`, or one of the box's own. */
  | { readonly code: "port-not-allowed"; readonly port: number; readonly why: PortRefusal["reason"] }
  /** The box has no browser (an image without one, or a `host` machine without one and no download). */
  | { readonly code: "no-browser" }
  /** The turn's pictures or the task's shown ports reached their limit. */
  | { readonly code: "limit-reached"; readonly limit: "attachments" | "previews" }
  /** A process didn't pass its ready check; its log says why. */
  | { readonly code: "not-ready"; readonly name: string; readonly logPath: string }
  /** No app process of that name. */
  | { readonly code: "unknown-process"; readonly name: string }
  /** A second primary: one is already the primary preview. */
  | { readonly code: "second-primary" }
  /** The environment declares no app process to start. */
  | { readonly code: "no-app-processes" };

/** One app tool's call, with its input. */
export type AppToolCall =
  | { readonly tool: typeof START_APP_TOOL; readonly input: StartAppInput }
  | { readonly tool: typeof SHOW_PREVIEW_TOOL; readonly input: ShowPreviewInput }
  | { readonly tool: typeof TAKE_SCREENSHOT_TOOL; readonly input: TakeScreenshotInput }
  | { readonly tool: typeof RECORD_APP_TOOL; readonly input: RecordAppInput };

/** What the box knows when an app tool is called. */
export type AppToolContext = {
  readonly reservedPorts: ReservedPorts;
  /** The environment's app processes' names. */
  readonly processNames: readonly string[];
  /** The task's previews now: the declared processes, the services marked as previews and the announced ports. */
  readonly previews: readonly { readonly port: number; readonly primary: boolean; readonly source: "declared" | "announced" }[];
  /** The pictures this turn added so far. */
  readonly attachmentsThisTurn: number;
  /** Whether the box has a browser. */
  readonly browser: boolean;
};

const portCheck = (port: number, reserved: ReservedPorts): AppToolRefusal | null => {
  const refused = portRefusal(port, reserved);
  return refused === null ? null : { code: "port-not-allowed", port, why: refused.reason };
};

const targetCheck = (target: AppToolTarget, context: AppToolContext): AppToolRefusal | null => {
  if ("process" in target) {
    return context.processNames.includes(target.process) ? null : { code: "unknown-process", name: target.process };
  }
  return portCheck(target.port, context.reservedPorts);
};

/**
 * Whether the box refuses an app tool's call before it runs it (ADR 0068): a port below
 * `appPortMin` or one of its own, a process it doesn't have, a second primary, no browser, or a
 * limit reached. `null`: run it. The input already passed its schema, which refuses a 21st step.
 */
export const appToolRefusal = (call: AppToolCall, context: AppToolContext): AppToolRefusal | null => {
  switch (call.tool) {
    case START_APP_TOOL: {
      if (context.processNames.length === 0) {
        return { code: "no-app-processes" };
      }
      const unknown = (call.input.names ?? []).find((name) => !context.processNames.includes(name));
      return unknown === undefined ? null : { code: "unknown-process", name: unknown };
    }
    case SHOW_PREVIEW_TOOL: {
      const refused = portCheck(call.input.port, context.reservedPorts);
      if (refused !== null) {
        return refused;
      }
      if (call.input.primary === true && context.previews.some((preview) => preview.primary && preview.port !== call.input.port)) {
        return { code: "second-primary" };
      }
      const shown = context.previews.some((preview) => preview.port === call.input.port);
      const announced = context.previews.filter((preview) => preview.source === "announced").length;
      return !shown && announced >= runnerLimits.announcedPreviewsMax ? { code: "limit-reached", limit: "previews" } : null;
    }
    case TAKE_SCREENSHOT_TOOL:
    case RECORD_APP_TOOL: {
      const refused = targetCheck(call.input.target, context);
      if (refused !== null) {
        return refused;
      }
      if (!context.browser) {
        return { code: "no-browser" };
      }
      return context.attachmentsThisTurn >= runnerLimits.attachmentsPerTurnMax ? { code: "limit-reached", limit: "attachments" } : null;
    }
    default:
      return call satisfies never;
  }
};

/** The text an app tool returns for a refusal. Names a process or a port the agent gave, never other text. */
export const appToolRefusalText = (refusal: AppToolRefusal): string => {
  switch (refusal.code) {
    case "port-not-allowed":
      return refusal.why === "below-min"
        ? `Port ${String(refusal.port)} isn't allowed: an app's port is ${String(runnerLimits.appPortMin)} or above.`
        : `Port ${String(refusal.port)} isn't allowed: it's one of this box's own ports, not the app's.`;
    case "no-browser":
      return (
        "There's no browser in this box, so no screenshot or recording can be taken. " +
        "Carry on without one; the members of the project see that the box has no browser."
      );
    case "limit-reached":
      return refusal.limit === "attachments"
        ? `This turn has added ${String(runnerLimits.attachmentsPerTurnMax)} screenshots and recordings, as many as a turn may. Carry on without more.`
        : `This task already shows ${String(runnerLimits.announcedPreviewsMax)} ports of its own, as many as it may.`;
    case "not-ready":
      return (
        `The app process ${JSON.stringify(refusal.name.slice(0, 41))} didn't get ready within ` +
        `${String(runnerLimits.appReadyTimeoutSeconds)} s. Read its log at ${refusal.logPath} to see why, fix it, and call the tool again.`
      );
    case "unknown-process":
      return `This environment has no app process ${JSON.stringify(refusal.name.slice(0, 41))}. Name one the task's instructions list, or give a port.`;
    case "second-primary":
      return "Another preview is already the primary. Show this one without primary.";
    case "no-app-processes":
      return "This environment declares no app process. Start the app yourself, then show its port with show_preview.";
    default:
      return refusal satisfies never;
  }
};

/**
 * Why an app process isn't running, in ostra's words for the agent (ticket 12): names, numbers and
 * the log's path, never the log. A port in use says to stop the agent's own server on it, or to
 * show that one with `show_preview`.
 */
export const appProcessReasonText = (process: Pick<StartAppProcessResult, "address" | "logPath" | "exitCode" | "reason">): string => {
  const port = new URL(process.address).port;
  const code = process.exitCode === null || process.exitCode === undefined ? "" : ` with code ${String(process.exitCode)}`;
  switch (process.reason) {
    case "port-in-use":
      return (
        `Port ${port} is already in use in this box, so it wasn't started. ` +
        `If you started a server on it yourself, stop yours and call start_app again, or keep yours and show it with ${SHOW_PREVIEW_TOOL}.`
      );
    case "ready-timeout":
      return `It didn't get ready within ${String(runnerLimits.appReadyTimeoutSeconds)} s. Read its log at ${process.logPath} to see why.`;
    case "exited":
      return `It exited${code}. Read its log at ${process.logPath} to see why.`;
    case "start-failed":
      return `It couldn't start: its folder is missing, or its port is one of this box's own. Its log, if any, is at ${process.logPath}.`;
    case "stopped":
      return `It was stopped${code}.`;
    case "box-stopped":
      return `It stopped with the box${code}.`;
    case null:
    case undefined:
      return "";
    default:
      return process.reason satisfies never;
  }
};

/** The text `start_app` returns: each process's state, address and log, and why one isn't running. */
export const startAppResultText = (result: StartAppResult): string =>
  result.processes.length === 0
    ? "No app process was started."
    : result.processes
        .map((process) => {
          const line = `${process.name} (${process.label}): ${process.state} at ${process.address}; its log is ${process.logPath}.`;
          const why = appProcessReasonText(process);
          return why === "" ? line : `${line} ${why}`;
        })
        .join("\n");

/** The text `show_preview` returns. */
export const showPreviewResultText = (input: { readonly label: string; readonly port: number }): string =>
  `${input.label} (port ${String(input.port)}) is shown in the task's preview pane. ` +
  "The members of the project can open it, and one may keep it in the environment.";

/** The text `take_screenshot` and `record_app` return: the picture's ID, which a finding may name, and what it holds. */
export const attachmentResultText = (result: {
  readonly attachmentId: string;
  readonly kind: "screenshot" | "recording";
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
  readonly frameCount: number | null;
}): string => {
  const size = `${String(result.width)}×${String(result.height)}`;
  if (result.kind === "screenshot") {
    return `Screenshot ${result.attachmentId} (${size}) is in the task's thread for the members of the project.`;
  }
  const seconds = ((result.durationMs ?? 0) / 1000).toFixed(1);
  return `Recording ${result.attachmentId} (${size}, ${seconds} s, ${String(result.frameCount ?? 0)} frames) is in the task's thread for the members of the project.`;
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
