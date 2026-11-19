import type { NotificationRecipient } from "@ostra/adapter-sdk";
import { defineNotificationContractSuite, memoryAdapterContext, sampleAccountMail, sampleNotification, suiteRecipient } from "@ostra/adapter-sdk/testing";
import { notificationIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { NotificationId } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { PanelNotificationAdapter } from "./panel-adapter.ts";
import { createMemoryPanelRows } from "./panel-rows.ts";

// The panel channel against its in-memory rows (ticket 11, F-036): the notification contract suite,
// then what is the panel's own: a row is delivered once, an answer moves its state, one member's
// row is never another's, and nothing leaks across organizations or into the logs.

const organizationId = organizationIdSchema.parse("org-notification-suite");
const otherOrganizationId = organizationIdSchema.parse("org-someone-else");

let rowCount = 0;
const nextRowId = (): NotificationId => {
  rowCount += 1;
  return notificationIdSchema.parse(`notification-${String(rowCount)}`);
};

defineNotificationContractSuite({
  name: "panel, on in-memory rows",
  create: () => {
    const rows = createMemoryPanelRows();
    const context = memoryAdapterContext();
    const adapter = new PanelNotificationAdapter({ rows }, context);
    const reachable = suiteRecipient("ada", { email: false, mention: false });
    const alsoReachable = suiteRecipient("grace", { email: false, mention: false });
    return Promise.resolve({
      adapter,
      fixture: {
        reachable,
        alsoReachable,
        logs: () => context.logger.records,
        // A panel row belongs to one member, so each notification gets a fresh row for the first recipient.
        prepare: (notification) => {
          const notificationId = nextRowId();
          rows.add({ organizationId, notificationId, memberId: reachable.memberId });
          return { ...notification, notificationId };
        },
        delivered: () =>
          Promise.resolve(
            rows
              .all()
              .filter((row) => row.deliveredAt !== null)
              .map((row) => ({
                providerMessageId: row.notificationId,
                to: [row.memberId],
                subject: row.notificationId,
                html: null,
                text: row.line,
              })),
          ),
      },
    });
  },
});

const setup = () => {
  const rows = createMemoryPanelRows();
  const context = memoryAdapterContext();
  const adapter = new PanelNotificationAdapter({ rows }, context);
  const ada = suiteRecipient("ada", { email: false, mention: false });
  const grace = suiteRecipient("grace", { email: false, mention: false });
  const row = (memberId = ada.memberId, id = nextRowId(), org = organizationId): NotificationId => {
    rows.add({ organizationId: org, notificationId: id, memberId });
    return id;
  };
  const notification = (recipients: readonly NotificationRecipient[], id: NotificationId | null) => ({
    ...sampleNotification(recipients),
    notificationId: id,
  });
  return { rows, context, adapter, ada, grace, row, notification };
};

describe("the panel notification adapter", () => {
  it("F-115: refuses an account mail as unsupported, and delivers no row", async () => {
    const { adapter, rows, row } = setup();
    const id = row();
    const mail = sampleAccountMail("newcomer@example.com");
    expect(await adapter.send(mail)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await adapter.update(mail, id)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(rows.get({ organizationId, notificationId: id })?.deliveredAt).toBeNull();
  });

  it("F-036: declares the panel channel, which edits, and is healthy", async () => {
    const { adapter } = setup();
    expect(adapter.name).toBe("panel");
    expect(adapter.capabilities).toEqual({ channels: ["panel"], edits: true });
    expect(await adapter.health()).toEqual({ status: "ok" });
  });

  it("F-036: delivers the row once, stamped with the adapter's clock, and answers its ID", async () => {
    const { adapter, rows, context, ada, row, notification } = setup();
    const id = row();
    context.clock.advance(5000);
    const at = context.clock.now();
    const sent = await adapter.send(notification([ada], id));
    expect(sent).toEqual({ ok: true, value: { providerMessageId: id, refused: [] } });
    expect(rows.get({ organizationId, notificationId: id })?.deliveredAt).toBe(at);
    context.clock.advance(5000);
    await adapter.send(notification([ada], id));
    // A second delivery keeps the first time: the member's "unread since" doesn't move.
    expect(rows.get({ organizationId, notificationId: id })?.deliveredAt).toBe(at);
  });

  it("F-036: refuses a recipient the row isn't for, and still delivers the member's own", async () => {
    const { adapter, rows, ada, grace, row, notification } = setup();
    const id = row(ada.memberId);
    const sent = await adapter.send(notification([ada, grace], id));
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.value.refused).toEqual([{ memberId: grace.memberId, reason: "the notification belongs to another member" }]);
    expect(rows.get({ organizationId, notificationId: id })?.deliveredAt).not.toBeNull();
  });

  it("F-036: a notification with no row is invalid, a row that's gone is not-found, and another organization's row is never found", async () => {
    const { adapter, ada, row, notification } = setup();
    expect(await adapter.send(notification([ada], null))).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.send(notification([ada], nextRowId()))).toMatchObject({ ok: false, error: { code: "not-found" } });
    const foreign = row(ada.memberId, nextRowId(), otherOrganizationId);
    expect(await adapter.send(notification([ada], foreign))).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await adapter.update(notification([ada], foreign), foreign)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("F-036: an answer moves the row's state and its line in place; a dismissal too", async () => {
    const { adapter, rows, ada, row, notification } = setup();
    const id = row();
    await adapter.send(notification([ada], id));
    const answered = { ...notification([ada], id), state: "answered" as const, body: "Answered by Grace: approved once." };
    expect(await adapter.update(answered, id)).toEqual({ ok: true, value: undefined });
    expect(rows.get({ organizationId, notificationId: id })).toMatchObject({ state: "answered", line: "Answered by Grace: approved once.", updates: 1 });
    expect(rows.all().length).toBe(1);
    expect(await adapter.update({ ...answered, state: "dismissed" }, id)).toEqual({ ok: true, value: undefined });
    expect(rows.get({ organizationId, notificationId: id })?.state).toBe("dismissed");
    // No state means the moment is open again.
    expect(await adapter.update(notification([ada], id), id)).toEqual({ ok: true, value: undefined });
    expect(rows.get({ organizationId, notificationId: id })?.state).toBe("open");
  });

  it("F-036: an update for a different row than the ID names is refused, and writes nothing", async () => {
    const { adapter, rows, ada, row, notification } = setup();
    const one = row();
    const two = row();
    expect(await adapter.update({ ...notification([ada], two), state: "answered" }, one)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.update(notification([ada], one), "not a row id!")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(rows.all().every((candidate) => candidate.updates === 0)).toBe(true);
  });

  it("F-036: a database that fails is unavailable, and the log names IDs, never the notification's words", async () => {
    const { adapter, rows, context, ada, row, notification } = setup();
    const id = row();
    const sent = notification([ada], id);
    rows.failNext();
    expect(await adapter.send(sent)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    rows.failNext();
    expect(await adapter.update({ ...sent, state: "answered" }, id)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await adapter.send(sent)).toMatchObject({ ok: true });
    const logged = JSON.stringify(context.logger.records);
    expect(logged).toContain(id);
    expect(logged).not.toContain(sent.body);
    expect(logged).not.toContain(sent.subject);
    expect(logged).not.toContain(String(ada.memberId));
  });
});
