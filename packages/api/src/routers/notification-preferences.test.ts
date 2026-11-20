import { choosableNotificationKinds, defaultChoice } from "@ostra/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedLinearConnection } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-036, F-115, ticket 37: a member's own choices of which moments reach them where. Defaults show
// for a moment they never changed, the panel can't be turned off, and nobody else's choices move.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

const choiceOf = (view: Awaited<ReturnType<Awaited<ReturnType<ApiHarness["as"]>>["notifications"]["preferences"]["get"]>>, kind: string, channel: string) =>
  view.choices.find((choice) => choice.kind === kind && choice.channel === channel);

describe("notifications.preferences", () => {
  it("F-036: shows every moment on every channel with its default, before the member changed anything", async () => {
    const view = await (await harness.as(harness.fixture.a.member)).notifications.preferences.get();
    expect(view.choices).toHaveLength(choosableNotificationKinds.length * 3);
    expect(view.choices.some((choice) => choice.kind === "test")).toBe(false);
    for (const choice of view.choices) {
      expect(choice.saved).toBe(false);
      expect(choice.enabled).toBe(choice.channel === "panel" ? true : defaultChoice(choice.kind, choice.channel));
    }
    // Email is on by default for the moments ADR 0050 names, off for the others.
    expect(choiceOf(view, "approval", "email")).toMatchObject({ enabled: true, default: true });
    expect(choiceOf(view, "stalled", "email")).toMatchObject({ enabled: false, default: false });
    expect(choiceOf(view, "stalled", "tracker")).toMatchObject({ enabled: true });
    expect(choiceOf(view, "approval", "panel")).toMatchObject({ enabled: true, locked: true });
    expect(view).toMatchObject({ emailOn: false, tracker: null, emailDelaySeconds: 120, lastSavedAt: null, isInstanceAdmin: false });
  });

  it("F-036/c2: a member's choices save and read back, with defaults for the rest", async () => {
    const member = await harness.as(harness.fixture.a.member);
    const saved = await member.notifications.preferences.save({
      choices: [
        { kind: "approval", channel: "email", enabled: false },
        { kind: "stalled", channel: "email", enabled: true },
        { kind: "plan", channel: "tracker", enabled: false },
      ],
    });
    expect(saved).toEqual({ saved: 3 });
    const view = await member.notifications.preferences.get();
    expect(choiceOf(view, "approval", "email")).toMatchObject({ enabled: false, saved: true, default: true });
    expect(choiceOf(view, "stalled", "email")).toMatchObject({ enabled: true, saved: true, default: false });
    expect(choiceOf(view, "plan", "tracker")).toMatchObject({ enabled: false, saved: true });
    // Untouched moments still show their defaults.
    expect(choiceOf(view, "question", "email")).toMatchObject({ enabled: true, saved: false });
    expect(view.lastSavedAt).toBeGreaterThan(0);

    // A later save changes the choice in place: one row per moment and channel.
    await member.notifications.preferences.save({ choices: [{ kind: "approval", channel: "email", enabled: true }] });
    expect(choiceOf(await member.notifications.preferences.get(), "approval", "email")).toMatchObject({ enabled: true, saved: true });
    expect(await harness.test.db.notificationPreference.count({ where: { memberId: harness.fixture.a.member.id, kind: "approval", channel: "email" } })).toBe(1);
  });

  it("F-036/c2: the panel can't be turned off, and a refused save changes nothing", async () => {
    const member = await harness.as(harness.fixture.a.insider);
    await expect(
      member.notifications.preferences.save({
        choices: [
          { kind: "approval", channel: "email", enabled: false },
          { kind: "approval", channel: "panel", enabled: false },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await harness.test.db.notificationPreference.count({ where: { memberId: harness.fixture.a.insider.id } })).toBe(0);
    // The panel set on is accepted and stores nothing: it is on whatever is stored.
    await member.notifications.preferences.save({ choices: [{ kind: "approval", channel: "panel", enabled: true }] });
    expect(await harness.test.db.notificationPreference.count({ where: { memberId: harness.fixture.a.insider.id } })).toBe(0);
    // The test mail is not a moment a member chooses.
    // @ts-expect-error the test mail is not a kind a member chooses: the input schema refuses it
    await expect(member.notifications.preferences.save({ choices: [{ kind: "test", channel: "email", enabled: true }] })).rejects.toThrow();
  });

  it("F-036: another member's choices, in either organization, are untouched", async () => {
    const { a, b } = harness.fixture;
    await (await harness.as(a.admin)).notifications.preferences.save({ choices: [{ kind: "crashed", channel: "email", enabled: false }] });
    await (await harness.as(b.admin)).notifications.preferences.save({ choices: [{ kind: "crashed", channel: "email", enabled: true }] });
    expect(choiceOf(await (await harness.as(a.admin)).notifications.preferences.get(), "crashed", "email")).toMatchObject({ enabled: false, saved: true });
    expect(choiceOf(await (await harness.as(b.admin)).notifications.preferences.get(), "crashed", "email")).toMatchObject({ enabled: true, saved: true });
    expect(choiceOf(await (await harness.as(a.member)).notifications.preferences.get(), "crashed", "email")).toMatchObject({ saved: false });
    expect(await harness.test.db.notificationPreference.count({ where: { organizationId: b.organization.id } })).toBe(1);
    await expect(harness.anonymous().notifications.preferences.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("F-115/c1: shows whether mail is on for the install, the connected tracker and the mail's delay", async () => {
    const { a } = harness.fixture;
    await harness.test.db.user.update({ where: { id: a.admin.userId }, data: { role: "admin" } });
    const admin = await harness.as(a.admin);
    expect(await admin.notifications.preferences.get()).toMatchObject({ emailOn: false, tracker: null, isInstanceAdmin: true });

    await admin.email.settings.save({ provider: "smtp", fromAddress: "ostra@example.com", fromName: "ostra", host: "relay.local", port: 25, secure: "none", user: null, password: null });
    await seedLinearConnection(harness);
    await harness.test.db.instanceSetting.upsert({ where: { id: "instance" }, create: { id: "instance", emailDelaySeconds: 300 }, update: { emailDelaySeconds: 300 } });
    const view = await (await harness.as(a.member)).notifications.preferences.get();
    expect(view).toMatchObject({ emailOn: true, tracker: { kind: "linear", name: "Linear", workspace: "ostra-test" }, emailDelaySeconds: 300, isInstanceAdmin: false });
    // The other organization has no tracker, but shares the install's mail.
    expect(await (await harness.as(harness.fixture.b.admin)).notifications.preferences.get()).toMatchObject({ emailOn: true, tracker: null });
  });
});
