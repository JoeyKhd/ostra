import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TicketAttachmentView, TicketContextView, TicketRoundView } from "@ostra/api";
import { connectionIdSchema, messageFileIdSchema } from "@ostra/protocol";
import type { MessageFileView } from "@ostra/task-view";

import { TicketContextMessage, TicketContextRow } from "./ticket-context-message";
import { attachmentsCountText, contextRowText, failureText, nameJoiners, shownAttachments, shownComments, ticketCounts, updatesAnswerOf, updatesAnswerText } from "./ticket-context-words";

// "What the agent got" (ticket-context.md; ticket 16): a ticket task's first message, its counts,
// what was left out or failed, the Ticket group's Context row and "Send ticket updates"' answer.

const MiB = 1024 * 1024;
const limits = { maxFiles: 20, maxFileBytes: 10 * MiB, maxTotalBytes: 50 * MiB };
const at = Date.UTC(2026, 10, 21, 13, 2);
const from = { where: "attachment" as const, author: null };

let next = 0;
const fileId = () => {
  next += 1;
  return messageFileIdSchema.parse(`0196f1a0-0000-7000-8000-${String(next).padStart(12, "0")}`);
};
const view = (name: string, kind: MessageFileView["kind"], over: Partial<MessageFileView> = {}): MessageFileView => {
  const id = fileId();
  return {
    fileId: id,
    name,
    kind,
    contentType: kind === "image" ? "image/png" : "application/octet-stream",
    size: 212 * 1024,
    origin: "ticket",
    asImage: kind === "image",
    text: kind === "document" ? "ready" : "none",
    downloadPath: `/api/tasks/t/files/${id}`,
    textWords: kind === "document" ? 1800 : null,
    textReason: null,
    ...over,
  };
};
const ready = (name: string, kind: MessageFileView["kind"]): TicketAttachmentView => ({ state: "ready", file: view(name, kind), from });
const failed = (name: string, retry: { readonly fileId: MessageFileView["fileId"]; readonly state: "ready" | "failed" } | null = null): TicketAttachmentView => ({ state: "failed", fileId: fileId(), name, from, retry });

const round = (over: Partial<TicketRoundView> = {}): TicketRoundView => ({
  round: 1,
  reason: "start",
  seq: 2,
  at,
  description: "Percent mode rounds half-cents down.",
  descriptionFiles: [],
  comments: [
    { author: "Dana Ortiz", at: at - 2 * 86_400_000, body: "Keep two decimals.", edited: false },
    { author: "Marcus Lee", at: at - 86_400_000, body: "Finance confirmed: half up.", edited: false },
    { author: "Priya Shah", at: at - 20 * 3_600_000, body: "Repro on 2.14.", edited: false },
  ],
  links: [{ title: "Sentry · ACME-WEB-4F2", url: "https://sentry.io/acme/web/4f2" }],
  attachments: [ready("wrong-total.png", "image"), ready("rounding-rules.docx", "document"), ready("percent-cases.csv", "text")],
  failure: null,
  filesNotFetched: false,
  unreadable: false,
  nothingNew: false,
  messageSeq: 3,
  imagesNotSent: null,
  imagesAsFilesFor: null,
  ...over,
});

const context = (first: TicketRoundView | null, over: Partial<TicketContextView> = {}): TicketContextView => ({
  state: first === null ? "fetching" : "read",
  ticketKey: "CALC-170",
  connection: null,
  limits,
  prompt: "You're working on CALC-170.",
  model: { name: "Claude Sonnet 5.5", imageInput: "yes" },
  isDriver: true,
  canSendUpdates: true,
  canRetry: false,
  rounds: first === null ? [] : [first],
  ...over,
});

const none = () => undefined;
const render = (shown: TicketContextView, retry: { readonly run: () => void; readonly pending: boolean } | null = null) =>
  renderToStaticMarkup(<TicketContextMessage view={shown} tracker="Linear" agent="OpenCode" now={at + 60_000} retry={retry} fileOf={none} onOpenImage={null} defaultOpen />);

