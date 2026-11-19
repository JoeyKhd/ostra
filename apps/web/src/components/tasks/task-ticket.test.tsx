import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { blobIdSchema, ticketWriteIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";
import { formatSize, restoredDetail, savedDetail } from "@/task/marker-words";

import { AgentGot, LimitBlock, RestoreConflict, TicketProperties, boxText, composerMode, idleHeader, reopenBlockedText, spendText } from "./task-ticket";
import type { ComposerInput, LimitState, TaskDetail } from "./task-ticket";

// F-064, F-031, F-032, F-033, F-047, F-068, F-097: the task page for tickets, reopening and limits
// (task-ticket.md, task-reopen.md, task-limits.md).

const now = Date.UTC(2026, 10, 19, 12);
const idle = { run: () => undefined, pending: false };

type Box = NonNullable<TaskDetail["box"]>;
const box = (over: Partial<Box>): Box => ({ state: "running", idleStopDueAt: null, releasedAt: null, releaseReason: null, runnerName: "alex-laptop", ...over });

describe("the box", () => {
  it("F-032: says each state, the idle stop's time, and why it was released", () => {
    expect(boxText(box({ state: "running" }), now)).toBe(t("taskPage.box.running"));
    expect(boxText(box({ state: "idle", idleStopDueAt: now + 11 * 60_000 }), now)).toBe("Idle · stops in 11 min");
    expect(boxText(box({ state: "stopped" }), now)).toBe(t("taskPage.box.stopped"));
    expect(boxText(box({ state: "released", releaseReason: "prs_closed" }), now)).toBe("Released · the PRs closed");
    expect(boxText(box({ state: "starting" }), now)).toBe(t("taskPage.box.starting"));
    expect(idleHeader(box({ state: "idle", idleStopDueAt: now + 11 * 60_000 }), now)).toBe("Idle, the box stops in 11 min");
    expect(idleHeader(box({ state: "running" }), now)).toBeNull();
  });
});

describe("the spend", () => {
  it("F-068: against the cap, in dollars, or in tokens when the model has no price", () => {
    expect(spendText({ unit: "usd", spent: 840_000, cap: 25_000_000, reached: false })).toBe("$0.84 of $25.00");
    expect(spendText({ unit: "tokens", spent: 96_000, cap: 2_000_000, reached: false })).toBe("96k of 2M");
  });
});

const limited = (over: Partial<LimitState>): LimitState => ({
  state: "needs_you",
  reason: null,
  limit: null,
  spend: { unit: "usd", spent: 25_000_000, cap: 25_000_000, reached: true },
  lostBox: false,
  reopenWithoutText: false,
  ...over,
});

describe("limits and crashes", () => {
  it("F-068: a stall is a needs-you block with the one-click Reopen", () => {
    const html = renderToStaticMarkup(<LimitBlock task={limited({ limit: "stall", reopenWithoutText: true })} reopen={{ ...idle, error: null }} />);
    expect(html).toContain("Needs you · stalled");
    expect(html).toContain(t("taskPage.limit.reopen"));
  });

  it("the maximum duration says so", () => {
    expect(renderToStaticMarkup(<LimitBlock task={limited({ limit: "max-duration" })} reopen={{ ...idle, error: null }} />)).toContain(t("taskPage.limit.max-durationBody"));
  });

  it("the spend cap shows spend against the cap, and no Reopen until it's raised", () => {
    const html = renderToStaticMarkup(<LimitBlock task={limited({ limit: "spend-cap" })} reopen={{ ...idle, error: null }} />);
    expect(html).toContain("$25.00 of its $25.00 cap");
    expect(html).not.toContain(t("taskPage.limit.reopen"));
  });

  it("F-047: a crash, and a lost box", () => {
    expect(renderToStaticMarkup(<LimitBlock task={limited({ reason: "crashed" })} reopen={{ ...idle, error: null }} />)).toContain(t("taskPage.limit.crashedBody"));
    const lost = limited({ reason: "crashed", lostBox: true });
    expect(renderToStaticMarkup(<LimitBlock task={lost} reopen={{ ...idle, error: null }} />)).toContain(t("taskPage.limit.boxLostBody"));
  });

  it("shows nothing while the task runs", () => {
    expect(renderToStaticMarkup(<LimitBlock task={limited({ state: "running", limit: "stall" })} reopen={{ ...idle, error: null }} />)).toBe("");
  });

  it("a refused reopen is an alert", () => {
    expect(renderToStaticMarkup(<LimitBlock task={limited({ limit: "stall" })} reopen={{ ...idle, error: "No" }} />)).toContain('role="alert"');
  });
});

describe("the composer: send or reopen", () => {
  const input = (over: Partial<ComposerInput>): ComposerInput => ({ state: "running", send: false, reopen: false, boxState: null, ...over });
  it("F-033: sends on a warm idle session, with the idle hint", () => {
    expect(composerMode(input({ send: true, boxState: "idle" }))).toEqual({ kind: "send", hint: t("taskPage.composer.idleHint") });
  });

  it("F-032: reopens a stopped task", () => {
    expect(composerMode(input({ state: "stopped", reopen: true })).kind).toBe("reopen");
  });

  it("offers no reopen on a merged task, and says why", () => {
    expect(composerMode(input({ state: "merged" }))).toEqual({ kind: "merged", hint: t("taskPage.composer.mergedHint") });
    expect(reopenBlockedText("spend_cap")).toBe(t("taskPage.composer.spendCap"));
  });
});

describe("the sync steps", () => {
  const writes: TaskDetail["sync"] = [
    { id: ticketWriteIdSchema.parse("01900000-0000-7000-8000-0000000000a1"), kind: "move", state: "done", attempts: 1, error: null, createdAt: now - 60_000, doneAt: now - 59_000 },
    { id: ticketWriteIdSchema.parse("01900000-0000-7000-8000-0000000000a2"), kind: "link_pr", state: "failed", attempts: 5, error: "Linear refused the link", createdAt: now - 30_000, doneAt: null },
  ];

  it("F-031: one line per step with its state, and Retry sync when one failed", () => {
    const html = renderToStaticMarkup(<TicketProperties task={{ ticket: null, sync: writes, canRetry: true }} now={now} retry={idle} createTicket={null} />);
    expect(html).toContain(t("taskPage.sync.move"));
    expect(html).toContain('data-state="failed"');
    expect(html).toContain(t("taskPage.sync.retry"));
  });

  it("F-097: a prompt task with a board offers Create ticket", () => {
    expect(renderToStaticMarkup(<TicketProperties task={{ ticket: null, sync: [], canRetry: false }} now={now} retry={idle} createTicket={{ ...idle, error: null }} />)).toContain(t("taskPage.createTicket"));
  });
});

describe("what the agent got", () => {
  it("is collapsed by default and counts the ticket's files", () => {
    const html = renderToStaticMarkup(<AgentGot files={[{ name: "1-mock.png", blobId: blobIdSchema.parse("01900000-0000-7000-8000-0000000000f1"), size: 240_000, contentType: "image/png" }]} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("1 file");
  });
});

describe("the restore conflict", () => {
  it("gives the driver Carry on without it; others see it muted, without buttons", () => {
    expect(renderToStaticMarkup(<RestoreConflict savedWorkUrl={null} canAnswer dismiss={idle} />)).toContain(t("taskPage.restoreConflict.dismiss"));
    const other = renderToStaticMarkup(<RestoreConflict savedWorkUrl={null} canAnswer={false} dismiss={idle} />);
    expect(other).not.toContain("<button");
    expect(other).toContain("text-muted");
  });
});

describe("the thread's markers", () => {
  it("says what a save kept", () => {
    expect(formatSize(2_400_000)).toBe("2.4 MB");
    expect(savedDetail({ turnOrdinal: 1, archiveBytes: 2_400_000, hiddenRefs: ["3be91f0aa5"], unsaved: 0 })).toBe("archive 2.4 MB · hidden ref 3be91f0");
    expect(savedDetail({ turnOrdinal: 2, archiveBytes: null, hiddenRefs: ["a", "b"], unsaved: 0 })).toBe("no archive (the upload failed) · hidden refs in 2 repos");
  });

  it("says how a session came back", () => {
    expect(restoredDetail({ kind: "session.restored", origin: "restored", replayedUpdates: 12, hiddenRef: "applied", previousBox: "released" })).toBe("a fresh box · 12 updates replayed · unfinished work restored");
    expect(restoredDetail({ kind: "session.restored" })).toBe("");
  });
});
