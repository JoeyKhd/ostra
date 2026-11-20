import { randomUUID } from "node:crypto";

import {
  agentSessionIdSchema,
  automationIdSchema,
  boardIdSchema,
  bulkStartIdSchema,
  bulkStartItemIdSchema,
  externalTicketIdSchema,
  memberIdSchema,
  taskIdSchema,
  ticketIdSchema,
  ticketKeySchema,
} from "@ostra/protocol";
import type { BoardId, MemberId } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { trackerUserFixtures } from "../testing/m6.ts";
import { leavesToStart, matchTrackerUser, oneActiveTaskError, oneActiveTaskWords, startingMemberOf, startRuleFor, taskOriginOf } from "./start-task.ts";
import type { MatchableMember, StartOrigin, TicketTree } from "./start-task.ts";

// The one start's pure part (ADR 0056, ADR 0057): the origins, the outside rule, the sub-issue walk
// and member matching, with spec section 8's fixture set of users and members.

const memberId = memberIdSchema.parse(randomUUID());
const automationId = automationIdSchema.parse(randomUUID());
const origins: readonly StartOrigin[] = [
  { kind: "member", memberId },
  { kind: "intake-rule", automationId, requireApproval: false },
  { kind: "occurrence", automationId, occurrenceAt: Date.UTC(2026, 10, 23, 9), requireApproval: true },
  { kind: "bulk-item", memberId, bulkStartId: bulkStartIdSchema.parse(randomUUID()), bulkStartItemId: bulkStartItemIdSchema.parse(randomUUID()), automationId: null },
  { kind: "sub-issue", memberId, parentTicketId: ticketIdSchema.parse(randomUUID()) },
  { kind: "linear", agentSessionId: agentSessionIdSchema.parse(randomUUID()), actor: { externalId: "lin-user-1", name: "Ana" }, matchedMemberId: memberId },
  { kind: "linear", agentSessionId: agentSessionIdSchema.parse(randomUUID()), actor: { externalId: "lin-user-2", name: "Visitor" }, matchedMemberId: null },
  { kind: "onboarding", memberId },
];

describe("the one start", () => {
  it("F-040: an outside task runs on the project's default profile, on its pools only, and waits for approval while the switch is on", () => {
    const outside = origins[6];
    if (outside === undefined) {
      throw new Error("fixture");
    }
    expect(startRuleFor(outside, { outsideApproval: true })).toEqual({ outside: true, needsApproval: true, poolOnly: true, profile: "project-default" });
    // Switched off by an organization admin: it starts at once, still on the default profile and a pool.
    expect(startRuleFor(outside, { outsideApproval: false })).toEqual({ outside: true, needsApproval: false, poolOnly: true, profile: "project-default" });
  });

  it("F-040: a matched member's Linear start, a member's and an automation's are not outside tasks; a rule may still ask for approval", () => {
    for (const origin of origins.filter((candidate) => !(candidate.kind === "linear" && candidate.matchedMemberId === null))) {
      const rule = startRuleFor(origin, { outsideApproval: true });
      expect(rule.outside, origin.kind).toBe(false);
      expect(rule.poolOnly, origin.kind).toBe(false);
      expect(rule.needsApproval, origin.kind).toBe(origin.kind === "occurrence");
    }
  });

  it("stores each origin, and names its starting member", () => {
    expect(origins.map(taskOriginOf)).toEqual(["member", "automation", "automation", "member", "member", "tracker", "tracker", "onboarding"]);
    expect(origins.map(startingMemberOf)).toEqual([memberId, null, null, memberId, memberId, memberId, null, memberId]);
  });

  it("names the ticket, never its text, when it already has an active task", () => {
    const error = oneActiveTaskError(ticketKeySchema.parse("OST-12"), taskIdSchema.parse(randomUUID()));
    expect(error.code).toBe("ticket-has-active-task");
    expect(oneActiveTaskWords(error)).toBe("OST-12 already has an active task.");
  });
});

