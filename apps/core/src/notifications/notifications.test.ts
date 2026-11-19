import { randomUUID } from "node:crypto";

import { createLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { LogRecord, TrackerAdapter } from "@ostra/adapter-sdk";
import { createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { JiraSite } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  createNeedsYouItemInTx,
  markNotificationRead,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  resolveNeedsYouItemsInTx,
} from "@ostra/domain";
import type { Clock } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { JobContext, Jobs } from "@ostra/jobs";
import { externalTicketIdSchema, memberIdSchema, notificationDeliveryIdSchema, notificationIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ConnectionId, NeedsYouItemId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { commentsOf, fanoutChangesOf, fixedEmailChannel, queuedDeliveries, testChannels } from "../testing/notify.ts";
import type { TestChannels } from "../testing/notify.ts";
import { mappingFor, seedBoard, seedTicketRow, seedTicketTask, seedTrackerConnection } from "../testing/tickets.ts";
import { createConnectionTrackers } from "../tracker/connections.ts";
import { createNotificationChannels } from "./channels.ts";
import { notifyDeliverHandler } from "./deliver.ts";
import type { EmailChannel, NotifyDeps } from "./deliver.ts";
import { notifyFanoutHandler } from "./fanout.ts";

// Ticket 20 (F-036, ADR 0050): a needs-you moment reaches its audience once per channel. Fan-out
// writes a notification per member and a delivery per wanted channel, then the queue's
// `notify.deliver` jobs send each through its adapter: the panel's, the ticket's (a Jira site here,
// one comment per moment, coalesced by editing the last), and mail's. The cases run against a real
// database, the real handlers and the real job queue, with the tracker on the Jira fake.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let connectionId: ConnectionId;
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});
const PUBLIC_URL = "https://ostra.example";
const taken = new Set<string>();
let now = Date.now();
const clock: Clock = { now: () => now };

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  // One Linear connection per organization: every bench's board hangs on it.
  connectionId = await seedTrackerConnection(test.db, secretStore, fixture.a.organization.id);
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

type Bench = {
  readonly site: JiraSite;
  readonly jira: JiraFakeAdapter;
  readonly channels: TestChannels;
  readonly email: EmailChannel & { readonly calls: () => number };
  readonly deps: NotifyDeps;
  /** Makes a task, with a ticket on the Jira board or none, and a driver or none. */
  readonly task: (options?: { readonly project?: "open" | "restricted"; readonly driver?: SeededMember | null; readonly ticket?: boolean }) => Promise<{ readonly taskId: TaskId; readonly projectId: ProjectId; readonly externalId: string | null }>;
};

const jobContext = <N extends "notify.fanout" | "notify.deliver">(job: N, payload: JobContext<N>["payload"], retryCount = 0): JobContext<N> => ({
  job,
  jobId: jobIdSchema.parse(randomUUID()),
  key: null,
  retryCount,
  payload,
  logger,
});

const bench = async (emailOutcome: Parameters<typeof fixedEmailChannel>[0] = { outcome: "sent", providerMessageId: "mail-1" }): Promise<Bench> => {
  const site = createJiraSite();
  const jira = new JiraFakeAdapter({ site });
  const organizationId = fixture.a.organization.id;
  const statuses = await jira.listStatuses({ externalId: site.projects[0]?.id ?? "" });
  if (!statuses.ok) throw new Error(statuses.error.message);
  const boards = new Map<ProjectId, Awaited<ReturnType<typeof seedBoard>>>();
  const board = async (projectId: ProjectId) => {
    const found = boards.get(projectId);
    if (found !== undefined) return found;
    const made = await seedBoard(test.db, { organizationId, projectId, connectionId, externalId: site.projects[0]?.id ?? "", mapping: mappingFor(statuses.value, "ostra") });
    boards.set(projectId, made);
    return made;
  };
  const channels = testChannels();
  const emailChannel = fixedEmailChannel(emailOutcome);
  const trackers = createConnectionTrackers({ db: test.db, secretStore, clock, logger, build: (): TrackerAdapter => jira });
  const deps: NotifyDeps = {
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    outbox: postgresCommandOutbox,
    audit: postgresAuditLog,
    clock,
    adapters: { codeHost: new FakeCodeHost(), modelProvider: new FakeModelProvider(), secretStore },
    logger,
    trackers,
    channels: channels.channels,
    email: emailChannel,
    publicUrl: PUBLIC_URL,
    emailDelaySeconds: 120,
    trackerCoalesceMinutes: 10,
    stallMinutes: 30,
  };
  return {
    site,
    jira,
    channels,
    email: emailChannel,
    deps,
    task: async (options = {}) => {
      const projectId = options.project === "restricted" ? fixture.a.restrictedProject.id : fixture.a.openProject.id;
      let ticketId = null;
      let externalId: string | null = null;
      let boardId = null;
      let ticketKey: string | null = null;
      if (options.ticket !== false) {
        const issue = site.createIssue(site.projects[0]?.id ?? "", { summary: "Login page is broken" });
        const ticket = await jira.getTicket({ externalId: site.projects[0]?.id ?? "" }, { externalId: issue.externalId });
        if (!ticket.ok) throw new Error(ticket.error.message);
        boardId = await board(projectId);
        ticketId = await seedTicketRow(test.db, { organizationId, projectId, boardId, connectionId, ticket: ticket.value });
        externalId = issue.externalId;
        ticketKey = issue.key;
      }
      const taskId = await seedTicketTask(test.db, { organizationId, projectId, boardId, ticketId, ticketKey });
      if (options.driver !== undefined) {
        await test.db.task.update({ where: { id: taskId }, data: { driverMemberId: options.driver?.id ?? null } });
      }
      return { taskId, projectId, externalId };
    },
  };
};

