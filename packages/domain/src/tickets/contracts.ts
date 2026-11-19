import type { TicketStatusCategory } from "@ostra/adapter-sdk";
import type { DbEnum } from "@ostra/db";
import { repoIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { TaskId, TicketKey } from "@ostra/protocol";
import { z } from "zod";

import { branchSlugFor } from "../branch-name.ts";
import type { MagicWord } from "./board-mapping.ts";

// Milestone 2's small domain contracts (ticket 06, and the decisions of ticket 40 on the targets).

// ---------- repos: the two checks (F-055, F-060) ----------

/** One check's answer: `unknown` when the code host can't say, with the reason. */
export const branchRuleCheckSchema = z.strictObject({
  result: z.union([z.boolean(), z.literal("unknown")]),
  /** Words for the panel, never a vendor's body: why it's false or unknown. */
  reason: z.string().max(500).optional(),
});
export type BranchRuleCheck = z.infer<typeof branchRuleCheckSchema>;

/** `Repo.branchRules`: the default branch's protection and signed-commit rule, as of `branchRulesCheckedAt`. */
export const repoBranchRulesSchema = z.strictObject({
  protected: branchRuleCheckSchema,
  signedCommits: branchRuleCheckSchema,
});
export type RepoBranchRules = z.infer<typeof repoBranchRulesSchema>;

/** How long a repo's checks are reused before "Check again" reads them anew (ticket 31). */
export const BRANCH_RULES_CACHE_MS = 10 * 60_000;

/** A repo whose default branch requires signed commits isn't supported: no task starts on it (F-055). */
export const repoIsUnsupported = (rules: RepoBranchRules | null): boolean => rules?.signedCommits.result === true;

/** A repo whose default branch isn't protected gets a warning (F-060). `unknown` warns too. */
export const repoNeedsProtectionWarning = (rules: RepoBranchRules | null): boolean =>
  rules !== null && rules.protected.result !== true;

// ---------- reopening ----------

/**
 * The member's message for a one-click reopen from a limit or a crash (ticket 40). English agent
 * input, not panel copy, so it lives here and not in the panel's messages.
 */
export const reopenCarryOnText = "Carry on from where you stopped.";

// ---------- retention (F-079, spec section 11, item 11) ----------

export type RetentionSetting = {
  /** `InstanceSetting.retentionDays`: `null` means keep. */
  readonly retentionDays: number | null;
  /** `InstanceSetting.retentionSetAt`: `null` means no admin has saved one. */
  readonly retentionSetAt: Date | null;
};

/** Where the retention in effect comes from: an admin's saved choice, the env, or the default (keep). */
export type RetentionSource = "saved" | "env" | "default";

export type RetentionInEffect = { readonly days: number | null; readonly source: RetentionSource };

/**
 * The retention in effect. A saved one wins over `OSTRA_RETENTION_DAYS`, and a saved "keep" (`null`)
 * counts as a choice. With none saved, the env applies; without it, keep. Pure.
 */
export const retentionInEffect = (setting: RetentionSetting | null, envDays: number | null): RetentionInEffect => {
  if (setting !== null && setting.retentionSetAt !== null) {
    return { days: setting.retentionDays, source: "saved" };
  }
  return envDays === null ? { days: null, source: "default" } : { days: envDays, source: "env" };
};

/** The retention's days in effect, or `null` to keep while the task exists. */
export const retentionDaysInEffect = (setting: RetentionSetting | null, envDays: number | null): number | null =>
  retentionInEffect(setting, envDays).days;

// ---------- the Linear connection ----------

/**
 * `Connection.appId` placeholders on a Linear row (the column is required): `pending` until the
 * admin pastes the app's client ID, and `api-key` on the development seed (spec section 3).
 */
export const linearAppIdPlaceholders = { pending: "pending", apiKey: "api-key" } as const;

export type ConnectionCredential = DbEnum.ConnectionCredential;

/** The panel's label for the development seed's credential. */
export const isDevelopmentCredential = (kind: ConnectionCredential | null): boolean => kind === "api_key";

// ---------- tickets ----------

/** Whether a status category is open on the tracker, for `Ticket.open`. */
export const isOpenCategory = (category: TicketStatusCategory): boolean => category === "open" || category === "started";

/** A ticket task's branch (spec section 11, item 5): `ostra/<key, lower case>-<last 8 hex of the task ID>-<slug>`. */
export const ticketBranchNameFor = (key: TicketKey, taskId: TaskId, title: string): string =>
  `ostra/${key.toLowerCase()}-${taskId.replaceAll("-", "").slice(-8)}-${branchSlugFor(title)}`;

/** A ticket task's PR title: `<KEY>: <ticket title>`, at most 256 characters. */
export const ticketPullRequestTitle = (key: TicketKey, title: string): string => {
  const full = `${key}: ${title.replace(/\s+/g, " ").trim()}`;
  return full.length <= 256 ? full : `${full.slice(0, 253).trimEnd()}...`;
};

/** The line a ticket task's PR body ends with, which links the ticket: `Closes OST-12` (or `Refs`). */
export const ticketMagicLine = (key: TicketKey, word: MagicWord): string => `${word} ${key}`;

// ---------- the tracker writer's outbox (F-031, F-046) ----------

/** What each kind of `TicketWrite` writes. Its text is never logged. */
export const ticketWritePayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("move"), target: z.enum(["started", "in-review", "done"]) }),
  /** ostra's one progress comment, made once; its ID goes on the task. */
  z.strictObject({ kind: z.literal("comment"), markdown: z.string().min(1).max(65_536) }),
  /** The same comment, edited in place. */
  z.strictObject({ kind: z.literal("comment_update"), markdown: z.string().min(1).max(65_536) }),
  z.strictObject({ kind: z.literal("link_pr"), repoId: repoIdSchema, url: z.url() }),
  z.strictObject({
    kind: z.literal("link_task"),
    url: z.url(),
    title: z.string().min(1).max(256),
    subtitle: z.string().max(256).nullable(),
  }),
  /** "Create ticket" on a prompt task (F-097). */
  z.strictObject({ kind: z.literal("create"), title: z.string().min(1).max(512), description: z.string().max(262_144).nullable() }),
]);
export type TicketWritePayload = z.infer<typeof ticketWritePayloadSchema>;
export type TicketWriteKind = TicketWritePayload["kind"];

