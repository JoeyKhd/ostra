import { setupTimelineSteps } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import { z } from "zod";

// `setup.timeline`'s input and output (F-076, ticket 24), apart from the router so the measure's
// script (`scripts/measure-setup.ts`) validates the panel's answer with the same schema, without
// loading the routers.

export const setupTimelineInputSchema = z.strictObject({
  /** When the person ran the guide's first command, in milliseconds since the epoch. */
  start: z.number().int().nonnegative(),
});

const step = z.enum(setupTimelineSteps);

/** The domain's `SetupTimeline`, as the panel sends it. */
export const setupTimelineOutputSchema = z.strictObject({
  organizationId: organizationIdSchema,
  start: z.number().int(),
  steps: z.array(
    z.discriminatedUnion("state", [
      z.strictObject({ step, state: z.literal("done"), optional: z.boolean(), at: z.number().int(), sinceStartMs: z.number().int() }),
      z.strictObject({ step, state: z.literal("missing"), optional: z.boolean() }),
    ]),
  ).readonly(),
  missing: z.array(step).readonly(),
  totalMs: z.number().int().nullable(),
});
export type SetupTimelineOutput = z.infer<typeof setupTimelineOutputSchema>;
