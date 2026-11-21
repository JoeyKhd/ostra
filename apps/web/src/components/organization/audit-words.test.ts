import { describe, expect, it } from "vitest";

import { auditActions } from "@ostra/domain";

import messages from "../../../messages/en.json";
import { ACTOR_KIND_CHOICES, actionPrefix, actorChoices, actorFilterOf, dayLabel, entityHref, entityKindTitle, entityKindWord, entityLabelOf, flattenData, isAuditPeriod, periodRange } from "./audit-words";

// F-073 (ticket 34): the audit log's filters and words, without a browser.

const NOW = new Date(2026, 10, 19, 14, 7, 33).getTime();
const DAY = 24 * 60 * 60 * 1000;

describe("the audit log's filters", () => {
  it("F-073/c2: a period is a range of whole days in the viewer's zone, and custom days include the last", () => {
    const today = new Date(2026, 10, 19).getTime();
    expect(periodRange("today", NOW, { from: null, to: null })).toEqual({ from: today });
    expect(periodRange("7d", NOW, { from: null, to: null })).toEqual({ from: new Date(2026, 10, 13).getTime() });
    expect(periodRange("all", NOW, { from: null, to: null })).toEqual({});
    expect(periodRange("custom", NOW, { from: "2026-11-01", to: "2026-11-02" })).toEqual({ from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 10, 2).getTime() + DAY });
    expect(periodRange("custom", NOW, { from: "nope", to: null })).toEqual({});
    expect(isAuditPeriod("30d")).toBe(true);
    expect(isAuditPeriod("1y")).toBe(false);
  });

  it("F-073: an action's group is its prefix, which filters every action under it", () => {
    expect(actionPrefix("task.created")).toBe("task.");
    expect(actionPrefix("member.role-changed")).toBe("member.");
  });
});

describe("the audit log's words", () => {
  it("F-073: a day band reads Today, Yesterday, a weekday this year and the year before", () => {
    expect(dayLabel(NOW - 60_000, NOW)).toBe("Today");
    expect(dayLabel(NOW - DAY, NOW)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 10, 17).getTime(), NOW)).toBe("Tue 17 Nov");
    expect(dayLabel(new Date(2025, 10, 17).getTime(), NOW)).toBe("17 Nov 2025");
  });

  it("F-073: an entry's data is one line per leaf, nested keys dotted, and none for no data", () => {
    expect(flattenData({ role: "member", grants: [{ projectId: "p-1", role: "admin" }] })).toEqual([
      ["role", "member"],
      ["grants.0.projectId", "p-1"],
      ["grants.0.role", "admin"],
    ]);
    expect(flattenData(null)).toEqual([]);
    expect(flattenData({})).toEqual([]);
  });

  it("F-073: a task entry links to its task, and an entity with no page links nowhere", () => {
    expect(entityHref({ entity: "task", entityId: "t-1", taskId: "t-1" })).toBe("/tasks/t-1");
    expect(entityHref({ entity: "member", entityId: "m-1", taskId: null })).toBe("/organization/members");
    expect(entityHref({ entity: "budget", entityId: "b-1", taskId: null })).toBeNull();
  });
});

describe("what an entry's entity is called (audit-log.md, the Entity column)", () => {
  const id = "0196f1a0-5b2c-7d3e-8f40-123456789abc";

  it("F-073/c2: the label the API gives, mono for a ticket key and pool, runner and provider names, sans for people, notes, projects and a task's title", () => {
    expect(entityLabelOf({ entity: "task", entityId: id, entityLabel: "CALC-161" })).toEqual({ text: "CALC-161", full: "CALC-161", mono: true });
    expect(entityLabelOf({ entity: "task", entityId: id, entityLabel: "Fix the cart total" })).toEqual({ text: "Fix the cart total", full: "Fix the cart total", mono: false });
    expect(entityLabelOf({ entity: "member", entityId: id, entityLabel: "Sam Rivera" })).toMatchObject({ text: "Sam Rivera", mono: false });
    expect(entityLabelOf({ entity: "project", entityId: id, entityLabel: "calculator" })).toMatchObject({ text: "calculator", mono: false });
    expect(entityLabelOf({ entity: "memory-note", entityId: id, entityLabel: "Settings keys" })).toMatchObject({ text: "Settings keys", mono: false });
    for (const entity of ["runner-pool", "runner", "model-provider"]) {
      expect(entityLabelOf({ entity, entityId: id, entityLabel: "build-01" })).toMatchObject({ text: "build-01", mono: true });
    }
  });

  it("F-073: an entity with no label shows its ID, short and mono, with the whole ID in its title; an entry about nothing has none", () => {
    expect(entityLabelOf({ entity: "budget", entityId: id, entityLabel: id })).toEqual({ text: "0196f1a0…", full: id, mono: true });
    expect(entityLabelOf({ entity: "budget", entityId: id, entityLabel: null })).toEqual({ text: "0196f1a0…", full: id, mono: true });
    expect(entityLabelOf({ entity: null, entityId: null, entityLabel: null })).toBeNull();
  });

  it("F-073/c2: a kind is named by the target's word, and the panel's leads with a capital", () => {
    expect(["runner-pool", "model-provider", "memory-note", "agent-profile", "task", "member", "budget"].map(entityKindWord)).toEqual(["pool", "provider", "note", "profile", "task", "member", "budget"]);
    expect(entityKindTitle("task")).toBe("Task");
    expect(entityKindTitle("runner-pool")).toBe("Pool");
  });

  it("F-083/c1: every kind the log names is worded from the message file, never shown as stored", () => {
    const words: readonly string[] = Object.values(messages.audit.kind);
    for (const kind of [...new Set(Object.values(auditActions)), "email-settings"]) {
      expect(words, kind).toContain(entityKindWord(kind));
    }
    expect(["organization", "member", "library-source", "user"].map(entityKindWord)).toEqual(["organization", "member", "library source", "account"]);
  });

  it("F-073/c2: a pool, a provider, a profile and a note link to their pages, by the kinds the log stores", () => {
    expect(entityHref({ entity: "runner-pool", entityId: id, taskId: null })).toBe("/organization/runners");
    expect(entityHref({ entity: "model-provider", entityId: id, taskId: null })).toBe("/organization/models");
    expect(entityHref({ entity: "agent-profile", entityId: id, taskId: null })).toBe(`/organization/agent-profiles/${id}`);
    expect(entityHref({ entity: "memory-note", entityId: id, taskId: null })).toBe(`/organization/memory/${id}`);
  });
});

describe("the Actor filter (audit-log.md, Filters)", () => {
  it("F-073/c2: lists the members, removed ones last with (removed), then Runners and System", () => {
    const choices = actorChoices([{ memberId: "m-1", name: "Sam Rivera" }], [{ memberId: "m-2", name: "Rae Okafor" }]);
    expect(choices.map((choice) => [choice.value, choice.label, choice.muted ?? false])).toEqual([
      ["m-1", "Sam Rivera", false],
      ["m-2", "Rae Okafor (removed)", true],
      [ACTOR_KIND_CHOICES.runners, "Runners", false],
      [ACTOR_KIND_CHOICES.system, "System", false],
    ]);
  });

  it("F-073/c2: a member's choice filters by the member, Runners by every runner and System by the system", () => {
    expect(actorFilterOf(null)).toBeNull();
    expect(actorFilterOf("m-1")).toEqual({ actorId: "m-1" });
    expect(actorFilterOf(ACTOR_KIND_CHOICES.runners)).toEqual({ actorKind: "runner" });
    expect(actorFilterOf(ACTOR_KIND_CHOICES.system)).toEqual({ actorKind: "system" });
  });
});
