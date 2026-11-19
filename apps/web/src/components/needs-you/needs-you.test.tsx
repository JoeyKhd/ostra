import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalAnswer, DoneList, NeedsYouTabs, NotificationRow, OpenEmpty, OpenList, PlanAnswer, QuestionAnswer, ReachPanel } from "./needs-you-list";
import type { Answers } from "./needs-you-list";
import { autoOpen, groupByProject, ledeWords, outcomeWords, pageOrder, toMarkRead } from "./needs-you-words";
import type { ApprovalAsk, NotificationView, PlanAsk, QuestionAsk } from "./needs-you-words";

// F-036 (the panel's notification list, read and unread), F-062 (needs you across the
// organization): the Needs you page (needs-you.md), grouped by project, answered in place.

const now = Date.UTC(2026, 10, 19, 10, 0);
const min = 60_000;
const approvalAsk: ApprovalAsk = { kind: "approval", approvalId: "a1", agent: "OpenCode", summary: "add a dependency", rule: "Adding a dependency", subject: "pnpm add p-retry", pattern: "pnpm add" };
const planAsk: PlanAsk = { kind: "plan", planId: "pl1", driver: null, entries: Array.from({ length: 10 }, (_, i) => ({ status: "pending" as const, text: `Step ${String(i + 1)}` })) };
const questionAsk: QuestionAsk = { kind: "question", questionId: "q1", question: "Keep the old CSV header?", options: ["Yes", "No"], driver: null };

const row = (over: Partial<NotificationView> & Pick<NotificationView, "id">): NotificationView => ({
  taskId: `task-${over.id}`,
  key: "CALC-142",
  title: "Retry webhook delivery on 5xx",
  project: { id: "p-calc", name: "calculator" },
  at: now - 4 * min,
  read: false,
  detail: { reason: "approval", command: "pnpm add p-retry" },
  ask: approvalAsk,
  outcome: null,
  deliveryFailed: null,
  ...over,
});

const rows: readonly NotificationView[] = [
  row({ id: "c-read", key: "CALC-139", read: true, at: now - 60 * min, detail: { reason: "setup_failed", exitCode: 1 }, ask: null }),
  row({ id: "c-approval" }),
  row({ id: "c-question", key: "CALC-150", at: now - 12 * min, detail: { reason: "question", question: "keep the old CSV header?" }, ask: questionAsk }),
  row({ id: "b-plan", key: "BIL-88", project: { id: "p-bill", name: "billing-platform" }, at: now - 11 * min, detail: { reason: "plan" }, ask: planAsk }),
  row({ id: "m-read", key: "MOB-52", project: { id: "p-mob", name: "mobile-app" }, read: true, at: now - 1 * min, detail: { reason: "no_changes" }, ask: null }),
];

const answered = { kind: "answered", outcome: { kind: "approved-once", by: { kind: "you" } } } as const;
const answers: Answers = { approval: () => Promise.resolve(answered), plan: () => Promise.resolve(answered), question: () => Promise.resolve(answered) };
const noop = () => undefined;

describe("the order", () => {
  it("F-036, F-062: groups by their newest unread, then newest; unread first inside a group, then newest", () => {
    const groups = groupByProject(rows);
    expect(groups.map((group) => group.project.name)).toEqual(["calculator", "billing-platform", "mobile-app"]);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(["c-approval", "c-question", "c-read"]);
    expect(pageOrder(groups)).toEqual(["c-approval", "c-question", "c-read", "b-plan", "m-read"]);
    const readNewest = row({ id: "c-read-new", read: true, at: now - min });
    expect(groupByProject([...rows, readNewest])[0]?.rows.map((r) => r.id)).toEqual(["c-approval", "c-question", "c-read-new", "c-read"]);
  });

  it("F-062: the first unread row that answers in place opens by itself; none when there's none", () => {
    expect(autoOpen(groupByProject(rows))).toBe("c-approval");
    expect(autoOpen(groupByProject(rows.filter((r) => r.ask === null)))).toBeNull();
    const project = { id: "p", name: "p" };
    const readAsk = row({ id: "read-ask", read: true });
    const answeredAsk = row({ id: "answered-ask", outcome: { kind: "expired" } });
    expect(autoOpen([{ project, rows: [readAsk, answeredAsk, row({ id: "open-ask" })] }])).toBe("open-ask");
  });

  it("F-036: the lede counts unread; the rows rendered unread are the ones marked read", () => {
    expect(ledeWords(6)).toBe("What waits on you across your projects. 6 unread.");
    expect(ledeWords(0)).toBe("What waits on you across your projects.");
    expect(toMarkRead(rows)).toEqual(["c-approval", "c-question", "b-plan"]);
  });
});

