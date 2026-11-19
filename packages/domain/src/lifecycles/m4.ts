import type { GitSha, MemberId, NoteId, UserId } from "@ostra/protocol";

import type { BudgetMonth } from "../budget/gate.ts";
import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// Milestone 4's lifecycles (spec section 5.4, ADR 0053, ADR 0044, ADR 0055, ADR 0040;
// domain-model.md, "A membership's lifecycle" and "A proposal's lifecycle"). Each is a
// discriminated union with one transition function, and every switch is exhaustive.

// ---------- a membership (F-002, ADR 0053) ----------

export type MembershipLifecycle =
  | { readonly state: "pending_verification" }
  | { readonly state: "active" }
  | { readonly state: "removed"; readonly removedAt: number; readonly removedByMemberId: MemberId };

export type MembershipInput =
  /** The invitee opened the verification mail's link. */
  | { readonly type: "verify" }
  /** An organization admin removed the membership. The last admin is refused by the use case. */
  | { readonly type: "remove"; readonly at: number; readonly byMemberId: MemberId };

/** The membership an accepted invitation makes: pending with email on, active without it. */
export const membershipOnAccept = (emailOn: boolean): MembershipLifecycle =>
  emailOn ? { state: "pending_verification" } : { state: "active" };

export const transitionMembership = (membership: MembershipLifecycle, input: MembershipInput): Transition<MembershipLifecycle> => {
  switch (membership.state) {
    case "pending_verification":
      switch (input.type) {
        case "verify":
          return moveTo({ state: "active" });
        case "remove":
          return moveTo({ state: "removed", removedAt: input.at, removedByMemberId: input.byMemberId });
        default:
          return input satisfies never;
      }
    case "active":
      switch (input.type) {
        case "verify":
          return refuse(input, membership.state);
        case "remove":
          return moveTo({ state: "removed", removedAt: input.at, removedByMemberId: input.byMemberId });
        default:
          return input satisfies never;
      }
    case "removed":
      // Final: invited again, the account gets a new membership.
      return refuse(input, membership.state);
    default:
      return membership satisfies never;
  }
};

/** Only an active membership makes a scope: a pending or removed one sees nothing (ADR 0053). */
export const membershipMakesScope = (membership: MembershipLifecycle): boolean => membership.state === "active";

// ---------- an invitation (F-002, ADR 0053) ----------

export type InvitationLifecycle =
  | { readonly state: "pending"; readonly expiresAt: number }
  | { readonly state: "accepted"; readonly acceptedAt: number; readonly acceptedUserId: UserId }
  | { readonly state: "revoked"; readonly revokedAt: number; readonly revokedByMemberId: MemberId }
  | { readonly state: "expired" };

export type InvitationInput =
  | { readonly type: "accept"; readonly at: number; readonly userId: UserId }
  | { readonly type: "revoke"; readonly at: number; readonly byMemberId: MemberId }
  /** The `invitation.expire` sweep, at `at`. */
  | { readonly type: "expire"; readonly at: number };

/**
 * An invitation works once, until it's revoked or expires. An accept at or after its expiry is
 * refused, even before the sweep has marked it.
 */
export const transitionInvitation = (invitation: InvitationLifecycle, input: InvitationInput): Transition<InvitationLifecycle> => {
  switch (invitation.state) {
    case "pending":
      switch (input.type) {
        case "accept":
          return input.at >= invitation.expiresAt
            ? refuse(input, "expired")
            : moveTo({ state: "accepted", acceptedAt: input.at, acceptedUserId: input.userId });
        case "revoke":
          return moveTo({ state: "revoked", revokedAt: input.at, revokedByMemberId: input.byMemberId });
        case "expire":
          return input.at >= invitation.expiresAt ? moveTo({ state: "expired" }) : refuse(input, invitation.state);
        default:
          return input satisfies never;
      }
    case "accepted":
    case "revoked":
    case "expired":
      return refuse(input, invitation.state);
    default:
      return invitation satisfies never;
  }
};

// ---------- a memory proposal (F-111, ADR 0044) ----------

export type ProposalLifecycle =
  | { readonly state: "proposed" }
  | {
      readonly state: "approved";
      readonly noteId: NoteId;
      /** "Approve and archive": the note it replaced, now archived; `null` for a plain approve. */
      readonly archivedNoteId: NoteId | null;
      readonly decidedBy: MemberId;
    }
  | { readonly state: "rejected"; readonly decidedBy: MemberId }
  | { readonly state: "merged"; readonly noteId: NoteId; readonly decidedBy: MemberId };

