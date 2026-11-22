import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { boardIdSchema, connectionIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { BoardProperties, MappingForm, NextTask } from "./boards-view";
import { groupStatuses, mappingProblems, mappingSavable, nextTaskLines, promptTicketsState, sameMapping } from "./board-words";
import { PromptTickets } from "./prompt-tickets";
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
  ticketsForPromptTasks: false,
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

describe("Prompt tasks: make a ticket for every prompt task (prompt-tickets.md)", () => {
  const web: BoardView = { ...board, id: boardIdSchema.parse("01900000-0000-7000-8000-0000000000b2"), name: "Web platform", key: "WEB" };
  const taking = { ...board, ticketsForPromptTasks: true };
  const row = (data: BoardsData, { error = null, organizationAdmin = true }: { readonly error?: string | null; readonly organizationAdmin?: boolean } = {}) =>
    renderToStaticMarkup(<PromptTickets view={data} selected={data.boards[0]} onSet={() => undefined} pending={false} error={error} organizationAdmin={organizationAdmin} />);
  const connection = view.connection;
  if (connection === null) throw new Error("the fixture's view has a connection");

  it("F-097/c2: reads the setting's state from the boards: none, off, on, and paused while the connection isn't active", () => {
    expect(promptTicketsState({ ...view, boards: [] })).toEqual({ kind: "none" });
    expect(promptTicketsState({ ...view, boards: [board, web] })).toEqual({ kind: "off" });
    expect(promptTicketsState({ ...view, boards: [web, taking] })).toEqual({ kind: "on", board: taking });
    expect(promptTicketsState({ ...view, connection: { ...connection, state: "failed" }, boards: [taking] })).toEqual({ kind: "paused", board: taking });
  });

  it("F-097/c2: off by default: the switch is off, and the line says Create ticket still makes one", () => {
    const html = row({ ...view, boards: [board, web] });
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Off: a prompt task makes no ticket. A member can still use <b");
    expect(html).not.toContain(esc(t("boards.promptTickets.boardAria")));
  });

  it("F-097/c2: on with one board, the sentence names it and there's no picker; with several, the picker names it too", () => {
    const one = row({ ...view, boards: [taking] });
    expect(one).toContain('aria-checked="true"');
    expect(one).toContain(">Calculator</b> as it starts. Refine tasks make theirs from their draft.");
    expect(one).not.toContain('role="combobox"');
    const several = row({ ...view, boards: [taking, web] });
    expect(several).toContain('role="combobox"');
    expect(several).toContain(esc(t("boards.promptTickets.boardAria")));
    expect(several).toContain("· CALC");
  });

  it("F-097/c2: with no board attached the switch is off and disabled, and says to attach a team first", () => {
    const html = row({ ...view, boards: [] });
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("disabled");
    expect(html).toContain(t("boards.promptTickets.none"));
  });

  it("F-097/c2: paused while Linear's connection isn't active: on, the picker resting, Reconnect Linear for an organization admin only", () => {
    const paused: BoardsData = { ...view, connection: { ...connection, state: "failed" }, boards: [taking, web] };
    const html = row(paused);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(esc("On, but the Linear connection isn't active, so prompt tasks get no ticket on <b"));
    expect(html).toContain('href="/organization/linear"');
    expect(html).toMatch(/role="combobox"[^>]*disabled/);
    expect(row(paused, { organizationAdmin: false })).not.toContain('href="/organization/linear"');
  });

  it("F-097/c2: a member reads it: the switch disabled, the board as plain text", () => {
    const html = row({ ...view, canEdit: false, boards: [taking, web] });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("disabled");
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain('data-testid="prompt-tickets-board"');
  });

  it("F-097/c2: a failed save says the server's reason under the row, as an alert", () => {
    const html = row({ ...view, boards: [board, web] }, { error: "Only a project admin changes which prompt tasks get a ticket" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Only a project admin changes which prompt tasks get a ticket");
    expect(html).toContain('aria-checked="false"');
  });

  it("F-097/c2: the panel says which board gets their tickets", () => {
    expect(renderToStaticMarkup(<BoardProperties view={view} board={taking} mapping={drafted} now={now} />)).toContain(t("boards.promptTickets.panelHere"));
    expect(renderToStaticMarkup(<BoardProperties view={view} board={board} mapping={drafted} now={now} />)).not.toContain(t("boards.promptTickets.panelHere"));
  });
});