describe("the Open tab", () => {
  const unread = new Set(rows.filter((r) => !r.read).map((r) => r.id));
  const html = renderToStaticMarkup(<OpenList rows={rows} now={now} answers={answers} unreadAtLoad={unread} />);

  it("F-036: unread rows carry the dot and the bright title; read ones don't", () => {
    expect(html.match(/aria-label="Unread"/g)?.length).toBe(3);
    expect(html).toMatch(/data-notification="c-read" data-read="true"/);
    expect(html).toMatch(/data-notification="c-approval" data-read="false"/);
  });

  it("F-062: the first approval opens with its inline answer: the rule, the subject, three buttons and the footnote", () => {
    expect(html).toContain("Needs you · approval");
    expect(html).toContain("OpenCode wants to add a dependency.");
    expect(html).toContain("Adding a dependency");
    expect(html).toContain("pnpm add p-retry");
    expect(html).toContain(">Deny<");
    expect(html).toContain(">Approve once<");
    expect(html).toContain(">Approve for this task<");
    expect(html).toContain("to the task&#x27;s rules. Any member of calculator can answer.");
    expect(html.match(/Needs you · /g)?.length).toBe(1);
  });

  it("F-062: rows that don't answer in place open their task; the reason line and age show", () => {
    expect(html).toMatch(/<a[^>]*href="\/tasks\/task-c-read"[^>]*>Open task<\/a>/);
    expect(html).toContain("Setup failed:");
    expect(html).toContain(">4m<");
    expect(html).toContain(">Answer<");
    expect(html).toContain(">Review plan<");
  });

  it("F-062: an answered row shows its outcome in place of its action", () => {
    const done = renderToStaticMarkup(
      <NotificationRow row={row({ id: "x", outcome: { kind: "approved-once", by: { kind: "member", name: "Sam Rivera" } } })} now={now} expanded={false} unreadDot answers={answers} onToggle={noop} onAnswered={noop} />,
    );
    expect(done).toContain("Approved once by Sam Rivera");
    expect(done).toContain(">Done<");
    expect(done).not.toContain("Approve once");
  });

  it("F-036: a failed delivery of the member's own shows under its row", () => {
    const failed = renderToStaticMarkup(
      <NotificationRow row={row({ id: "x", ask: null, deliveryFailed: { channel: "email", error: "550 mailbox full" } })} now={now} expanded={false} unreadDot answers={answers} onToggle={noop} onAnswered={noop} />,
    );
    expect(failed).toContain("The mail didn&#x27;t send: 550 mailbox full. ostra retries.");
  });

  it("F-062: an empty Open tab shows the picture and its two lines", () => {
    const empty = renderToStaticMarkup(<OpenEmpty />);
    expect(empty).toContain("Nothing waits on you");
    expect(empty).toContain("/inbox-empty-illustration.webp");
  });
});

