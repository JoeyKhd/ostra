import type { ExternalTicketId, TicketKey } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { AdapterResult } from "../common/result.ts";
import { ticketStatusCategories } from "../tracker/base.ts";
import type { BoardRef, StatusMapping, Ticket, TrackerAdapter } from "../tracker/base.ts";
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

export const defineTrackerContractSuite = (options: ContractSuiteOptions<TrackerAdapter, TrackerSuiteFixture>): void => {
  describe(`tracker contract: ${options.name}`, () => {
    const subject = useSubject(options);
    defineMentionCases(subject);
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