export type ProposalInput =
  | { readonly type: "approve"; readonly noteId: NoteId; readonly byMemberId: MemberId }
  /** Approve as a new note and archive the one it contradicts (ADR 0044, Q204): an approve. */
  | { readonly type: "approve_and_archive"; readonly noteId: NoteId; readonly archivedNoteId: NoteId; readonly byMemberId: MemberId }
  | { readonly type: "reject"; readonly byMemberId: MemberId }
  | { readonly type: "merge"; readonly intoNoteId: NoteId; readonly byMemberId: MemberId };

export const transitionProposal = (proposal: ProposalLifecycle, input: ProposalInput): Transition<ProposalLifecycle> => {
  switch (proposal.state) {
    case "proposed":
      switch (input.type) {
        case "approve":
          return moveTo({ state: "approved", noteId: input.noteId, archivedNoteId: null, decidedBy: input.byMemberId });
        case "approve_and_archive":
          return input.archivedNoteId === input.noteId
            ? refuse(input, proposal.state)
            : moveTo({ state: "approved", noteId: input.noteId, archivedNoteId: input.archivedNoteId, decidedBy: input.byMemberId });
        case "reject":
          return moveTo({ state: "rejected", decidedBy: input.byMemberId });
        case "merge":
          return moveTo({ state: "merged", noteId: input.intoNoteId, decidedBy: input.byMemberId });
        default:
          return input satisfies never;
      }
    case "approved":
    case "rejected":
    case "merged":
      return refuse(input, proposal.state);
    default:
      return proposal satisfies never;
  }
};

/** Only an approved or merged proposal's text reaches an agent, through its note (Q86). */
export const proposalReachesAgents = (proposal: ProposalLifecycle): boolean =>
  proposal.state === "approved" || proposal.state === "merged";

// ---------- a budget's month (F-037, ADR 0055) ----------

export type BudgetMonthLifecycle =
  | { readonly state: "under"; readonly month: BudgetMonth }
  | { readonly state: "warned"; readonly month: BudgetMonth }
  | { readonly state: "reached"; readonly month: BudgetMonth };

export type BudgetMonthInput =
  /** Spend was counted, or the budget changed: where the month now stands. */
  | { readonly type: "measure"; readonly month: BudgetMonth; readonly level: "under" | "warn" | "reached" }
  /** An admin raised the budget: back to what the new amount says, warnings already sent stay sent. */
  | { readonly type: "raise"; readonly level: "under" | "warn" | "reached" };

/**
 * A month only moves up (`under` → `warned` → `reached`), so each notice is sent once per month.
 * A new month starts again at its own level; a raise moves down to the level the new amount gives.
 */
export const transitionBudgetMonth = (current: BudgetMonthLifecycle, input: BudgetMonthInput): Transition<BudgetMonthLifecycle> => {
  const at = (level: "under" | "warn" | "reached", month: BudgetMonth): BudgetMonthLifecycle =>
    level === "under" ? { state: "under", month } : level === "warn" ? { state: "warned", month } : { state: "reached", month };
  switch (input.type) {
    case "measure": {
      if (input.month !== current.month) {
        return moveTo(at(input.level, input.month));
      }
      const rank = { under: 0, warned: 1, reached: 2 } as const;
      const next = at(input.level, input.month);
      return rank[next.state] > rank[current.state] ? moveTo(next) : refuse(input, current.state);
    }
    case "raise":
      return moveTo(at(input.level, current.month));
    default:
      return input satisfies never;
  }
};

// ---------- the independent-review check (F-104, ADR 0040) ----------

export type ReviewCheckLifecycle =
  | { readonly state: "pending"; readonly headSha: GitSha; readonly reason: string }
  | { readonly state: "passed"; readonly headSha: GitSha; readonly approverMemberId: MemberId };

export type ReviewCheckInput =
  | { readonly type: "evaluated"; readonly headSha: GitSha; readonly verdict: { readonly passed: true; readonly approverMemberId: MemberId } | { readonly passed: false; readonly reason: string } }
  /** A new head was pushed: the check is pending on it until an approval of that head. */
  | { readonly type: "new_head"; readonly headSha: GitSha };

/** The check moves both ways, per head (`pending` ⇄ `passed`). An evaluation of an old head is refused. */
export const transitionReviewCheck = (check: ReviewCheckLifecycle, input: ReviewCheckInput): Transition<ReviewCheckLifecycle> => {
  switch (input.type) {
    case "new_head":
      return input.headSha === check.headSha
        ? refuse(input, check.state)
        : moveTo({ state: "pending", headSha: input.headSha, reason: "a new commit needs a new approval" });
    case "evaluated":
      if (input.headSha !== check.headSha) {
        return refuse(input, "another head");
      }
      return input.verdict.passed
        ? moveTo({ state: "passed", headSha: check.headSha, approverMemberId: input.verdict.approverMemberId })
        : moveTo({ state: "pending", headSha: check.headSha, reason: input.verdict.reason });
    default:
      return input satisfies never;
  }
};
