import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { boardIdSchema, connectionIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { BoardProperties, MappingForm, NextTask } from "./boards-view";
import { groupStatuses, mappingProblems, mappingSavable, nextTaskLines, sameMapping } from "./board-words";
import type { BoardView, BoardsData, Mapping } from "./board-words";

// F-007, F-031: the boards page (project-boards.md): the drafted mapping, an edit, a status that
// disappeared, and the read-only view for members.

const now = Date.UTC(2026, 10, 19, 12);
const esc = (text: string): string => text.replaceAll("'", "&#x27;");

const status = (id: string, name: string, vendorType: string, category: "open" | "started" | "done" | "cancelled", position: number) => ({ id, name, vendorType, category, position });

const drafted: Mapping = { open: ["s-backlog", "s-todo"], started: "s-progress", inReview: "s-review", done: "s-done", doneBy: "ostra", magicWord: "Closes" };

const board: BoardView = {
  id: boardIdSchema.parse("01900000-0000-7000-8000-0000000000b1"),
  name: "Calculator",
  key: "CALC",
  externalId: "team-1",
  attachedAt: Date.UTC(2026, 10, 18),
  openTickets: 38,
  lastPolledAt: now - 40_000,
  lastEvent: { at: now - 120_000, type: "Issue", ticketKey: "CALC-161" },
  integration: "not_installed",
  mapping: drafted,
  statusGroups: [
    { category: "open", statuses: [status("s-triage", "Triage", "triage", "open", 0), status("s-backlog", "Backlog", "backlog", "open", 1), status("s-todo", "Todo", "unstarted", "open", 2)] },
    { category: "started", statuses: [status("s-progress", "In Progress", "started", "started", 3), status("s-review", "In Review", "started", "started", 4)] },
    { category: "done", statuses: [status("s-done", "Done", "completed", "done", 5)] },
    { category: "cancelled", statuses: [status("s-canceled", "Canceled", "canceled", "cancelled", 6), status("s-dup", "Duplicate", "duplicate", "cancelled", 7)] },
  ],
  statusesError: null,
  missingStatuses: [],
  startFromLinear: false,
};

const view: BoardsData = { connection: { connectionId: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c1"), workspaceName: "acme", mode: "webhooks", state: "active", pollSeconds: 60, agentMode: false }, canEdit: true, boards: [board] };

const form = (mapping: Mapping, canEdit = true) => renderToStaticMarkup(<MappingForm board={board} mapping={mapping} canEdit={canEdit} onChange={() => undefined} />);

describe("the drafted mapping", () => {
  it("F-031: groups every status by Linear's type, duplicate with canceled", () => {
    expect(groupStatuses(board).map((group) => group.type)).toEqual(["triage", "backlog", "unstarted", "started", "completed", "canceled"]);
    expect(groupStatuses(board).at(-1)?.statuses.map((item) => item.name)).toEqual(["Canceled", "Duplicate"]);
  });

  it("F-031: shows each step's status and the magic word's sample", () => {
    const html = form(drafted);
    expect(html).toContain("Backlog");
    expect(html).toContain("In Progress");
    expect(html).toContain("Closes CALC-142");
    expect(html).toContain(t("boards.mapping.notInstalled"));
  });

  it("says what the next task does, one sentence per step", () => {
    const html = renderToStaticMarkup(<NextTask board={board} mapping={drafted} />);
    expect(html).toContain("When the task starts, ostra moves it to <b");
    expect(html).toContain(">In Progress</b>");
    expect(html).toContain("When the last PR merges, ostra moves it to <b");
  });
});

describe("an edit", () => {
  const edited: Mapping = { ...drafted, inReview: "s-progress", doneBy: "integration", magicWord: "Refs" };

  it("is seen in the sentences before it's saved", () => {
    const lines = nextTaskLines(board, edited).map((line) => line.text);
    expect(lines[1]).toBe(t("boards.next.inReviewSame"));
    expect(lines[2]).toBe(t("boards.next.doneIntegration"));
    expect(form(edited)).toContain("Refs CALC-142");
  });

  it("makes the mapping savable only when it differs and holds", () => {
    expect(sameMapping(drafted, { ...drafted })).toBe(true);
    expect(sameMapping(drafted, edited)).toBe(false);
    expect(mappingSavable(board, edited)).toBe(true);
  });

  it("refuses an empty Open in words", () => {
    const empty: Mapping = { ...drafted, open: [] };
    expect(mappingSavable(board, empty)).toBe(false);
    expect(form(empty)).toContain(t("boards.mapping.openEmpty"));
  });
});

describe("a status that disappeared", () => {
  const gone: Mapping = { ...drafted, done: "s-shipped" };

  it("is struck through in red, with a hint to pick another, and blocks saving", () => {
    expect([...mappingProblems(board, gone).gone]).toEqual(["s-shipped"]);
    expect(mappingSavable(board, gone)).toBe(false);
    const html = form(gone);
    expect(html).toContain("line-through");
    expect(html).toContain(t("boards.mapping.gone"));
  });
});

describe("a member", () => {
  it("sees the mapping read-only: values, no pickers", () => {
    const html = form(drafted, false);
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain(esc(t("boards.mapping.remove", { name: "Backlog" })));
    expect(html).toContain("Backlog");
    expect(html).toContain('data-disabled=""');
  });
});

describe("the panel", () => {
  it("shows the board, the connection and the team's statuses with their steps", () => {
    const html = renderToStaticMarkup(<BoardProperties view={view} board={board} mapping={drafted} now={now} />);
    expect(html).toContain("CALC");
    expect(html).toContain("38 open");
    expect(html).toContain(t("boards.panel.webhooks"));
    expect(html).toContain("acme");
    expect(html).toContain(t("boards.panel.notInstalled"));
    expect(html).toContain("Statuses in CALC");
  });
});
