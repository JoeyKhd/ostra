import { describe, expect, it } from "vitest";

import { actionPrefix, dayLabel, entityHref, flattenData, isAuditPeriod, periodRange } from "./audit-words";

// F-073 (ticket 34): the audit log's filters and words, without a browser.

const NOW = new Date(2026, 10, 19, 14, 7, 33).getTime();
const DAY = 24 * 60 * 60 * 1000;

describe("the audit log's filters", () => {
  it("F-073: a period is a range of whole days in the viewer's zone, and custom days include the last", () => {
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