describe("the ticket's counts", () => {
  it("counts files and links as attachments, and says how many of all when some didn't make it", () => {
    const all = round();
    expect(attachmentsCountText(ticketCounts(all))).toBe("4");
    const some = round({ attachments: [...all.attachments, { state: "left-out", name: "a.mp4", size: 84 * MiB, reason: "too-big", from }, failed("b.pdf")] });
    expect(attachmentsCountText(ticketCounts(some))).toBe("4 of 6");
  });

  it("words the Context row: all of it, some of it, or what didn't load in red", () => {
    expect(contextRowText(ticketCounts(round()))).toEqual({ text: "4 attachments · 3 comments", failed: false });
    expect(contextRowText(ticketCounts(round({ attachments: [ready("a.png", "image"), { state: "left-out", name: "b.zip", size: null, reason: "too-many", from }], links: [] })))).toEqual({ text: "1 of 2 attachments", failed: false });
    expect(contextRowText(ticketCounts(round({ attachments: [failed("a.png"), failed("b.pdf")] })))).toEqual({ text: "2 attachments didn't load", failed: true });
    expect(contextRowText(ticketCounts(round({ attachments: [], links: [], comments: [] })))).toEqual({ text: "The title alone", failed: false });
  });

  it("says how often ostra tried a failed file and when, the tracker's own answer not being kept", () => {
    expect(failureText({ status: null, tries: 3, lastAt: at }, "Linear")).toMatch(/^Linear didn't give them: ostra tried three times, the last at \d\d:\d\d\.$/);
    expect(failureText(null, "Linear")).toBe("Linear didn't give them.");
    expect(nameJoiners(3)).toEqual([", ", " and ", ""]);
    expect(nameJoiners(1)).toEqual([""]);
  });

  it("shows a failed file a Retry fetched as given, with the file it fetched", () => {
    const fetched = view("wrong-total.png", "image");
    const shown = shownAttachments(round({ attachments: [failed("wrong-total.png", { fileId: fetched.fileId, state: "ready" }), failed("note.pdf", { fileId: fileId(), state: "failed" })] }), (id) => (id === fetched.fileId ? fetched : undefined));
    expect(shown.map((one) => one.state)).toEqual(["ready", "failed"]);
  });

  it("shows the newest two comments, then all", () => {
    expect(shownComments([1, 2, 3], false)).toEqual({ shown: [2, 3], hidden: 1 });
    expect(shownComments([1, 2, 3], true)).toEqual({ shown: [1, 2, 3], hidden: 0 });
    expect(shownComments([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 });
  });

  it("answers Send ticket updates with the round after the press", () => {
    const rounds = [{ round: 1, nothingNew: false, unreadable: false }];
    expect(updatesAnswerOf(rounds, 1)).toEqual({ kind: "reading" });
    expect(updatesAnswerOf([...rounds, { round: 2, nothingNew: true, unreadable: false }], 1)).toEqual({ kind: "nothing-new" });
    expect(updatesAnswerOf([...rounds, { round: 2, nothingNew: false, unreadable: false }], 1)).toEqual({ kind: "sent" });
    expect(updatesAnswerText({ kind: "nothing-new" }, "OpenCode", "Linear")).toBe("Nothing new on the ticket since the agent read it.");
  });
});

describe("What the agent got", () => {
  it("F-151/c1: is the thread's first bubble: the member and the time over it, the key and the tracker, the title, the description and a summary with Show it all", () => {
    const html = renderToStaticMarkup(
      <TicketContextMessage view={context(round())} tracker="Linear" agent="OpenCode" now={at + 60_000} retry={null} fileOf={none} onOpenImage={null} by="Priya Shah" at={at} title="Fix the percent rounding" />,
    );
    expect(html).toContain('data-part="bubble-got"');
    expect(html).toContain(">Priya Shah<");
    expect(html).toContain(">CALC-170<");
    expect(html).toContain("from Linear · what the agent got");
    expect(html).toContain(">Fix the percent rounding<");
    expect(html).toContain("Percent mode rounds half-cents down.");
    expect(html).toContain("4 attachments · 3 comments");
    expect(html).toContain('data-action="show-it-all"');
    expect(html).toContain('aria-expanded="false"');
    // Its files, comments and where it all is wait behind Show it all.
    expect(html).not.toContain("Finance confirmed: half up.");
    expect(html).not.toContain("Show the prompt");
  });

  it("F-152/c4: a Jira ticket's meta line carries Jira's mark, one colour, before the key", () => {
    const view = context(round(), { connection: { id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c2"), kind: "jira", name: "Globex Jira" } });
    const html = renderToStaticMarkup(<TicketContextMessage view={view} tracker="Jira" agent="OpenCode" now={at + 60_000} retry={null} fileOf={none} onOpenImage={null} by="Priya Shah" at={at} title="Checkout total ignores the coupon" />);
    expect(html).toContain('data-tracker-mark="jira"');
    expect(html).toContain('data-treatment="mono"');
    expect(html).toContain(">CALC-170<");
    expect(html).toContain("from Jira");
  });

  it("shows the description, the files with their text, the link not fetched, the comments and where it all is", () => {
    const html = render(context(round()));
    expect(html).toContain("What the agent got");
    expect(html).toContain("Percent mode rounds half-cents down.");
    expect(html).toContain('aria-label="Image wrong-total.png from CALC-170, open"');
    expect(html).toContain('data-part="text-extracted"');
    expect(html).toContain("Link · not fetched");
    expect(html).toContain('aria-label="Sentry · ACME-WEB-4F2, link, opens in a new tab"');
    expect(html).toContain("Show 1 more");
    expect(html).toContain("Finance confirmed: half up.");
    expect(html).not.toContain("Keep two decimals.");
    expect(html).toContain(".ostra/ticket/");
    expect(html).toContain("Show the prompt");
  });

  it("lists what the ticket's limits left out, with why", () => {
    const html = render(context(round({ attachments: [ready("a.png", "image"), { state: "left-out", name: "support-call.mp4", size: 84 * MiB, reason: "too-big", from }, { state: "left-out", name: "checkout-flow-7.png", size: null, reason: "too-many", from }] })));
    expect(html).toContain("2 left out, and the agent was told which");
    expect(html).toContain("84 MB, over the 10 MB a file can be");
    expect(html).toContain("past the 20 attachments a ticket can give");
  });

  it("keeps a failed file's place, names it with why, and offers Retry to the driver only", () => {
    const failedRound = context(round({ attachments: [failed("wrong-total.png"), ready("b.png", "image"), failed("IEEE-754-note.pdf")], failure: { status: null, tries: 3, lastAt: at } }));
    const driver = render(failedRound, { run: () => undefined, pending: false });
    expect(driver).toContain('data-part="thumb-missing"');
    expect(driver).toContain('data-part="file-missing"');
    expect(driver).toContain("2 attachments didn&#x27;t load from Linear");
    expect(driver).toContain("ostra tried three times");
    expect(driver).toContain('data-action="retry-ticket-files"');
    expect(driver).toContain("The agent started without them.");
    expect(render(failedRound)).not.toContain('data-action="retry-ticket-files"');
    expect(render(failedRound, { run: () => undefined, pending: true })).toContain("Retrying…");
  });

  it("says the tracker doesn't offer its files, and shows the fetch while the task starts", () => {
    expect(render(context(round({ attachments: [], links: [], filesNotFetched: true })))).toContain("The ticket&#x27;s files weren&#x27;t fetched: Linear doesn&#x27;t offer them.");
    const fetching = render(context(null));
    expect(fetching).toContain("Fetching the ticket&#x27;s attachments and comments…");
    expect(fetching).not.toContain("Percent mode rounds");
  });

  it("is reached from the Ticket group's Context row", () => {
    const html = renderToStaticMarkup(<TicketContextRow round={round()} fileOf={none} onShow={() => undefined} />);
    expect(html).toContain("4 attachments · 3 comments");
    expect(html).toContain('aria-label="Context: 4 attachments · 3 comments. Show what the agent got"');
  });
});
