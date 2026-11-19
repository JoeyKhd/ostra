import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { boardIdSchema, connectionIdSchema, projectIdSchema, repoIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { InboxEmpty, InboxLede, TicketPanel, TicketRow } from "./inbox-view";
import type { StartFormProps } from "./inbox-view";
import { contextLine, filtered, filtersFrom, filtersToSearch, listInputOf } from "./inbox-words";
import type { InboxDetail, InboxSource, InboxTicket } from "./inbox-words";
import { SafeMarkdown, countImages } from "./safe-markdown";

// F-010, F-007: the Inbox (inbox.md): rows, filters in the URL, the existing task, start, and the
// empty states.

const now = Date.UTC(2026, 10, 19, 12);
const esc = (text: string): string => text.replaceAll("'", "&#x27;");
const projectId = projectIdSchema.parse("01900000-0000-7000-8000-000000000010");
const board = { id: boardIdSchema.parse("01900000-0000-7000-8000-0000000000b1"), name: "Calculator", key: "CALC" };

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
};

const source: InboxSource = {
  boards: [{ ...board, lastPolledAt: now - 8000 }],
  connection: { connectionId: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c1"), workspaceName: "acme", state: "active", mode: "webhooks", pollSeconds: 60 },
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

  it("says when Linear isn't answering, in red", () => {
    const html = renderToStaticMarkup(<InboxLede source={{ ...source, stale: true }} now={now} />);
    expect(html).toContain(esc("Linear isn't answering"));
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
