import { reachability } from "@ostra/adapter-sdk";
import type { CodeHostIntegration, StatusMapping, TrackerStatus, TrackerWorkflow, TransitionTaken } from "@ostra/adapter-sdk";
import { z } from "zod";

// A board's status mapping (F-007, F-031, spec section 3, step 2): which tracker statuses count as
// open for the Inbox, which status each step of ticket sync moves a ticket to, who moves it to
// done, and the word a PR body links the ticket with. ostra owns this format: strict. It's kept in
// `Board.statusMap`, and the tracker adapter's `moveTicket` takes it as a `StatusMapping`.

const statusIdSchema = z.string().min(1).max(256);

/** Who moves a ticket to done when its PR merges (spec section 11, item 4). */
export const doneBySchema = z.enum([
  /** The tracker's own GitHub integration, which links PRs and moves statuses. */
  "integration",
  /** ostra, through the tracker adapter. */
  "ostra",
]);
export type DoneBy = z.infer<typeof doneBySchema>;

/** The word before the ticket's key in a PR's body (spec section 11, item 5). */
export const magicWordSchema = z.enum(["Closes", "Refs"]);
export type MagicWord = z.infer<typeof magicWordSchema>;

export const boardMappingSchema = z.strictObject({
  /** The statuses the Inbox lists by default (spec section 11, item 10). */
  open: z.array(statusIdSchema).max(100),
  started: statusIdSchema,
  inReview: statusIdSchema,
  done: statusIdSchema,
  /** Milestone 6 (F-099): where "Mark ready" moves a refined ticket; absent until a project admin picks it. */
  ready: statusIdSchema.optional(),
  doneBy: doneBySchema,
  magicWord: magicWordSchema.default("Closes"),
});
export type BoardMapping = z.infer<typeof boardMappingSchema>;

/** The three moves of a mapping, as the tracker adapter takes them. */
export const statusMappingOf = (mapping: BoardMapping): StatusMapping => ({
  started: mapping.started,
  inReview: mapping.inReview,
  done: mapping.done,
});