const emailOf = async (member: SeededMember): Promise<string> => (await test.db.user.findUniqueOrThrow({ where: { id: member.userId } })).email;

const newItem = (
  taskId: TaskId,
  projectId: ProjectId,
  reason: "approval" | "question" | "plan" | "crashed" | "draft_ready" | "files_outside_repos" = "approval",
  audience: "driver" | "project_members" = "project_members",
): Promise<NeedsYouItemId> =>
  test.db.$transaction((tx) => createNeedsYouItemInTx({ jobs }, tx, { organizationId: fixture.a.organization.id, projectId, taskId, reason, audience }));

const fanout = (itemId: NeedsYouItemId, change: "created" | "answered" | "dismissed", deps: NotifyDeps, organizationId: OrganizationId = fixture.a.organization.id) =>
  notifyFanoutHandler(deps)(jobContext("notify.fanout", { organizationId, needsYouItemId: itemId, notificationId: null, change }));

/** Runs the queued `notify.deliver` jobs as the queue would, each retried on a throw: returns how many ran. */
const deliverQueued = async (deps: NotifyDeps, retryCount = 0): Promise<number> => {
  const queued = await queuedDeliveries(test.db, taken);
  for (const job of queued) {
    await notifyDeliverHandler(deps)(jobContext("notify.deliver", { organizationId: job.organizationId, deliveryId: job.deliveryId }, retryCount)).catch(() => undefined);
  }
  return queued.length;
};

const deliveriesOf = (itemId: NeedsYouItemId) =>
  test.db.notificationDelivery.findMany({ where: { notification: { needsYouItemId: itemId } }, include: { notification: true }, orderBy: { id: "asc" } });

const notificationsOf = (itemId: NeedsYouItemId) => test.db.notification.findMany({ where: { needsYouItemId: itemId }, orderBy: { memberId: "asc" } });

