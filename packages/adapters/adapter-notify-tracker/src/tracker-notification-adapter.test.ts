import type { MomentNotification, NotificationRecipient, TicketContext, TrackerAdapter } from "@ostra/adapter-sdk";
import { LinearAdapter } from "@ostra/adapter-linear";
import {
  createFakeLinear,
  createJiraFakeSuiteSubject,
  defineNotificationContractSuite,
  fakeLinearSuiteFixture,
  memoryAdapterContext,
  memoryIdempotencyStore,
  sampleAccountMail,
  sampleNotification,
  suiteRecipient,
} from "@ostra/adapter-sdk/testing";
import type { DeliveredNotification, FakeLinear, NotificationSuiteFixture, TrackerSuiteFixture } from "@ostra/adapter-sdk/testing";
import { externalTicketIdSchema, ticketKeySchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { TrackerNotificationAdapter } from "./tracker-notification-adapter.ts";

// The ticket channel against the fake Linear server and the Jira fake (ticket 11, F-036): the
// notification contract suite on each, then what's the channel's own: one comment per key, an edit
// on `update`, mentions of the recipients that have one, and a comment that can't be made to say
// more than ostra means it to.

const linearOn = (fake: FakeLinear, token: string, kind: "api-key" | "oauth"): LinearAdapter =>
  new LinearAdapter({ auth: { kind, token }, apiUrl: fake.apiUrl, fileOrigins: [new URL(fake.apiUrl).origin] });

type Subject = {
  readonly tracker: TrackerAdapter;
  readonly suite: TrackerSuiteFixture;
  readonly dispose: () => Promise<void>;
};

const linearSubject = async (): Promise<Subject> => {
  const fake = await createFakeLinear();
  const other = await createFakeLinear();
  const app = fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example.test/oauth/linear/callback"], webhookUrl: null });
  const token = fake.mintToken("app");
  const appUser = fake.appUser();
  if (appUser === undefined) throw new Error("the fake made no app user");
  return {
    tracker: linearOn(fake, token.accessToken, "oauth"),
    suite: fakeLinearSuiteFixture({ fake, other: linearOn(other, other.adminApiKey, "api-key"), ownUserId: appUser.id, webhookSecret: app.webhookSecret }),
    dispose: async () => {
      await Promise.all([fake.close(), other.close()]);
    },
  };
};

const jiraSubject = (): Subject => {
  const { adapter, fixture } = createJiraFakeSuiteSubject();
  return { tracker: adapter, suite: fixture, dispose: () => Promise.resolve() };
};

/** The mentions the suite's recipients carry: the text to look for in a comment. */
const ada = suiteRecipient("ada", { email: false, mention: true });
const grace = suiteRecipient("grace", { email: false, mention: true });
const noMention = suiteRecipient("linus", { email: false, mention: false });

/** A ticket the fake holds, and what the notification's comments on it say. */
type Seeded = { readonly externalId: TicketContext["ticket"]["externalId"] };

const commentsOf = async (tracker: TrackerAdapter, suite: TrackerSuiteFixture, ticket: Seeded) => {
  const context = await tracker.getTicketContext(suite.board, { externalId: ticket.externalId });
  if (!context.ok) throw new Error(context.error.message);
  return context.value.comments;
};

/** What the suite needs of a channel: seed a ticket per notification, and read the comments back. */
const notificationFixture = (subject: Subject, logs: NotificationSuiteFixture["logs"]): NotificationSuiteFixture => {
  const seeded: Seeded[] = [];
  return {
    logs,
    reachable: ada,
    alsoReachable: grace,
    prepare: async (notification) => {
      const ticket = await subject.suite.seedTicket({ title: "Add CONTRIBUTING.md" });
      seeded.push(ticket);
      return { ...notification, ticket: { externalId: ticket.externalId } };
    },
    rateLimitNext: () => {
      void subject.suite.rateLimitNext(2);
    },
    delivered: async () => {
      const delivered: DeliveredNotification[] = [];
      for (const ticket of seeded) {
        for (const comment of await commentsOf(subject.tracker, subject.suite, ticket)) {
          delivered.push({
            providerMessageId: comment.id,
            to: [ada, grace].flatMap((recipient) => (recipient.trackerMention !== null && comment.body.includes(recipient.trackerMention) ? [recipient.trackerMention] : [])),
            subject: ticket.externalId,
            html: null,
            text: comment.body,
          });
        }
      }
      return delivered;
    },
  };
};

/** The tracker channel over a subject, with a recording logger the suite reads. */
const withLogs = (subject: Subject) => {
  const context = memoryAdapterContext();
  return {
    adapter: new TrackerNotificationAdapter({ tracker: subject.tracker, board: subject.suite.board }, context),
    fixture: notificationFixture(subject, () => context.logger.records),
  };
};

defineNotificationContractSuite({
  name: "tracker, on the fake Linear",
  create: async () => {
    const subject = await linearSubject();
    return {
      ...withLogs(subject),
      dispose: subject.dispose,
    };
  },
});

defineNotificationContractSuite({
  name: "tracker, on the Jira fake",
  create: () => {
    const subject = jiraSubject();
    return Promise.resolve({
      ...withLogs(subject),
      dispose: subject.dispose,
    });
  },
});

const trackers: readonly { readonly name: string; readonly make: () => Promise<Subject> }[] = [
  { name: "Linear", make: linearSubject },
  { name: "the Jira fake", make: () => Promise.resolve(jiraSubject()) },
];

describe.each(trackers)("the tracker notification adapter on $name", ({ make }) => {
  const setup = async () => {
    const subject = await make();
    const idempotency = memoryIdempotencyStore();
    const context = { ...memoryAdapterContext(), idempotency };
    const adapter = new TrackerNotificationAdapter({ tracker: subject.tracker, board: subject.suite.board }, context);
    const ticket = await subject.suite.seedTicket({ title: "Add CONTRIBUTING.md" });
    const comments = () => commentsOf(subject.tracker, subject.suite, ticket);
    const notify = (recipients: readonly NotificationRecipient[], extra: Partial<MomentNotification> = {}): MomentNotification => ({
      ...sampleNotification(recipients),
      ticket: { externalId: ticket.externalId },
      ...extra,
    });
    return { ...subject, context, idempotency, adapter, ticket, comments, notify };
  };

  it("F-036: posts one comment per key, however many times the send is retried", async () => {
    const { adapter, comments, notify, dispose } = await setup();
    const notification = notify([ada]);
    const first = await adapter.send(notification);
    const again = await adapter.send(notification);
    expect(first).toMatchObject({ ok: true, value: { refused: [] } });
    expect(again).toEqual(first);
    expect(await comments()).toHaveLength(1);
    // A new moment is a new key, and a new comment (the coalescing is core's call, through `update`).
    await adapter.send(notify([ada]));
    expect(await comments()).toHaveLength(2);
    await dispose();
  });

  it("F-036: the comment says the moment, quotes the task's title, mentions the recipients that have one and links the task", async () => {
    const { adapter, comments, notify, dispose } = await setup();
    const notification = notify([ada, noMention, grace]);
    await adapter.send(notification);
    const [comment] = await comments();
    expect(comment?.body).toContain(`${ada.trackerMention ?? "?"} ${grace.trackerMention ?? "?"}`);
    expect(comment?.body).toContain('**An approval needs you** on "Add CONTRIBUTING.md"');
    expect(comment?.body).toContain(`[Open the task](${notification.url})`);
    // Linus has no mention on this tracker: nobody is mentioned for him, and he isn't refused either.
    expect(comment?.body).not.toContain("linus");
    await dispose();
  });

  it("F-036: a recipient with no mention is still on the ticket's comment; nobody mentioned means no mention line", async () => {
    const { adapter, comments, notify, dispose } = await setup();
    const sent = await adapter.send(notify([noMention]));
    expect(sent).toMatchObject({ ok: true, value: { refused: [] } });
    const [comment] = await comments();
    expect(comment?.body.startsWith("**An approval needs you**")).toBe(true);
    await dispose();
  });

  it("F-036: update edits the comment in place: the same comment, a new moment's words, an answered state", async () => {
    const { adapter, comments, notify, dispose } = await setup();
    const sent = await adapter.send(notify([ada]));
    if (!sent.ok || sent.value.providerMessageId === null) throw new Error("the send failed");
    const id = sent.value.providerMessageId;
    const answered = notify([ada], { state: "answered", body: "Answered by Grace: approved once." });
    expect(await adapter.update(answered, id)).toEqual({ ok: true, value: undefined });
    const after = await comments();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(id);
    expect(after[0]?.body).toContain("**An approval needs you (answered)**");
    expect(after[0]?.body).toContain("Answered by Grace: approved once.");
    // A coalesced moment: a later notification rewrites the same comment.
    const later = notify([grace], { title: "A question for you", body: "The agent has a question." });
    expect(await adapter.update(later, id)).toEqual({ ok: true, value: undefined });
    expect((await comments())[0]?.body).toContain("**A question for you**");
    expect(await comments()).toHaveLength(1);
    await dispose();
  });

  it("F-036: finds the ticket by its key as well as by its stable ID", async () => {
    const { adapter, comments, notify, ticket, tracker, suite, dispose } = await setup();
    const found = await tracker.getTicket(suite.board, { externalId: ticket.externalId });
    if (!found.ok) throw new Error(found.error.message);
    expect((await adapter.send(notify([ada], { ticket: { key: ticketKeySchema.parse(found.value.key) } }))).ok).toBe(true);
    expect(await comments()).toHaveLength(1);
    await dispose();
  });

  it("F-036: a notification with no ticket, or a link that isn't a web address, is refused before any call", async () => {
    const { adapter, comments, notify, dispose } = await setup();
    expect(await adapter.send(notify([ada], { ticket: null }))).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.send(sampleNotification([ada]))).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.send(notify([ada], { url: "javascript:alert(1)" }))).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.update(notify([ada], { ticket: null }), "1")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await comments()).toHaveLength(0);
    await dispose();
  });

  it("F-036: a ticket the board doesn't have is not-found, and a failed send isn't recorded: the retry posts", async () => {
    const { adapter, comments, notify, ticket, dispose } = await setup();
    const gone = notify([ada], { ticket: { externalId: externalTicketIdSchema.parse(`${ticket.externalId}-gone`) } });
    expect(await adapter.send(gone)).toMatchObject({ ok: false, error: { code: "not-found" } });
    // The same key, now on the ticket that exists: the failure left no record behind.
    const retry = { ...gone, ticket: { externalId: ticket.externalId } };
    expect(await adapter.send(retry)).toMatchObject({ ok: true });
    expect(await comments()).toHaveLength(1);
    await dispose();
  });

  it("F-036: a send another attempt started and never finished isn't posted twice", async () => {
    const { adapter, comments, notify, idempotency, dispose } = await setup();
    const notification = notify([ada]);
    // What a crashed attempt leaves: the key claimed, no result.
    await idempotency.claim(`notify-tracker:${notification.organizationId}:${notification.idempotencyKey.replaceAll(":", "_")}`, 1);
    expect(await adapter.send(notification)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await comments()).toHaveLength(0);
    await dispose();
  });

  it("F-036: the comment can't be made to say more than ostra means: a hostile title stays inside its quotes as plain text", async () => {
    const { adapter, comments, notify, dispose } = await setup();
    const hostile = '"\n# Heading\n[click](https://evil.example/) @everyone `rm -rf /` <img src=x onerror=alert(1)> https://evil.example/x';
    await adapter.send(notify([ada], { subject: hostile }));
    const [comment] = await comments();
    const body = comment?.body ?? "";
    expect(body.split("\n").filter((line) => line.startsWith("#"))).toEqual([]);
    expect(body).not.toMatch(/(?<!\\)\[click\]/);
    expect(body).not.toMatch(/(?<!\\)</);
    expect(body).not.toMatch(/(?<!\\)@everyone/);
    expect(body).not.toContain("https://evil.example");
    expect(body).not.toMatch(/(?<!\\)`/);
    expect(body).toContain("Open the task");
    await dispose();
  });

  it("F-036: logs carry the kind and a count, never the title, the body or a mention", async () => {
    const { adapter, notify, context, dispose } = await setup();
    const notification = notify([ada], { subject: "Quiet secret subject" });
    await adapter.send(notification);
    const logged = JSON.stringify(context.logger.records);
    expect(logged).toContain("tracker_notification.posted");
    expect(logged).not.toContain("Quiet secret subject");
    expect(logged).not.toContain(notification.body);
    expect(logged).not.toContain(ada.trackerMention ?? "?");
    await dispose();
  });

  it("F-036: declares the ticket channel, edits where the tracker lets ostra edit its own comment, and reports the tracker's health", async () => {
    const { adapter, tracker, dispose } = await setup();
    expect(adapter.name).toBe("tracker");
    expect(adapter.capabilities).toEqual({ channels: ["tracker"], edits: tracker.capabilities.commentEdit });
    expect(await adapter.health()).toEqual(await tracker.health());
    await dispose();
  });
});

/** The same tracker, but one that doesn't let ostra edit its own comment (adapter parity: a declared gap). */
const withoutCommentEdit = (tracker: TrackerAdapter): TrackerAdapter =>
  new Proxy(tracker, {
    get: (target, property): unknown => {
      if (property === "capabilities") {
        return { ...target.capabilities, commentEdit: false };
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });

describe("the tracker notification adapter on a tracker that can't edit comments", () => {
  it("F-036: declares edits false, says unsupported on update and leaves the comment as it was", async () => {
    const subject = jiraSubject();
    const tracker = withoutCommentEdit(subject.tracker);
    const adapter = new TrackerNotificationAdapter({ tracker, board: subject.suite.board }, memoryAdapterContext());
    expect(adapter.capabilities).toEqual({ channels: ["tracker"], edits: false });
    const ticket = await subject.suite.seedTicket({ title: "Add CONTRIBUTING.md" });
    const notification = { ...sampleNotification([ada]), ticket: { externalId: ticket.externalId } };
    const sent = await adapter.send(notification);
    if (!sent.ok || sent.value.providerMessageId === null) throw new Error("the send failed");
    expect(await adapter.update({ ...notification, state: "answered" }, sent.value.providerMessageId)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const comments = await commentsOf(subject.tracker, subject.suite, ticket);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).not.toContain("(answered)");
  });
});

describe("the tracker notification adapter and account mails", () => {
  it("F-115: refuses an account mail as unsupported, and posts no comment with its link", async () => {
    const subject = jiraSubject();
    const adapter = new TrackerNotificationAdapter({ tracker: subject.tracker, board: subject.suite.board }, memoryAdapterContext());
    const ticket = await subject.suite.seedTicket({ title: "Add CONTRIBUTING.md" });
    const mail = sampleAccountMail("newcomer@example.com");
    expect(await adapter.send(mail)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await adapter.update(mail, "comment-1")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await commentsOf(subject.tracker, subject.suite, ticket)).toEqual([]);
  });
});
