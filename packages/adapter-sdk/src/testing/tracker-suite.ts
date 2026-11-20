import { externalTicketIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { ExternalTicketId, TicketKey } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { AdapterResult } from "../common/result.ts";
import { agentActivityKinds, ticketStatusCategories } from "../tracker/base.ts";
import type { AgentActivityKind, BoardRef, StatusMapping, Ticket, TrackerAdapter } from "../tracker/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The tracker contract suite (ADR 0025, spec section 5.2): every tracker adapter runs it, against
// its fake (the Jira fake here; Linear's adapter on the fake Linear server, ticket 07) and, when
// the test workspace's credentials are loaded, against the real tracker. The fixture drives the
// fake the way people do outside ostra: it seeds and edits tickets, moves one to another board,
// signs deliveries and answers 429 when asked. Every case also checks that another
// organization's connection sees nothing of this one's.

export type SeedTicketInput = {
  readonly title: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
  readonly comments?: readonly string[];
  /** Puts one image in the description, which `downloadFile` can fetch. */
  readonly withImage?: boolean;
};

export type SeededTicket = { readonly externalId: ExternalTicketId; readonly key: TicketKey };

export type TrackerSuiteFixture = {
  /** A board with the tracker's default statuses. */
  readonly board: BoardRef;
  /** Its key, such as `OST`. */
  readonly boardKey: string;
  /** A second board on the same workspace, a ticket can move to (its key changes). */
  readonly otherBoard: BoardRef;
  /** The board's statuses for each step. */
  readonly mapping: StatusMapping;
  /** An adapter on another organization's workspace. It must see nothing of this one. */
  readonly other: TrackerAdapter;
  /** The connection's webhook signing secret. */
  readonly webhookSecret: string;
  /** The adapter's own user, for the echo check; `null` when it has none (an API key). */
  readonly ownUserId: string | null;
  /** Whether the tracker's GitHub integration is installed on the fake. */
  readonly integrationInstalled: boolean;
  /** The fake's clock, in ms since the epoch: tickets are stamped with it. */
  readonly now: () => number;
  /** Moves the fake's clock on, so the next change is stamped later. */
  readonly advance: (ms: number) => Promise<void>;
  /** A person creates a ticket on `board`. */
  readonly seedTicket: (input: SeedTicketInput) => Promise<SeededTicket>;
  /** A person edits a ticket's title. */
  readonly editTicket: (externalId: ExternalTicketId, title: string) => Promise<void>;
  /** A person moves the ticket to `otherBoard`; the new key. */
  readonly moveToOtherBoard: (externalId: ExternalTicketId) => Promise<TicketKey>;
  /** A delivery about the ticket, signed as the tracker signs it, made by its own user or a person. */
  readonly signedDelivery: (input: {
    readonly ticket: SeededTicket;
    readonly byOwnUser: boolean;
    readonly sentAt: number;
  }) => Promise<{ readonly rawBody: Uint8Array; readonly headers: Readonly<Record<string, string>> }>;
  /** The tracker's next answer is 429 with `Retry-After`. */
  readonly rateLimitNext: (retryAfterSeconds: number) => Promise<void>;
  /** Milestone 3: adds a user with this email to the board's tracker. Absent: the mention case is skipped. */
  readonly seedUser?: (email: string) => Promise<SeededTrackerUser>;
  /**
   * Milestone 6: what the agent-session, people, sub-issue and draft cases need. Absent: only the
   * case that checks each capability's declared absence runs (an adapter whose milestone 6
   * operations aren't built yet, such as Linear's before ticket 07).
   */
  readonly milestone6?: TrackerMilestone6Hooks;
};

/** What a session's fixture hands back: the event's body, as `verifyWebhook` gives it on. */
export type SessionDelivery = { readonly sessionId: string; readonly body: unknown };

/** An activity the tracker recorded in a session, as the fixture reads it from the fake. */
export type RecordedActivity = { readonly kind: AgentActivityKind; readonly body: string | null; readonly ephemeral: boolean };

/** Milestone 6 (F-012): a person in the tracker drives a session the way Linear's UI does. */
export type TrackerSessionFixture = {
  /** The person who delegates, mentions and follows up. */
  readonly person: { readonly userId: string; readonly name: string };
  /** A person delegates the ticket to the app: the `created` event. */
  readonly delegate: (ticket: SeededTicket) => Promise<SessionDelivery>;
  /** A person mentions the app in a comment on the ticket: a `created` event with its comment. */
  readonly mention: (ticket: SeededTicket, text: string) => Promise<SessionDelivery & { readonly commentId: string }>;
  /** A person replies in the session's thread: the `prompted` event. */
  readonly followUp: (sessionId: string, text: string) => Promise<SessionDelivery>;
  /** A person presses "Send stop request": a `prompted` event with the stop signal. */
  readonly stop: (sessionId: string) => Promise<SessionDelivery>;
  /** The app's activities in the session, oldest first: never a person's prompts. */
  readonly activities: (sessionId: string) => Promise<readonly RecordedActivity[]>;
  /** The session's link, or `null`. */
  readonly link: (sessionId: string) => Promise<string | null>;
};

export type TrackerMilestone6Hooks = {
  /** Adds a person to the tracker, for `getUser`. */
  readonly seedPerson: (input: { readonly name: string; readonly email: string }) => Promise<{ readonly userId: string }>;
  /** Present on a tracker with `agentSessions`. */
  readonly sessions?: TrackerSessionFixture;
};

/** What the milestone 6 cases run on: a board, and, to go past the capability checks, tickets and the hooks. */
export type TrackerMilestone6Fixture = {
  readonly board: BoardRef;
  readonly seedTicket?: (input: SeedTicketInput) => Promise<SeededTicket>;
  /** The board's statuses for each step, to move a child to done. */
  readonly mapping?: StatusMapping;
  readonly hooks?: TrackerMilestone6Hooks;
};

/**
 * A user a fixture added. `mentionHolds` is the text the user's mention must hold, for a tracker
 * whose mention names the user by something other than its ID (Linear's is the profile URL);
 * absent, the mention must hold the user's ID.
 */
export type SeededTrackerUser = { readonly userId: string; readonly mentionHolds?: string };

const must = <T>(result: AdapterResult<T>, what: string): T => {
  if (!result.ok) {
    throw new Error(`${what}: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

const allTickets = async (adapter: TrackerAdapter, board: BoardRef, since: number, pageSize: number): Promise<Ticket[]> => {
  const tickets: Ticket[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const listed = must(
      await adapter.listTickets({ board, updatedSince: since, order: "updatedAt", pageSize, ...(cursor === undefined ? {} : { cursor }) }),
      "listTickets",
    );
    tickets.push(...listed.tickets);
    if (listed.nextCursor === null) {
      return tickets;
    }
    cursor = listed.nextCursor;
  }
  throw new Error("listTickets never ended");
};

const trackerCapabilityTypes = {
  agentSessions: "boolean",
  subIssues: "boolean",
  statusGraph: "boolean",
  webhooks: "boolean",
  commentEdit: "boolean",
  attachments: "boolean",
  transitions: "boolean",
  mentions: "boolean",
  agentScopes: "array",
  agentSessionLink: "boolean",
  ticketFields: "object",
} as const;

/** The tracker's first cases only: for an adapter whose milestone 2 operations aren't built yet. */
export const defineTrackerFirstCases = <Fixture>(options: ContractSuiteOptions<TrackerAdapter, Fixture>): void => {
  describe(`tracker contract (first cases): ${options.name}`, () => {
    defineCommonCases(useSubject(options), "tracker", trackerCapabilityTypes);
  });
};

/** What the mention case needs: a board and a way to add a user to the tracker. */
export type TrackerMentionFixture = {
  readonly board: BoardRef;
  readonly seedUser?: (email: string) => Promise<SeededTrackerUser>;
};

/** Milestone 3 (F-036): `findUsersByEmail`, for every tracker that has `mentions`. */
const defineMentionCases = (subject: () => { readonly adapter: TrackerAdapter; readonly fixture: TrackerMentionFixture }): void => {
  it("F-036: finds tracker users by email, each with the mention that notifies them: a match, no match, two at once", async (context) => {
    const { adapter, fixture } = subject();
    if (!adapter.capabilities.mentions) {
      expect(await adapter.findUsersByEmail(fixture.board, ["a@example.com"])).toMatchObject({ ok: false, error: { code: "unsupported" } });
      return;
    }
    if (fixture.seedUser === undefined) {
      context.skip();
      return;
    }
    const suffix = Math.random().toString(36).slice(2, 8);
    const first = `first-${suffix}@example.com`;
    const second = `second-${suffix}@example.com`;
    const one = await fixture.seedUser(first);
    const two = await fixture.seedUser(second);
    const found = must(await adapter.findUsersByEmail(fixture.board, [first]), "findUsersByEmail");
    expect(found.map((user) => ({ email: user.email, userId: user.userId }))).toEqual([{ email: first, userId: one.userId }]);
    expect(found[0]?.mention.length).toBeGreaterThan(0);
    expect(found[0]?.mention).toContain(one.mentionHolds ?? one.userId);
    expect(must(await adapter.findUsersByEmail(fixture.board, [`nobody-${suffix}@example.com`]), "findUsersByEmail")).toEqual([]);
    const both = must(await adapter.findUsersByEmail(fixture.board, [second.toUpperCase(), first, `nobody-${suffix}@example.com`]), "findUsersByEmail");
    expect(both.map((user) => user.userId).sort()).toEqual([one.userId, two.userId].sort());
  });
};

/** Milestone 3: the mention case alone, for an adapter whose other operations the full suite doesn't run. */
export const defineTrackerMentionSuite = (options: ContractSuiteOptions<TrackerAdapter, TrackerMentionFixture>): void => {
  describe(`tracker contract (mentions): ${options.name}`, () => {
    defineMentionCases(useSubject(options));
  });
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/** Milestone 6 (spec section 5.2): agent sessions, people, sub-issues and draft writes. */
const defineMilestone6Cases = (subject: () => { readonly adapter: TrackerAdapter; readonly fixture: TrackerMilestone6Fixture }): void => {
  it("declares each milestone 6 capability, and answers unsupported where it's absent", async () => {
    const { adapter, fixture } = subject();
    const { capabilities } = adapter;
    expect(Array.isArray(capabilities.agentScopes)).toBe(true);
    expect(typeof capabilities.ticketFields.acceptanceCriteria).toBe("boolean");
    if (!capabilities.agentSessions) {
      // No agent sessions: no scopes to ask for, and every session operation is refused.
      expect(capabilities.agentScopes).toEqual([]);
      expect(capabilities.agentSessionLink).toBe(false);
      expect(adapter.parseAgentSessionEvent({ type: "AgentSessionEvent", action: "created" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(await adapter.postAgentActivity("session-1", { kind: "thought", body: "Reading", ephemeral: true, idempotencyKey: "k-1" })).toMatchObject({
        ok: false,
        error: { code: "unsupported" },
      });
    } else {
      expect(capabilities.agentScopes.length).toBeGreaterThan(0);
    }
    if (!capabilities.agentSessionLink) {
      expect(await adapter.setAgentSessionLink("session-1", "https://ostra.example.test/tasks/1")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    }
    if (!capabilities.attachments) {
      const ref = { key: ticketKeySchema.parse("NONE-1") };
      expect(await adapter.attachFile(fixture.board, ref, { name: "a.png", contentType: "image/png", bytes: PNG })).toMatchObject({ ok: false, error: { code: "unsupported" } });
    }
  });

  it("reads a person by ID, and an unknown one is not-found", async (context) => {
    const { adapter, fixture } = subject();
    if (fixture.hooks === undefined) {
      context.skip();
      return;
    }
    const suffix = Math.random().toString(36).slice(2, 8);
    const person = await fixture.hooks.seedPerson({ name: `Ada ${suffix}`, email: `ada-${suffix}@example.com` });
    expect(must(await adapter.getUser(person.userId), "getUser")).toMatchObject({ userId: person.userId, name: `Ada ${suffix}`, active: true });
    const found = must(await adapter.getUser(person.userId), "getUser");
    expect(found.email === null || found.email === `ada-${suffix}@example.com`).toBe(true);
    expect(await adapter.getUser(`nobody-${suffix}`)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("creates a child under a parent and reads it back, open until it's done", async (context) => {
    const { adapter, fixture } = subject();
    const { seedTicket } = fixture;
    if (seedTicket === undefined || fixture.hooks === undefined) {
      // An adapter that declares sub-issues gives the suite what it needs to check them.
      expect(adapter.capabilities.subIssues, "an adapter that declares subIssues gives the suite seedTicket and its hooks").toBe(false);
      context.skip();
      return;
    }
    const parent = await seedTicket({ title: "Parent" });
    const created = await adapter.createTicket(fixture.board, { title: "Child", description: "Part one", parent: { externalId: parent.externalId } });
    if (!adapter.capabilities.subIssues) {
      expect(created).toMatchObject({ ok: false, error: { code: "unsupported" } });
      return;
    }
    const child = must(created, "createTicket with a parent");
    expect(child).toMatchObject({ parentExternalId: parent.externalId, parentKey: parent.key });
    const context6 = must(await adapter.getTicketContext(fixture.board, { externalId: parent.externalId }), "getTicketContext");
    expect(context6.children.map((one) => ({ externalId: one.externalId, title: one.title, open: one.open }))).toEqual([
      { externalId: child.externalId, title: "Child", open: true },
    ]);
    const childContext = must(await adapter.getTicketContext(fixture.board, { externalId: child.externalId }), "the child's context");
    expect(childContext.parent?.externalId).toBe(parent.externalId);
    if (fixture.mapping !== undefined) {
      for (const target of ["started", "in-review", "done"] as const) {
        must(await adapter.moveTicket(fixture.board, { externalId: child.externalId }, target, fixture.mapping), `moveTicket ${target}`);
      }
      const after = must(await adapter.getTicketContext(fixture.board, { externalId: parent.externalId }), "getTicketContext after done");
      expect(after.children.map((one) => one.open)).toEqual([false]);
    }
    const elsewhere = await adapter.createTicket(fixture.board, { title: "Orphan", description: null, parent: { externalId: externalTicketIdSchema.parse("no-such-parent") } });
    expect(elsewhere.ok).toBe(false);
  });

  it("writes a draft's description, and its criteria only where the tracker has the field", async (context) => {
    const { adapter, fixture } = subject();
    const { seedTicket } = fixture;
    if (seedTicket === undefined || fixture.hooks === undefined) {
      context.skip();
      return;
    }
    const seeded = await seedTicket({ title: "Refine me", description: "Vague" });
    const ref = { externalId: seeded.externalId };
    const description = "## What\n\nThe banner shows the user's name.\n\n- [ ] One `$(whoami)` stays text";
    must(await adapter.updateTicket(fixture.board, ref, { description }), "updateTicket");
    const read = must(await adapter.getTicket(fixture.board, ref), "getTicket");
    expect(read.description).toBe(description);
    const withCriteria = await adapter.updateTicket(fixture.board, ref, { description, acceptanceCriteria: "- It shows the name" });
    if (adapter.capabilities.ticketFields.acceptanceCriteria) {
      must(withCriteria, "updateTicket with criteria");
      expect(must(await adapter.getTicket(fixture.board, ref), "getTicket").acceptanceCriteria).toBe("- It shows the name");
    } else {
      expect(withCriteria).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    }
    expect((await adapter.updateTicket({ externalId: "no-such-board" }, ref, { description })).ok).toBe(false);
  });

  it("attaches a file to a ticket, which downloads back", async (context) => {
    const { adapter, fixture } = subject();
    const { seedTicket } = fixture;
    if (seedTicket === undefined || fixture.hooks === undefined || !adapter.capabilities.attachments) {
      context.skip();
      return;
    }
    const seeded = await seedTicket({ title: "With a file" });
    const attached = must(
      await adapter.attachFile(fixture.board, { externalId: seeded.externalId }, { name: "mock-up.png", contentType: "image/png", bytes: PNG }),
      "attachFile",
    );
    const context6 = must(await adapter.getTicketContext(fixture.board, { externalId: seeded.externalId }), "getTicketContext");
    expect(context6.attachments.map((attachment) => attachment.url)).toContain(attached.url);
    const file = must(await adapter.downloadFile(attached.url, 1024 * 1024), "downloadFile");
    expect([...file.bytes]).toEqual([...PNG]);
  });

  it("reads a session's created, follow-up and stop events, and tolerates an unknown field", async (context) => {
    const { adapter, fixture } = subject();
    const sessions = fixture.hooks?.sessions;
    const { seedTicket } = fixture;
    if (!adapter.capabilities.agentSessions || sessions === undefined || seedTicket === undefined) {
      context.skip();
      return;
    }
    const seeded = await seedTicket({ title: "Delegated" });
    const created = await sessions.delegate(seeded);
    const read = must(adapter.parseAgentSessionEvent(created.body), "parseAgentSessionEvent created");
    expect(read).toMatchObject({
      sessionId: created.sessionId,
      action: "created",
      ticketExternalId: seeded.externalId,
      teamExternalId: fixture.board.externalId,
      creator: { userId: sessions.person.userId, name: sessions.person.name },
      signal: null,
    });
    // The vendor owns the format: a field ostra doesn't know is read past.
    const widened = typeof created.body === "object" && created.body !== null ? { ...created.body, somethingNew: { nested: true } } : created.body;
    expect(must(adapter.parseAgentSessionEvent(widened), "parseAgentSessionEvent with an unknown field").sessionId).toBe(created.sessionId);

    const followUp = await sessions.followUp(created.sessionId, "Also check the footer");
    expect(must(adapter.parseAgentSessionEvent(followUp.body), "parseAgentSessionEvent prompted")).toMatchObject({
      sessionId: created.sessionId,
      action: "prompted",
      prompt: "Also check the footer",
      signal: null,
    });
    // A stop is an event ostra reads, never a call it makes (ADR 0013).
    const stop = await sessions.stop(created.sessionId);
    expect(must(adapter.parseAgentSessionEvent(stop.body), "parseAgentSessionEvent stop")).toMatchObject({ sessionId: created.sessionId, action: "prompted", signal: "stop" });

    const mention = await sessions.mention(seeded, "can you look at this?");
    expect(must(adapter.parseAgentSessionEvent(mention.body), "parseAgentSessionEvent mention")).toMatchObject({
      sessionId: mention.sessionId,
      action: "created",
      commentId: mention.commentId,
    });
    expect(adapter.parseAgentSessionEvent({ type: "Issue", action: "update" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("posts each activity once per idempotency key, with its kind and ephemeral flag", async (context) => {
    const { adapter, fixture } = subject();
    const sessions = fixture.hooks?.sessions;
    const { seedTicket } = fixture;
    if (!adapter.capabilities.agentSessions || sessions === undefined || seedTicket === undefined) {
      context.skip();
      return;
    }
    const { sessionId } = await sessions.delegate(await seedTicket({ title: "Progress" }));
    const thought = { kind: "thought", body: "Reading the code", ephemeral: true, idempotencyKey: "task-1:thought:1" } as const;
    const first = must(await adapter.postAgentActivity(sessionId, thought), "postAgentActivity");
    const again = must(await adapter.postAgentActivity(sessionId, thought), "postAgentActivity again");
    expect(again.activityId).toBe(first.activityId);
    for (const kind of agentActivityKinds.filter((one) => one !== "thought")) {
      must(await adapter.postAgentActivity(sessionId, { kind, body: `A ${kind}`, ephemeral: false, idempotencyKey: `task-1:${kind}` }), `postAgentActivity ${kind}`);
    }
    // An action's text is the tracker's own shape (Linear's action and parameter), so only its kind is compared.
    const recorded = await sessions.activities(sessionId);
    expect(recorded.map((activity) => ({ kind: activity.kind, ephemeral: activity.ephemeral, body: activity.kind === "action" ? null : activity.body }))).toEqual([
      { kind: "thought", ephemeral: true, body: "Reading the code" },
      ...agentActivityKinds.filter((one) => one !== "thought").map((kind) => ({ kind, ephemeral: false, body: kind === "action" ? null : `A ${kind}` })),
    ]);
    if (adapter.capabilities.agentSessionLink) {
      must(await adapter.setAgentSessionLink(sessionId, "https://ostra.example.test/tasks/0196f1a0"), "setAgentSessionLink");
      expect(await sessions.link(sessionId)).toBe("https://ostra.example.test/tasks/0196f1a0");
    }
  });
};

/** Milestone 6's cases alone, for an adapter the full suite doesn't run (the tiny tracker). */
export const defineTrackerMilestone6Suite = (options: ContractSuiteOptions<TrackerAdapter, TrackerMilestone6Fixture>): void => {
  describe(`tracker contract (milestone 6): ${options.name}`, () => {
    defineMilestone6Cases(useSubject(options));
  });
};

export const defineTrackerContractSuite = (options: ContractSuiteOptions<TrackerAdapter, TrackerSuiteFixture>): void => {
  describe(`tracker contract: ${options.name}`, () => {
    const subject = useSubject(options);
    defineMentionCases(subject);
    defineMilestone6Cases(() => {
      const { adapter, fixture } = subject();
      const hooks = fixture.milestone6;
      return {
        adapter,
        fixture: hooks === undefined ? { board: fixture.board } : { board: fixture.board, seedTicket: fixture.seedTicket, mapping: fixture.mapping, hooks },
      };
    });
    defineCommonCases(subject, "tracker", trackerCapabilityTypes);

    const otherSeesNothing = async (ticket: SeededTicket): Promise<void> => {
      const { fixture } = subject();
      const byId = await fixture.other.getTicket(fixture.board, { externalId: ticket.externalId });
      expect(byId.ok, "another organization reads the ticket by its ID").toBe(false);
      const byKey = await fixture.other.getTicket(fixture.board, ticket.key);
      expect(byKey.ok, "another organization reads the ticket by its key").toBe(false);
    };

    it("lists the board and its statuses, each in one of the four categories", async () => {
      const { adapter, fixture } = subject();
      const boards = must(await adapter.listBoards(), "listBoards");
      expect(boards.map((board) => board.externalId)).toContain(fixture.board.externalId);
      expect(boards.find((board) => board.externalId === fixture.board.externalId)?.key).toBe(fixture.boardKey);
      const statuses = must(await adapter.listStatuses(fixture.board), "listStatuses");
      for (const status of statuses) {
        expect(ticketStatusCategories).toContain(status.category);
      }
      const ids = statuses.map((status) => status.id);
      expect(ids).toEqual(expect.arrayContaining([fixture.mapping.started, fixture.mapping.inReview, fixture.mapping.done]));
      expect(statuses.some((status) => status.category === "open")).toBe(true);
      const otherBoards = must(await fixture.other.listBoards(), "the other organization's listBoards");
      expect(otherBoards.map((board) => board.externalId)).not.toContain(fixture.board.externalId);
      expect((await fixture.other.listStatuses(fixture.board)).ok).toBe(false);
    });

    it("reads a ticket by key and by its stable ID, with its labels", async () => {
      const { adapter, fixture } = subject();
      const seeded = await fixture.seedTicket({ title: "Read me", description: "Plain text", labels: ["docs"] });
      const byKey = must(await adapter.getTicket(fixture.board, seeded.key), "getTicket by key");
      const byId = must(await adapter.getTicket(fixture.board, { externalId: seeded.externalId }), "getTicket by ID");
      expect(byId).toEqual(byKey);
      expect(byId).toMatchObject({ externalId: seeded.externalId, key: seeded.key, title: "Read me", labels: ["docs"] });
      expect(byId.status.category).toBe("open");
      expect((await adapter.getTicket(fixture.otherBoard, { externalId: seeded.externalId })).ok).toBe(false);
      await otherSeesNothing(seeded);
    });

    it("pages through tickets updated since a time, oldest change first, inclusive", async () => {
      const { adapter, fixture } = subject();
      await fixture.advance(60_000);
      const since = fixture.now();
      const seeded: SeededTicket[] = [];
      for (const title of ["First", "Second", "Third"]) {
        seeded.push(await fixture.seedTicket({ title }));
        await fixture.advance(1000);
      }
      const listed = await allTickets(adapter, fixture.board, since, 2);
      const ours = listed.filter((ticket) => seeded.some((one) => one.externalId === ticket.externalId));
      expect(ours.map((ticket) => ticket.title)).toEqual(["First", "Second", "Third"]);
      expect(new Set(listed.map((ticket) => ticket.externalId)).size).toBe(listed.length);
      const times = listed.map((ticket) => ticket.updatedAt);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      // Inclusive: the first ticket's own time still finds it.
      const first = ours[0];
      if (first === undefined) throw new Error("no first ticket");
      const fromFirst = await allTickets(adapter, fixture.board, first.updatedAt, 50);
      expect(fromFirst.map((ticket) => ticket.externalId)).toContain(first.externalId);
      // Edited later, it comes after the others.
      await fixture.advance(1000);
      await fixture.editTicket(first.externalId, "First, edited");
      const again = await allTickets(adapter, fixture.board, since, 2);
      expect(again.filter((ticket) => seeded.some((one) => one.externalId === ticket.externalId)).map((ticket) => ticket.title)).toEqual([
        "Second",
        "Third",
        "First, edited",
      ]);
      const others = await fixture.other.listTickets({ board: fixture.board });
      expect(others.ok ? others.value.tickets.length : 0).toBe(0);
    });

    it("finds a ticket whose key changed by its stable ID", async () => {
      const { adapter, fixture } = subject();
      const seeded = await fixture.seedTicket({ title: "Moving team" });
      const newKey = await fixture.moveToOtherBoard(seeded.externalId);
      expect(newKey).not.toBe(seeded.key);
      const moved = must(await adapter.getTicket(fixture.otherBoard, { externalId: seeded.externalId }), "getTicket after the move");
      expect(moved).toMatchObject({ externalId: seeded.externalId, key: newKey });
      await otherSeesNothing({ externalId: seeded.externalId, key: newKey });
    });

    it("reads a ticket's context: description, comments, labels and its image", async () => {
      const { adapter, fixture } = subject();
      const seeded = await fixture.seedTicket({
        title: "With context",
        description: "Fix the `$(whoami)` banner",
        labels: ["bug"],
        comments: ["First comment", "Second comment"],
        withImage: true,
      });
      const context = must(await adapter.getTicketContext(fixture.board, { externalId: seeded.externalId }), "getTicketContext");
      expect(context.ticket).toMatchObject({ externalId: seeded.externalId, labels: ["bug"] });
      expect(context.ticket.description).toContain("Fix the `$(whoami)` banner");
      expect(context.comments.map((comment) => comment.body)).toEqual(["First comment", "Second comment"]);
      expect(context.images).toHaveLength(1);
      const image = context.images[0];
      if (image === undefined) throw new Error("no image");
      const file = must(await adapter.downloadFile(image.url, 10 * 1024 * 1024), "downloadFile");
      expect(file.bytes.length).toBeGreaterThan(0);
      expect(await adapter.downloadFile(image.url, 1)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect((await fixture.other.getTicketContext(fixture.board, { externalId: seeded.externalId })).ok).toBe(false);
    });

    it("moves a ticket through the mapping, and a second move to the same step writes nothing", async () => {
      const { adapter, fixture } = subject();
      const seeded = await fixture.seedTicket({ title: "Move me" });
      const ref = { externalId: seeded.externalId };
      for (const [target, statusId] of [
        ["started", fixture.mapping.started],
        ["in-review", fixture.mapping.inReview],
        ["done", fixture.mapping.done],
      ] as const) {
        const moved = must(await adapter.moveTicket(fixture.board, ref, target, fixture.mapping), `moveTicket ${target}`);
        expect(moved).toMatchObject({ moved: true, status: { id: statusId } });
        const again = must(await adapter.moveTicket(fixture.board, ref, target, fixture.mapping), `moveTicket ${target} again`);
        expect(again.moved).toBe(false);
        expect(must(await adapter.getTicket(fixture.board, ref), "getTicket").status.id).toBe(statusId);
      }
      expect((await fixture.other.moveTicket(fixture.board, ref, "started", fixture.mapping)).ok).toBe(false);
    });

    it("edits its own comment in place, and keeps one comment", async () => {
      const { adapter, fixture } = subject();
      const seeded = await fixture.seedTicket({ title: "Progress" });
      const { commentId } = must(await adapter.comment(fixture.board, seeded.key, "ostra is working on this"), "comment");
      const edited = await adapter.updateComment(fixture.board, { externalId: seeded.externalId }, commentId, "ostra opened a PR");
      if (!adapter.capabilities.commentEdit) {
        expect(edited).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      must(edited, "updateComment");
      const context = must(await adapter.getTicketContext(fixture.board, { externalId: seeded.externalId }), "getTicketContext");
      expect(context.comments.map((comment) => comment.body)).toEqual(["ostra opened a PR"]);
      expect(
        (await fixture.other.updateComment(fixture.board, { externalId: seeded.externalId }, commentId, "x")).ok,
      ).toBe(false);
    });

    it("links the task and a PR once each, however often it's asked", async () => {
      const { adapter, fixture } = subject();
      const seeded = await fixture.seedTicket({ title: "Links" });
      const ref = { externalId: seeded.externalId };
      const link = { url: "https://ostra.example.test/tasks/0196f1a0", title: "ostra task", subtitle: "Running" };
      const first = must(await adapter.linkTask(fixture.board, ref, link), "linkTask");
      const second = must(await adapter.linkTask(fixture.board, ref, link), "linkTask again");
      expect(second.attachmentId).toBe(first.attachmentId);
      const pr = "https://github.com/ostra-test/test1/pull/7";
      must(await adapter.linkPullRequest(fixture.board, seeded.key, pr), "linkPullRequest");
      must(await adapter.linkPullRequest(fixture.board, seeded.key, pr), "linkPullRequest again");
      const context = must(await adapter.getTicketContext(fixture.board, ref), "getTicketContext");
      expect(context.attachments.filter((attachment) => attachment.url === link.url)).toHaveLength(1);
      expect(context.attachments.filter((attachment) => attachment.url === pr)).toHaveLength(1);
      expect((await fixture.other.linkTask(fixture.board, ref, link)).ok).toBe(false);
    });

    it("creates a ticket on the board", async () => {
      const { adapter, fixture } = subject();
      const created = must(await adapter.createTicket(fixture.board, { title: "From a prompt task", description: "Made by ostra" }), "createTicket");
      expect(created.key.startsWith(`${fixture.boardKey}-`)).toBe(true);
      expect(must(await adapter.getTicket(fixture.board, { externalId: created.externalId }), "getTicket").title).toBe("From a prompt task");
      await otherSeesNothing(created);
    });

    it("says whether the tracker's GitHub integration is installed", async () => {
      const { adapter, fixture } = subject();
      expect(must(await adapter.detectCodeHostIntegration(fixture.board), "detectCodeHostIntegration").installed).toBe(
        fixture.integrationInstalled,
      );
    });

    it("verifies a signed delivery, and refuses a bad signature, none, and a stale one", async () => {
      const { adapter, fixture } = subject();
      const seeded = await fixture.seedTicket({ title: "Webhook" });
      const sentAt = fixture.now();
      const delivery = await fixture.signedDelivery({ ticket: seeded, byOwnUser: false, sentAt });
      const request = { rawBody: delivery.rawBody, headers: delivery.headers, secret: fixture.webhookSecret, now: sentAt + 2000 };
      if (!adapter.capabilities.webhooks) {
        expect(adapter.verifyWebhook(request).ok).toBe(false);
        return;
      }
      const verified = adapter.verifyWebhook(request);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.signatureHash).toMatch(/^[0-9a-f]{64}$/);
      const hint = must(adapter.parseWebhook({ body: verified.body, ownUserId: fixture.ownUserId }), "parseWebhook");
      expect(hint).toMatchObject({ ticketExternalId: seeded.externalId, byOwnUser: false });

      const tampered = new Uint8Array(delivery.rawBody);
      tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 1;
      expect(adapter.verifyWebhook({ ...request, rawBody: tampered })).toEqual({ ok: false, reason: "bad-signature" });
      expect(adapter.verifyWebhook({ ...request, secret: `${fixture.webhookSecret}x` })).toEqual({ ok: false, reason: "bad-signature" });
      expect(adapter.verifyWebhook({ ...request, headers: {} })).toEqual({ ok: false, reason: "missing-signature" });
      expect(adapter.verifyWebhook({ ...request, now: sentAt + 61_000 })).toEqual({ ok: false, reason: "stale" });
    });

    it("marks a delivery its own user caused, so ostra doesn't act on its echo", async () => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.webhooks || fixture.ownUserId === null) return;
      const seeded = await fixture.seedTicket({ title: "Echo" });
      const sentAt = fixture.now();
      const delivery = await fixture.signedDelivery({ ticket: seeded, byOwnUser: true, sentAt });
      const verified = adapter.verifyWebhook({ rawBody: delivery.rawBody, headers: delivery.headers, secret: fixture.webhookSecret, now: sentAt });
      if (!verified.ok) throw new Error(`the delivery was refused: ${verified.reason}`);
      expect(must(adapter.parseWebhook({ body: verified.body, ownUserId: fixture.ownUserId }), "parseWebhook").byOwnUser).toBe(true);
      expect(must(adapter.parseWebhook({ body: verified.body, ownUserId: null }), "parseWebhook").byOwnUser).toBe(false);
    });

    it("turns a 429 into rate-limited, with the time to wait", async () => {
      const { adapter, fixture } = subject();
      const seeded = await fixture.seedTicket({ title: "Busy" });
      await fixture.rateLimitNext(3);
      const limited = await adapter.getTicket(fixture.board, { externalId: seeded.externalId });
      expect(limited).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 3000 } });
      expect((await adapter.getTicket(fixture.board, { externalId: seeded.externalId })).ok).toBe(true);
    });
  });
};
