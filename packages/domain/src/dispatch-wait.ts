import { Prisma } from "@ostra/db";
import { runnerIdSchema } from "@ostra/protocol";
import type { RunnerId } from "@ostra/protocol";
import { z } from "zod";

// Why a queued task waits (Q132, milestone 2's ticket 43): a code with its values, stored in
// `Task.dispatchWait` and worded by the panel's message files (F-083). Core never writes the
// sentence a member reads. `dispatchTask`, `acceptOffer` and the offer timeout record it; an offer
// going out clears it, because then the task waits on the runner the offer went to, which its lease
// says.
//
// `dispatchNote`, the English sentence milestone 1 stored, is written beside it for one release
// (add first, drop later), from `dispatchNoteFor`.

export const dispatchWaitSchema = z.discriminatedUnion("code", [
  /** The session's agent profile has no model. */
  z.strictObject({ code: z.literal("no-model") }),
  /** The model provider asked to wait (a rate limit) until `until`, epoch ms. */
  z.strictObject({ code: z.literal("provider-held"), until: z.number().int().nonnegative() }),
  /** The model provider is at its cap of sessions at once. */
  z.strictObject({ code: z.literal("provider-cap"), cap: z.number().int().positive() }),
  /** The model provider isn't allowed on personal runners, and the task picked one. */
  z.strictObject({ code: z.literal("personal-runner-not-allowed") }),
  /** The picked personal runner is offline, busy, revoked, or not its creator's. */
  z.strictObject({ code: z.literal("personal-runner-unavailable") }),
  /** No runner of the project's pools is online with a free slot. */
  z.strictObject({ code: z.literal("no-runner-online") }),
  /** A runner declined the offer; the next dispatch looks for another. */
  z.strictObject({ code: z.literal("offer-declined") }),
  /** A runner didn't answer the offer in time; the next dispatch looks for another. */
  z.strictObject({ code: z.literal("offer-timed-out") }),
]);
export type DispatchWait = z.infer<typeof dispatchWaitSchema>;
export type DispatchWaitCode = DispatchWait["code"];

/** The stored value: a parsed reason, or `null` when there is none or it doesn't parse. */
export const dispatchWaitFromDb = (value: unknown): DispatchWait | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = dispatchWaitSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** What to write: the reason checked against the schema, or the database's `NULL`. */
export const dispatchWaitToDb = (wait: DispatchWait | null): Prisma.InputJsonObject | typeof Prisma.DbNull =>
  wait === null ? Prisma.DbNull : dispatchWaitSchema.parse(wait);

/** Milestone 1's sentence, still stored in `dispatchNote` for one release. Never shown by the panel. */
export const dispatchNoteFor = (wait: DispatchWait): string => {
  switch (wait.code) {
    case "no-model":
      return "The session's agent profile has no model: an admin picks one under Models.";
    case "provider-held":
      return `The model provider asked to wait (a rate limit) until ${new Date(wait.until).toISOString()}.`;
    case "provider-cap":
      return `The model provider is at its cap of ${String(wait.cap)} sessions at once.`;
    case "personal-runner-not-allowed":
      return "The model provider isn't allowed on personal runners: an admin turns it on under Models.";
    case "personal-runner-unavailable":
      return "The picked personal runner is offline or busy.";
    case "no-runner-online":
      return "No runner of the project's pools is online with a free slot.";
    case "offer-declined":
      return "The runner declined the offer; looking for another.";
    case "offer-timed-out":
      return "The runner didn't answer the offer in time; looking for another.";
    default:
      return wait satisfies never;
  }
};

/** The columns that record why a task waits, both of them. */
export const dispatchWaitColumns = (wait: DispatchWait | null) => ({
  dispatchWait: dispatchWaitToDb(wait),
  dispatchNote: wait === null ? null : dispatchNoteFor(wait),
});

/**
 * Why a queued task waits, as `tasks.get` and the task list return it (Q132): the runner its open
 * offer went to, or the reason no runner fits. `null` for a task that isn't queued, and just after
 * a task was made, before its first dispatch ran. Every sentence is the panel's (F-083).
 */
export type Waiting =
  | { readonly kind: "offered"; readonly runner: { readonly id: RunnerId; readonly name: string }; /** Epoch ms. */ readonly since: number }
  | { readonly kind: "no-runner"; readonly reason: DispatchWait }
  | null;

/** A task's active lease, with its runner, as the readers load it. */
export type OpenOffer = {
  readonly acceptedAt: Date | null;
  readonly grantedAt: Date;
  readonly runner: { readonly id: string; readonly name: string } | undefined;
};

export const waitingFor = (task: { readonly state: string; readonly dispatchWait: unknown }, offer: OpenOffer | null): Waiting => {
  if (task.state !== "queued") {
    return null;
  }
  // An offer no runner accepted yet: the task waits on that runner.
  if (offer !== null && offer.acceptedAt === null && offer.runner !== undefined) {
    return { kind: "offered", runner: { id: runnerIdSchema.parse(offer.runner.id), name: offer.runner.name }, since: offer.grantedAt.getTime() };
  }
  const reason = dispatchWaitFromDb(task.dispatchWait);
  return reason === null ? null : { kind: "no-runner", reason };
};
