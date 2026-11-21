import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { repoIdSchema, ticketIdSchema, ticketWriteIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { PhoneTaskSections } from "./phone-task-sections";
import type { TaskDetail } from "./task-ticket";

// F-075, F-064, F-031 (m2's `phone-task` target): on a phone, a ticket task's Ticket, Sync on
// Linear and Pull requests sections, above the thread.

const now = Date.UTC(2026, 10, 21, 14, 31);
const idle = { run: () => undefined, pending: false };

const ticket: NonNullable<TaskDetail["ticket"]> = {
  id: ticketIdSchema.parse("01900000-0000-7000-8000-0000000000b1"),
  key: "CALC-161",
  title: "Add history panel",
  url: "https://linear.app/acme/issue/CALC-161",
  status: { name: "In Review", category: "started" },
  board: "Calculator",
  tracker: "linear",
  labels: ["frontend", "history"],
  priority: 2,
  cachedAt: now,
  removed: false,
};

const write = (n: number, kind: TaskDetail["sync"][number]["kind"], state: TaskDetail["sync"][number]["state"]): TaskDetail["sync"][number] => ({
  id: ticketWriteIdSchema.parse(`01900000-0000-7000-8000-00000000000${String(n)}`),
  kind,
  state,
  attempts: state === "failed" ? 3 : 1,
  error: state === "failed" ? "linear: rate limited" : null,
  createdAt: now - 30 * 60_000,
  doneAt: state === "done" ? now - 29 * 60_000 : null,
});

const repo = (n: number, fullName: string, pr: { readonly number: number; readonly state: "open" | "merged" | "closed_unmerged" } | null): TaskDetail["repos"][number] => ({
  repoId: repoIdSchema.parse(`01900000-0000-7000-8000-00000000010${String(n)}`),
  fullName,
  branchName: "ostra/calc-161",
  baseBranch: "main",
  state: pr === null ? "branch_pushed" : pr.state === "merged" ? "merged" : "pr_open",
  headSha: null,
  ci: null,
  pr: pr === null ? null : { number: pr.number, url: `https://github.com/${fullName}/pull/${String(pr.number)}`, state: pr.state === "open" ? "open" : pr.state === "merged" ? "merged" : "closed" },
  behindBy: null,
  behindCheckedAt: null,
  pullRequests:
    pr === null
      ? []
      : [{ number: pr.number, url: `https://github.com/${fullName}/pull/${String(pr.number)}`, branchName: "ostra/calc-161", state: pr.state, draft: false, draftByOstra: false, openedAt: now, closedAt: null, reviewCheck: null }],
});

const draw = (task: Partial<Parameters<typeof PhoneTaskSections>[0]["task"]>) =>
  renderToStaticMarkup(
    <PhoneTaskSections
      task={{ ticket, sync: [], repos: [], contextFiles: [], kind: "code", canRetry: false, ...task }}
      retry={idle}
      details={<div data-testid="task-properties-stub" />}
    />,
  );

describe("the phone's ticket sections (phone-task.md)", () => {
  it("F-075, F-064: a ticket task on a phone shows its Ticket section: the status on Linear with a link to it, and what the agent got, which opens", () => {
    const html = draw({});
    expect(html).toContain('data-testid="phone-ticket"');
    expect(html).toContain(t("taskPage.phone.statusOn", { status: "In Review", tracker: "Linear" }));
    expect(html).toContain('href="https://linear.app/acme/issue/CALC-161"');
    expect(html).toContain(t("taskPage.phone.openIn", { tracker: "Linear" }));
    expect(html).toContain(t("taskPage.agentGot"));
    expect(html).toContain('aria-expanded="false"');
    // Only under 640px: wider, the header's strip and the properties say the same.
    expect(html).toContain('class="sm:hidden"');
  });

  it("F-075, F-031: Sync on Linear lists each write with its state, and a failed one offers Retry sync when the driver can retry", () => {
    const sync = [write(1, "move", "done"), write(2, "link_pr", "failed"), write(3, "comment", "pending")];
    const html = draw({ sync, canRetry: true });
    expect(html).toContain(t("taskPage.phone.syncOn", { tracker: "Linear" }));
    expect(html).toContain('data-state="done"');
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('data-state="pending"');
    expect(html).toContain(t("taskPage.sync.move"));
    expect(html).toContain(t("taskPage.sync.retry"));
    // A viewer who can't retry sees the failure, never the button.
    expect(draw({ sync, canRetry: false })).not.toContain(t("taskPage.sync.retry"));
    // Nothing written yet: no section.
    expect(draw({ sync: [] })).not.toContain('data-testid="phone-sync"');
  });

  it("F-075: Pull requests has a row per repo, its newest PR's number and state, or None yet", () => {
    const html = draw({ repos: [repo(1, "acme/calculator-web", { number: 483, state: "open" }), repo(2, "acme/calculator-api", { number: 91, state: "merged" }), repo(3, "acme/docs", null)] });
    expect(html).toContain('data-testid="phone-prs"');
    expect(html).toContain("acme/calculator-web");
    expect(html).toContain("#483");
    expect(html).toContain('data-pr-state="open"');
    expect(html).toContain('data-pr-state="merged"');
    expect(html).toContain(t("taskPage.phone.noPrYet"));
  });

  it("F-075: a prompt task has no Ticket or Sync section, only its Pull requests; a refine task shows its ticket alone", () => {
    const prompt = draw({ ticket: null, sync: [write(1, "create", "done")], repos: [repo(1, "acme/calculator-web", null)] });
    expect(prompt).not.toContain('data-testid="phone-ticket"');
    expect(prompt).not.toContain('data-testid="phone-sync"');
    expect(prompt).toContain('data-testid="phone-prs"');
    const refine = draw({ kind: "refine", sync: [write(1, "move", "done")], repos: [repo(1, "acme/calculator-web", null)] });
    expect(refine).toContain('data-testid="phone-ticket"');
    expect(refine).not.toContain('data-testid="phone-sync"');
    expect(refine).not.toContain('data-testid="phone-prs"');
  });

  it("F-075/c1: the properties don't stack under the thread on a phone: a Details row opens them, the Ticket section's last, or a row of its own without a ticket", () => {
    const row = /<button type="button"[^>]*data-action="task-details"[^>]*>.*?<\/button>/;
    const ticketed = draw({});
    expect(ticketed).toMatch(row);
    const button = row.exec(ticketed)?.[0];
    expect(button).toContain(t("taskPage.phone.details"));
    expect(button).toContain('aria-haspopup="dialog"');
    // The Ticket section's last row.
    expect(ticketed.indexOf('data-action="task-details"')).toBeGreaterThan(ticketed.indexOf('data-testid="phone-agent-got"'));
    expect(ticketed.indexOf('data-action="task-details"')).toBeLessThan(ticketed.indexOf("</section>"));
    // A prompt task: a row of its own, under its Pull requests.
    const prompt = draw({ ticket: null, repos: [repo(1, "acme/calculator-web", null)] });
    expect(prompt.match(/data-action="task-details"/g)).toHaveLength(1);
    expect(prompt.indexOf('data-action="task-details"')).toBeGreaterThan(prompt.indexOf('data-testid="phone-prs"'));
    // The sheet holds the properties only while it's open: nothing of them is drawn on the page.
    expect(ticketed).not.toContain("task-properties-stub");
  });
});
