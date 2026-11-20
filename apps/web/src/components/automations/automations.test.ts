import { boardIdSchema, bulkStartIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { applyPreset, conditionsOf, filterOf, newDraft, presetOf, sameDraft, settingsOf } from "./automation-draft";
import { bulkReasonText, filterWords, labelsNoRunnerCarries, noNames, occurrenceText } from "./automation-words";
import type { FilterNames, HistoryRun } from "./automation-words";
import { bandsOf, shownRuns } from "./history-bands";

// Ticket 31 (F-011, F-106): the automations screens' words and the editor's draft, pure.

const boardOne = boardIdSchema.parse("019a0000-0000-7000-8000-000000000001");
const press = bulkStartIdSchema.parse("019a0000-0000-7000-8000-000000000002");

const names: FilterNames = {
  statuses: new Map([["s-todo", "Todo"], ["s-triage", "Triage"]]),
  assignees: new Map([["u-1", "Sam Lee"]]),
  boards: new Map([[boardOne, "Calculator"], ["b-2", "Billing"]]),
  boardCount: 1,
};

const filter = (over: Partial<Parameters<typeof filterWords>[0]> = {}): Parameters<typeof filterWords>[0] => ({
  labels: null,
  excludeLabels: [],
  status: null,
  assignees: [],
  boardIds: [],
  trackerProjectIds: [],
  ...over,
});

describe("the filter in words (automations.md)", () => {
  it("F-011: says each clause in its fixed order, as the list, the editor and the history show it", () => {
    expect(filterWords(filter({ labels: { mode: "any", names: ["bug"] }, status: { by: "id", ids: ["s-todo"] }, assignees: [{ kind: "unassigned" }] }), names)).toBe("label bug, status Todo, unassigned");
    expect(filterWords(filter({ labels: { mode: "any", names: ["bug", "crash"] } }), names)).toBe("label bug or crash, any status");
    expect(filterWords(filter({ labels: { mode: "all", names: ["bug", "ui"] } }), names)).toBe("labels bug and ui, any status");
    expect(filterWords(filter({ excludeLabels: ["wontfix"], status: { by: "category", categories: ["started"] } }), names)).toBe("not label wontfix, status category Started");
    expect(filterWords(filter({ assignees: [{ kind: "app" }, { kind: "user", userId: "u-1" }], status: { by: "id", ids: ["s-todo"] } }), names)).toBe("status Todo, assigned to ostra or assigned to Sam Lee");
    expect(filterWords(filter(), names)).toBe("every open ticket");
  });

  it("F-011: names the board only when the project has more than one", () => {
    const boardFilter = filter({ boardIds: [boardOne], status: { by: "id", ids: ["s-todo"] } });
    expect(filterWords(boardFilter, names)).toBe("status Todo");
    expect(filterWords(boardFilter, { ...names, boardCount: 2 })).toBe("status Todo, board Calculator");
    expect(filterWords(filter({ status: { by: "id", ids: ["gone"] } }), noNames)).toBe("status a removed status");
  });
});

describe("the editor's draft (automation-edit.md)", () => {
  it("F-106: a preset writes its cron, and a day preset keeps the time in the field", () => {
    expect(presetOf("0 9 * * 1")).toBe("monday");
    expect(presetOf("0  9 * *   1-5")).toBe("weekdays");
    expect(presetOf("*/30 * * * *")).toBe("custom");
    expect(applyPreset("weekdays", "0 7 * * 1")).toBe("0 7 * * 1-5");
    expect(applyPreset("daily", "*/5 * * * *")).toBe("0 9 * * *");
    expect(applyPreset("hourly", "0 7 * * 1")).toBe("0 * * * *");
  });

  it("F-011: the condition rows become the filter the API takes, and back", () => {
    const rows = conditionsOf(filter({ labels: { mode: "any", names: ["bug"] }, excludeLabels: ["wontfix"], status: { by: "id", ids: ["s-todo"] }, assignees: [{ kind: "unassigned" }, { kind: "user", userId: "u-1" }] }));
    expect(rows.map((row) => row.field)).toEqual(["labels", "labels", "status", "assignee"]);
    expect(filterOf(rows)).toEqual({
      labels: { mode: "any", names: ["bug"] },
      excludeLabels: ["wontfix"],
      status: { by: "id", ids: ["s-todo"] },
      assignees: [{ kind: "unassigned" }, { kind: "user", userId: "u-1" }],
      boardIds: [],
      trackerProjectIds: [],
    });
    // Rows without a value name no condition: a filter needs one at least.
    expect(filterOf(conditionsOf(null))).toBeNull();
  });

  it("F-011, F-106: a rule saves its filter and never a repo; a prompt schedule saves its prompt; an incomplete form saves nothing", () => {
    const rule = { ...newDraft("match", true), name: "Triage bugs", conditions: conditionsOf(filter({ labels: { mode: "any", names: ["bug"] } })) };
    const saved = settingsOf(rule);
    expect(saved.ok && saved.settings).toMatchObject({ kind: "intake_rule", name: "Triage bugs", taskKind: "code", agentProfileId: null, poolLabels: [], requireApproval: false, filter: { labels: { mode: "any", names: ["bug"] } } });
    expect(JSON.stringify(saved)).not.toContain("repo");
    expect(settingsOf({ ...rule, name: " " }).ok).toBe(false);
    const prompt = { ...newDraft("schedule", false), name: "Deps", title: "Update", prompt: "Update the dependencies" };
    expect(prompt.does).toBe("prompt");
    const schedule = settingsOf(prompt);
    expect(schedule.ok && schedule.settings).toMatchObject({ kind: "schedule", schedule: "0 9 * * 1", skipWhileOpen: true, does: { kind: "prompt", title: "Update", prompt: "Update the dependencies" } });
    expect(settingsOf({ ...prompt, prompt: "" }).ok).toBe(false);
    expect(sameDraft(rule, { ...rule, conditions: conditionsOf(filter({ labels: { mode: "any", names: ["bug"] } })) })).toBe(true);
    expect(sameDraft(rule, { ...rule, name: "Other" })).toBe(false);
  });
});

const run = (over: Partial<HistoryRun>): HistoryRun => ({
  id: "r",
  kind: "ticket_match",
  state: "started",
  skipReason: null,
  occurrenceAt: null,
  at: 0,
  ticket: null,
  task: null,
  bulkStartId: null,
  ...over,
});

describe("the editor's pool labels (automation-edit.md)", () => {
  it("F-011: names each label of the draft no runner of the project's pools carries, a new one too, and none before the runners are known", () => {
    expect(labelsNoRunnerCarries(["tier:gpu", "zone:eu"], ["executor:docker", "tier:gpu"])).toEqual(["zone:eu"]);
    expect(labelsNoRunnerCarries(["tier:gpu"], ["executor:docker", "tier:gpu"])).toEqual([]);
    expect(labelsNoRunnerCarries(["zone:eu"], undefined)).toEqual([]);
  });
});

describe("the history's bands (automation-history.md)", () => {
  it("F-106: a schedule's matches go under their occurrence, a press's under the press, newest first", () => {
    const runs = [
      run({ id: "o1", kind: "occurrence", occurrenceAt: 1000, at: 1000 }),
      run({ id: "m1", at: 1001 }),
      run({ id: "m2", at: 1002 }),
      run({ id: "o2", kind: "occurrence", state: "missed", occurrenceAt: 2000, at: 9000 }),
      run({ id: "p", kind: "start_all", at: 9500, bulkStartId: press }),
      run({ id: "m3", at: 9600, bulkStartId: press }),
    ];
    const bands = bandsOf([...runs].reverse(), () => "day");
    expect(bands.map((band) => band.key)).toEqual(["p", "o2", "o1"]);
    expect(bands[0]?.rows.map((row) => row.id)).toEqual(["m3"]);
    expect(bands[2]?.rows.map((row) => row.id)).toEqual(["m2", "m1"]);
  });

  it("F-011: only the rows the history draws are selectable, so the default is the newest row shown, never a press's own run", () => {
    const runs = [
      run({ id: "m1", at: 1 }),
      run({ id: "p", kind: "start_all", state: "started", at: 9500, bulkStartId: press }),
      run({ id: "m3", at: 9600, bulkStartId: press }),
      run({ id: "m4", at: 9700, bulkStartId: press }),
    ];
    const shown = shownRuns(bandsOf([...runs].reverse(), () => "day"));
    expect(shown.map((row) => row.id)).toEqual(["m4", "m3", "m1"]);
    // A skipped occurrence with nothing under it is a row of its own.
    const lone = shownRuns(bandsOf([run({ id: "o", kind: "occurrence", state: "skipped", occurrenceAt: 5, at: 5 })], () => "day"));
    expect(lone.map((row) => row.id)).toEqual(["o"]);
  });

  it("F-011: a rule's own matches band by day", () => {
    const bands = bandsOf([run({ id: "a", at: 3 }), run({ id: "b", at: 2 }), run({ id: "c", at: 1 })], (at) => (at > 1 ? "today" : "yesterday"));
    expect(bands.map((band) => (band.kind === "day" ? [band.day, band.rows.map((row) => row.id)] : null))).toEqual([
      ["today", ["a", "b"]],
      ["yesterday", ["c"]],
    ]);
  });

  it("F-106: an occurrence is said in its zone, and a bulk reason in words", () => {
    expect(occurrenceText(Date.UTC(2026, 10, 23, 8, 0), "Europe/Amsterdam")).toBe("Mon 23 Nov, 09:00");
    expect(occurrenceText(Date.UTC(2026, 10, 23, 8, 0), "UTC")).toBe("Mon 23 Nov, 08:00");
    expect(bulkReasonText("has-task")).toBe("it already has a task");
    expect(bulkReasonText("something-new")).toBe("it couldn't start (something-new)");
  });
});