describe("the helpers that write a needs-you item", () => {
  it("F-036: an item and its fan-out job commit together, and a rolled-back item leaves no job", async () => {
    const b = await bench();
    const { taskId, projectId } = await b.task({ driver: fixture.a.member });
    const rolledBack: { id: string | null } = { id: null };
    await test.db
      .$transaction(async (tx) => {
        const id = await createNeedsYouItemInTx({ jobs }, tx, { organizationId: fixture.a.organization.id, projectId, taskId, reason: "approval", audience: "driver" });
        rolledBack.id = id;
        throw new Error("the transaction fails after the item and its job were written");
      })
      .catch(() => undefined);
    expect(rolledBack.id).not.toBeNull();
    expect(await test.db.needsYouItem.count({ where: { id: rolledBack.id ?? "" } })).toBe(0);
    expect(await fanoutChangesOf(test.db, rolledBack.id ?? "")).toEqual([]);

    const kept = await newItem(taskId, projectId, "approval", "driver");
    expect(await fanoutChangesOf(test.db, kept)).toEqual(["created"]);
  });

  it("F-036: an answer or a dismissal owes one fan-out for each item it closes, and none for an item already closed", async () => {
    const b = await bench();
    const { taskId, projectId } = await b.task({ driver: fixture.a.member });
    const first = await newItem(taskId, projectId, "approval", "driver");
    const second = await newItem(taskId, projectId, "question", "driver");
    const closed = await test.db.$transaction((tx) =>
      resolveNeedsYouItemsInTx({ jobs }, tx, { taskId }, { state: "answered", at: new Date(now), byMemberId: fixture.a.member.id }),
    );
    expect([...closed].sort()).toEqual([first, second].sort());
    expect(await fanoutChangesOf(test.db, first)).toEqual(["created", "answered"]);
    expect(await fanoutChangesOf(test.db, second)).toEqual(["created", "answered"]);
    // Closing them again closes nothing and owes nothing.
    const again = await test.db.$transaction((tx) =>
      resolveNeedsYouItemsInTx({ jobs }, tx, { taskId }, { state: "dismissed", at: new Date(now), byMemberId: fixture.a.member.id }),
    );
    expect(again).toEqual([]);
    expect(await fanoutChangesOf(test.db, first)).toEqual(["created", "answered"]);
    expect(await test.db.needsYouItem.findUniqueOrThrow({ where: { id: first } })).toMatchObject({ state: "answered", resolvedByMemberId: fixture.a.member.id });
  });
});

