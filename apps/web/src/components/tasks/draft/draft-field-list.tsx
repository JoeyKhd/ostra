"use client";

import { ChevronRightIcon, GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import type { RefineDraft } from "@ostra/protocol";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { plural, t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

import { lineCount, markItems, moveItem } from "./draft-words";

// The draft's fields (refine-draft.md, "The Draft tab", item 2): a label with its count, then the
// field. A list's item is a 30px row: its grip (a menu to move it, and `Alt`+arrows in its input),
// its number, a single-line input and its `x`. An item a member changed says so under it, with the
// agent's words; an agent's item a member removed leaves a line with "Restore".

/** A field's 12px `--faint` label, with a mono count for a list. */
export const FieldLabel = ({ label, count, htmlFor }: { readonly label: string; readonly count?: ReactNode; readonly htmlFor?: string }) => (
  <div className="mb-1.5 flex items-baseline gap-2.5 text-sm text-faint">
    {htmlFor === undefined ? <span>{label}</span> : <label htmlFor={htmlFor}>{label}</label>}
    {count === undefined ? null : <span className="font-mono">{count}</span>}
  </div>
);

/** Who changed an item, as its line says it. */
export type Editor = { readonly you: boolean; readonly name: string };

const editedWords = (editor: Editor): string => (editor.you ? t("draft.editedByYou") : t("draft.editedBy", { name: editor.name }));

export const DraftList = ({ field, label, add, items, agent, editor, editable, onChange }: {
  readonly field: "acceptanceCriteria" | "edgeCases" | "openQuestions";
  readonly label: string;
  /** "Add a criterion" and the like. */
  readonly add: MessageKey;
  readonly items: readonly string[];
  /** The agent's newest version of this list, when a member's version is shown. */
  readonly agent: readonly string[] | null;
  readonly editor: Editor | null;
  readonly editable: boolean;
  readonly onChange: (items: readonly string[]) => void;
}) => {
  const { marks, removed } = markItems(items, editor === null ? null : agent);
  const id = (index: number) => `draft-${field}-${String(index)}`;
  const focus = (index: number) => {
    setTimeout(() => { document.getElementById(id(index))?.focus(); }, 0);
  };
  const move = (index: number, by: -1 | 1) => {
    onChange(moveItem(items, index, by));
    focus(index + by);
  };
  return (
    <section data-field={field} aria-label={label}>
      <FieldLabel label={label} count={items.length} />
      {editable ? null : (
        <ol className="space-y-1">
          {items.map((item, index) => (
            <li key={`${String(index)}-${item}`} className="flex items-baseline gap-3 text-body text-text" data-item={index}>
              <span className="w-4 shrink-0 text-right font-mono text-sm text-muted">{index + 1}</span>
              <span className="min-w-0 break-words">{item}</span>
            </li>
          ))}
        </ol>
      )}
      {!editable ? null : (
        <ol>
          {items.map((item, index) => {
            const mark = marks[index];
            return (
              <li key={index} data-item={index}>
                <div className="flex min-h-[30px] items-center gap-2 py-px">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="hidden size-5 shrink-0 place-items-center rounded-sm text-faint hover:text-muted min-[760px]:grid" aria-label={t("draft.reorder", { n: index + 1 })}>
                        <GripVerticalIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem disabled={index === 0} onSelect={() => { move(index, -1); }}>{t("draft.moveUp")}</DropdownMenuItem>
                      <DropdownMenuItem disabled={index === items.length - 1} onSelect={() => { move(index, 1); }}>{t("draft.moveDown")}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span className="w-4 shrink-0 text-right font-mono text-sm text-muted">{index + 1}</span>
                  <Input
                    id={id(index)}
                    aria-label={t("draft.itemLabel", { field: label, n: index + 1 })}
                    className="h-[26px] min-w-0 flex-1 rounded-[6px] px-2 text-ui"
                    value={item}
                    onChange={(event) => { onChange(items.map((one, at) => (at === index ? event.target.value : one))); }}
                    onKeyDown={(event) => {
                      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                        event.preventDefault();
                        move(index, event.key === "ArrowUp" ? -1 : 1);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="grid size-6 shrink-0 place-items-center rounded-sm text-faint hover:bg-sel hover:text-text"
                    aria-label={t("draft.removeItem", { field: label, n: index + 1 })}
                    onClick={() => { onChange(items.filter((_, at) => at !== index)); }}
                  >
                    <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                  </button>
                </div>
                {editor === null || mark === undefined || mark.kind === "same" ? null : (
                  <p className="pb-1 pl-6 text-[11.5px] text-faint min-[760px]:pl-[52px]" data-testid="draft-edited">
                    {mark.kind === "edited" ? `${editedWords(editor)} · ${t("draft.agentWas", { text: mark.agent })}` : editor.you ? t("draft.addedByYou") : t("draft.addedBy", { name: editor.name })}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {editor === null || !editable
        ? null
        : removed.map((gone) => (
            <p key={`${String(gone.index)}-${gone.text}`} className="flex items-center gap-2 py-0.5 pl-6 text-[11.5px] text-faint min-[760px]:pl-[52px]">
              <span className="min-w-0 truncate">{editor.you ? t("draft.removedByYou", { text: gone.text }) : t("draft.removedBy", { name: editor.name, text: gone.text })}</span>
              <Button variant="link" className="text-[11.5px]" onClick={() => { onChange([...items.slice(0, gone.index), gone.text, ...items.slice(gone.index)]); }}>{t("draft.restore")}</Button>
            </p>
          ))}
      {editable ? (
        <Button
          variant="link"
          className="mt-1 gap-1 pl-1 text-[12.5px]"
          onClick={() => {
            onChange([...items, ""]);
            focus(items.length);
          }}
        >
          <PlusIcon aria-hidden /> {t(add)}
        </Button>
      ) : null}
    </section>
  );
};

/** The sub-tickets: a row per sub-ticket, its title in an input, expanding to its text. */
export const DraftSubTickets = ({ items, editable, onChange, applied }: {
  readonly items: RefineDraft["subTickets"];
  readonly editable: boolean;
  readonly onChange: (items: RefineDraft["subTickets"]) => void;
  /** Once applied: each sub-ticket's key and address, by place. */
  readonly applied: readonly { readonly key: string; readonly url: string | null }[] | null;
}) => {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (index: number) => {
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const label = t("draft.subTickets");
  return (
    <section data-field="subTickets" aria-label={label}>
      <FieldLabel label={label} count={items.length} />
      <ul className="space-y-1.5">
        {items.map((sub, index) => {
          const made = applied?.[index];
          if (!editable) {
            return (
              <li key={`${String(index)}-${sub.title}`} className="flex min-h-[28px] items-center gap-3 text-body" data-item={index}>
                {made === undefined ? null : <span className="shrink-0 font-mono text-ui text-teal">{made.key}</span>}
                <span className="min-w-0 flex-1 truncate text-text">{sub.title}</span>
                {made?.url === null || made?.url === undefined ? null : (
                  <a href={made.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-ui text-teal hover:underline">{t("draft.subIssueLink")}</a>
                )}
              </li>
            );
          }
          const expanded = open.has(index);
          return (
            <li key={index} data-item={index}>
              <div className="flex min-h-[30px] items-center gap-2 py-px">
                <button type="button" className="grid size-5 shrink-0 place-items-center rounded-sm text-muted hover:text-text" aria-expanded={expanded} aria-label={t("draft.expandSubTicket", { n: index + 1 })} onClick={() => { toggle(index); }}>
                  <ChevronRightIcon aria-hidden className={cn("size-[14px] stroke-[1.75] transition-transform", expanded && "rotate-90")} />
                </button>
                <div className="flex min-h-[30px] min-w-0 flex-1 items-center rounded-[6px] border border-control-line bg-surface pr-2 focus-within:border-faint">
                  <input
                    aria-label={t("draft.subTicketTitle", { n: index + 1 })}
                    className="h-full min-w-0 flex-1 bg-transparent px-2 text-ui text-text outline-none"
                    value={sub.title}
                    onChange={(event) => { onChange(items.map((one, at) => (at === index ? { ...one, title: event.target.value } : one))); }}
                  />
                  <span className="shrink-0 font-mono text-sm text-faint">{plural(lineCount(sub.description), "draft.lines.one", "draft.lines.other")}</span>
                </div>
                <button type="button" className="grid size-6 shrink-0 place-items-center rounded-sm text-faint hover:bg-sel hover:text-text" aria-label={t("draft.removeSubTicket", { n: index + 1 })} onClick={() => { onChange(items.filter((_, at) => at !== index)); }}>
                  <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                </button>
              </div>
              {expanded ? (
                <Textarea
                  aria-label={t("draft.subTicketText", { n: index + 1 })}
                  className="ml-7 mt-1 w-[calc(100%-28px-32px)] text-ui [field-sizing:content]"
                  value={sub.description}
                  onChange={(event) => { onChange(items.map((one, at) => (at === index ? { ...one, description: event.target.value } : one))); }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {editable && items.length < 20 ? (
        <Button variant="link" className="mt-1 gap-1 pl-1 text-[12.5px]" onClick={() => { onChange([...items, { title: "", description: "" }]); }}>
          <PlusIcon aria-hidden /> {t("draft.addSubTicket")}
        </Button>
      ) : null}
    </section>
  );
};
