import { parseTicketTemplate } from "@ostra/domain/ticket-template";
import type { ParsedTicketTemplate, TemplateProblem } from "@ostra/domain/ticket-template";

import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The ticket template editor's pure parts (ticket-template.md, F-064): the validator's verdict
// (ticket 06's, run in the page as the admin types), the placeholder list and the edited lines.

export type TemplateView = RouterOutputs["projects"]["getTicketTemplate"];

type TemplateNode = ParsedTicketTemplate["nodes"][number];

/** The distinct placeholders a template uses, sections included. */
export const placeholdersUsed = (template: ParsedTicketTemplate): number => {
  const names = new Set<string>();
  const walk = (nodes: readonly TemplateNode[], scope: string): void => {
    for (const node of nodes) {
      if (node.type === "value") names.add(`${scope}${node.name}`);
      if (node.type === "section") {
        names.add(`${scope}#${node.name}`);
        walk(node.children, node.mode === "each" ? `${scope}${node.name}.` : scope);
      }
    }
  };
  walk(template.nodes, "");
  return names.size;
};

export type Validation = { readonly ok: true; readonly uses: number } | { readonly ok: false; readonly problem: TemplateProblem };

/** The validator's verdict on the editor's text. Blank means the built-in template. */
export const validate = (text: string, builtIn: string): Validation => {
  const parsed = parseTicketTemplate(text.trim() === "" ? builtIn : text);
  if (parsed.ok) return { ok: true, uses: placeholdersUsed(parsed.template) };
  const [first] = parsed.problems;
  return { ok: false, problem: first ?? { line: 1, message: t("errors.unknown") } };
};

/** The scope inside each section, as ticket 06's template language opens it. */
const sectionScopes: Readonly<Record<string, string>> = {
  labels: "label",
  comments: "comment",
  parent: "ticketRef",
  children: "ticketRef",
  linked: "link",
  images: "image",
};

export type PlaceholderRow = {
  readonly name: string;
  /** What a click inserts at the caret: the tag, or a section's open and close tags. */
  readonly insert: string;
  readonly label: string;
  readonly description: string;
};

const descriptions: Readonly<Record<string, MessageKey>> = {
  "ticket.key": "ticketTemplate.placeholders.describe.ticket_key",
  "ticket.title": "ticketTemplate.placeholders.describe.ticket_title",
  "ticket.url": "ticketTemplate.placeholders.describe.ticket_url",
  "ticket.status": "ticketTemplate.placeholders.describe.ticket_status",
  "ticket.priority": "ticketTemplate.placeholders.describe.ticket_priority",
  "ticket.description": "ticketTemplate.placeholders.describe.ticket_description",
  "task.branch": "ticketTemplate.placeholders.describe.task_branch",
  "instructions": "ticketTemplate.placeholders.describe.instructions",
  "labels": "ticketTemplate.placeholders.describe.labels",
  "comments": "ticketTemplate.placeholders.describe.comments",
  "parent": "ticketTemplate.placeholders.describe.parent",
  "children": "ticketTemplate.placeholders.describe.children",
  "linked": "ticketTemplate.placeholders.describe.linked",
  "images": "ticketTemplate.placeholders.describe.images",
};

/** The description of a placeholder or section the editor knows; empty for one added later. */
const describe = (name: string): string => {
  const key = descriptions[name];
  return key === undefined ? "" : t(key);
};

/** Every placeholder and section the template may use, from the server's vocabulary. */
export const placeholderRows = (vocabulary: TemplateView["vocabulary"]): readonly PlaceholderRow[] => {
  const root = vocabulary["root"];
  if (root === undefined) return [];
  return [
    ...root.placeholders.map((name) => ({ name, insert: `{{${name}}}`, label: `{{${name}}}`, description: describe(name) })),
    ...root.sections.map((name) => {
      const scope = sectionScopes[name];
      const fields = scope === undefined ? [] : (vocabulary[scope]?.placeholders ?? []);
      const inside = fields.map((field) => `{{${field}}}`).join(", ");
      return {
        name,
        insert: `{{#${name}}}{{/${name}}}`,
        label: `{{#${name}}}`,
        description: inside === "" ? describe(name) : t("ticketTemplate.placeholders.withFields", { description: describe(name), fields: inside }),
      };
    }),
  ];
};

/** The 1-based lines of `current` that differ from `saved`, for the gutter's marks. */
export const changedLines = (saved: string, current: string): ReadonlySet<number> => {
  const before = saved.split("\n");
  const changed = new Set<number>();
  current.split("\n").forEach((line, i) => {
    if (before[i] !== line) changed.add(i + 1);
  });
  return changed;
};

/** `text` with `insert` put in place of the selection from `start` to `end`. */
export const insertAt = (text: string, start: number, end: number, insert: string): { readonly text: string; readonly caret: number } => ({
  text: `${text.slice(0, start)}${insert}${text.slice(end)}`,
  caret: start + insert.length,
});

/** The eyebrow over the title: built-in or custom, and whether the editor holds unsaved edits. */
export const eyebrow = (view: TemplateView, edited: boolean, savedJustNow: boolean): string => {
  if (edited) return `${view.builtIn ? t("ticketTemplate.eyebrow.builtInShort") : t("ticketTemplate.eyebrow.custom")} · ${t("ticketTemplate.eyebrow.edited")}`;
  if (view.builtIn) return t("ticketTemplate.eyebrow.builtIn");
  return savedJustNow ? `${t("ticketTemplate.eyebrow.custom")} · ${t("ticketTemplate.eyebrow.saved", { age: "just now" })}` : t("ticketTemplate.eyebrow.custom");
};

/** The text the editor starts from: the saved template, or the built-in one. */
export const startingText = (view: TemplateView): string => view.saved ?? view.builtInTemplate;
