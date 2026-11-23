import type { ExternalTicketId } from "@ostra/protocol";
import { expect, it } from "vitest";

import type { AdapterResult } from "../common/result.ts";
import { mappedStatusId } from "../tracker/base.ts";
import type { BoardRef, MoveTarget, TrackerAdapter } from "../tracker/base.ts";
import { routeTo } from "../tracker/workflow.ts";
import type { TrackerWorkflow, WorkflowTransition } from "../tracker/workflow.ts";
import type { SeededTicket, SeedTicketInput, TrackerSuiteFixture } from "./tracker-suite.ts";

// Milestone 11's cases of the tracker contract suite (spec section 5.2, ADR 0071): the workflow a
// board's statuses form and a move along it (F-008/c5), for every adapter that declares
// `statusGraph` or `transitions`; and two connections of one adapter on two sites or workspaces of
// one organization, kept apart (F-152/c3), for every adapter. The fixture drives the tracker as a
// person does: it puts a ticket in a status, and names the routes its workflow has.

/** Milestone 11 (F-008): the tracker's workflow, as the fixture knows it, for the workflow cases. */
export type TrackerWorkflowHooks = {
  /** A person moves the ticket to a status on the tracker, as its own UI does. */
  readonly setStatus: (externalId: ExternalTicketId, statusId: string) => Promise<void>;
  /** From `from`, the mapping's status for `target` is two transitions away, and no fewer. */
  readonly twoSteps: { readonly from: string; readonly target: MoveTarget };
  /** From `from`, no route of at most three transitions reaches the mapping's status for `target`. */
  readonly noRoute: { readonly from: string; readonly target: MoveTarget };
  /** The name of a global transition the workflow has: one taken from any status. */
  readonly globalTransition: string;
  /** An adapter on the same board whose credential can't read the workflow graph. */
  readonly withoutWorkflowAccess: () => TrackerAdapter;
};

/**
 * Milestone 11 (F-152/c3): a second connection of the same adapter, in the same organization, on
 * another site or workspace (a second Jira site, a second Linear workspace), with its own secret.
 */
export type TrackerSecondSubject = {
  readonly adapter: TrackerAdapter;
  readonly board: BoardRef;
  readonly webhookSecret: string;
  /** Its tracker's clock, in ms since the epoch. */
  readonly now: () => number;
  readonly seedTicket: (input: SeedTicketInput) => Promise<SeededTicket>;
  /** A delivery about one of its tickets, signed with its own secret. */
  readonly signedDelivery: TrackerSuiteFixture["signedDelivery"];
  /** A file of `size` bytes on its file host. Absent on an adapter that downloads nothing. */
  readonly seedFile?: (size: number) => Promise<string>;
};

/** A second subject made from a suite fixture on another site: what the two-site case reads of it. */
export const secondSubjectOf = (adapter: TrackerAdapter, fixture: TrackerSuiteFixture): TrackerSecondSubject => ({
  adapter,
  board: fixture.board,
  webhookSecret: fixture.webhookSecret,
  now: fixture.now,
  seedTicket: fixture.seedTicket,
  signedDelivery: fixture.signedDelivery,
  ...(fixture.files?.seedFile === undefined ? {} : { seedFile: fixture.files.seedFile }),
});

