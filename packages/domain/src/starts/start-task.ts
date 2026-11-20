import type { DbEnum } from "@ostra/db";
import type {
  AgentSessionId,
  AutomationId,
  BoardId,
  BulkStartId,
  BulkStartItemId,
  ExternalTicketId,
  MemberId,
  TaskId,
  TicketId,
  TicketKey,
} from "@ostra/protocol";

// The one start (F-010, F-011, F-106, F-107, F-077, F-012, F-040, F-113; ADR 0056, ADR 0057): every
// way a task starts, by hand or not, goes through `startTask`, so the queue, a project's cap on a
// pool, the budget and the one-active-task rule apply to all of them alike. This file is its pure
// part: the origin as a closed union, the outside rule, the sub-issue tree walk and the
// one-active-task error. The use case's signature is in `../use-cases/m6-signatures.ts`.

/** Where a start came from. Closed: a new way to start a task is a new member here. */
export type StartOrigin =
  /** A member pressed Start in the panel, or the CLI. */
  | { readonly kind: "member"; readonly memberId: MemberId }
  /** An intake rule matched a ticket (ADR 0056): once per ticket per rule. */
  | { readonly kind: "intake-rule"; readonly automationId: AutomationId; readonly requireApproval: boolean }
  /** A schedule's occurrence started its prompt task. */
  | { readonly kind: "occurrence"; readonly automationId: AutomationId; readonly occurrenceAt: number; readonly requireApproval: boolean }
  /** One ticket of a bulk start (the Inbox, or a dry run's "Start all"). */
  | { readonly kind: "bulk-item"; readonly memberId: MemberId; readonly bulkStartId: BulkStartId; readonly bulkStartItemId: BulkStartItemId; readonly automationId: AutomationId | null }
  /** A leaf of a parent ticket a member started (F-077). */
  | { readonly kind: "sub-issue"; readonly memberId: MemberId; readonly parentTicketId: TicketId }
  /**
   * A delegation or a mention in Linear's agent mode (ADR 0057). `matchedMemberId`: the member the
   * Linear user matched, or `null` for someone outside.
   */
  | {
      readonly kind: "linear";
      readonly agentSessionId: AgentSessionId;
      readonly actor: { readonly externalId: string; readonly name: string };
      readonly matchedMemberId: MemberId | null;
    }
  /** A project admin's "Set up with an agent" (F-113). */
  | { readonly kind: "onboarding"; readonly memberId: MemberId };

export type StartOriginKind = StartOrigin["kind"];

/** The task's stored origin. */
export const taskOriginOf = (origin: StartOrigin): DbEnum.TaskOrigin => {
  switch (origin.kind) {
    case "member":
    case "bulk-item":
    case "sub-issue":
      return "member";
    case "intake-rule":
    case "occurrence":
      return "automation";
    case "linear":
      return "tracker";
    case "onboarding":
      return "onboarding";
    default:
      return origin satisfies never;
  }
};

/** The member a start is on behalf of: the task's starter and driver. `null` for an automation's or an outside task. */
export const startingMemberOf = (origin: StartOrigin): MemberId | null => {
  switch (origin.kind) {
    case "member":
    case "bulk-item":
    case "sub-issue":
    case "onboarding":
      return origin.memberId;
    case "linear":
      return origin.matchedMemberId;
    case "intake-rule":
    case "occurrence":
      return null;
    default:
      return origin satisfies never;
  }
};

/**
 * What the outside rule decides for a start (ADR 0057, F-040). An outside task (a Linear user who
 * matched no member) runs on the project's default profile for its kind, only on the project's
 * pools, and waits for a member's approval while the project's switch is on. An automation's task
 * isn't an outside task: a project admin wrote the rule, which may ask for approval anyway.
 */
export type StartRule = {
  readonly outside: boolean;
  /** The task starts `awaiting_approval`. */
  readonly needsApproval: boolean;
  /** Never offered to a personal runner (`Task.poolOnly`). */
  readonly poolOnly: boolean;
  /** `project-default`: whatever profile was asked for, the project's default for the kind runs. */
  readonly profile: "requested" | "project-default";
};

export const startRuleFor = (origin: StartOrigin, project: { readonly outsideApproval: boolean }): StartRule => {
  switch (origin.kind) {
    case "linear":
      return origin.matchedMemberId === null
        ? { outside: true, needsApproval: project.outsideApproval, poolOnly: true, profile: "project-default" }
        : { outside: false, needsApproval: false, poolOnly: false, profile: "project-default" };
    case "intake-rule":
    case "occurrence":
      return { outside: false, needsApproval: origin.requireApproval, poolOnly: false, profile: "requested" };
    case "member":
    case "bulk-item":
    case "sub-issue":
    case "onboarding":
      return { outside: false, needsApproval: false, poolOnly: false, profile: "requested" };
    default:
      return origin satisfies never;
  }
};

/** The one-active-task rule's refusal (F-010): a ticket has at most one active code task. */
export type OneActiveTaskError = { readonly code: "ticket-has-active-task"; readonly ticketKey: TicketKey; readonly taskId: TaskId };

