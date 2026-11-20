"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleXIcon, EyeOffIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

import type { ProjectId, TicketId } from "@ostra/protocol";

import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatCount } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { changedLines, eyebrow, insertAt, placeholderRows, startingText, validate } from "./ticket-template-words";
import type { PlaceholderRow, TemplateView, Validation } from "./ticket-template-words";

/** A ticket of the project's Inbox, to preview the template on. */
export type PreviewTicket = { readonly id: TicketId; readonly key: string; readonly title: string };

/** What the preview box holds: a render, a problem the server found, or nothing yet. */
export type PreviewState =
  | { readonly kind: "none" }
  | { readonly kind: "rendered"; readonly prompt: string }
  | { readonly kind: "failed"; readonly message: string };

const PREVIEW_DELAY_MS = 400;
const SAVED_FOR_MS = 4000;

/** The line under the editor: valid (and how many placeholders), saved, or the validator's problem. */
export const ValidationLine = ({ validation, saved }: { readonly validation: Validation; readonly saved: boolean }) =>
  validation.ok ? (
    <p role="status" className="mt-2 flex items-center gap-1.5 text-ui text-green">
      <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" />
      {saved ? t("ticketTemplate.editor.saved") : plural(validation.uses, "ticketTemplate.editor.valid.one", "ticketTemplate.editor.valid.other")}
    </p>
  ) : (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-ui text-red">
      <CircleXIcon aria-hidden className="mt-[3px] size-[14px] shrink-0 stroke-[1.75]" />
      {t("ticketTemplate.editor.problem", { line: validation.problem.line, message: validation.problem.message })}
    </p>
  );

