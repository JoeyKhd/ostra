import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { boardIdSchema, connectionIdSchema, projectIdSchema, repoIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { InboxEmpty, InboxLede, TicketPanel, TicketRow } from "./inbox-view";
import type { StartFormProps } from "./inbox-view";
import { contextLine, filtered, filtersFrom, filtersToSearch, ledeSource, listInputOf } from "./inbox-words";
import type { InboxDetail, InboxSource, InboxTicket } from "./inbox-words";
import { SafeMarkdown, countImages } from "./safe-markdown";

// F-010, F-007: the Inbox (inbox.md): rows, filters in the URL, the existing task, start, and the
// empty states.

const now = Date.UTC(2026, 10, 19, 12);
const esc = (text: string): string => text.replaceAll("'", "&#x27;");
const projectId = projectIdSchema.parse("01900000-0000-7000-8000-000000000010");
const board = { id: boardIdSchema.parse("01900000-0000-7000-8000-0000000000b1"), name: "Calculator", key: "CALC", connection: null, paused: false };

const ticket: InboxTicket = {
  id: ticketIdSchema.parse("01900000-0000-7000-8000-0000000000d1"),
  key: "CALC-174",
  title: "Support keyboard input for operators",
  url: "https://linear.app/acme/issue/CALC-174",
  board,
  status: { id: "s-todo", name: "Todo", category: "open" },
  priority: 2,
  labels: ["feature", "ui", "a11y"],
  assignee: { id: "u1", name: "Sam Rivera" },
  updatedAt: now - 3 * 60_000,
  task: null,
  subIssues: 0,
  codeStart: { tasks: 1, overLimit: false },
};

const source: InboxSource = {
  boards: [{ ...board, lastPolledAt: now - 8000 }],
  connections: [{ id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c1"), kind: "linear", name: "Acme Linear", state: "active", mode: "webhooks" }],
  connected: true,
  pollSeconds: 60,
  cacheUpdatedAt: now - 8000,
  stale: false,
};

const detail: InboxDetail = { ...ticket, description: "Typing **+** should work. See [the spec](https://example.com/spec).\n\n![shot](https://x/y.png)", parentKey: "CALC-100", imageCount: 1, driver: null, source };

const start: StartFormProps = { detail, repos: [], profile: "OpenCode", runOn: "alex-mbp", onStart: () => undefined, starting: false, error: null };
const panel = (data: InboxDetail, form: Partial<StartFormProps> = {}) => renderToStaticMarkup(<TicketPanel detail={data} several={false} now={now} start={{ ...start, ...form }} />);

describe("the rows", () => {
  it("F-010: key, title, two labels and the rest counted, status and age", () => {
    const html = renderToStaticMarkup(<TicketRow ticket={ticket} several={false} selected onSelect={() => undefined} now={now} />);
    expect(html).toContain("CALC-174");
    expect(html).toContain(ticket.title);
    expect(html).toContain("feature");
    expect(html).toContain("+1");
    expect(html).toContain("Todo");
    expect(html).toContain(">3m<");
    expect(html).toContain('aria-pressed="true"');
  });

  it("shows the board only when the project has several", () => {
    expect(renderToStaticMarkup(<TicketRow ticket={ticket} several onSelect={() => undefined} selected={false} now={now} />)).toContain("Calculator");
  });

  it("links an active task by its state and short ID", () => {
    const withTask: InboxTicket = { ...ticket, task: { id: taskIdSchema.parse("01900000-0000-7000-8000-00000a17be09"), state: "running", active: true, shortId: "a17be093" } };
    const html = renderToStaticMarkup(<TicketRow ticket={withTask} several={false} selected={false} onSelect={() => undefined} now={now} />);
    expect(html).toContain("/tasks/01900000-0000-7000-8000-00000a17be09");
    expect(html).toContain("a17be093");
  });

  it("a parent's chip gives way before its title: a narrow title cell keeps the count, the words in its tooltip and its name", () => {
    const html = renderToStaticMarkup(<TicketRow ticket={{ ...ticket, subIssues: 4 }} several={false} selected={false} onSelect={() => undefined} now={now} />);
    expect(html).toContain('class="@container');
    expect(html).toContain('title="4 sub-issues"');
    expect(html).toMatch(/<span class="hidden @min-\[22rem\]:inline">4 sub-issues<\/span>/);
    expect(html).toMatch(/<span aria-hidden="true">4<\/span><span class="sr-only">4 sub-issues<\/span>/);
  });
});

describe("the filters", () => {
  it("live in the URL, the default status left out", () => {
    const filters = filtersFrom(new URLSearchParams("status=open,started&label=bug&priority=1,9&q=keys"));
    expect(filters).toEqual({ status: ["open", "started"], labels: ["bug"], priorities: [1], assignees: [], text: "keys" });
    expect(filtersToSearch(filters, new URLSearchParams("ticket=CALC-1"))).toBe("?ticket=CALC-1&status=open%2Cstarted&label=bug&priority=1&q=keys");
    expect(filtersToSearch(filtersFrom(new URLSearchParams("")), new URLSearchParams())).toBe("");
    expect(filtered(filtersFrom(new URLSearchParams("")))).toBe(false);
    expect(filtered(filters)).toBe(true);
  });

  it("become the list's input", () => {
    expect(listInputOf(projectId, filtersFrom(new URLSearchParams("label=bug")))).toEqual({ projectId, status: ["open"], limit: 50, labels: ["bug"] });
  });
});

describe("the lede", () => {
  it("names the board and the cache's age", () => {
    const html = renderToStaticMarkup(<InboxLede source={source} now={now} />);
    expect(html).toContain("Calculator");
    expect(html).toContain("updated 8s ago");
  });

  it("says when the tracker isn't answering, in red", () => {
    const html = renderToStaticMarkup(<InboxLede source={{ ...source, stale: true }} now={now} />);
    expect(html).toContain(esc("The tracker isn't answering"));
    expect(html).toContain("text-red");
  });
});

describe("the panel", () => {
  it("shows the ticket, its untrusted description and Start task", () => {
    const html = panel(detail);
    expect(html).toContain("CALC-174");
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("Sam Rivera");
    expect(html).toContain("1 image");
    expect(html).toContain(t("inbox.panel.startTask"));
    expect(html).toContain("1 image and the parent ticket");
  });

  it("an existing active task replaces Start task with Open task", () => {
    const active: InboxDetail = { ...detail, task: { id: taskIdSchema.parse("01900000-0000-7000-8000-00000a17be09"), state: "running", active: true, shortId: "a17be093" } };
    const html = panel(active);
    expect(html).toContain(t("inbox.panel.openTask"));
    expect(html).not.toContain(t("inbox.panel.startTask"));
  });

  it("an earlier finished task is named, and start still offered", () => {
    const earlier: InboxDetail = { ...detail, task: { id: taskIdSchema.parse("01900000-0000-7000-8000-000000000e01"), state: "stopped", active: false, shortId: "00000e01" } };
    const html = panel(earlier);
    expect(html).toContain("An earlier task");
    expect(html).toContain(t("inbox.panel.startTask"));
  });

  it("starting disables the button; a refusal is an alert", () => {
    expect(panel(detail, { starting: true })).toContain(t("inbox.panel.starting"));
    expect(panel(detail, { error: "This ticket already has an active task, x." })).toContain('role="alert"');
  });

  it("F-055: a signed-commit repo disables Start, with the reason", () => {
    const repo = {
      repoId: repoIdSchema.parse("01900000-0000-7000-8000-0000000000a1"),
      fullName: "acme/x",
      defaultBranch: "main",
      private: true,
      checkedAt: now,
      defaultBranchProtected: { result: true },
      signedCommitsRequired: { result: true },
      installation: null,
    } as const;
    const html = panel(detail, { repos: [repo] });
    expect(html).toContain("acme/x requires signed commits");
    expect(html).toContain('aria-describedby="inbox-repo-block"');
  });
});

describe("the empty states", () => {
  it("no boards yet: says so, and offers Attach a board to admins", () => {
    const html = renderToStaticMarkup(<InboxEmpty kind="no-boards" board={null} projectId={projectId} admin />);
    expect(html).toContain(t("inbox.empty.noBoards"));
    expect(html).toContain(`/projects/${projectId}/boards`);
    expect(renderToStaticMarkup(<InboxEmpty kind="no-boards" board={null} projectId={projectId} admin={false} />)).not.toContain(t("inbox.empty.attach"));
  });

  it("nothing open: names the board, with no button", () => {
    const html = renderToStaticMarkup(<InboxEmpty kind="nothing-open" board="Calculator" projectId={projectId} admin />);
    expect(html).toContain("Nothing open on Calculator");
    expect(html).not.toContain("<a ");
  });
});

describe("each ticket's tracker (ticket-chips.md, F-152/c4)", () => {
  const linearBoard = { ...board, connection: { id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c1"), kind: "linear" as const, name: "Acme Linear" } };
  const jiraBoard = { ...board, key: "PROJ", name: "Globex Calculator", connection: { id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c2"), kind: "jira" as const, name: "Globex Jira" } };
  const withBoard = (kind: "linear" | "jira", over: Partial<InboxTicket> = {}): InboxTicket => ({
    ...ticket,
    ...over,
    key: kind === "jira" ? "PROJ-12" : "CALC-170",
    board: kind === "jira" ? jiraBoard : linearBoard,
  });
  const rowOf = (data: InboxTicket): string => renderToStaticMarkup(<TicketRow ticket={data} several selected={false} onSelect={() => undefined} now={now} />);

  it("F-152/c4: a Linear and a Jira row each carry their mark in the key's colour, with the connection's tooltip", () => {
    const linearRow = rowOf(withBoard("linear"));
    expect(linearRow).toContain('data-tracker-mark="linear"');
    expect(linearRow).toContain('data-treatment="mono"');
    expect(linearRow).toContain('title="Linear · Acme Linear"');
    expect(linearRow).toContain('aria-label="Linear"');
    const jiraRow = rowOf(withBoard("jira"));
    expect(jiraRow).toContain('data-tracker-mark="jira"');
    expect(jiraRow).toContain('data-treatment="mono"');
    expect(jiraRow).toContain('title="Jira · Globex Jira"');
    expect(jiraRow).toContain('aria-label="Jira"');
  });

  it("F-152/c4: the chip counts a Jira parent's sub-tasks and a Linear one's sub-issues", () => {
    const jiraRow = rowOf(withBoard("jira", { subIssues: 2 }));
    expect(jiraRow).toContain("2 sub-tasks");
    expect(rowOf(withBoard("linear", { subIssues: 2 }))).toContain("2 sub-issues");
  });

  it("F-152/c4: the selected ticket's panel marks it and opens it in its tracker, with Jira's status square", () => {
    const jiraDetail: InboxDetail = { ...detail, ...withBoard("jira"), status: { id: "s-prog", name: "In Progress", category: "started" } };
    const html = renderToStaticMarkup(<TicketPanel detail={jiraDetail} several={false} now={now} start={{ ...start, detail: jiraDetail }} />);
    expect(html).toContain(t("inbox.panel.openIn", { tracker: "Jira" }));
    expect(html).toContain('data-tracker-mark="jira"');
    expect(html).toContain("jira-cat-started");
  });

  it("F-152/c4: the lede names the boards' tracker, or your trackers for both kinds", () => {
    // `{board}` stays for the lede's caller, which draws the name in `--text`.
    expect(ledeSource({ ...source, boards: [{ ...linearBoard, lastPolledAt: now }] })).toEqual({ board: "Calculator", text: "Open tickets from {board} on Linear" });
    expect(ledeSource({ ...source, boards: [{ ...jiraBoard, lastPolledAt: now }] })).toEqual({ board: "Globex Calculator", text: "Open tickets from {board} on Jira" });
    expect(ledeSource({ ...source, boards: [{ ...linearBoard, lastPolledAt: now }, { ...jiraBoard, lastPolledAt: now }] }).text).toBe("Open tickets from 2 boards on your trackers");
  });
});

describe("untrusted markdown", () => {
  it("renders no raw HTML and only safe links, in a new tab", () => {
    const html = renderToStaticMarkup(<SafeMarkdown markdown={'<script>alert(1)</script> [x](javascript:alert(1)) [y](https://a.b/c) `code`'} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://a.b/c" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("<code");
  });

  it("counts images instead of showing them", () => {
    expect(countImages("a ![b](c) d ![e](f)")).toBe(2);
    expect(renderToStaticMarkup(<SafeMarkdown markdown="![b](https://x/y.png)" />)).not.toContain("<img");
  });

  it("says what the agent gets", () => {
    expect(contextLine({ imageCount: 0, parentKey: null })).toBe("The agent gets the title, the description and the labels.");
  });
});
