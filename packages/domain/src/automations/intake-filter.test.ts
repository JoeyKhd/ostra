import { randomUUID } from "node:crypto";

import { boardIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { intakeFilterSchema, matchesFilter, parseIntakeFilter } from "./intake-filter.ts";
import type { FilterTicket, IntakeFilter } from "./intake-filter.ts";

// An intake rule's filter (F-011, ADR 0056): every field, each with a match and a near miss.

const boardA = boardIdSchema.parse(randomUUID());
const boardB = boardIdSchema.parse(randomUUID());

const ticket: FilterTicket = {
  boardId: boardA,
  labels: ["Bug", "backend"],
  statusId: "status-todo",
  statusCategory: "open",
  assigneeId: "user-ana",
  trackerProjectId: "proj-payments",
  open: true,
};

const filter = (fields: Partial<Record<keyof IntakeFilter, unknown>>): IntakeFilter => intakeFilterSchema.parse(fields);

describe("an intake rule's filter", () => {
  it("F-011/c1: matches labels, any of or all of, case-folded, with a near miss for each", () => {
    expect(matchesFilter(ticket, filter({ labels: { mode: "any", names: ["bug", "frontend"] } }))).toBe(true);
    expect(matchesFilter(ticket, filter({ labels: { mode: "any", names: ["frontend", "docs"] } }))).toBe(false);
    expect(matchesFilter(ticket, filter({ labels: { mode: "all", names: ["BUG", " backend "] } }))).toBe(true);
    expect(matchesFilter(ticket, filter({ labels: { mode: "all", names: ["bug", "frontend"] } }))).toBe(false);
  });

  it("F-011/c1: a label exclusion keeps a ticket out, whatever else matches", () => {
    const included = filter({ labels: { mode: "any", names: ["bug"] } });
    expect(matchesFilter(ticket, included)).toBe(true);
    expect(matchesFilter(ticket, filter({ labels: { mode: "any", names: ["bug"] }, excludeLabels: ["Backend"] }))).toBe(false);
    // A near miss: an exclusion the ticket doesn't carry changes nothing.
    expect(matchesFilter(ticket, filter({ labels: { mode: "any", names: ["bug"] }, excludeLabels: ["wontfix"] }))).toBe(true);
    // An exclusion alone is a filter: every ticket but the excluded ones.
    expect(matchesFilter(ticket, filter({ excludeLabels: ["backend"] }))).toBe(false);
    expect(matchesFilter({ ...ticket, labels: ["docs"] }, filter({ excludeLabels: ["backend"] }))).toBe(true);
  });

  it("F-011/c1: matches a status by ID or by category, with a near miss for each", () => {
    expect(matchesFilter(ticket, filter({ status: { by: "id", ids: ["status-todo"] } }))).toBe(true);
    expect(matchesFilter(ticket, filter({ status: { by: "id", ids: ["status-doing"] } }))).toBe(false);
    expect(matchesFilter(ticket, filter({ status: { by: "category", categories: ["open", "started"] } }))).toBe(true);
    expect(matchesFilter(ticket, filter({ status: { by: "category", categories: ["started"] } }))).toBe(false);
    expect(matchesFilter({ ...ticket, statusId: null, statusCategory: null }, filter({ status: { by: "category", categories: ["open"] } }))).toBe(false);
  });

  it("F-011/c1: matches an assignee, nobody, or ostra's app, with a near miss for each", () => {
    expect(matchesFilter(ticket, filter({ assignees: [{ kind: "user", userId: "user-ana" }] }))).toBe(true);
    expect(matchesFilter(ticket, filter({ assignees: [{ kind: "user", userId: "user-bo" }] }))).toBe(false);
    expect(matchesFilter({ ...ticket, assigneeId: null }, filter({ assignees: [{ kind: "unassigned" }] }))).toBe(true);
    expect(matchesFilter(ticket, filter({ assignees: [{ kind: "unassigned" }] }))).toBe(false);
    const app = filter({ assignees: [{ kind: "app" }] });
    expect(matchesFilter({ ...ticket, assigneeId: "user-ostra" }, app, { appUserId: "user-ostra" })).toBe(true);
    expect(matchesFilter({ ...ticket, assigneeId: "user-ostra" }, app, { appUserId: null })).toBe(false);
    expect(matchesFilter(ticket, app, { appUserId: "user-ostra" })).toBe(false);
  });

  it("F-011/c1: matches a board and the tracker's own project, with a near miss for each", () => {
    expect(matchesFilter(ticket, filter({ boardIds: [boardA] }))).toBe(true);
    expect(matchesFilter(ticket, filter({ boardIds: [boardB] }))).toBe(false);
    expect(matchesFilter(ticket, filter({ trackerProjectIds: ["proj-payments"] }))).toBe(true);
    expect(matchesFilter(ticket, filter({ trackerProjectIds: ["proj-search"] }))).toBe(false);
    expect(matchesFilter({ ...ticket, trackerProjectId: null }, filter({ trackerProjectIds: ["proj-payments"] }))).toBe(false);
  });

  it("F-011/c1: needs every condition it names, and never matches a closed ticket", () => {
    const all = filter({ labels: { mode: "any", names: ["bug"] }, status: { by: "category", categories: ["open"] }, boardIds: [boardA] });
    expect(matchesFilter(ticket, all)).toBe(true);
    expect(matchesFilter({ ...ticket, boardId: boardB }, all)).toBe(false);
    expect(matchesFilter({ ...ticket, open: false }, all)).toBe(false);
  });

  it("refuses a filter with no condition, an unknown field and a bad assignee, as stored data", () => {
    expect(parseIntakeFilter({}).ok).toBe(false);
    expect(parseIntakeFilter({ labels: { mode: "any", names: ["bug"] }, repo: "x" }).ok).toBe(false);
    expect(parseIntakeFilter({ assignees: [{ kind: "everyone" }] }).ok).toBe(false);
    expect(parseIntakeFilter({ labels: { mode: "some", names: ["bug"] } }).ok).toBe(false);
    expect(parseIntakeFilter({ boardIds: [boardA] })).toEqual({ ok: true, filter: filter({ boardIds: [boardA] }) });
  });
});