describe("fan-out and delivery", () => {
  it("F-036: one item reaches every audience member once per channel, and a replayed job sends nothing twice", async () => {
    const b = await bench();
    const { taskId, projectId, externalId } = await b.task({ driver: null });
    // Two of the three members have a tracker user with their address; the admin has none.
    const memberEmail = await emailOf(fixture.a.member);
    const insiderEmail = await emailOf(fixture.a.insider);
    const memberUser = b.site.addUser(memberEmail);
    const insiderUser = b.site.addUser(insiderEmail);
    const lookup = vi.spyOn(b.jira, "findUsersByEmail");

    const itemId = await newItem(taskId, projectId, "approval", "project_members");
    await fanout(itemId, "created", b.deps);

    const everyone = [fixture.a.admin.id, fixture.a.member.id, fixture.a.insider.id].sort();
    expect((await notificationsOf(itemId)).map((row) => row.memberId).sort()).toEqual(everyone);
    const rows = await deliveriesOf(itemId);
    expect(rows).toHaveLength(9);
    for (const memberId of everyone) {
      expect(
        rows
          .filter((row) => row.notification.memberId === memberId)
          .map((row) => row.channel)
          .sort(),
      ).toEqual(["email", "panel", "tracker"]);
    }
    // Mail waits its delay; the others are due at once.
    expect(rows.filter((row) => row.channel === "email").every((row) => row.dueAt.getTime() - now >= 119_000)).toBe(true);

    // The queue holds one job per delivery, except the ticket's: one comment per moment, so one lead.
    const jobsRun = await deliverQueued(b.deps);
    expect(jobsRun).toBe(7);
    const sent = await deliveriesOf(itemId);
    expect(sent.every((row) => row.state === "sent")).toBe(true);
    expect(b.channels.panel.sent.map((notification) => (notification.category === "account" ? null : notification.recipients[0]?.memberId)).sort()).toEqual(everyone);
    expect(b.email.calls()).toBe(3);
    // One comment on the ticket, mentioning the two people the tracker knows, and one lookup for all three.
    const comments = commentsOf(b.site, externalIdOf(externalId));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`[~accountid:${memberUser}]`);
    expect(comments[0]).toContain(`[~accountid:${insiderUser}]`);
    expect(comments[0]?.match(/accountid/g)).toHaveLength(2);
    expect(lookup).toHaveBeenCalledTimes(1);

    // A replay of the fan-out writes nothing, and a replay of every delivery's job sends nothing.
    await fanout(itemId, "created", b.deps);
    expect(await deliveriesOf(itemId)).toHaveLength(9);
    for (const row of sent) {
      await notifyDeliverHandler(b.deps)(jobContext("notify.deliver", { organizationId: fixture.a.organization.id, deliveryId: notificationDeliveryIdSchema.parse(row.id) }));
    }
    expect(b.channels.panel.sent).toHaveLength(3);
    expect(b.email.calls()).toBe(3);
    expect(commentsOf(b.site, externalIdOf(externalId))).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("F-036: a member who can't open the project gets nothing", async () => {
    const b = await bench();
    // A restricted project: the admin and the listed insider can open it, the other member can't.
    const restricted = await b.task({ project: "restricted", driver: null });
    const item = await newItem(restricted.taskId, restricted.projectId, "approval", "project_members");
    await fanout(item, "created", b.deps);
    expect((await notificationsOf(item)).map((row) => row.memberId).sort()).toEqual([fixture.a.admin.id, fixture.a.insider.id].sort());

    // A driver who can't open it gets nothing, and nobody else is notified in their place.
    const driven = await b.task({ project: "restricted", driver: fixture.a.member });
    const own = await newItem(driven.taskId, driven.projectId, "question", "driver");
    await fanout(own, "created", b.deps);
    expect(await notificationsOf(own)).toEqual([]);
    expect(await deliveriesOf(own)).toEqual([]);
  });

  it("F-036: another organization's members never get a notification", async () => {
    const b = await bench();
    const { taskId, projectId } = await b.task({ driver: null });
    const itemId = await newItem(taskId, projectId);
    // A fan-out job carrying the other organization's ID finds nothing of ours.
    await fanout(itemId, "created", b.deps, fixture.b.organization.id);
    expect(await notificationsOf(itemId)).toEqual([]);
    await fanout(itemId, "created", b.deps);
    const notified = await notificationsOf(itemId);
    expect(notified.every((row) => row.organizationId === fixture.a.organization.id)).toBe(true);
    expect(notified.map((row) => row.memberId)).not.toContain(fixture.b.admin.id);
    expect(await test.db.notification.count({ where: { memberId: fixture.b.admin.id } })).toBe(0);
  });

  it("F-036: turning a channel off for a kind stops it for that member only", async () => {
    const b = await bench();
    const { taskId, projectId } = await b.task({ driver: null });
    for (const channel of ["tracker", "email"] as const) {
      await test.db.notificationPreference.create({
        data: { organizationId: fixture.a.organization.id, memberId: fixture.a.admin.id, kind: "question", channel, enabled: false },
      });
    }
    // The panel can't be turned off: a row saying so changes nothing.
    await test.db.notificationPreference.create({
      data: { organizationId: fixture.a.organization.id, memberId: fixture.a.admin.id, kind: "question", channel: "panel", enabled: false },
    });
    const itemId = await newItem(taskId, projectId, "question", "project_members");
    await fanout(itemId, "created", b.deps);
    const rows = await deliveriesOf(itemId);
    const channelsOf = (memberId: string) =>
      rows
        .filter((row) => row.notification.memberId === memberId)
        .map((row) => row.channel)
        .sort();
    expect(channelsOf(fixture.a.admin.id)).toEqual(["panel"]);
    expect(channelsOf(fixture.a.member.id)).toEqual(["email", "panel", "tracker"]);
    expect(channelsOf(fixture.a.insider.id)).toEqual(["email", "panel", "tracker"]);
    // Another moment's choices are untouched: an approval still mails the admin.
    const other = await newItem(taskId, projectId, "approval", "project_members");
    await fanout(other, "created", b.deps);
    expect((await deliveriesOf(other)).filter((row) => row.notification.memberId === fixture.a.admin.id).map((row) => row.channel).sort()).toEqual(["email", "panel", "tracker"]);
  });

  it("F-036: the ticket's comment is edited within the coalescing window and posted after it", async () => {
    const b = await bench();
    const { taskId, projectId, externalId } = await b.task({ driver: fixture.a.member });
    const issue = externalIdOf(externalId);
    const start = now;

    const first = await newItem(taskId, projectId, "approval", "driver");
    await fanout(first, "created", b.deps);
    await deliverQueued(b.deps);
    expect(commentsOf(b.site, issue)).toHaveLength(1);
    expect(commentsOf(b.site, issue)[0]).toContain("An approval is waiting");

    // A minute later, a second moment on the task edits that comment: still one.
    now = start + 60_000;
    const second = await newItem(taskId, projectId, "question", "driver");
    await fanout(second, "created", b.deps);
    await deliverQueued(b.deps);
    expect(commentsOf(b.site, issue)).toHaveLength(1);
    expect(commentsOf(b.site, issue)[0]).toContain("A question for you");
    const shared = (await deliveriesOf(first)).find((row) => row.channel === "tracker")?.providerMessageId;
    expect((await deliveriesOf(second)).find((row) => row.channel === "tracker")?.providerMessageId).toBe(shared);

    // Past the window, counted from when the comment was posted (not from the edit into it), a third posts anew.
    now = start + 11 * 60_000;
    const third = await newItem(taskId, projectId, "plan", "driver");
    await fanout(third, "created", b.deps);
    await deliverQueued(b.deps);
    const comments = commentsOf(b.site, issue);
    expect(comments).toHaveLength(2);
    expect(comments[1]).toContain("A plan to approve");

    // Answering the third edits its own comment to say who answered, and doesn't post a fourth.
    await test.db.$transaction((tx) =>
      resolveNeedsYouItemsInTx({ jobs }, tx, { id: third }, { state: "answered", at: new Date(now), byMemberId: fixture.a.member.id }),
    );
    await fanout(third, "answered", b.deps);
    expect((await notificationsOf(third)).every((row) => row.state === "answered")).toBe(true);
    await deliverQueued(b.deps);
    const after = commentsOf(b.site, issue);
    expect(after).toHaveLength(2);
    expect(after[1]).toMatch(/answered by member-a/);
    // The panel's row followed it too, with no comment edited for a moment that never had one.
    expect(b.channels.panel.sent.filter((notification) => notification.kind === "plan")).toHaveLength(1);
  });

  it("F-036: a failing tracker leaves the panel and email delivered, and is retried then failed in words", async () => {
    const b = await bench();
    const { taskId, projectId } = await b.task({ driver: fixture.a.member });
    const notifier = trackerNotifier(b);
    const itemId = await newItem(taskId, projectId, "approval", "driver");
    await fanout(itemId, "created", b.deps);
    notifier.failWith = { code: "unavailable", message: "the tracker is down" };

    await deliverQueued(b.deps, 0);
    let rows = await deliveriesOf(itemId);
    const byChannel = (channel: string) => rows.find((row) => row.channel === channel);
    expect(byChannel("panel")?.state).toBe("sent");
    expect(byChannel("email")?.state).toBe("sent");
    // The first failure waits for the queue's retry: pending, with the words of why and no secret in them.
    expect(byChannel("tracker")?.state).toBe("pending");
    expect(byChannel("tracker")?.error).toContain("unavailable");
    expect(byChannel("tracker")?.attempts).toBe(1);

    // The queue's retry finds the tracker back: sent.
    notifier.failWith = null;
    const retried = byChannel("tracker");
    if (retried === undefined) throw new Error("no tracker delivery");
    await notifyDeliverHandler(b.deps)(jobContext("notify.deliver", { organizationId: fixture.a.organization.id, deliveryId: notificationDeliveryIdSchema.parse(retried.id) }, 1));
    rows = await deliveriesOf(itemId);
    expect(byChannel("tracker")?.state).toBe("sent");
    expect(byChannel("tracker")?.attempts).toBe(2);
  });

  it("F-036: a tracker that keeps failing ends as a failed delivery with its error in words, and nothing else changes", async () => {
    const b = await bench();
    const { taskId, projectId } = await b.task({ driver: fixture.a.member });
    const itemId = await newItem(taskId, projectId, "approval", "driver");
    await fanout(itemId, "created", b.deps);
    await deliverQueued(b.deps);
    const sentTracker = (await deliveriesOf(itemId)).find((row) => row.channel === "tracker");
    expect(sentTracker?.state).toBe("sent");

    const second = await newItem(taskId, projectId, "question", "driver");
    // Past the window so a new comment is tried, and the tracker refuses for good.
    now += 30 * 60_000;
    const notifier = trackerNotifier(b);
    notifier.failWith = { code: "forbidden", message: "the app may not comment on this ticket" };
    await fanout(second, "created", b.deps);
    await deliverQueued(b.deps);
    const rows = await deliveriesOf(second);
    const tracker = rows.find((row) => row.channel === "tracker");
    expect(tracker?.state).toBe("failed");
    expect(tracker?.error).toBe("forbidden: the app may not comment on this ticket");
    expect(rows.find((row) => row.channel === "panel")?.state).toBe("sent");
    expect(rows.find((row) => row.channel === "email")?.state).toBe("sent");
  });

  it("F-036: a tracker that stays down is failed once the queue's retries are used up, with its error in words", async () => {
    const b = await bench();
    const { taskId, projectId } = await b.task({ driver: fixture.a.member });
    const notifier = trackerNotifier(b);
    notifier.failWith = { code: "unavailable", message: "the tracker is down" };
    const itemId = await newItem(taskId, projectId, "approval", "driver");
    await fanout(itemId, "created", b.deps);
    // The queue's last attempt: `notify.deliver` retries 8 times (packages/jobs).
    await deliverQueued(b.deps, 8);
    const rows = await deliveriesOf(itemId);
    expect(rows.find((row) => row.channel === "tracker")).toMatchObject({ state: "failed", error: "unavailable: the tracker is down", attempts: 1 });
    expect(rows.find((row) => row.channel === "panel")?.state).toBe("sent");
  });

  it("F-036: a moment answered before its ticket comment goes out posts none, and one answered while it's posted is edited at once", async () => {
    const b = await bench();
    const { taskId, projectId, externalId } = await b.task({ driver: fixture.a.member });
    const issue = externalIdOf(externalId);

    // Answered before the comment is posted: its delivery is skipped as closed.
    const early = await newItem(taskId, projectId, "question", "driver");
    await fanout(early, "created", b.deps);
    await test.db.$transaction((tx) => resolveNeedsYouItemsInTx({ jobs }, tx, { id: early }, { state: "answered", at: new Date(now), byMemberId: fixture.a.member.id }));
    await fanout(early, "answered", b.deps);
    await deliverQueued(b.deps);
    expect(commentsOf(b.site, issue)).toHaveLength(0);
    expect((await deliveriesOf(early)).find((row) => row.channel === "tracker")).toMatchObject({ state: "skipped", error: "The item was no longer open." });

    // Answered while the comment is being posted: the answer's own fan-out found no comment to edit,
    // so the delivery runs the closing fan-out again once it has one.
    now += 60 * 60_000;
    const racing = await newItem(taskId, projectId, "approval", "driver");
    await fanout(racing, "created", b.deps);
    const notifier = trackerNotifier(b);
    notifier.afterPost = async () => {
      await test.db.$transaction((tx) => resolveNeedsYouItemsInTx({ jobs }, tx, { id: racing }, { state: "answered", at: new Date(now), byMemberId: fixture.a.member.id }));
      await fanout(racing, "answered", b.deps);
    };
    await deliverQueued(b.deps);
    notifier.afterPost = null;
    await deliverQueued(b.deps);
    expect(commentsOf(b.site, issue)).toHaveLength(1);
    expect(commentsOf(b.site, issue)[0]).toMatch(/answered by member-a/);
  });

  it("F-036: a task with no ticket gets no ticket comment, and a reason with no moment notifies nobody", async () => {
    const b = await bench();
    const plain = await b.task({ driver: fixture.a.member, ticket: false });
    const item = await newItem(plain.taskId, plain.projectId, "crashed", "driver");
    await fanout(item, "created", b.deps);
    expect((await deliveriesOf(item)).map((row) => row.channel).sort()).toEqual(["email", "panel"]);

    const files = await newItem(plain.taskId, plain.projectId, "files_outside_repos", "driver");
    await fanout(files, "created", b.deps);
    expect(await notificationsOf(files)).toEqual([]);

    // A draft PR ready for review is the `pr_ready` moment, and goes to the driver.
    const ready = await newItem(plain.taskId, plain.projectId, "draft_ready", "project_members");
    await fanout(ready, "created", b.deps);
    const notified = await notificationsOf(ready);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ memberId: fixture.a.member.id, kind: "pr_ready" });
  });

  it("F-036: a notification change tells the live stream, for the member, and reading marks only the member's own", async () => {
    const b = await bench();
    const { taskId, projectId } = await b.task({ driver: fixture.a.member });
    const before = await test.db.changeNotice.count({ where: { organizationId: fixture.a.organization.id, entity: "member", entityId: fixture.a.member.id } });
    const itemId = await newItem(taskId, projectId, "approval", "driver");
    await fanout(itemId, "created", b.deps);
    expect(await test.db.changeNotice.count({ where: { organizationId: fixture.a.organization.id, entity: "member", entityId: fixture.a.member.id } })).toBe(before + 1);

    const [notification] = await notificationsOf(itemId);
    if (notification === undefined) throw new Error("no notification");
    const id = notificationIdSchema.parse(notification.id);
    // Someone else can't mark it read.
    const foreign = await markNotificationRead(b.deps, { organizationId: fixture.a.organization.id, memberId: memberIdSchema.parse(fixture.a.insider.id) }, { notificationIds: [id] });
    expect(foreign.marked).toBe(0);
    expect((await notificationsOf(itemId))[0]?.readAt).toBeNull();
    const own = await markNotificationRead(b.deps, { organizationId: organizationIdSchema.parse(fixture.a.organization.id), memberId: memberIdSchema.parse(fixture.a.member.id) }, { notificationIds: [id] });
    expect(own.marked).toBe(1);
    expect((await notificationsOf(itemId))[0]?.readAt).not.toBeNull();
    // The change reached the stream for the reader too.
    expect(await test.db.changeNotice.count({ where: { organizationId: fixture.a.organization.id, entity: "member", entityId: fixture.a.member.id } })).toBe(before + 2);
    // An answer closes the notification, which tells the stream again so the sidebar's count drops.
    await test.db.$transaction((tx) => resolveNeedsYouItemsInTx({ jobs }, tx, { id: itemId }, { state: "answered", at: new Date(now), byMemberId: fixture.a.member.id }));
    await fanout(itemId, "answered", b.deps);
    expect(await test.db.changeNotice.count({ where: { organizationId: fixture.a.organization.id, entity: "member", entityId: fixture.a.member.id } })).toBe(before + 3);
  });

  it("F-036: through the real panel and ticket adapters, a moment lands in the panel and on the ticket, and an answer closes both", async () => {
    const b = await bench();
    // The real adapters of tickets 11 and 20: the panel on the Notification table, the ticket on the Jira fake.
    const deps: NotifyDeps = { ...b.deps, channels: createNotificationChannels(test.db, { logger, clock: adapterClock }) };
    const { taskId, projectId, externalId } = await b.task({ driver: fixture.a.member });
    const issue = externalIdOf(externalId);
    const mention = b.site.addUser(await emailOf(fixture.a.member));

    const itemId = await newItem(taskId, projectId, "question", "driver");
    await fanout(itemId, "created", deps);
    await deliverQueued(deps);
    const rows = await deliveriesOf(itemId);
    expect(rows.map((row) => [row.channel, row.adapter, row.state]).sort()).toEqual([
      ["email", "email", "sent"],
      ["panel", "panel", "sent"],
      ["tracker", "tracker", "sent"],
    ]);
    // The panel row is the member's open notification, and its delivery names it.
    const [row] = await notificationsOf(itemId);
    expect(row).toMatchObject({ memberId: fixture.a.member.id, state: "open", kind: "question" });
    expect(rows.find((delivery) => delivery.channel === "panel")?.providerMessageId).toBe(row?.id);
    // One comment on the ticket, from the tracker adapter: the moment, a mention and the task's link.
    const [comment] = commentsOf(b.site, issue);
    expect(commentsOf(b.site, issue)).toHaveLength(1);
    expect(comment).toContain("A question for you");
    expect(comment).toContain(`[~accountid:${mention}]`);
    expect(comment).toContain(PUBLIC_URL);

    // The member answers: the panel row closes, and the same comment is edited to say so.
    await test.db.$transaction((tx) =>
      resolveNeedsYouItemsInTx({ jobs }, tx, { id: itemId }, { state: "answered", at: new Date(now), byMemberId: fixture.a.member.id }),
    );
    await fanout(itemId, "answered", deps);
    await deliverQueued(deps);
    expect((await notificationsOf(itemId))[0]?.state).toBe("answered");
    const after = commentsOf(b.site, issue);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/answered by member-a/);
  });

  it("F-036: nothing in the logs carries a comment, an address or a title", () => {
    const lines = JSON.stringify(records);
    expect(lines).not.toContain("Login page is broken");
    expect(lines).not.toContain("@example.com");
    expect(lines).not.toContain("accountid");
  });
});

const externalIdOf = (value: string | null) => {
  if (value === null) throw new Error("the task has no ticket");
  return externalTicketIdSchema.parse(value);
};

/** The tracker notifier the deliveries of this bench use: built on first ask, as the handler builds it. */
const trackerNotifier = (b: Bench) => {
  const built = b.channels.channels.tracker({ organizationId: fixture.a.organization.id, tracker: b.jira, board: { externalId: b.site.projects[0]?.id ?? "" } });
  const found = b.channels.trackerNotifiers.find((candidate) => candidate === built);
  if (found === undefined) throw new Error("no tracker notifier built");
  return found;
};
