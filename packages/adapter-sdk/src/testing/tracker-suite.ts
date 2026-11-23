import { createServer } from "node:http";
import type { Server } from "node:http";

import { externalTicketIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { ExternalTicketId, TicketKey } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { AdapterResult } from "../common/result.ts";
import { agentActivityKinds, ticketStatusCategories } from "../tracker/base.ts";
import type { AgentActivityKind, BoardRef, OwnWrites, StatusMapping, Ticket, TicketFileWhere, TrackerAdapter } from "../tracker/base.ts";
import { ticketFilesCapabilities, trackerRichTexts } from "../tracker/capabilities.ts";
import type { TicketFilesCapability } from "../tracker/capabilities.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";
import { defineTrackerTwoSitesCases, defineTrackerWorkflowCases } from "./tracker-workflow-cases.ts";
import type { TrackerSecondSubject, TrackerWorkflowHooks } from "./tracker-workflow-cases.ts";

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
  /**
   * How old a signed delivery may be before it's stale, as the tracker's adapter takes it. Default
   * 60 s (Linear's window); Jira's is longer, as its retries come minutes later (ADR 0047).
   */
  readonly webhookMaxAgeMs?: number;
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
  /**
   * Milestone 9 (F-149): what the files cases need. Absent: only an adapter that declares
   * `ticketFiles: "none"` may leave it out.
   */
  readonly files?: TrackerFilesHooks;
  /**
   * Milestone 11 (F-008/c5): the workflow's hooks, for the workflow read and the moves along it.
   * Absent: only an adapter that declares neither `statusGraph` nor `transitions` may leave it out.
   */
  readonly workflow?: TrackerWorkflowHooks;
  /**
   * Milestone 11 (F-152/c3): a second connection of the adapter in the same organization, on
   * another site or workspace. Absent: the two-site case is skipped.
   */
  readonly second?: TrackerSecondSubject;
};

/**
 * Milestone 9 (F-149): a ticket a person made with files in it, as the tracker shows them, and
 * the URL of each (as `getTicketContext` lists it).
 */
export type SeededTicketWithFiles = SeededTicket & {
  /** Inline in the description, in this order: an image, then a document linked. */
  readonly descriptionImage: string;
  readonly descriptionFile: string;
  /** A person's comment showing an image, and its ID. */
  readonly commentId: string;
  readonly commentImage: string;
  /** A document a person attached to the ticket, shown nowhere in its text. */
  readonly attachedFile: string;
  /** A link attachment (a Figma frame): a link, never a file. */
  readonly linkAttachment: string;
  /** An image on the tracker's file host the ticket doesn't show: the suite's ostra comment shows it. */
  readonly spareImage: string;
};

/** Milestone 9 (F-149): the tracker's files, as a person puts them there. */
export type TrackerFilesHooks = {
  readonly seedTicketWithFiles: () => Promise<SeededTicketWithFiles>;
  /**
   * A follow-up's text as the tracker gives it (markdown): an image and then a document on the
   * tracker's file host, then a link to the same kind of file off it.
   */
  readonly followUpText: () => Promise<{ readonly text: string; readonly image: string; readonly file: string; readonly offHost: string }>;
  /** A file of `size` bytes on the tracker's file host. Absent on an adapter that downloads nothing. */
  readonly seedFile?: (size: number) => Promise<string>;
  /**
   * A file on the file host whose body never ends and declares no length: a download that doesn't
   * stop at its cap never returns. Absent where nothing streams (an in-memory fake).
   */
  readonly seedEndlessFile?: () => Promise<string>;
};

