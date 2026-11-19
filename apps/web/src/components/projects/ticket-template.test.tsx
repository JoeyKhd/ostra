import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { builtInTicketTemplate, ticketTemplateVocabulary } from "@ostra/domain/ticket-template";
import { projectIdSchema, ticketIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { PlaceholderList, PreviewColumn, TemplateEditor, ValidationLine } from "./ticket-template-view";
import type { PreviewColumnProps } from "./ticket-template-view";
import { changedLines, eyebrow, insertAt, placeholderRows, validate } from "./ticket-template-words";
import type { TemplateView } from "./ticket-template-words";

// F-064: the ticket template editor (ticket-template.md): validation, the placeholders and the preview.

const view: TemplateView = {
  saved: null,
  builtIn: true,
  builtInTemplate: builtInTicketTemplate,
  vocabulary: Object.fromEntries(Object.entries(ticketTemplateVocabulary).map(([scope, words]) => [scope, { placeholders: [...words.placeholders], sections: [...words.sections] }])),
  maxChars: 20_000,
};

const projectId = projectIdSchema.parse("01900000-0000-7000-8000-000000000010");
const ticketId = ticketIdSchema.parse("01900000-0000-7000-8000-000000000020");

describe("the validator's verdict", () => {
  it("counts the distinct placeholders a valid template uses", () => {
    expect(validate("{{ticket.key}}: {{ticket.title}} {{ticket.key}}", builtInTicketTemplate)).toEqual({ ok: true, uses: 2 });
    expect(validate("{{#labels}}{{name}}{{/labels}}", builtInTicketTemplate)).toEqual({ ok: true, uses: 2 });
  });

  it("names the line of the first problem", () => {
    const verdict = validate("fine\n{{ticket.asignee}}", builtInTicketTemplate);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem.line).toBe(2);
  });

  it("reads a blank template as the built-in one", () => {
    expect(validate("   ", builtInTicketTemplate).ok).toBe(true);
  });

  it("shows valid in green as a status, a problem in red as an alert", () => {
    expect(renderToStaticMarkup(<ValidationLine validation={{ ok: true, uses: 10 }} saved={false} />)).toContain("Valid · uses 10 placeholders");
    expect(renderToStaticMarkup(<ValidationLine validation={{ ok: true, uses: 10 }} saved />)).toContain(t("ticketTemplate.editor.saved"));
    const bad = renderToStaticMarkup(<ValidationLine validation={{ ok: false, problem: { line: 12, message: "nope" } }} saved={false} />);
    expect(bad).toContain('role="alert"');
    expect(bad).toContain("Line 12: nope");
  });

  it("turns the refused line's number red in the gutter", () => {
    const html = renderToStaticMarkup(<TemplateEditor view={view} text={"ok\n{{nope}}"} onText={() => undefined} admin savedJustNow={false} />);
    expect(html).toContain('class="pr-3.5 text-right text-red">2<');
  });
});

describe("the editor", () => {
  it("marks the lines changed since the last save", () => {
    expect([...changedLines("a\nb\nc", "a\nB\nc\nd")]).toEqual([2, 4]);
    const html = renderToStaticMarkup(<TemplateEditor view={view} text={`${builtInTicketTemplate}\nmore`} onText={() => undefined} admin savedJustNow={false} />);
    expect(html).toContain("data-changed");
  });

  it("is read-only, without marks, for a member", () => {
    const html = renderToStaticMarkup(<TemplateEditor view={view} text={`${builtInTicketTemplate}\nmore`} onText={() => undefined} admin={false} savedJustNow={false} />);
    expect(html).toContain("readOnly");
    expect(html).not.toContain("data-changed");
  });

  it("inserts at the caret, replacing the selection", () => {
    expect(insertAt("ab", 1, 1, "{{x}}")).toEqual({ text: "a{{x}}b", caret: 6 });
    expect(insertAt("abc", 0, 2, "Z")).toEqual({ text: "Zc", caret: 1 });
  });

  it("says built-in or custom, and edited", () => {
    expect(eyebrow(view, false, false)).toBe(t("ticketTemplate.eyebrow.builtIn"));
    expect(eyebrow(view, true, false)).toBe("Built-in · edited, not saved");
    expect(eyebrow({ ...view, builtIn: false, saved: "x" }, false, true)).toBe("Custom · saved just now");
  });
});

describe("the placeholders", () => {
  it("lists every placeholder and section of the vocabulary, sections with what's inside", () => {
    const rows = placeholderRows(view.vocabulary);
    expect(rows.map((row) => row.label)).toContain("{{ticket.key}}");
    const comments = rows.find((row) => row.name === "comments");
    expect(comments?.insert).toBe("{{#comments}}{{/comments}}");
    expect(comments?.description).toContain("{{author}}");
    const html = renderToStaticMarkup(<PlaceholderList rows={rows} onInsert={() => undefined} />);
    expect(html).toContain(`aria-label="Insert {{ticket.key}}"`);
    expect(renderToStaticMarkup(<PlaceholderList rows={rows} onInsert={null} />)).not.toContain("<button");
  });
});

describe("the preview", () => {
  const props: PreviewColumnProps = {
    projectId,
    tickets: [{ id: ticketId, key: "CALC-212", title: "Division by 3 rounds the wrong way" }],
    ticketId,
    onTicket: () => undefined,
    preview: { kind: "rendered", prompt: "You're working on CALC-212\n```ticket-text\n10 / 3\n```" },
    stale: false,
    rendering: false,
  };

  it("shows the render verbatim with its length, and that it's never logged", () => {
    const html = renderToStaticMarkup(<PreviewColumn {...props} />);
    expect(html).toContain("CALC-212");
    expect(html).toContain("characters");
    expect(html).toContain(t("ticketTemplate.preview.note"));
    expect(html).toContain('class="block min-h-5 text-faint">```ticket-text');
  });

  it("dims the last render while the template doesn't pass", () => {
    expect(renderToStaticMarkup(<PreviewColumn {...props} stale />)).toContain("opacity-50");
  });

  it("with no ticket in the Inbox, says so and links to the boards", () => {
    const html = renderToStaticMarkup(<PreviewColumn {...props} tickets={[]} ticketId={null} preview={{ kind: "none" }} />);
    expect(html).toContain(t("ticketTemplate.preview.attach"));
    expect(html).toContain(`/projects/${projectId}/boards`);
  });

  it("a failed render is an alert", () => {
    expect(renderToStaticMarkup(<PreviewColumn {...props} preview={{ kind: "failed", message: "No such ticket" }} />)).toContain('role="alert"');
  });
});
