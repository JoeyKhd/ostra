import { randomUUID } from "node:crypto";

import type { CiCheckRun, CiResults, CiStatus } from "@ostra/adapter-sdk";
import { boardIdSchema, externalTicketIdSchema, memberIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { BoardId, MemberId } from "@ostra/protocol";

import type { FilterTicket } from "../automations/intake-filter.ts";
import type { MatchableMember, TicketTree, TrackerUser } from "../starts/start-task.ts";

// Milestone 6's fixtures (spec section 8), for the builders' tests in core and api: a head's check
// runs and statuses, a cached ticket as a filter reads it, a ticket tree, and the tracker users and
// members whose addresses differ only by case, by a plus suffix and by a trailing space.

/** A finished, passing GitHub Actions check run; override what the case needs. */
export const ciCheckRun = (fields: Partial<CiCheckRun> = {}): CiCheckRun => ({
  id: randomUUID(),
  name: "test",
  appSlug: "github-actions",
  status: "completed",
  conclusion: "success",
  detailsUrl: null,
  startedAt: 0,
  completedAt: 60_000,
  ...fields,
});

/** A passing commit status. */
export const ciStatus = (fields: Partial<CiStatus> = {}): CiStatus => ({ context: "ci/legacy", state: "success", targetUrl: null, description: null, ...fields });

export const ciResults = (checkRuns: readonly CiCheckRun[], statuses: readonly CiStatus[] = []): CiResults => ({ checkRuns, statuses });

/** An open ticket on a board, as the filter reads it. */
export const filterTicket = (fields: Partial<FilterTicket> = {}): FilterTicket => ({
  boardId: boardIdSchema.parse(randomUUID()),
  labels: [],
  statusId: null,
  statusCategory: "open",
  assigneeId: null,
  trackerProjectId: null,
  trackerProjectName: null,
  open: true,
  ...fields,
});

/** A ticket of a tree, with its children: open and on `boardId` unless said. */
export const ticketTree = (key: string, fields: { readonly open?: boolean; readonly boardId?: BoardId | null; readonly children?: readonly TicketTree[] } = {}): TicketTree => ({
  externalId: externalTicketIdSchema.parse(`ext-${key}`),
  key: ticketKeySchema.parse(key),
  open: fields.open ?? true,
  boardId: fields.boardId === undefined ? null : fields.boardId,
  children: fields.children ?? [],
});

/** Spec section 8's set: members, and Linear users whose addresses differ from theirs only at the edges. */
export type TrackerUserFixtures = {
  readonly ana: MemberId;
  readonly members: readonly MatchableMember[];
  readonly users: {
    /** Ana, in other case: a member. */
    readonly caseOnly: TrackerUser;
    /** Ana with a trailing space: a member. */
    readonly trailingSpace: TrackerUser;
    /** Ana with a plus suffix: someone else, as written. */
    readonly plusSuffix: TrackerUser;
    /** No address from Linear: outside. */
    readonly noAddress: TrackerUser;
  };
};

export const trackerUserFixtures = (): TrackerUserFixtures => {
  const ana = memberIdSchema.parse(randomUUID());
  return {
    ana,
    members: [
      { memberId: ana, email: "Ana.Silva@Example.com", active: true, canOpenProject: true },
      { memberId: memberIdSchema.parse(randomUUID()), email: "bo@example.com", active: true, canOpenProject: false },
    ],
    users: {
      caseOnly: { userId: "lin-ana-1", name: "Ana", email: "ana.silva@EXAMPLE.com" },
      trailingSpace: { userId: "lin-ana-2", name: "Ana", email: "ana.silva@example.com " },
      plusSuffix: { userId: "lin-ana-3", name: "Ana", email: "ana.silva+linear@example.com" },
      noAddress: { userId: "lin-x", name: "Someone", email: null },
    },
  };
};