const must = <T,>(result: AdapterResult<T>, what: string): T => {
  if (!result.ok) {
    throw new Error(`${what}: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

const takeableFrom = (transition: WorkflowTransition, statusId: string): boolean => transition.from === "any" || transition.from.includes(statusId);

type Subject = () => { readonly adapter: TrackerAdapter; readonly fixture: TrackerSuiteFixture };

/** The workflow's cases (F-008/c5): its read, a move along a route, and a move no route reaches. */
export const defineTrackerWorkflowCases = (subject: Subject): void => {
  it("F-008/c5: reads the board's workflow, its statuses and transitions with global ones from any, and a credential without workflow access reads the statuses alone", async (context) => {
    const { adapter, fixture } = subject();
    if (!adapter.capabilities.statusGraph) {
      expect(await adapter.readWorkflow(fixture.board)).toMatchObject({ ok: false, error: { code: "unsupported" } });
      return;
    }
    const hooks = fixture.workflow;
    if (hooks === undefined) {
      context.skip();
      return;
    }
    const workflow = must(await adapter.readWorkflow(fixture.board), "readWorkflow");
    expect(workflow.readable).toBe(true);
    const statusIds = workflow.statuses.map((status) => status.id);
    expect(new Set(statusIds).size).toBe(statusIds.length);
    expect(statusIds).toEqual(expect.arrayContaining([fixture.mapping.started, fixture.mapping.inReview, fixture.mapping.done]));
    const listed = must(await adapter.listStatuses(fixture.board), "listStatuses");
    expect(new Set(statusIds)).toEqual(new Set(listed.map((status) => status.id)));
    expect(workflow.transitions.length).toBeGreaterThan(0);
    for (const transition of workflow.transitions) {
      expect(statusIds, `transition ${transition.name} goes to a status of the board`).toContain(transition.to);
      if (transition.from !== "any") {
        expect(transition.from.length, `transition ${transition.name} is from some status, or any`).toBeGreaterThan(0);
      }
    }
    // Each transition once per (from, to, name).
    const keys = workflow.transitions.map((transition) => JSON.stringify([transition.from === "any" ? "any" : [...transition.from].sort(), transition.to, transition.name]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(workflow.transitions.find((transition) => transition.name === hooks.globalTransition)?.from).toBe("any");
    // The routes the fixture names, as `routeTo` reads them.
    expect(routeTo(workflow, hooks.twoSteps.from, mappedStatusId(fixture.mapping, hooks.twoSteps.target))).toHaveLength(2);
    expect(routeTo(workflow, hooks.noRoute.from, mappedStatusId(fixture.mapping, hooks.noRoute.target))).toBeNull();

    const blind = must(await hooks.withoutWorkflowAccess().readWorkflow(fixture.board), "readWorkflow without workflow access");
    expect(blind).toMatchObject({ readable: false, transitions: [] });
    expect(new Set(blind.statuses.map((status) => status.id))).toEqual(new Set(statusIds));
    // Another organization's connection reads nothing of this board.
    expect((await fixture.other.readWorkflow(fixture.board)).ok).toBe(false);
  });

  it("F-008/c5: moves along a two-step route by its transitions, answering both in via, never a status write; a repeat move writes nothing", async (context) => {
    const { adapter, fixture } = subject();
    const hooks = fixture.workflow;
    if (!adapter.capabilities.transitions || hooks === undefined) {
      expect(adapter.capabilities.transitions && hooks === undefined, "an adapter that declares transitions gives the suite its workflow hooks").toBe(false);
      context.skip();
      return;
    }
    const { from, target } = hooks.twoSteps;
    const goal = mappedStatusId(fixture.mapping, target);
    const seeded = await fixture.seedTicket({ title: "Two steps" });
    const ref = { externalId: seeded.externalId };
    await hooks.setStatus(seeded.externalId, from);
    const moved = must(await adapter.moveTicket(fixture.board, ref, target, fixture.mapping), `moveTicket ${target}`);
    expect(moved).toMatchObject({ moved: true, status: { id: goal } });
    expect(moved.via).toHaveLength(2);
    // Each step is a transition of the workflow, taken from where the last one left the ticket.
    const workflow: TrackerWorkflow | null = adapter.capabilities.statusGraph ? must(await adapter.readWorkflow(fixture.board), "readWorkflow") : null;
    if (workflow !== null) {
      let at = from;
      for (const step of moved.via) {
        const transition = workflow.transitions.find((candidate) => candidate.id === step.id && candidate.name === step.name && takeableFrom(candidate, at));
        expect(transition, `${step.name} is a transition from ${at}`).toBeDefined();
        at = transition?.to ?? at;
      }
      expect(at).toBe(goal);
    }
    expect(must(await adapter.getTicket(fixture.board, ref), "getTicket").status.id).toBe(goal);
    const again = must(await adapter.moveTicket(fixture.board, ref, target, fixture.mapping), `moveTicket ${target} again`);
    expect(again).toMatchObject({ moved: false, via: [], status: { id: goal } });
  });

  it("F-008/c5: a move no route reaches is a conflict, and the ticket stays where it was", async (context) => {
    const { adapter, fixture } = subject();
    const hooks = fixture.workflow;
    if (!adapter.capabilities.transitions || hooks === undefined) {
      context.skip();
      return;
    }
    const { from, target } = hooks.noRoute;
    const seeded = await fixture.seedTicket({ title: "No way there" });
    await hooks.setStatus(seeded.externalId, from);
    expect(await adapter.moveTicket(fixture.board, { externalId: seeded.externalId }, target, fixture.mapping)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(must(await adapter.getTicket(fixture.board, { externalId: seeded.externalId }), "getTicket").status.id).toBe(from);
  });
};

/** Two connections of one adapter in one organization (F-152/c3): nothing of one reaches the other. */
export const defineTrackerTwoSitesCases = (subject: Subject): void => {
  it("F-152/c3: two connections on two sites of one organization keep apart: a delivery signed for one is refused by the other, and neither reads the other's ticket or file", async (context) => {
    const { adapter, fixture } = subject();
    const second = fixture.second;
    if (second === undefined) {
      context.skip();
      return;
    }
    const first = await fixture.seedTicket({ title: "On the first site" });
    const other = await second.seedTicket({ title: "On the second site" });
    if (adapter.capabilities.webhooks) {
      const firstNow = fixture.now();
      const secondNow = second.now();
      const toFirst = await fixture.signedDelivery({ ticket: first, byOwnUser: false, sentAt: firstNow });
      const toSecond = await second.signedDelivery({ ticket: other, byOwnUser: false, sentAt: secondNow });
      // Each is accepted by its own connection under its own secret...
      expect(adapter.verifyWebhook({ ...toFirst, secret: fixture.webhookSecret, now: firstNow }).ok).toBe(true);
      expect(second.adapter.verifyWebhook({ ...toSecond, secret: second.webhookSecret, now: secondNow }).ok).toBe(true);
      // ...and refused by the other's.
      expect(second.adapter.verifyWebhook({ ...toFirst, secret: second.webhookSecret, now: firstNow })).toEqual({ ok: false, reason: "bad-signature" });
      expect(adapter.verifyWebhook({ ...toSecond, secret: fixture.webhookSecret, now: secondNow })).toEqual({ ok: false, reason: "bad-signature" });
    }
    // Neither reads the other's ticket, on either board.
    for (const board of [fixture.board, second.board]) {
      expect((await second.adapter.getTicket(board, { externalId: first.externalId })).ok, "the second reads the first's ticket").toBe(false);
      expect((await adapter.getTicket(board, { externalId: other.externalId })).ok, "the first reads the second's ticket").toBe(false);
      expect((await second.adapter.getTicketContext(board, { externalId: first.externalId })).ok).toBe(false);
    }
    expect((await second.adapter.getTicket(fixture.board, first.key)).ok).toBe(false);
    expect((await adapter.getTicket(second.board, other.key)).ok).toBe(false);
    // Each reads its own.
    expect(must(await adapter.getTicket(fixture.board, { externalId: first.externalId }), "the first's own ticket").title).toBe("On the first site");
    expect(must(await second.adapter.getTicket(second.board, { externalId: other.externalId }), "the second's own ticket").title).toBe("On the second site");
    // Neither downloads the other's file.
    const firstFile = fixture.files?.seedFile;
    if (firstFile !== undefined && second.seedFile !== undefined) {
      const mine = await firstFile(16);
      const theirs = await second.seedFile(16);
      expect(must(await adapter.downloadFile(mine, 1024), "the first's own file").bytes.length).toBe(16);
      expect(must(await second.adapter.downloadFile(theirs, 1024), "the second's own file").bytes.length).toBe(16);
      expect((await second.adapter.downloadFile(mine, 1024)).ok, "the second downloads the first's file").toBe(false);
      expect((await adapter.downloadFile(theirs, 1024)).ok, "the first downloads the second's file").toBe(false);
    }
  });
};