/** Reads `Board.statusMap` (storage). A milestone 1 row's `{}` is `null`: the board needs a mapping. */
export const parseBoardMapping = (value: unknown): BoardMapping | null => {
  const parsed = boardMappingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The statuses a draft is made from: `listStatuses`'s answer. */
export type MappableStatus = Pick<TrackerStatus, "id" | "name" | "category" | "vendorType" | "position">;

export type MappingDraft =
  | { readonly ok: true; readonly mapping: BoardMapping }
  | { readonly ok: false; readonly reason: "no-started-status" | "no-done-status" };

const REVIEW_NAME = /review/i;

/** What a draft reads besides the statuses: the integration check, and whether the tracker moves by transitions. */
export type MappingDraftContext = Pick<CodeHostIntegration, "installed"> & {
  /** The adapter declares `transitions` (Jira): Done is moved by ostra by default (milestone 11, choice 8). */
  readonly transitions?: boolean;
};

/**
 * Drafts a board's mapping from its statuses and the integration check (spec section 3, step 2):
 * open is every open status (Linear's triage, backlog and unstarted); started is the first started
 * status not named like review; in review is the started status named like "review", or the
 * started status; done is the first done status. Ticket sync moves to done only when the tracker's
 * own GitHub integration isn't installed, or, on a tracker that moves by transitions (Jira, whose
 * GitHub integration links a PR but moves nothing), always (milestone 11, choice 8). Pure: a
 * project admin edits the draft before it's saved.
 */
export const draftBoardMapping = (statuses: readonly MappableStatus[], integration: MappingDraftContext): MappingDraft => {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  const started = ordered.filter((status) => status.category === "started");
  const plainStarted = started.find((status) => !REVIEW_NAME.test(status.name)) ?? started[0];
  if (plainStarted === undefined) {
    return { ok: false, reason: "no-started-status" };
  }
  const review = started.find((status) => REVIEW_NAME.test(status.name)) ?? plainStarted;
  const done = ordered.find((status) => status.category === "done");
  if (done === undefined) {
    return { ok: false, reason: "no-done-status" };
  }
  return {
    ok: true,
    mapping: {
      open: ordered.filter((status) => status.category === "open").map((status) => status.id),
      started: plainStarted.id,
      inReview: review.id,
      done: done.id,
      doneBy: integration.transitions !== true && integration.installed ? "integration" : "ostra",
      magicWord: "Closes",
    },
  };
};

/** Every status a mapping names must be one of the board's: the check before a mapping is saved. */
export const unknownMappedStatuses = (mapping: BoardMapping, statuses: readonly Pick<TrackerStatus, "id">[]): readonly string[] => {
  const known = new Set(statuses.map((status) => status.id));
  return [...mapping.open, mapping.started, mapping.inReview, mapping.done].filter((id) => !known.has(id));
};

// ---------- a workflow's reach (milestone 11, F-008/c5, F-008/c7) ----------

/** The steps of a mapping that move a ticket to a target status. */
export const mappingSteps = ["started", "inReview", "done", "ready"] as const;
export type MappingStep = (typeof mappingSteps)[number];

/** One `by …` line of a step: the first transition of the routes it starts, and the statuses it serves. */
export type StepRoute = {
  readonly transition: TransitionTaken;
  /** The statuses a ticket takes this transition from (their IDs, in the workflow's order), or `any` for a global one. */
  readonly from: readonly string[] | "any";
};

/** How a step's target status is reached from each status of the workflow. */
export type StepReach = {
  readonly step: MappingStep;
  /** The target status's ID. */
  readonly target: string;
  /** `by Ready for review, from In Progress`: one line per first transition, in the workflow's order. */
  readonly by: readonly StepRoute[];
  /** The statuses no route of at most three transitions leaves toward the target: a ticket there stays put. */
  readonly unreachable: readonly string[];
};

export type MappingReachability =
  /** The credential can't read the graph (Jira without `read:workflow:jira`): no lines, no warnings. */
  | { readonly readable: false }
  | { readonly readable: true; readonly steps: readonly StepReach[] };

/**
 * The Boards page's lines for a mapping on a transitions tracker (boards-mixed.md): for each step,
 * the transitions that start the routes to its target status and the statuses each serves, and
 * the statuses none leaves toward it. Read from the adapter's workflow with the SDK's
 * `reachability` (the rule Jira's `moveTicket` walks). Pure.
 */
export const mappingReachability = (workflow: TrackerWorkflow, mapping: BoardMapping): MappingReachability => {
  if (!workflow.readable) {
    return { readable: false };
  }
  const steps = mappingSteps.flatMap((step): readonly StepReach[] => {
    const target = mapping[step];
    if (target === undefined) {
      return [];
    }
    const lines: { readonly transition: TransitionTaken; readonly global: boolean; readonly from: string[] }[] = [];
    const unreachable: string[] = [];
    for (const { status, reach } of reachability(workflow, target)) {
      switch (reach.kind) {
        case "here":
          break;
        case "route": {
          const line = lines.find((candidate) => candidate.transition.id === reach.first.id);
          if (line === undefined) {
            lines.push({ transition: { id: reach.first.id, name: reach.first.name }, global: reach.first.from === "any", from: [status.id] });
          } else {
            line.from.push(status.id);
          }
          break;
        }
        case "unreachable":
          unreachable.push(status.id);
          break;
        default:
          return reach satisfies never;
      }
    }
    return [{ step, target, by: lines.map((line) => ({ transition: line.transition, from: line.global ? "any" : line.from })), unreachable }];
  });
  return { readable: true, steps };
};

/**
 * The progress comment's line when a move found no route (Q352): the ticket stays where it is,
 * and the comment says so. Status names and the key only.
 */
export const movedNot = (input: { readonly key: string; readonly from: string; readonly to: string }): string =>
  `${input.key} stays in ${input.from}: no transition in its workflow reaches ${input.to}.`;
