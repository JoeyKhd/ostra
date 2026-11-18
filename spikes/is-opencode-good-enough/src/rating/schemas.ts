// The rating scale, and the key that turns a blind ID back into a run.

import { z } from "zod";
import { RunIdSchema } from "../runner/schemas.ts";
import { TicketIdSchema } from "../tickets/schema.ts";

/**
 * The reviewer's verdict on a pull request, as research/rivet.md's bake-off
 * words it: merge as it is, merge with small edits, reject. The pass bar counts
 * the first two.
 */
export const RATINGS = ["merge-as-is", "merge-with-small-edits", "reject"] as const;
export const RatingSchema = z.enum(RATINGS);
export type Rating = z.infer<typeof RatingSchema>;

export const isMergeable = (rating: Rating): boolean => rating === "merge-as-is" || rating === "merge-with-small-edits";

export const BlindIdSchema = z.string().regex(/^R-[0-9a-f]{6}$/).brand<"BlindId">();
export type BlindId = z.infer<typeof BlindIdSchema>;

export const KeyEntrySchema = z.strictObject({
  id: BlindIdSchema,
  runId: RunIdSchema,
  ticketId: TicketIdSchema,
  /** The set of runs it came from, relative to the spike's folder. */
  setDir: z.string(),
});
export type KeyEntry = z.infer<typeof KeyEntrySchema>;

export const KeyFileSchema = z.strictObject({
  schema: z.literal(1),
  seed: z.number().int(),
  createdAt: z.string(),
  /** In the order of the sheet. */
  entries: z.array(KeyEntrySchema),
});
export type KeyFile = z.infer<typeof KeyFileSchema>;

export const RATINGS_HEADER = ["id", "rating", "notes"] as const;
