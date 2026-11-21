"use client";

import { ChevronDownIcon, CircleAlertIcon, ImageOffIcon, LoaderCircleIcon, PaperclipIcon, RotateCcwIcon, TicketIcon } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { FileLimits } from "@ostra/domain/file-limits";
import { FILES_ROOT_DIR, TICKET_FILES_FOLDER } from "@ostra/protocol";

import { PropRow } from "@/components/shell/page-frame";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatAge } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { AgentMarkdown } from "@/task/renderers";

import { FileChipLink, LinkChip, MissingChip } from "./file-chip";
import { FileThumb, MissingThumb, MoreThumb } from "./file-thumb";
import { extensionOf, stripOf } from "./file-words";
import type { ThreadFile } from "./file-words";
import { imageName, LeftOutList } from "./message-files";
import { attachmentsCountText, contextMetaText, contextRowText, failureText, nameJoiners, shownComments, ticketCounts } from "./ticket-context-words";
import type { TicketAttachment, TicketContextView } from "./ticket-context-words";

// "What the agent got" (ticket-context.md; F-149, F-150): a ticket task's first message, before the
// agent's first turn. The ticket's description (three lines, `Show all`), its files (pictures in
// milestone 8's strip, the rest as chips, links listed and not fetched), its comments (the newest
// two, `Show {n} more`), and where it all is in the box with `Show the prompt`. What the ticket's
// limits left out is listed with why; what didn't load keeps its place, dashed, with Retry for the
// driver. Every string in it is the ticket's: drawn as text, never HTML.

/** Where the ticket's files are in the box: `.ostra/ticket/`. */
export const TICKET_FOLDER = `${FILES_ROOT_DIR}/${TICKET_FILES_FOLDER}/`;

/** The picture extensions a failed file's place is a picture tile for: it never arrived, so its kind is its name's. */
const PICTURES: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp"];

/** A section's label: 12px 500 `--faint`, 12px under the last, with its count in mono. */
const Section = ({ label, count, children }: { readonly label: string; readonly count?: string; readonly children: ReactNode }) => (
  <section className="mt-3" aria-label={label}>
    <p className="flex items-center gap-1.5 text-xs font-medium text-faint">
      {label}
      {count === undefined ? null : <span className="font-mono">{count}</span>}
    </p>
    {children}
  </section>
);

/** A teal `Show all ⌄` / `Show less ⌃`, a button with `aria-expanded`. */
const Toggle = ({ open, onToggle, children }: { readonly open: boolean; readonly onToggle: () => void; readonly children: ReactNode }) => (
  <button type="button" aria-expanded={open} onClick={onToggle} className="mt-[3px] inline-flex items-center gap-1 text-[13.5px] text-teal hover:underline">
    {children}
    <ChevronDownIcon aria-hidden className={cn("size-[14px] stroke-[1.75] transition-transform", open && "rotate-180")} />
  </button>
);

/** The description, clamped to three lines (four on a phone) with `Show all` when it's longer. */
const Description = ({ text }: { readonly text: string }) => {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || open) return undefined;
    const measure = () => { setLong(element.scrollHeight > element.clientHeight + 1); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [open, text]);
  return (
    <>
      <div ref={box} className={cn("mt-[3px] text-body text-text [&_.agent-md>p:first-child]:mt-0", !open && "line-clamp-3 max-sm:line-clamp-4")} data-part="ticket-description">
        <AgentMarkdown text={text} />
      </div>
      {long || open ? (
        <Toggle open={open} onToggle={() => { setOpen((now) => !now); }}>
          {open ? t("task.ticketContext.showLess") : t("task.ticketContext.showAll")}
        </Toggle>
      ) : null}
    </>
  );
};

/** The comments: one 28px row each, the newest two first shown, each wrapping in full once all show. */
const Comments = ({ comments, now }: { readonly comments: TicketContextView["comments"]; readonly now: number }) => {
  const [all, setAll] = useState(false);
  const { shown, hidden } = shownComments(comments, all);
  return (
    <>
      <ul className="mt-1">
        {shown.map((comment, index) => (
          <li key={`${String(comment.at)}-${String(index)}`} className={cn("grid min-h-7 grid-cols-[20px_auto_minmax(0,1fr)] items-center gap-x-2 text-ui", all && "items-start py-1")}>
            <Avatar name={comment.author} className={cn("size-5 text-[9px]", all && "mt-px")} />
            <span className="whitespace-nowrap font-medium">
              {comment.author}
              <span className="ml-1.5 font-mono text-[12.5px] font-normal text-faint">{formatAge(comment.at, now)}</span>
            </span>
            <span className={cn("min-w-0 text-text-2", all ? "whitespace-pre-wrap break-words" : "truncate max-sm:line-clamp-2 max-sm:whitespace-normal")}>{comment.body}</span>
          </li>
        ))}
      </ul>
      {hidden === 0 && !all ? null : (
        <Toggle open={all} onToggle={() => { setAll((now) => !now); }}>
          {all ? t("task.ticketContext.showLess") : t("task.ticketContext.showMore", { n: hidden })}
        </Toggle>
      )}
    </>
  );
};