/** Milestone 9: what the files cases run on, for an adapter the full suite doesn't run (the tiny tracker). */
export type TrackerFilesFixture = {
  readonly board: BoardRef;
  /** The adapter's own user, as `OwnWrites` names it; `null` when it has none. */
  readonly ownUserId: string | null;
  readonly files?: TrackerFilesHooks;
  /** An adapter on another organization's workspace, which must read none of this one's files. */
  readonly other?: TrackerAdapter;
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
  ticketFiles: "string",
  magicWords: "boolean",
  richText: "string",
  jqlFilter: "boolean",
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
      expect(await adapter.listAttachments(fixture.board, ref)).toMatchObject({ ok: false, error: { code: "unsupported" } });
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

  it("attaches a file to a ticket, which downloads back and is listed with its marker", async (context) => {
    const { adapter, fixture } = subject();
    const { seedTicket } = fixture;
    if (seedTicket === undefined || fixture.hooks === undefined || !adapter.capabilities.attachments) {
      context.skip();
      return;
    }
    const seeded = await seedTicket({ title: "With a file" });
    const ref = { externalId: seeded.externalId };
    expect(must(await adapter.listAttachments(fixture.board, ref), "listAttachments")).toEqual([]);
    const marker = "Attached by ostra from a draft (image 1)";
    const attached = must(await adapter.attachFile(fixture.board, ref, { name: "mock-up.png", contentType: "image/png", bytes: PNG, marker }), "attachFile");
    const context6 = must(await adapter.getTicketContext(fixture.board, ref), "getTicketContext");
    expect(context6.attachments.map((attachment) => attachment.url)).toContain(attached.url);
    // F-099: a retry finds the file by its marker, so it isn't attached twice.
    const listed = must(await adapter.listAttachments(fixture.board, ref), "listAttachments");
    expect(listed.filter((attachment) => attachment.subtitle === marker).map((attachment) => attachment.url)).toEqual([attached.url]);
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

// ---------- milestone 9: a ticket's files (F-149, spec section 5.2) ----------

/** The markers the suite's own ostra writes carry: core passes its own the same way (`OwnWrites`). */
const SUITE_COMMENT_MARKER = "<sub>ostra edits this comment as the task moves:";
const SUITE_ATTACHMENT_MARKER = "Attached by ostra from a draft";

const ownWritesOf = (userId: string | null): OwnWrites => ({
  userId,
  commentMarkers: [SUITE_COMMENT_MARKER],
  attachmentMarkers: [SUITE_ATTACHMENT_MARKER],
});

/** The files a person's ticket shows, for each capability, as `{ url, where, commentId }` in order. */
const expectedPeoplesFiles = (
  seeded: SeededTicketWithFiles,
  capability: TicketFilesCapability,
): readonly { readonly url: string; readonly where: TicketFileWhere; readonly commentId: string | null }[] => {
  const image = { url: seeded.descriptionImage, where: "description" as const, commentId: null };
  const comment = { url: seeded.commentImage, where: "comment" as const, commentId: seeded.commentId };
  switch (capability) {
    case "all":
      return [
        image,
        { url: seeded.descriptionFile, where: "description", commentId: null },
        comment,
        { url: seeded.attachedFile, where: "attachment", commentId: null },
      ];
    case "images":
      return [image, comment];
    case "none":
      return [];
    default:
      return capability satisfies never;
  }
};

type RecordedRequest = { readonly path: string; readonly credentials: readonly string[] };

/** A host that isn't the tracker's: it records every request it gets, and the credentials each carried. */
const startOffHost = async (): Promise<{ readonly origin: string; readonly requests: readonly RecordedRequest[]; readonly close: () => Promise<void> }> => {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const credentials = ["authorization", "cookie", "proxy-authorization", "x-api-key"].filter((name) => request.headers[name] !== undefined);
    requests.push({ path: request.url ?? "/", credentials });
    response.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
    response.end(Buffer.from(PNG));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the off-host server has no TCP address");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
};

/** Milestone 9 (spec section 5.2): `ticketFiles`, `TicketContext.files`, `filesInText` and `downloadFile`'s limits. */
const defineFilesCases = (subject: () => { readonly adapter: TrackerAdapter; readonly fixture: TrackerFilesFixture }): void => {
  it("F-149/c6: declares ticketFiles as all, images or none, and gives the suite its files unless none", () => {
    const { adapter, fixture } = subject();
    expect(ticketFilesCapabilities).toContain(adapter.capabilities.ticketFiles);
    if (adapter.capabilities.ticketFiles !== "none") {
      expect(fixture.files, "an adapter that declares ticketFiles gives the suite its files hooks").toBeDefined();
    }
  });

  it("F-149/c6: lists a ticket's files once each, in order, as ticketFiles says: the description's image and document, a comment's image, an attached document", async (context) => {
    const { adapter, fixture } = subject();
    const hooks = fixture.files;
    if (hooks === undefined) {
      context.skip();
      return;
    }
    const seeded = await hooks.seedTicketWithFiles();
    const read = must(await adapter.getTicketContext(fixture.board, { externalId: seeded.externalId }, { own: ownWritesOf(fixture.ownUserId) }), "getTicketContext");
    const { ticketFiles } = adapter.capabilities;
    const peoples = read.files.filter((file) => !file.byOstra);
    expect(peoples.map((file) => ({ url: file.url, where: file.where, commentId: file.commentId }))).toEqual(expectedPeoplesFiles(seeded, ticketFiles));
    expect(new Set(read.files.map((file) => file.url)).size, "each URL once").toBe(read.files.length);
    for (const file of read.files) {
      expect(file.name.length, "every file has a name").toBeGreaterThan(0);
      expect(file.size === null || (Number.isInteger(file.size) && file.size >= 0)).toBe(true);
    }
    // `none`: nothing, and the ticket's text is all a task starts from.
    if (ticketFiles === "none") {
      expect(read.files).toEqual([]);
      return;
    }
    // Only files the tracker holds: each one downloads with the adapter's credential.
    for (const file of peoples) {
      expect(must(await adapter.downloadFile(file.url, 10 * 1024 * 1024), `downloadFile ${file.where}`).bytes.length).toBeGreaterThan(0);
    }
    // Another organization's connection reads none of it.
    expect((await fixture.other?.getTicketContext(fixture.board, { externalId: seeded.externalId }))?.ok ?? false).toBe(false);
  });

  it("F-149/c6: marks a file in ostra's own comment, or an attachment ostra made, byOstra, and none without OwnWrites", async (context) => {
    const { adapter, fixture } = subject();
    const hooks = fixture.files;
    if (hooks === undefined) {
      context.skip();
      return;
    }
    const seeded = await hooks.seedTicketWithFiles();
    const ref = { externalId: seeded.externalId };
    if (adapter.capabilities.ticketFiles === "none") {
      expect(must(await adapter.getTicketContext(fixture.board, ref, { own: ownWritesOf(fixture.ownUserId) }), "getTicketContext").files).toEqual([]);
      return;
    }
    // ostra's progress comment, written as core writes it: through the adapter, with its marker.
    must(await adapter.comment(fixture.board, seeded.key, `**ostra is working on this.**\n\n![progress.png](${seeded.spareImage})\n\n${SUITE_COMMENT_MARKER} https://ostra.example.test/tasks/1</sub>`), "comment");
    let ownAttachment: string | null = null;
    if (adapter.capabilities.attachments) {
      ownAttachment = must(
        await adapter.attachFile(fixture.board, ref, { name: "draft.png", contentType: "image/png", bytes: PNG, marker: `${SUITE_ATTACHMENT_MARKER} (image 1)` }),
        "attachFile",
      ).url;
    }
    const read = must(await adapter.getTicketContext(fixture.board, ref, { own: ownWritesOf(fixture.ownUserId) }), "getTicketContext");
    const ostras = [seeded.spareImage, ...(ownAttachment === null ? [] : [ownAttachment])];
    // People's files are exactly the earlier case's: ostra's own never count among them.
    expect(read.files.filter((file) => !file.byOstra).map((file) => file.url)).toEqual(expectedPeoplesFiles(seeded, adapter.capabilities.ticketFiles).map((file) => file.url));
    // Both are images, so `all` and `images` list them, marked.
    expect(read.files.filter((file) => file.byOstra).map((file) => file.url)).toEqual(ostras);
    // Told nothing of ostra's writes, the adapter marks nothing.
    const untold = must(await adapter.getTicketContext(fixture.board, ref), "getTicketContext without OwnWrites");
    expect(untold.files.filter((file) => file.byOstra)).toEqual([]);
    expect(untold.files.map((file) => file.url)).toEqual(expect.arrayContaining(ostras));
    // ostra's own user is enough without a marker, where the connection has one.
    if (fixture.ownUserId !== null) {
      const byAuthor = must(
        await adapter.getTicketContext(fixture.board, ref, { own: { userId: fixture.ownUserId, commentMarkers: [], attachmentMarkers: [] } }),
        "getTicketContext by author",
      );
      expect(byAuthor.files.find((file) => file.url === seeded.spareImage)?.byOstra).toBe(true);
    }
  });

  it("F-149/c1: never lists a link attachment as a file: it stays a link, and nothing behind it is fetched", async (context) => {
    const { adapter, fixture } = subject();
    const hooks = fixture.files;
    if (hooks === undefined) {
      context.skip();
      return;
    }
    const seeded = await hooks.seedTicketWithFiles();
    const read = must(await adapter.getTicketContext(fixture.board, { externalId: seeded.externalId }, { own: ownWritesOf(fixture.ownUserId) }), "getTicketContext");
    if (adapter.capabilities.ticketFiles !== "none") {
      expect(read.attachments.map((attachment) => attachment.url)).toContain(seeded.linkAttachment);
    }
    expect(read.files.map((file) => file.url)).not.toContain(seeded.linkAttachment);
    expect(read.images.map((image) => image.url)).not.toContain(seeded.linkAttachment);
  });

  it("F-149/c9: reads a follow-up's text for the files on the tracker's file host, as ticketFiles says, and ignores a link off it", async (context) => {
    const { adapter, fixture } = subject();
    const hooks = fixture.files;
    if (hooks === undefined) {
      expect(adapter.filesInText("![shot.png](https://files.example.test/shot.png)")).toEqual([]);
      context.skip();
      return;
    }
    const sample = await hooks.followUpText();
    const found = adapter.filesInText(sample.text);
    const expected = { all: [sample.image, sample.file], images: [sample.image], none: [] }[adapter.capabilities.ticketFiles];
    expect(found.map((file) => file.url)).toEqual(expected);
    for (const file of found) {
      expect(file).toMatchObject({ where: "comment", commentId: null, byOstra: false });
      expect(file.name.length).toBeGreaterThan(0);
    }
    expect(found.map((file) => file.url)).not.toContain(sample.offHost);
    expect(adapter.filesInText("")).toEqual([]);
  });

  it("F-149/c1: downloads a file within maxBytes; refuses one over it, having read no more; refuses a URL off the file host with no credential sent", async () => {
    const { adapter, fixture } = subject();
    const offHost = await startOffHost();
    try {
      const refused = await adapter.downloadFile(`${offHost.origin}/uploads/stolen.png`, 1024 * 1024);
      expect(refused.ok, "a file off the tracker's host").toBe(false);
      expect(offHost.requests.flatMap((request) => request.credentials), "no credential leaves for another host").toEqual([]);
    } finally {
      await offHost.close();
    }
    const hooks = fixture.files;
    if (hooks?.seedFile !== undefined) {
      const size = 64 * 1024;
      const url = await hooks.seedFile(size);
      expect(must(await adapter.downloadFile(url, size), "downloadFile within maxBytes").bytes.length).toBe(size);
      expect(await adapter.downloadFile(url, size - 1)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    }
    if (hooks?.seedEndlessFile !== undefined) {
      // A body that never ends: only a reader that stops past maxBytes returns at all.
      const endless = await hooks.seedEndlessFile();
      expect(await adapter.downloadFile(endless, 256 * 1024)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    }
  });
};

/** Milestone 9's files cases alone, for an adapter the full suite doesn't run (the tiny tracker). */
export const defineTrackerFilesSuite = (options: ContractSuiteOptions<TrackerAdapter, TrackerFilesFixture>): void => {
  describe(`tracker contract (files): ${options.name}`, () => {
    defineFilesCases(useSubject(options));
  });
};

export const defineTrackerContractSuite = (options: ContractSuiteOptions<TrackerAdapter, TrackerSuiteFixture>): void => {
  describe(`tracker contract: ${options.name}`, () => {
    const subject = useSubject(options);
    defineMentionCases(subject);
    defineFilesCases(() => {
      const { adapter, fixture } = subject();
      return { adapter, fixture: { board: fixture.board, ownUserId: fixture.ownUserId, other: fixture.other, ...(fixture.files === undefined ? {} : { files: fixture.files }) } };
    });
    defineMilestone6Cases(() => {
      const { adapter, fixture } = subject();
      const hooks = fixture.milestone6;
      return {
        adapter,
        fixture: hooks === undefined ? { board: fixture.board } : { board: fixture.board, seedTicket: fixture.seedTicket, mapping: fixture.mapping, hooks },
      };
    });
    defineCommonCases(subject, "tracker", trackerCapabilityTypes);
    defineTrackerWorkflowCases(subject);
    defineTrackerTwoSitesCases(subject);

    it("declares milestone 11's words: magicWords, richText and jqlFilter", () => {
      const { capabilities } = subject().adapter;
      expect(trackerRichTexts).toContain(capabilities.richText);
      expect(typeof capabilities.magicWords).toBe("boolean");
      expect(typeof capabilities.jqlFilter).toBe("boolean");
    });

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
        // Milestone 11 (F-008): a transitions tracker names what it took; one that writes the status, nothing.
        if (adapter.capabilities.transitions) {
          expect(moved.via.length).toBeGreaterThan(0);
        } else {
          expect(moved.via).toEqual([]);
        }
        const again = must(await adapter.moveTicket(fixture.board, ref, target, fixture.mapping), `moveTicket ${target} again`);
        expect(again.moved).toBe(false);
        expect(again.via).toEqual([]);
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
      expect(adapter.verifyWebhook({ ...request, now: sentAt + (fixture.webhookMaxAgeMs ?? 60_000) + 1000 })).toEqual({ ok: false, reason: "stale" });
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