/** The placeholders a template may use; a click inserts one at the caret (admins only). */
export const PlaceholderList = ({ rows, onInsert }: { readonly rows: readonly PlaceholderRow[]; readonly onInsert: ((row: PlaceholderRow) => void) | null }) => (
  <Section title={t("ticketTemplate.placeholders.title")} count={rows.length}>
    <ul className="rows" data-testid="placeholders">
      {rows.map((row) => {
        const cells = (
          <>
            <span className="truncate font-mono text-ui text-text">{row.label}</span>
            <span className="min-w-0 text-ui text-muted">{row.description}</span>
          </>
        );
        const grid = "grid min-h-[34px] w-full grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-center gap-4 py-1 text-left sm:grid-cols-[220px_minmax(0,1fr)]";
        return (
          <li key={row.name}>
            {onInsert === null ? (
              <div className={grid}>{cells}</div>
            ) : (
              <button type="button" className={cn(grid, "hover:bg-hover")} aria-label={t("ticketTemplate.placeholders.insert", { name: row.label })} onClick={() => { onInsert(row); }}>
                {cells}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  </Section>
);

/** The rendered prompt, verbatim: the fence lines of the marked blocks in `--faint`. */
const PromptText = ({ prompt }: { readonly prompt: string }) => (
  <>
    {prompt.split("\n").map((line, i) => (
      <span key={`${String(i)}-${line}`} className={cn("block min-h-5", line.startsWith("```") ? "text-faint" : "text-text")}>
        {line === "" ? "​" : line}
      </span>
    ))}
  </>
);

export type PreviewColumnProps = {
  readonly projectId: ProjectId;
  readonly tickets: readonly PreviewTicket[] | undefined;
  readonly ticketId: TicketId | null;
  readonly onTicket: (id: TicketId) => void;
  readonly preview: PreviewState;
  /** The template in the editor doesn't pass: the last good render stays, dimmed. */
  readonly stale: boolean;
  readonly rendering: boolean;
};

/** The right half: the render of the editor's template on one Inbox ticket. */
export const PreviewColumn = ({ projectId, tickets, ticketId, onTicket, preview, stale, rendering }: PreviewColumnProps) => {
  const none = tickets?.length === 0;
  const [before = "", after = ""] = t("ticketTemplate.preview.empty").split("{link}");
  return (
    <section className="mt-[26px] min-w-0">
      <div className="mb-1 flex h-[30px] items-center gap-2">
        <h2 className="text-body font-semibold">{t("ticketTemplate.preview.title")}</h2>
        <span className="text-ui text-muted">{t("ticketTemplate.preview.on")}</span>
        <Select value={ticketId ?? ""} onValueChange={(value) => { const ticket = tickets?.find((item) => item.id === value); if (ticket !== undefined) onTicket(ticket.id); }} disabled={tickets === undefined || none}>
          <SelectTrigger aria-label={t("ticketTemplate.preview.ticket")} className="h-[30px] min-w-0 max-w-[340px] font-mono text-sm">
            <SelectValue placeholder={t("ticketTemplate.preview.noTicket")} />
          </SelectTrigger>
          <SelectContent align="start">
            {tickets?.map((ticket) => (
              <SelectItem key={ticket.id} value={ticket.id}>
                <span className="font-mono text-sm text-text">{ticket.key}</span>
                <span className="truncate text-sm text-muted">{ticket.title}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {preview.kind === "rendered" ? (
          <span className="ml-auto shrink-0 font-mono text-xs text-faint">{t("ticketTemplate.preview.chars", { n: formatCount(preview.prompt.length) })}</span>
        ) : null}
      </div>
      <div className="relative overflow-hidden rounded-lg border border-line-2 bg-surface" data-testid="template-preview">
        {rendering ? <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-line-2" /> : null}
        <div className={cn("max-h-[70vh] min-h-[240px] overflow-y-auto whitespace-pre-wrap break-words px-[18px] py-3.5 font-mono text-ui leading-5", stale && "opacity-50")}>
          {none ? (
            <p className="font-sans text-ui text-muted">
              {before}
              <Link href={`/projects/${projectId}/boards`} className="text-teal hover:underline">
                {t("ticketTemplate.preview.attach")}
              </Link>
              {after}
            </p>
          ) : preview.kind === "rendered" ? (
            <PromptText prompt={preview.prompt} />
          ) : preview.kind === "failed" ? (
            <p role="alert" className="flex items-start gap-1.5 font-sans text-red">
              <CircleXIcon aria-hidden className="mt-[3px] size-[14px] shrink-0 stroke-[1.75]" />
              {preview.message}
            </p>
          ) : (
            <div className="space-y-2.5" aria-busy>
              <Skeleton className="w-3/4" />
              <Skeleton className="w-1/2" />
              <Skeleton className="w-2/3" />
            </div>
          )}
        </div>
      </div>
      <p className="mt-2.5 flex items-center gap-2 text-xs text-faint">
        <EyeOffIcon aria-hidden className="size-[13px] stroke-[1.75]" />
        {t("ticketTemplate.preview.note")}
      </p>
    </section>
  );
};

export type TemplateEditorProps = {
  readonly view: TemplateView;
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly admin: boolean;
  readonly savedJustNow: boolean;
  readonly editorRef?: Ref<HTMLTextAreaElement>;
};

/** The left half: the editor, its validation line. */
export const TemplateEditor = ({ view, text, onText, admin, savedJustNow, editorRef }: TemplateEditorProps) => {
  const validation = validate(text, view.builtInTemplate);
  return (
    <Section title={t("ticketTemplate.editor.title")} note={t("ticketTemplate.editor.note")} className="min-w-0">
      <CodeEditor
        id="ticket-template"
        label={t("ticketTemplate.editor.label")}
        value={text}
        onChange={onText}
        readOnly={!admin}
        highlightTags
        minLines={12}
        changedLines={admin ? changedLines(startingText(view), text) : new Set()}
        errorLine={validation.ok ? null : validation.problem.line}
        {...(editorRef === undefined ? {} : { textareaRef: editorRef })}
      />
      <ValidationLine validation={validation} saved={savedJustNow} />
    </Section>
  );
};

const Loading = () => (
  <div className="grid gap-7 xl:grid-cols-2">
    <div className="mt-[26px] space-y-3" aria-busy>
      <Skeleton className="w-[120px]" />
      <Skeleton className="h-[264px] w-full rounded-lg" />
    </div>
    <div className="mt-[26px] space-y-3" aria-busy>
      <Skeleton className="w-[160px]" />
      <Skeleton className="h-[264px] w-full rounded-lg" />
    </div>
  </div>
);

/**
 * Project › Settings › Ticket template (F-064; ticket-template.md): the template a ticket task's
 * first prompt is rendered from, beside its render on one of the Inbox's tickets.
 */
export const TicketTemplateView = ({ projectId, tickets }: { readonly projectId: ProjectId; readonly tickets: readonly PreviewTicket[] | undefined }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const admin = project.data?.role === "admin";
  const template = useQuery({ ...trpc.projects.getTicketTemplate.queryOptions({ projectId }), enabled: admin });
  const [edited, setEdited] = useState<string | null>(null);
  const [savedJustNow, setSavedJustNow] = useState(false);
  const [chosen, setChosen] = useState<TicketId | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "none" });
  const editor = useRef<HTMLTextAreaElement>(null);
  const view = template.data;
  const text = edited ?? (view === undefined ? "" : startingText(view));
  const dirty = view !== undefined && edited !== null && edited !== startingText(view);
  const validation = view === undefined ? null : validate(text, view.builtInTemplate);
  const ticketId = chosen ?? tickets?.[0]?.id ?? null;

  const onSaved = async (next: TemplateView) => {
    queryClient.setQueryData(trpc.projects.getTicketTemplate.queryKey({ projectId }), next);
    setEdited(null);
    setSavedJustNow(true);
    setTimeout(() => { setSavedJustNow(false); }, SAVED_FOR_MS);
    await queryClient.invalidateQueries({ queryKey: trpc.projects.getTicketTemplate.queryKey({ projectId }) });
  };
  const save = useMutation(trpc.projects.saveTicketTemplate.mutationOptions({ onSuccess: async (result) => { if (result.saved) await onSaved(result.template); } }));
  const render = useMutation(
    trpc.projects.previewTicketTemplate.mutationOptions({
      onSuccess: (result) => {
        if (result.rendered) setPreview({ kind: "rendered", prompt: result.prompt });
      },
      onError: (error) => { setPreview({ kind: "failed", message: errorText(error) ?? t("errors.unknown") }); },
    }),
  );
  const renderPreview = render.mutate;

  // The preview follows the editor 400ms after typing stops, while the template passes.
  const valid = validation?.ok === true;
  useEffect(() => {
    if (!admin || ticketId === null || !valid) return;
    const timer = setTimeout(() => { renderPreview({ projectId, ticketId, template: text }); }, PREVIEW_DELAY_MS);
    return () => { clearTimeout(timer); };
  }, [admin, projectId, ticketId, text, valid, renderPreview]);

  // The browser asks before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); };
  }, [dirty]);

  const insert = (row: PlaceholderRow) => {
    const area = editor.current;
    const start = area?.selectionStart ?? text.length;
    const end = area?.selectionEnd ?? text.length;
    const next = insertAt(text, start, end, row.insert);
    setEdited(next.text);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(next.caret, next.caret);
    });
  };

  const saveProblem = save.data?.saved === false ? save.data.problems[0] : undefined;
  const failure: ReactNode =
    save.error !== null ? errorText(save.error) : saveProblem === undefined ? null : t("ticketTemplate.editor.problem", { line: saveProblem.line, message: saveProblem.message });

  return (
    <PageFrame
      crumbs={[
        { label: project.data?.name ?? "", href: `/projects/${projectId}` },
        { label: t("ticketTemplate.settings") },
        { label: t("ticketTemplate.title") },
      ]}
      actions={
        admin && view !== undefined ? (
          <>
            {view.builtIn ? null : (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" disabled={save.isPending}>{t("ticketTemplate.reset")}</Button>
                </AlertDialogTrigger>
                <AlertDialogContent
                  title={t("ticketTemplate.resetTitle")}
                  body={t("ticketTemplate.resetBody")}
                  cancel={t("common.cancel")}
                  action={t("ticketTemplate.resetAction")}
                  onAction={() => { save.mutate({ projectId, template: null }); }}
                />
              </AlertDialog>
            )}
            <Button variant="primary" className="ml-1" disabled={!dirty || validation?.ok !== true || save.isPending} onClick={() => { save.mutate({ projectId, template: text }); }}>
              {save.isPending ? t("common.saving") : t("ticketTemplate.save")}
            </Button>
          </>
        ) : undefined
      }
    >
      <PageHeading
        eyebrow={view === undefined ? <Skeleton className="w-[160px]" /> : eyebrow(view, dirty, savedJustNow)}
        title={t("ticketTemplate.title")}
        lede={admin || project.data === undefined ? t("ticketTemplate.lede") : `${t("ticketTemplate.lede")} ${t("ticketTemplate.readOnly")}`}
      />
      {failure === null ? null : <p role="alert" className="mt-2 text-ui text-red">{failure}</p>}
      {project.data !== undefined && !admin ? (
        <p className="mt-6 text-body text-muted">{t("common.adminsOnly")}</p>
      ) : view === undefined ? (
        template.isError ? (
          <p role="alert" className="mt-6 text-ui text-red">{errorText(template.error)}</p>
        ) : (
          <Loading />
        )
      ) : (
        <div className="grid gap-x-7 xl:grid-cols-2">
          <div className="min-w-0">
            <TemplateEditor view={view} text={text} onText={setEdited} admin={admin} savedJustNow={savedJustNow} editorRef={editor} />
            <div className="hidden xl:block">
              <PlaceholderList rows={placeholderRows(view.vocabulary)} onInsert={admin ? insert : null} />
            </div>
          </div>
          <PreviewColumn projectId={projectId} tickets={tickets} ticketId={ticketId} onTicket={setChosen} preview={preview} stale={!valid} rendering={render.isPending} />
          <div className="xl:hidden">
            <PlaceholderList rows={placeholderRows(view.vocabulary)} onInsert={admin ? insert : null} />
          </div>
        </div>
      )}
    </PageFrame>
  );
};