/**
 * A ticket write's idempotency key, fixed by the task and the step (ADR 0037), so a replayed event
 * finds the row instead of making a second one: `ticket-write:<taskId>:<step>`.
 */
export const ticketWriteKey = (taskId: TaskId, step: TicketWriteStep): string => {
  switch (step.kind) {
    case "move":
      return `ticket-write:${taskId}:move:${step.target}`;
    case "comment":
      return `ticket-write:${taskId}:comment`;
    case "comment_update":
      // One per state the comment shows: a replay of the same state edits nothing new.
      return `ticket-write:${taskId}:comment-update:${step.revision}`;
    case "link_pr":
      return `ticket-write:${taskId}:link-pr:${step.repoId}`;
    case "link_task":
      return `ticket-write:${taskId}:link-task`;
    case "create":
      return `ticket-write:${taskId}:create`;
    default:
      return step satisfies never;
  }
};

/** What a ticket write's key is made from. */
export type TicketWriteStep =
  | { readonly kind: "move"; readonly target: "started" | "in-review" | "done" }
  | { readonly kind: "comment" }
  /** `revision`: what the comment shows, such as `pr-opened:3` (the event's seq). */
  | { readonly kind: "comment_update"; readonly revision: string }
  | { readonly kind: "link_pr"; readonly repoId: string }
  | { readonly kind: "link_task" }
  | { readonly kind: "create" };

/** A ticket key from a tracker, checked; `null` when it isn't one. */
export const parseTicketKey = (value: string): TicketKey | null => {
  const parsed = ticketKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
