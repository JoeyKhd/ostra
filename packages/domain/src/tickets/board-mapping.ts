import type { CodeHostIntegration, StatusMapping, TrackerStatus } from "@ostra/adapter-sdk";
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

/**
 * Drafts a board's mapping from its statuses and the integration check (spec section 3, step 2):
 * open is every open status (Linear's triage, backlog and unstarted); started is the first started
 * status not named like review; in review is the started status named like "review", or the
 * started status; done is the first done status. Ticket sync moves to done only when the tracker's
 * own GitHub integration isn't installed. Pure: a project admin edits the draft before it's saved.
 */
export const draftBoardMapping = (statuses: readonly MappableStatus[], integration: Pick<CodeHostIntegration, "installed">): MappingDraft => {
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
      doneBy: integration.installed ? "integration" : "ostra",
      magicWord: "Closes",
    },
  };
};

/** Every status a mapping names must be one of the board's: the check before a mapping is saved. */
export const unknownMappedStatuses = (mapping: BoardMapping, statuses: readonly Pick<TrackerStatus, "id">[]): readonly string[] => {
  const known = new Set(statuses.map((status) => status.id));
  return [...mapping.open, mapping.started, mapping.inReview, mapping.done].filter((id) => !known.has(id));
};