describe("the inline answers", () => {
  const target = row({ id: "x" });

  it("F-062: a task rule's pattern only when it can add one", () => {
    const html = renderToStaticMarkup(<ApprovalAnswer row={target} ask={{ ...approvalAsk, pattern: null, rule: null }} answers={answers} onAnswered={noop} />);
    expect(html).not.toContain("Approve for this task");
    expect(html).toContain("custom rule");
    expect(html).toContain("Any member of calculator can answer.");
  });

  it("F-062: a plan shows eight entries then the rest on the task; only the driver answers", () => {
    const html = renderToStaticMarkup(<PlanAnswer row={target} ask={planAsk} answers={answers} onAnswered={noop} />);
    expect(html).toContain("Step 8");
    expect(html).not.toContain("Step 9");
    expect(html).toContain("2 more on the task");
    expect(html).toContain(">Approve plan<");
    expect(html).toContain('href="/tasks/task-x?plan=edit"');
    const other = renderToStaticMarkup(<PlanAnswer row={target} ask={{ ...planAsk, driver: "Alex Kim" }} answers={answers} onAnswered={noop} />);
    expect(other).toContain("Alex Kim is driving. Open the task to take over.");
    expect(other).not.toContain("Approve plan");
  });

  it("F-062: a question offers the agent's options and a free answer; only the driver answers", () => {
    const html = renderToStaticMarkup(<QuestionAnswer row={target} ask={questionAsk} answers={answers} onAnswered={noop} />);
    expect(html).toContain("Keep the old CSV header?");
    expect(html).toContain(">Yes<");
    expect(html).toContain('placeholder="Your answer"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send answer<\/button>/);
    expect(renderToStaticMarkup(<QuestionAnswer row={target} ask={{ ...questionAsk, driver: "Alex Kim" }} answers={answers} onAnswered={noop} />)).not.toContain("Your answer");
  });

  it("F-062: the question's text is plain text, never markup", () => {
    const html = renderToStaticMarkup(<QuestionAnswer row={target} ask={{ ...questionAsk, question: "<img src=x onerror=alert(1)>" }} answers={answers} onAnswered={noop} />);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("the Done tab and the panel", () => {
  it("F-036: outcomes in words", () => {
    expect(outcomeWords({ kind: "approved-once", by: { kind: "member", name: "Sam Rivera" } })).toBe("Approved once by Sam Rivera");
    expect(outcomeWords({ kind: "approved-task", by: { kind: "you" } })).toBe("Approved for this task by you");
    expect(outcomeWords({ kind: "denied", by: { kind: "you" } })).toBe("Denied by you");
    expect(outcomeWords({ kind: "by-rule" })).toBe("Approved by rule");
    expect(outcomeWords({ kind: "plan-approved", by: { kind: "member", name: "Sam Rivera" } })).toBe("Plan approved by Sam Rivera");
    expect(outcomeWords({ kind: "answered", by: { kind: "you" } })).toBe("Answered by you");
    expect(outcomeWords({ kind: "expired" })).toBe("Expired");
    expect(outcomeWords({ kind: "closed" })).toBe("Closed");
  });

  it("F-036: Done lists the outcome and the project; nothing answered says so", () => {
    const html = renderToStaticMarkup(<DoneList rows={[row({ id: "d", read: true, outcome: { kind: "denied", by: { kind: "you" } } })]} now={now} onMore={noop} hasMore={false} />);
    expect(html).toContain("Denied by you");
    expect(html).toContain("calculator");
    expect(html).not.toContain("Unread");
    expect(renderToStaticMarkup(<DoneList rows={[]} now={now} onMore={noop} hasMore={false} />)).toContain("Nothing answered yet.");
  });

  it("F-036: the tabs count the open notifications", () => {
    const html = renderToStaticMarkup(<NeedsYouTabs tab="open" onTab={noop} openCount={9} />);
    expect(html).toContain(">Open");
    expect(html).toContain(">9<");
    expect(html).toContain('aria-selected="true"');
  });

  it("F-036: where these reach the member: always the panel, the ticket, the mail after its delay", () => {
    const html = renderToStaticMarkup(<ReachPanel reach={{ tracker: "Linear", ticketOff: false, email: { kind: "on", address: "alex@acme.dev", delayMinutes: 2 } }} />);
    expect(html).toContain("Always");
    expect(html).toContain("A comment on Linear");
    expect(html).toContain("alex@acme.dev");
    expect(html).toContain("after 2 min, if unread");
    expect(html).toContain("A mail waits 2 minutes and isn&#x27;t sent once you&#x27;ve read it here.");
    const off = renderToStaticMarkup(<ReachPanel reach={{ tracker: "Linear", ticketOff: true, email: { kind: "install-off" } }} />);
    expect(off).toContain("Mail is off on this install");
    expect(off).not.toContain("A mail waits");
  });
});