export const oneActiveTaskError = (ticketKey: TicketKey, taskId: TaskId): OneActiveTaskError => ({ code: "ticket-has-active-task", ticketKey, taskId });

/** The refusal's words, for a bulk item's reason and the panel. Names the ticket's key, never its text. */
export const oneActiveTaskWords = (error: OneActiveTaskError): string => `${error.ticketKey} already has an active task.`;

// ---------- sub-issues (F-077, ADR 0056) ----------

/** A ticket and its sub-issues, as the tracker's context gives them, each mapped to its cached row. */
export type TicketTree = {
  readonly externalId: ExternalTicketId;
  readonly key: TicketKey;
  readonly open: boolean;
  /** The project's board the ticket is cached on, or `null` when it's on none of them. */
  readonly boardId: BoardId | null;
  readonly children: readonly TicketTree[];
};

export type SubIssueSkip = { readonly key: TicketKey; readonly reason: "not-on-a-board" | "too-deep" };

export type Leaves =
  | { readonly ok: true; readonly start: readonly { readonly externalId: ExternalTicketId; readonly key: TicketKey; readonly boardId: BoardId }[]; readonly skipped: readonly SubIssueSkip[] }
  /** More leaves than the limit: nothing starts, and the member is told how many. */
  | { readonly ok: false; readonly reason: "over-limit"; readonly count: number; readonly max: number }
  /** The ticket has no open sub-issues: start it as one ticket. */
  | { readonly ok: false; readonly reason: "no-children" };

/**
 * The leaves a code start on a parent runs (ADR 0056): the open tickets without open children of
 * their own, down to `depth` levels below the parent (`OSTRA_SUB_ISSUES_DEPTH`), on one of the
 * project's boards; at most `max` (`OSTRA_SUB_ISSUES_MAX`), or none. The parent never runs. A leaf
 * on no board of the project is listed and skipped; an open ticket at the last level whose open
 * children are deeper is listed as too deep. `boards` narrows to the project's boards.
 */
export const leavesToStart = (tree: TicketTree, boards: ReadonlySet<BoardId>, depth: number, max: number): Leaves => {
  const start: { readonly externalId: ExternalTicketId; readonly key: TicketKey; readonly boardId: BoardId }[] = [];
  const skipped: SubIssueSkip[] = [];
  const seen = new Set<ExternalTicketId>([tree.externalId]);
  const walk = (node: TicketTree, level: number): void => {
    for (const child of node.children) {
      if (!child.open || seen.has(child.externalId)) {
        continue;
      }
      seen.add(child.externalId);
      const openChildren = child.children.some((grandchild) => grandchild.open);
      if (openChildren) {
        if (level >= depth) {
          skipped.push({ key: child.key, reason: "too-deep" });
        } else {
          walk(child, level + 1);
        }
        continue;
      }
      if (child.boardId === null || !boards.has(child.boardId)) {
        skipped.push({ key: child.key, reason: "not-on-a-board" });
        continue;
      }
      start.push({ externalId: child.externalId, key: child.key, boardId: child.boardId });
    }
  };
  if (!tree.children.some((child) => child.open)) {
    return { ok: false, reason: "no-children" };
  }
  walk(tree, 1);
  if (start.length > max) {
    return { ok: false, reason: "over-limit", count: start.length, max };
  }
  return { ok: true, start, skipped };
};

// ---------- member matching (ADR 0057, Q214) ----------

/** A Linear user, as `getUser` or the session's creator gives them. Their address may be missing. */
export type TrackerUser = { readonly userId: string; readonly name: string; readonly email: string | null };

/** An active or inactive member, with their account's address and their access to the project. */
export type MatchableMember = {
  readonly memberId: MemberId;
  readonly email: string;
  readonly active: boolean;
  /** Whether they can open the project the task lands in (`requireProjectAccess`'s `read`). */
  readonly canOpenProject: boolean;
};

export type TrackerUserMatch =
  | { readonly kind: "member"; readonly memberId: MemberId }
  | { readonly kind: "outside"; readonly reason: "no-address" | "no-member" | "no-access" | "ambiguous" };

/** An address as matching compares it: surrounding space trimmed, case-folded; a plus suffix kept. */
export const foldAddress = (address: string): string => address.trim().toLowerCase();

/**
 * A tracker user is a member when their address matches exactly one active member's account
 * address, compared folded, and that member can open the task's project (`canOpenProject`, which
 * the caller reads for that project). Anyone else is outside. Made for each event, never kept as a
 * link.
 */
export const matchTrackerUser = (user: TrackerUser, members: readonly MatchableMember[]): TrackerUserMatch => {
  if (user.email === null || foldAddress(user.email) === "") {
    return { kind: "outside", reason: "no-address" };
  }
  const address = foldAddress(user.email);
  const same = members.filter((member) => member.active && foldAddress(member.email) === address);
  if (same.length === 0) {
    return { kind: "outside", reason: "no-member" };
  }
  if (same.length > 1) {
    return { kind: "outside", reason: "ambiguous" };
  }
  const [member] = same;
  if (member?.canOpenProject !== true) {
    return { kind: "outside", reason: "no-access" };
  }
  return { kind: "member", memberId: member.memberId };
};