/** The ticket's files: pictures in the strip, the rest as chips, then the links; failed ones keep their place. */
const Files = ({ view, agent, onOpenImage }: { readonly view: TicketContextView; readonly agent: string; readonly onOpenImage: ((file: ThreadFile) => void) | null }) => {
  const present = view.attachments.filter((one): one is Exclude<TicketAttachment, { readonly state: "left-out" }> => one.state !== "left-out");
  const picture = (one: (typeof present)[number]) => (one.state === "ready" ? one.file.kind === "image" : PICTURES.includes(extensionOf(one.name)));
  const pictures = present.filter(picture);
  const others = present.filter((one) => !picture(one));
  const { shown, more } = stripOf(pictures);
  const sixth = pictures[shown.length];
  return (
    <>
      {pictures.length === 0 ? null : (
        <div className="mt-1.5 flex items-end gap-3 overflow-x-auto pb-1" data-testid="ticket-images">
          {shown.map((one, index) =>
            one.state === "ready" ? (
              <FileThumb key={one.file.fileId} src={one.file.downloadPath} name={imageName(one.file.name, view.ticketKey)} onOpen={onOpenImage === null ? null : () => { onOpenImage(one.file); }} />
            ) : (
              <MissingThumb key={`missing-${String(index)}`} name={one.name} />
            ),
          )}
          {more === 0 ? null : <MoreThumb more={more} onOpen={onOpenImage === null || sixth?.state !== "ready" ? null : () => { onOpenImage(sixth.file); }} />}
        </div>
      )}
      {others.length + view.links.length === 0 ? null : (
        <div className="mt-2.5 flex flex-wrap gap-2 max-sm:flex-col" data-testid="ticket-file-chips">
          {others.map((one, index) => (one.state === "ready" ? <FileChipLink key={one.file.fileId} file={one.file} agent={agent} /> : <MissingChip key={`missing-${String(index)}`} name={one.name} />))}
          {view.links.map((link, index) => (
            <LinkChip key={`${link.url}-${String(index)}`} title={link.title === "" ? link.url : link.title} href={link.url} />
          ))}
        </div>
      )}
    </>
  );
};

/** What didn't load: a 2px red rule, the names and why, Retry for the driver. */
const Failed = ({ view, retry }: { readonly view: TicketContextView; readonly retry: { readonly run: () => void; readonly pending: boolean } | null }) => {
  const names = view.attachments.flatMap((one) => (one.state === "failed" ? [one.name] : []));
  if (names.length === 0) return null;
  return (
    <div className="mt-2.5 border-l-2 border-red pl-3" data-testid="ticket-files-failed">
      <p className="flex items-center gap-2 text-ui font-medium text-red">
        <CircleAlertIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75]" />
        {plural(names.length, "task.ticketContext.failedOne", "task.ticketContext.failed", { tracker: view.tracker })}
      </p>
      <p className="mt-[3px] text-[13.5px] text-muted">
        {names.map((name, index) => (
          <Fragment key={`${name}-${String(index)}`}>
            <span className="font-mono text-ui text-text">{name}</span>
            {nameJoiners(names.length)[index]}
          </Fragment>
        ))}
        {t("task.ticketContext.failedWhy", { why: failureText(view.failure, view.tracker) })}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-faint">
        {retry === null ? null : (
          <Button size="sm" disabled={retry.pending} onClick={retry.run} data-action="retry-ticket-files">
            <RotateCcwIcon aria-hidden />
            {retry.pending ? t("task.ticketContext.retrying") : t("task.ticketContext.retry")}
          </Button>
        )}
        <span>{t("task.ticketContext.startedWithout")}</span>
      </div>
    </div>
  );
};

