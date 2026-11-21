import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { messageFileIdSchema } from "@ostra/protocol";

import type { ThreadFile } from "./file-words";
import { TicketContextMessage, TicketContextRow } from "./ticket-context-message";
import { attachmentsCountText, contextRowText, failureText, nameJoiners, shownComments, ticketCounts } from "./ticket-context-words";
import type { TicketAttachment, TicketContextView } from "./ticket-context-words";

// "What the agent got" (ticket-context.md; ticket 16): a ticket task's first message, its counts,
// what was left out or failed, and the Ticket group's Context row.

const MiB = 1024 * 1024;
const limits = { maxFiles: 20, maxFileBytes: 10 * MiB, maxTotalBytes: 50 * MiB };
const at = Date.UTC(2026, 10, 21, 13, 2);

let next = 0;
const file = (name: string, kind: ThreadFile["kind"], over: Partial<ThreadFile> = {}): TicketAttachment => {
  next += 1;
  return {
    state: "ready",
    file: {
      fileId: messageFileIdSchema.parse(`0196f1a0-0000-7000-8000-${String(next).padStart(12, "0")}`),
      name,
      kind,
      contentType: kind === "image" ? "image/png" : "application/octet-stream",
      size: 212 * 1024,
      origin: "ticket",
      asImage: kind === "image",
      text: kind === "document" ? "ready" : "none",
      downloadPath: `/api/tasks/t/files/${String(next)}`,
      textWords: kind === "document" ? 1800 : null,
      textReason: null,
      ...over,
    },
  };
};

const view = (over: Partial<TicketContextView> = {}): TicketContextView => ({
  at,
  ticketKey: "CALC-170",
  tracker: "Linear",
  state: "read",
  description: "Percent mode rounds half-cents down.",
  attachments: [file("wrong-total.png", "image"), file("rounding-rules.docx", "document"), file("percent-cases.csv", "text")],
  links: [{ title: "Sentry · ACME-WEB-4F2", url: "https://sentry.io/acme/web/4f2" }],
  comments: [
    { author: "Dana Ortiz", at: at - 2 * 86_400_000, body: "Keep two decimals.", edited: false },
    { author: "Marcus Lee", at: at - 86_400_000, body: "Finance confirmed: half up.", edited: false },
    { author: "Priya Shah", at: at - 20 * 3_600_000, body: "Repro on 2.14.", edited: false },
  ],
  failure: null,
  filesNotOffered: false,
  prompt: "You're working on CALC-170.",
  imagesAsFilesFor: null,
  ...over,
});

const render = (shown: TicketContextView, retry: { readonly run: () => void; readonly pending: boolean } | null = null) =>
  renderToStaticMarkup(<TicketContextMessage view={shown} agent="OpenCode" limits={limits} now={at + 60_000} retry={retry} onOpenImage={null} />);

describe("the ticket's counts", () => {
  it("counts files and links as attachments, and says how many of all when some didn't make it", () => {
    expect(attachmentsCountText(ticketCounts(view()))).toBe("4");
    const some = view({ attachments: [...view().attachments, { state: "left-out", name: "a.mp4", size: 84 * MiB, reason: "too-big" }, { state: "failed", name: "b.pdf" }] });
    expect(attachmentsCountText(ticketCounts(some))).toBe("4 of 6");
  });

  it("words the Context row: all of it, some of it, or what didn't load in red", () => {
    expect(contextRowText(ticketCounts(view()))).toEqual({ text: "4 attachments · 3 comments", failed: false });
    expect(contextRowText(ticketCounts(view({ attachments: [file("a.png", "image"), { state: "left-out", name: "b.zip", size: null, reason: "too-many" }], links: [] })))).toEqual({ text: "1 of 2 attachments", failed: false });
    expect(contextRowText(ticketCounts(view({ attachments: [{ state: "failed", name: "a.png" }, { state: "failed", name: "b.pdf" }] })))).toEqual({ text: "2 attachments didn't load", failed: true });
    expect(contextRowText(ticketCounts(view({ attachments: [], links: [], comments: [] })))).toEqual({ text: "The title alone", failed: false });
  });

  it("says what the tracker answered, how often and when", () => {
    expect(failureText({ status: 503, tries: 3, lastAt: Date.UTC(2026, 10, 21, 13, 2) }, "Linear")).toMatch(/^Linear answered 503 three times, the last at \d\d:\d\d\.$/);
    expect(failureText({ status: null, tries: 1, lastAt: null }, "Linear")).toBe("Linear didn't answer once.");
    expect(failureText(null, "Linear")).toBe("Linear didn't give them.");
    expect(nameJoiners(3)).toEqual([", ", " and ", ""]);
    expect(nameJoiners(1)).toEqual([""]);
  });

  it("shows the newest two comments, then all", () => {
    expect(shownComments([1, 2, 3], false)).toEqual({ shown: [2, 3], hidden: 1 });
    expect(shownComments([1, 2, 3], true)).toEqual({ shown: [1, 2, 3], hidden: 0 });
    expect(shownComments([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 });
  });
});

describe("What the agent got", () => {
  it("shows the description, the files with their text, the link not fetched, the comments and where it all is", () => {
    const html = render(view());
    expect(html).toContain("What the agent got");
    expect(html).toContain("Percent mode rounds half-cents down.");
    expect(html).toContain('aria-label="Image wrong-total.png from CALC-170, open"');
    expect(html).toContain("rounding-rules.docx");
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
    const html = render(view({ attachments: [file("a.png", "image"), { state: "left-out", name: "support-call.mp4", size: 84 * MiB, reason: "too-big" }, { state: "left-out", name: "checkout-flow-7.png", size: null, reason: "too-many" }] }));
    expect(html).toContain("2 left out, and the agent was told which");
    expect(html).toContain("84 MB, over the 10 MB a file can be");
    expect(html).toContain("past the 20 attachments a ticket can give");
  });

  it("keeps a failed file's place, names it with why, and offers Retry to the driver only", () => {
    const failed = view({ attachments: [{ state: "failed", name: "wrong-total.png" }, file("b.png", "image"), { state: "failed", name: "IEEE-754-note.pdf" }], failure: { status: 503, tries: 3, lastAt: at } });
    const driver = render(failed, { run: () => undefined, pending: false });
    expect(driver).toContain('data-part="thumb-missing"');
    expect(driver).toContain('data-part="file-missing"');
    expect(driver).toContain("2 attachments didn&#x27;t load from Linear");
    expect(driver).toContain("Linear answered 503 three times");
    expect(driver).toContain('data-action="retry-ticket-files"');
    expect(driver).toContain("The agent started without them.");
    expect(render(failed)).not.toContain('data-action="retry-ticket-files"');
    expect(render(failed, { run: () => undefined, pending: true })).toContain("Retrying…");
  });

  it("says the tracker doesn't offer its files, and shows the fetch while the task starts", () => {
    expect(render(view({ attachments: [], filesNotOffered: true }))).toContain("The ticket&#x27;s files weren&#x27;t fetched: Linear doesn&#x27;t offer them.");
    const fetching = render(view({ state: "fetching" }));
    expect(fetching).toContain("Fetching the ticket&#x27;s attachments and comments…");
    expect(fetching).not.toContain("Percent mode rounds");
  });

  it("is reached from the Ticket group's Context row", () => {
    const html = renderToStaticMarkup(<TicketContextRow view={view()} onShow={() => undefined} />);
    expect(html).toContain("4 attachments · 3 comments");
    expect(html).toContain('aria-label="Context: 4 attachments · 3 comments. Show what the agent got"');
  });
});