describe("a parent's leaves", () => {
  const board = boardIdSchema.parse(randomUUID());
  const otherBoard = boardIdSchema.parse(randomUUID());
  let counter = 0;
  const node = (open: boolean, boardId: BoardId | null, children: readonly TicketTree[] = []): TicketTree => {
    counter += 1;
    return { externalId: externalTicketIdSchema.parse(`ext-${String(counter)}`), key: ticketKeySchema.parse(`OST-${String(counter)}`), open, boardId, children };
  };
  const boards = new Set([board]);

  it("F-077: starts the open leaves to three levels, never the parent, and skips the closed", () => {
    const leafA = node(true, board);
    const leafB = node(true, board);
    const closed = node(false, board);
    // A chain three levels down whose last ticket has an open child on a fourth.
    const level4 = node(true, board);
    const level3 = node(true, board, [level4]);
    const level2 = node(true, board, [level3, node(false, board)]);
    const level1 = node(true, board, [level2]);
    const parent = node(true, board, [leafA, closed, node(true, board, [leafB]), level1]);
    const leaves = leavesToStart(parent, boards, 3, 50);
    expect(leaves.ok).toBe(true);
    if (!leaves.ok) {
      return;
    }
    expect(leaves.start.map((leaf) => leaf.key)).toEqual([leafA.key, leafB.key]);
    // level3's open child is on a fourth level: level3 is listed as too deep, and nothing under it starts.
    expect(leaves.skipped).toEqual([{ key: level3.key, reason: "too-deep" }]);
    expect(leaves.start.some((leaf) => leaf.key === parent.key)).toBe(false);
  });

  it("F-077: lists a child on no board of the project and skips it", () => {
    const elsewhere = node(true, otherBoard);
    const nowhere = node(true, null);
    const leaf = node(true, board);
    const leaves = leavesToStart(node(true, board, [elsewhere, nowhere, leaf]), boards, 3, 50);
    expect(leaves).toEqual({
      ok: true,
      start: [{ externalId: leaf.externalId, key: leaf.key, boardId: board }],
      skipped: [
        { key: elsewhere.key, reason: "not-on-a-board" },
        { key: nowhere.key, reason: "not-on-a-board" },
      ],
    });
  });

  it("F-077: starts nothing over the limit, and says how many", () => {
    const parent = node(true, board, Array.from({ length: 51 }, () => node(true, board)));
    expect(leavesToStart(parent, boards, 3, 50)).toEqual({ ok: false, reason: "over-limit", count: 51, max: 50 });
    expect(leavesToStart(parent, boards, 3, 51).ok).toBe(true);
    expect(leavesToStart(node(true, board, [node(false, board)]), boards, 3, 50)).toEqual({ ok: false, reason: "no-children" });
  });
});

describe("member matching", () => {
  const ana = memberIdSchema.parse(randomUUID());
  const bo = memberIdSchema.parse(randomUUID());
  const cy = memberIdSchema.parse(randomUUID());
  const members: readonly MatchableMember[] = [
    { memberId: ana, email: "Ana.Silva@Example.com", active: true, canOpenProject: true },
    { memberId: bo, email: "bo@example.com ", active: true, canOpenProject: false },
    { memberId: cy, email: "cy@example.com", active: false, canOpenProject: true },
  ];
  const match = (email: string | null) => matchTrackerUser({ userId: "lin-1", name: "A Linear user", email }, members);
  const member = (id: MemberId) => ({ kind: "member", memberId: id });

  it("F-040: matches an address case-folded and trimmed, and keeps a plus suffix as written", () => {
    expect(match("ana.silva@example.com")).toEqual(member(ana));
    expect(match("  ANA.SILVA@EXAMPLE.COM ")).toEqual(member(ana));
    expect(match("ana.silva+linear@example.com")).toEqual({ kind: "outside", reason: "no-member" });
  });

  it("F-040: anyone else is outside: no address, no member, a removed member, or no access to the project", () => {
    expect(match(null)).toEqual({ kind: "outside", reason: "no-address" });
    expect(match("  ")).toEqual({ kind: "outside", reason: "no-address" });
    expect(match("stranger@example.com")).toEqual({ kind: "outside", reason: "no-member" });
    expect(match("cy@example.com")).toEqual({ kind: "outside", reason: "no-member" });
    expect(match("bo@example.com")).toEqual({ kind: "outside", reason: "no-access" });
  });

  it("F-040: spec section 8's fixture set: case and a trailing space match, a plus suffix and no address don't", () => {
    const fixtures = trackerUserFixtures();
    expect(matchTrackerUser(fixtures.users.caseOnly, fixtures.members)).toEqual(member(fixtures.ana));
    expect(matchTrackerUser(fixtures.users.trailingSpace, fixtures.members)).toEqual(member(fixtures.ana));
    expect(matchTrackerUser(fixtures.users.plusSuffix, fixtures.members)).toEqual({ kind: "outside", reason: "no-member" });
    expect(matchTrackerUser(fixtures.users.noAddress, fixtures.members)).toEqual({ kind: "outside", reason: "no-address" });
  });

  it("calls two active members with one address outside, rather than guess", () => {
    const twins: readonly MatchableMember[] = [...members, { memberId: memberIdSchema.parse(randomUUID()), email: "ana.silva@example.com", active: true, canOpenProject: true }];
    expect(matchTrackerUser({ userId: "lin-1", name: "Ana", email: "ana.silva@example.com" }, twins)).toEqual({ kind: "outside", reason: "ambiguous" });
  });
});
