import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { boardIdSchema, connectionIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { AttachedRows, BoardProperties, MappingForm, NextTask, PauseLines } from "./boards-view";
import { groupStatuses, mappingProblems, mappingSavable, nextTaskLines, promptTicketsState, sameMapping } from "./board-words";
import type { BoardView, BoardsData, Mapping, Workflow } from "./board-words";
import { JiraMapping } from "./jira-mapping";
import { PromptTickets } from "./prompt-tickets";

// F-007, F-031, F-152, F-008: the boards page (project-boards.md, boards-mixed.md): a Linear team's
// drafted mapping, a Jira project's transition lines, the attach rows' marks, a paused board, and
// the read-only view for members.

const now = Date.UTC(2026, 10, 19, 12);
const esc = (text: string): string => text.replaceAll("'", "&#x27;");

const status = (id: string, name: string, vendorType: string, category: "open" | "started" | "done" | "cancelled", position: number) => ({ id, name, vendorType, category, position });

const linearCaps = {
  agentSessions: true,
  subIssues: true,
  statusGraph: false,
  webhooks: true,
  commentEdit: true,
  attachments: true,
  transitions: false,
  mentions: true,
  agentScopes: [],
  agentSessionLink: false,
  ticketFields: { acceptanceCriteria: true },
  ticketFiles: "all" as const,
  magicWords: true,
  richText: "markdown" as const,
  jqlFilter: false,
};

const jiraCaps = { ...linearCaps, statusGraph: true, transitions: true, magicWords: false, agentSessions: false, richText: "adf" as const, jqlFilter: true };

const drafted: Mapping = { open: ["s-backlog", "s-todo"], started: "s-progress", inReview: "s-review", done: "s-done", doneBy: "ostra", magicWord: "Closes" };

const linearStatuses = [
  { category: "open" as const, statuses: [status("s-triage", "Triage", "triage", "open", 0), status("s-backlog", "Backlog", "backlog", "open", 1), status("s-todo", "Todo", "unstarted", "open", 2)] },
  { category: "started" as const, statuses: [status("s-progress", "In Progress", "started", "started", 3), status("s-review", "In Review", "started", "started", 4)] },
  { category: "done" as const, statuses: [status("s-done", "Done", "completed", "done", 5)] },
  { category: "cancelled" as const, statuses: [status("s-canceled", "Canceled", "canceled", "cancelled", 6), status("s-dup", "Duplicate", "duplicate", "cancelled", 7)] },
];

const linearConnection = { id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c1"), kind: "linear" as const, name: "Acme Linear", state: "active" as const, mode: "webhooks" as const, agentMode: false };

const board: BoardView = {
  id: boardIdSchema.parse("01900000-0000-7000-8000-0000000000b1"),
  name: "Calculator",
  key: "CALC",
  externalId: "team-1",
  connection: linearConnection,
  state: { state: "attached" },
  capabilities: linearCaps,
  attachedAt: Date.UTC(2026, 10, 18),
  openTickets: 38,
  lastPolledAt: now - 40_000,
  lastEvent: { at: now - 120_000, type: "Issue", ticketKey: "CALC-161" },
  integration: "not_installed",
  mapping: drafted,
  statusGroups: linearStatuses,
  statusesError: null,
  missingStatuses: [],
  startFromLinear: false,
  ticketsForPromptTasks: false,
};

const view: BoardsData = {
  connections: [{ id: linearConnection.id, kind: "linear", name: "Acme Linear", state: "active" }],
  pollSeconds: 60,
  canEdit: true,
  boards: [board],
};

const form = (mapping: Mapping, canEdit = true) => renderToStaticMarkup(<MappingForm board={board} mapping={mapping} canEdit={canEdit} onChange={() => undefined} />);

describe("a Linear team's drafted mapping", () => {
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

// ── A Jira project's mapping (boards-mixed.md, F-008/c5, F-008/c7) ──────────────────────────

const jiraStatuses = [
  { category: "open" as const, statuses: [status("j-backlog", "Backlog", "new", "open", 0), status("j-todo", "To Do", "new", "open", 1)] },
  { category: "started" as const, statuses: [status("j-progress", "In Progress", "indeterminate", "started", 2), status("j-review", "In Review", "indeterminate", "started", 3), status("j-blocked", "Blocked", "indeterminate", "started", 4)] },
  { category: "done" as const, statuses: [status("j-done", "Done", "done", "done", 5), status("j-wont", "Won't Do", "done", "done", 6)] },
];

const jiraBoard: BoardView = {
  ...board,
  id: boardIdSchema.parse("01900000-0000-7000-8000-0000000000b3"),
  name: "Globex Calculator",
  key: "PROJ",
  externalId: "10001",
  connection: { ...linearConnection, id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c2"), kind: "jira", name: "Globex Jira" },
  capabilities: jiraCaps,
  statusGroups: jiraStatuses,
  integration: "unknown",
  mapping: { ...drafted, open: ["j-backlog", "j-todo"], started: "j-progress", inReview: "j-review", done: "j-done" },
};

const workflow: Workflow = {
  readable: true,
  statuses: [
    { id: "j-backlog", name: "Backlog", category: "open" },
    { id: "j-todo", name: "To Do", category: "open" },
    { id: "j-progress", name: "In Progress", category: "started" },
    { id: "j-review", name: "In Review", category: "started" },
    { id: "j-blocked", name: "Blocked", category: "started" },
    { id: "j-done", name: "Done", category: "done" },
    { id: "j-wont", name: "Won't Do", category: "done" },
  ],
  transitions: [
    { id: "11", name: "Start progress", from: ["j-backlog", "j-todo"], to: "j-progress" },
    { id: "21", name: "Ready for review", from: ["j-progress"], to: "j-review" },
    { id: "41", name: "Done", from: ["j-review"], to: "j-done" },
    { id: "51", name: "Won't do", from: "any", to: "j-wont" },
  ],
  steps: [
    { step: "started", target: "j-progress", by: [{ transition: { id: "11", name: "Start progress" }, from: ["j-backlog", "j-todo"] }], unreachable: [] },
    { step: "inReview", target: "j-review", by: [{ transition: { id: "21", name: "Ready for review" }, from: ["j-progress"] }], unreachable: ["j-blocked"] },
    { step: "done", target: "j-done", by: [{ transition: { id: "41", name: "Done" }, from: ["j-review"] }], unreachable: ["j-wont"] },
  ],
  reach: [
    { statusId: "j-progress", reachedFrom: ["j-backlog", "j-todo"], unreachable: [], global: false },
    { statusId: "j-review", reachedFrom: ["j-progress"], unreachable: ["j-blocked"], global: false },
    { statusId: "j-done", reachedFrom: ["j-review"], unreachable: ["j-wont"], global: false },
  ],
};

const jiraForm = (mapping: Mapping, data: Workflow = workflow, canEdit = true) =>
  renderToStaticMarkup(
    <JiraMapping board={jiraBoard} mapping={mapping} onChange={() => undefined} canEdit={canEdit} workflow={data} workflowError={null} workflowUrl="https://globex.atlassian.net/secure/admin/workflows/ListWorkflows.jspa" />,
  );

describe("a Jira project's mapping", () => {
  it("F-008/c5: shows each step's transition line and the unreachable warning from the workflow, with Workflow in Jira", () => {
    const html = jiraForm(drafted);
    expect(html).toContain(t("boards.jira.by", { transition: "Start progress", statuses: "Backlog or To Do" }));
    expect(html).toContain(t("boards.jira.by", { transition: "Ready for review", statuses: "In Progress" }));
    expect(html).toContain(t("boards.jira.unreachable", { status: "In Review", from: "Blocked" }));
    expect(html).toContain(t("boards.jira.workflowLink"));
    expect(html).toContain('href="https://globex.atlassian.net/secure/admin/workflows/ListWorkflows.jspa"');
  });

  it("F-008/c5: without workflow access the lines and warnings are gone, and one line says why", () => {
    const html = jiraForm(drafted, { readable: false, statuses: workflow.statuses });
    expect(html).toContain(esc(t("boards.jira.notReadable", { key: "PROJ" })));
    expect(html).not.toContain(t("boards.jira.by", { transition: "Start progress", statuses: "Backlog or To Do" }));
    expect(html).not.toContain(t("boards.jira.unreachable", { status: "In Review", from: "Blocked" }));
  });

  it("F-008/c7: Done is moved by switches to Jira automation, and its line shows", () => {
    expect(jiraForm(drafted)).not.toContain(esc(t("boards.doneBy.jiraInfo", { key: "PROJ" })));
    const html = jiraForm({ ...drafted, doneBy: "integration" });
    expect(html).toContain(t("boards.doneBy.jira"));
    expect(html).toContain(esc(t("boards.doneBy.jiraInfo", { key: "PROJ" })));
    const lines = nextTaskLines(jiraBoard, { ...drafted, doneBy: "integration" }, workflow).map((line) => line.text);
    expect(lines[2]).toBe(t("boards.next.jiraDoneIntegration"));
  });

  it("F-008/c7: with ostra moving Done, the next task names the transition", () => {
    const lines = nextTaskLines(jiraBoard, jiraBoard.mapping ?? drafted, workflow);
    expect(lines[0]).toEqual({ text: t("boards.next.jiraStarted"), status: "In Progress", transition: "Start progress" });
    expect(lines[2]).toEqual({ text: t("boards.next.jiraDoneOstra"), status: "Done", transition: "Done" });
  });

  it("has no magic-word row: a Jira board links its PRs by the key", () => {
    expect(jiraForm(drafted)).not.toContain(t("boards.mapping.magicWord"));
  });

  it("F-152/c5: a paused board's mapping reads only", () => {
    const html = jiraForm(drafted, workflow, false);
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain("In Progress");
  });
});

describe("the attached rows (F-152/c4)", () => {
  const rows = (data: BoardsData) =>
    renderToStaticMarkup(<AttachedRows view={data} selectedId={undefined} onSelect={() => undefined} onDetach={() => undefined} detaching={false} now={now} />);

  it("F-152/c4: each row has its tracker's mark and its connection's name", () => {
    const html = rows({ ...view, boards: [board, jiraBoard] });
    expect(html).toContain('data-tracker-mark="linear"');
    expect(html).toContain('data-tracker-mark="jira"');
    expect(html).toContain(t("boards.via.line", { connection: "Acme Linear", word: "team" }));
    expect(html).toContain(t("boards.via.line", { connection: "Globex Jira", word: "project" }));
  });

  it("F-152/c5: a disconnected connection's board is paused, with its line and link", () => {
    const paused: BoardView = { ...jiraBoard, state: { state: "paused", pausedBy: "disconnected", since: Date.UTC(2026, 10, 20) } };
    const data: BoardsData = { ...view, boards: [paused] };
    const html = rows(data);
    expect(html).toContain(t("boards.state.paused"));
    expect(html).toContain('data-paused="true"');
    const lines = renderToStaticMarkup(<PauseLines view={data} />);
    expect(lines).toContain(esc(t("boards.state.pausedLine", { connection: "Globex Jira", date: "20 Nov 2026", key: "PROJ", kind: "Jira" })));
    expect(lines).toContain('href="/organization/trackers"');
    expect(lines).toContain(t("boards.state.trackers"));
  });

  it("F-152/c5: a failed connection's board says Connection failed and asks to reconnect", () => {
    const failed: BoardView = { ...jiraBoard, state: { state: "paused", pausedBy: "failed", since: Date.UTC(2026, 10, 20) } };
    const data: BoardsData = { ...view, boards: [failed] };
    expect(rows(data)).toContain(t("boards.state.failed"));
    const lines = renderToStaticMarkup(<PauseLines view={data} />);
    expect(lines).toContain(esc(t("boards.state.failedLine", { connection: "Globex Jira", date: "20 Nov 2026", key: "PROJ", kind: "Jira" })));
    expect(lines).toContain(t("boards.state.reconnect"));
  });
});

describe("the panel", () => {
  it("shows the board, its tracker and a Linear team's statuses with their steps", () => {
    const html = renderToStaticMarkup(<BoardProperties view={view} board={board} mapping={drafted} now={now} />);
    expect(html).toContain("CALC");
    expect(html).toContain("38 open");
    expect(html).toContain(t("boards.panel.webhooks"));
    expect(html).toContain(t("boards.panel.tracker"));
    expect(html).toContain("Acme Linear");
    expect(html).toContain("Statuses in CALC");
  });

  it("shows a Jira project's workflow and transitions", () => {
    const html = renderToStaticMarkup(<BoardProperties view={{ ...view, boards: [jiraBoard] }} board={jiraBoard} mapping={jiraBoard.mapping} now={now} workflow={workflow} />);
    expect(html).toContain(t("boards.panel.workflowFor", { key: "PROJ" }));
    expect(html).toContain(t("boards.panel.transitions"));
    expect(html).toContain("Ready for review");
    expect(html).toContain("any → Won&#x27;t Do");
  });
});

describe("Prompt tasks: make a ticket for every prompt task (prompt-tickets.md)", () => {
  const web: BoardView = { ...board, id: boardIdSchema.parse("01900000-0000-7000-8000-0000000000b2"), name: "Web platform", key: "WEB" };
  const taking = { ...board, ticketsForPromptTasks: true };
  const row = (data: BoardsData, { error = null, organizationAdmin = true }: { readonly error?: string | null; readonly organizationAdmin?: boolean } = {}) =>
    renderToStaticMarkup(<PromptTickets view={data} selected={data.boards[0]} onSet={() => undefined} pending={false} error={error} organizationAdmin={organizationAdmin} />);

  it("F-097/c2: reads the setting's state from the boards: none, off, on, and paused while the connection isn't active", () => {
    expect(promptTicketsState({ ...view, boards: [] })).toEqual({ kind: "none" });
    expect(promptTicketsState({ ...view, boards: [board, web] })).toEqual({ kind: "off" });
    expect(promptTicketsState({ ...view, boards: [web, taking] })).toEqual({ kind: "on", board: taking });
    expect(promptTicketsState({ ...view, boards: [{ ...taking, connection: { ...linearConnection, state: "failed" } }] })).toEqual({ kind: "paused", board: { ...taking, connection: { ...linearConnection, state: "failed" } } });
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

  it("F-097/c2: with no board attached the switch is off and disabled, and says to attach one first", () => {
    const html = row({ ...view, boards: [] });
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("disabled");
    expect(html).toContain(t("boards.promptTickets.none"));
  });

  it("F-097/c2: paused while the board's connection isn't active: on, the picker resting, Reconnect on Trackers for an admin only", () => {
    const paused: BoardsData = { ...view, boards: [{ ...taking, connection: { ...linearConnection, state: "failed" } }, web] };
    const html = row(paused);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(esc("On, but the board's tracker connection isn't active, so prompt tasks get no ticket on <b"));
    expect(html).toContain('href="/organization/trackers"');
    expect(html).toMatch(/role="combobox"[^>]*disabled/);
    expect(row(paused, { organizationAdmin: false })).not.toContain('href="/organization/trackers"');
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
