import { Prisma } from "@ostra/db";
import { boxSizeNameSchema, executorKindSchema, poolIdSchema, runnerIdSchema, runnerLabelSchema, taskNotOfferableReasonSchema, taskNotOfferableWords } from "@ostra/protocol";
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
  /**
   * Milestone 3 (F-094, ADR 0038 amended): the environment has services, and no runner online
   * that the task may go to can start them (the `docker` executor at minor 2). `online` names the
   * ones that are, so the panel can say "only `host` runners are online".
   */
  z.strictObject({
    code: z.literal("needs-services-runner"),
    online: z.array(z.strictObject({ name: z.string().min(1).max(200), executor: executorKindSchema })).max(20),
  }),
  /**
   * Milestone 3 (F-021): the task's profile uses what only a runner at protocol `minor` or later
   * can do (rules, plan first, skills, MCP servers), and only older runners could take it.
   * Milestone 9 (ADR 0070, Q340): `reason` says why when it isn't the profile, as one of
   * `isTaskOfferable`'s reasons (`message-files`: the task's files, which a runner below minor 8
   * would never write). Missing: the profile.
   */
  z.strictObject({ code: z.literal("needs-protocol"), minor: z.number().int().positive(), reason: taskNotOfferableReasonSchema.exactOptional() }),
  /**
   * Milestone 4 (F-135, ADR 0065): no provider on the project's list serves the profile's model, or
   * the chosen one stopped listing it. `modelName` is the catalog ID or the endpoint's model ID.
   */
  z.strictObject({
    code: z.literal("no-provider-for-model"),
    modelName: z.string().min(1).max(256),
    /**
     * ADR 0065 amended 2026-11-20: the profile runs on its own provider, `name`, which the project's
     * list doesn't allow (`not-allowed`) or which no longer lists the model (`not-listed`). Absent:
     * nothing on the list serves the model by name.
     */
    provider: z.strictObject({ name: z.string().min(1).max(200), reason: z.enum(["not-allowed", "not-listed"]) }).exactOptional(),
  }),
  /** Milestone 4 (F-135): the session's provider is no longer on its project's list. */
  z.strictObject({ code: z.literal("provider-not-allowed") }),
  /** Milestone 4 (F-037, ADR 0055): this month's budget of the project or the organization is reached. */
  z.strictObject({ code: z.literal("budget-reached"), scope: z.enum(["organization", "project"]) }),
  /** Milestone 4 (F-037, ADR 0055): a budget applies and the task's model has no price, so it can't be counted. */
  z.strictObject({ code: z.literal("model-unpriced") }),
  /**
   * Milestone 4 (F-136, ADR 0065): a repo of the task is reached through a GitHub installation an
   * organization admin unlinked or removed, so ostra mints no token for it. `repo` is its full name.
   */
  z.strictObject({ code: z.literal("installation-not-linked"), repo: z.string().min(1).max(256) }),
  // ---- milestone 5 (F-067, F-069, F-095, F-120, ADR 0059): `chooseRunner`'s nearest miss ----
  /** The pool's runners need a registry for snapshots (`kubernetes`), and the organization has none set. */
  z.strictObject({ code: z.literal("needs-registry"), poolId: poolIdSchema }),
  /** The environment has services, and no runner of the project's pools starts them (`host` never does). */
  z.strictObject({ code: z.literal("needs-services") }),
  /** No runner of the project's pools carries every label the task's profile asks for. */
  z.strictObject({ code: z.literal("no-runner-with-labels"), labels: z.array(runnerLabelSchema).max(64) }),
  /** The project's box size is larger than any runner of its pools offers. */
  z.strictObject({ code: z.literal("size-too-large"), size: boxSizeNameSchema }),
  /** The project has `cap` boxes on the pool, its share. */
  z.strictObject({ code: z.literal("project-share-reached"), poolId: poolIdSchema, cap: z.number().int().nonnegative() }),
  /** The pool has as many boxes as its own cap allows. */
  z.strictObject({ code: z.literal("pool-full"), poolId: poolIdSchema }),
  /** A runner fits, and none has room now: the task waits its turn, at `place` in the pool's queue. */
  z.strictObject({ code: z.literal("queued"), poolId: poolIdSchema, place: z.number().int().positive() }),
  /**
   * 2026-11-21 (ADR 0059 amended, F-069): a follow-up of a member's task (its AI review), which no
   * runner of the project's pools can take now, nor `runner`, the personal runner its task ran on.
   * `personal` says why that runner can't: `busy` (no free slot), `offline` (not connected, or not
   * taking tasks), `outdated` (its protocol is older than the task needs), or `not-allowed` (the
   * session's model provider isn't allowed on personal runners, so only the pools may take it).
   */
  z.strictObject({
    code: z.literal("follow-up-waits"),
    runner: z.strictObject({ id: runnerIdSchema, name: z.string().min(1).max(200) }),
    personal: z.enum(["busy", "offline", "outdated", "not-allowed"]),
  }),
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
    case "needs-services-runner":
      return wait.online.length === 0
        ? "Needs a runner that can start services (the docker executor); none is online."
        : `Needs a runner that can start services (the docker executor); only ${[...new Set(wait.online.map((runner) => runner.executor))].join(" and ")} runners are online.`;
    case "needs-protocol":
      return wait.reason === undefined
        ? `The task's agent profile needs a runner at protocol ${String(wait.minor)} or later: update the runner.`
        : taskNotOfferableWords(wait.reason, wait.minor);
    case "no-provider-for-model":
      if (wait.provider !== undefined) {
        return wait.provider.reason === "not-allowed"
          ? `The profile runs on ${wait.provider.name}, which this project's list doesn't allow: an organization admin adds it in Models and keys.`
          : `${wait.provider.name}, the profile's provider, no longer lists ${wait.modelName}: an organization admin picks another model for the profile.`;
      }
      return `No provider on this project's list serves ${wait.modelName}: an organization admin adds one under Models.`;
    case "provider-not-allowed":
      return "The session's model provider is no longer allowed in this project.";
    case "budget-reached":
      return `The ${wait.scope === "project" ? "project's" : "organization's"} budget for this month is reached: the task waits until it's raised or the month ends.`;
    case "model-unpriced":
      return "This model has no price, so the budget can't count it";
    case "installation-not-linked":
      return `The GitHub installation that holds ${wait.repo} isn't linked to ostra: an organization admin links it on the GitHub page.`;
    case "needs-registry":
      return "The pool's runners need a registry for snapshots: an admin sets one under Organization, Registry.";
    case "needs-services":
      return "The environment has services, and no runner of the project's pools can start them.";
    case "no-runner-with-labels":
      return `No runner of the project's pools has every label the profile asks for (${wait.labels.join(", ")}).`;
    case "size-too-large":
      return `The ${wait.size} box size is larger than any runner of the project's pools offers.`;
    case "project-share-reached":
      return `The project is at its share of the pool: ${String(wait.cap)} boxes.`;
    case "pool-full":
      return "The pool is at its cap of boxes.";
    case "queued":
      return `Waiting its turn: number ${String(wait.place)} in the pool's queue.`;
    case "follow-up-waits":
      return wait.personal === "not-allowed"
        ? "Waiting for a runner of the project's pools: the model provider isn't allowed on personal runners."
        : "Waiting for a runner: the one its task ran on, or one of the project's pools.";
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