/** The last line: where it all is in the box, and the rendered prompt one click away. */
const LastLine = ({ view }: { readonly view: TicketContextView }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13.5px] text-muted" data-testid="ticket-context-where">
        <PaperclipIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" />
        <span className="min-w-0">
          {t("task.ticketContext.inTheBox")} <span className="font-mono text-ui text-text">{TICKET_FOLDER}</span>
          {t("task.ticketContext.inTheBoxWith")}
          {view.imagesAsFilesFor === null ? null : t("task.ticketContext.imagesAsFiles", { model: view.imagesAsFilesFor })}
        </span>
        {view.prompt === null ? null : (
          <>
            <span aria-hidden className="text-faint">·</span>
            <button type="button" aria-expanded={open} onClick={() => { setOpen((now) => !now); }} className="inline-flex items-center gap-[3px] text-teal hover:underline" data-action="show-prompt">
              {open ? t("task.ticketContext.hidePrompt") : t("task.ticketContext.showPrompt")}
              <ChevronDownIcon aria-hidden className={cn("size-[14px] stroke-[1.75] transition-transform", open && "rotate-180")} />
            </button>
          </>
        )}
      </p>
      {open && view.prompt !== null ? (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3.5 py-2.5 font-mono text-xs leading-[1.6] text-text" data-testid="ticket-prompt">
          {view.prompt}
        </pre>
      ) : null}
    </>
  );
};

export const TicketContextMessage = ({ view, agent, limits, now, retry, onOpenImage }: {
  readonly view: TicketContextView;
  readonly agent: string;
  /** The ticket's limits (`OSTRA_TICKET_FILES_*`), for the left-out reasons. */
  readonly limits: FileLimits;
  readonly now: number;
  /** Retry (`tasks.retryTicketFiles`), for the driver; `null` for anyone else. */
  readonly retry: { readonly run: () => void; readonly pending: boolean } | null;
  readonly onOpenImage: ((file: ThreadFile) => void) | null;
}) => {
  const counts = ticketCounts(view);
  const leftOut = view.attachments.flatMap((one) => (one.state === "left-out" ? [{ name: one.name, reason: one.reason, size: one.size }] : []));
  return (
    <div id="ticket-context" className="flex scroll-mt-24 gap-3 py-2.5" data-part="ticket-context" data-state={view.state}>
      <span className="mt-0.5 inline-grid size-7 shrink-0 place-items-center rounded-full border border-line-2 text-muted">
        <TicketIcon aria-hidden className="size-[14px] stroke-[1.75]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{t("task.ticketContext.title")}</span>
          <span className="font-mono text-sm text-faint">{contextMetaText(view)}</span>
        </div>
        {view.state === "fetching" ? (
          <p className="mt-1 flex items-center gap-2 text-sm text-faint" data-testid="ticket-context-fetching">
            <LoaderCircleIcon aria-hidden className="size-[11px] animate-spin" />
            {t("task.ticketContext.fetching")}
          </p>
        ) : (
          <>
            {view.description === null || view.description.trim() === "" ? null : (
              <Section label={t("task.ticketContext.description")}>
                <Description text={view.description} />
              </Section>
            )}
            {counts.total === 0 ? null : (
              <Section label={t("task.ticketContext.attachmentsLabel")} count={attachmentsCountText(counts)}>
                <Files view={view} agent={agent} onOpenImage={onOpenImage} />
                <LeftOutList notes={leftOut} scope="ticket" limits={limits} tracker={view.tracker} />
                <Failed view={view} retry={retry} />
              </Section>
            )}
            {view.filesNotOffered ? (
              <p className="mt-2.5 flex items-center gap-2 text-[13.5px] text-muted" data-testid="ticket-files-not-offered">
                <ImageOffIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" />
                {t("task.ticketContext.notOffered", { tracker: view.tracker })}
              </p>
            ) : null}
            {view.comments.length === 0 ? null : (
              <Section label={t("task.ticketContext.commentsLabel")} count={String(view.comments.length)}>
                <Comments comments={view.comments} now={now} />
              </Section>
            )}
            <LastLine view={view} />
          </>
        )}
      </div>
    </div>
  );
};

/** The Ticket group's `Context` row: what the agent got in a few words, a button that scrolls the thread to it. */
export const TicketContextRow = ({ view, onShow }: { readonly view: Pick<TicketContextView, "attachments" | "links" | "comments">; readonly onShow: () => void }) => {
  const row = contextRowText(ticketCounts(view));
  return (
    <PropRow label={t("task.ticketContext.row")}>
      <button type="button" onClick={onShow} aria-label={t("task.ticketContext.rowName", { what: row.text })} className={cn("truncate text-left hover:underline", row.failed ? "text-red" : "text-text")} data-testid="ticket-context-row">
        {row.text}
      </button>
    </PropRow>
  );
};
