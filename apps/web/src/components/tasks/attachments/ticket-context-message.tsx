"use client";

import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, ImageOffIcon, LoaderCircleIcon, PaperclipIcon, RotateCcwIcon, TicketIcon } from "lucide-react";
import { Fragment, useState } from "react";
import type { ImgHTMLAttributes, ReactNode } from "react";

import type { TicketAttachmentView, TicketContextView, TicketRoundView } from "@ostra/api";
import { FILES_ROOT_DIR, TICKET_FILES_FOLDER } from "@ostra/protocol";
import type { MessageFileId } from "@ostra/protocol";
import type { MessageFileView } from "@ostra/task-view";

import { PropRow } from "@/components/shell/page-frame";
import { TrackerMark, trackerMarkAt } from "@/components/trackers/tracker-mark";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatAge, formatClock } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { AgentMarkdown } from "@/task/renderers";

import { FileChipLink, LinkChip, MissingChip } from "./file-chip";
import { FileThumb, MissingThumb, MoreThumb } from "./file-thumb";
import { extensionOf, stripOf } from "./file-words";
import { imageName, LeftOutList } from "./message-files";
import { attachmentsCountText, contextRowText, failureText, nameJoiners, shownAttachments, shownComments, ticketCounts } from "./ticket-context-words";

// "What the agent got" (ticket-context.md; F-149, F-150): a ticket task's first message, before the
// agent's first turn, from `tasks.ticketContext`'s first round. The ticket's description (three
// lines, `Show all`), its files (pictures in milestone 8's strip, the rest as chips, links listed and
// not fetched), its comments (the newest two, `Show {n} more`), and where it all is in the box with
// `Show the prompt`. What the ticket's limits left out is listed with why; what didn't load keeps
// its place, dashed, with Retry for the driver. Every string in it is the ticket's: drawn as text,
// never HTML.

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

/**
 * The description, clamped to three lines (four on a phone) while the bubble shows its summary,
 * whole once it shows it all. A picture in it that ostra stored shows as its name in teal, opening
 * the viewer.
 */
const Description = ({ text, pictures, onOpen, clamp }: {
  readonly text: string;
  readonly pictures: ReadonlyMap<string, MessageFileView>;
  readonly onOpen: ((fileId: MessageFileId) => void) | null;
  readonly clamp: boolean;
}) => {
  const image = ({ src, alt }: ImgHTMLAttributes<HTMLImageElement>): ReactNode => {
    const file = typeof src === "string" ? pictures.get(src) : undefined;
    if (file === undefined || onOpen === null) return <span className="text-faint">[{alt ?? t("task.image")}]</span>;
    return (
      <button type="button" className="text-teal hover:underline" onClick={() => { onOpen(file.fileId); }} data-part="description-image">
        {file.name}
      </button>
    );
  };
  return (
    <div
      className={cn("text-body text-text [&_.agent-md_:where(p,ul,ol)]:my-0 [&_.agent-md_:where(p,ul,ol)+:where(p,ul,ol)]:mt-1.5", clamp && "line-clamp-3 max-sm:line-clamp-4")}
      data-part="ticket-description"
    >
      <AgentMarkdown text={text} image={image} />
    </div>
  );
};

/** The comments: one 28px row each, the newest two first shown, each wrapping in full once all show. */
const Comments = ({ comments, now }: { readonly comments: TicketRoundView["comments"]; readonly now: number }) => {
  const [all, setAll] = useState(false);
  const { shown, hidden } = shownComments(comments, all);
  return (
    <>
      <ul className="mt-1">
        {shown.map((comment, index) => (
          <li key={`${String(comment.at)}-${String(index)}`} className={cn("grid min-h-7 grid-cols-[20px_auto_minmax(0,1fr)] items-center gap-x-2 text-ui", all && "items-start py-1")} data-part="ticket-comment">
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
const Files = ({ attachments, links, ticketKey, agent, onOpenImage }: {
  readonly attachments: readonly TicketAttachmentView[];
  readonly links: TicketRoundView["links"];
  readonly ticketKey: string;
  readonly agent: string;
  readonly onOpenImage: ((fileId: MessageFileId) => void) | null;
}) => {
  const present = attachments.filter((one): one is Exclude<TicketAttachmentView, { readonly state: "left-out" }> => one.state !== "left-out");
  const picture = (one: (typeof present)[number]) => (one.state === "ready" ? one.file.kind === "image" : PICTURES.includes(extensionOf(one.name)));
  const pictures = present.filter(picture);
  const others = present.filter((one) => !picture(one));
  const { shown, more } = stripOf(pictures);
  const sixth = pictures[shown.length];
  return (
    <>
      {pictures.length === 0 ? null : (
        <div className="mt-1.5 flex items-end gap-3 overflow-x-auto pb-1" data-testid="ticket-images">
          {shown.map((one) =>
            one.state === "ready" ? (
              <FileThumb key={one.file.fileId} src={one.file.downloadPath} name={imageName(one.file.name, ticketKey)} onOpen={onOpenImage === null ? null : () => { onOpenImage(one.file.fileId); }} />
            ) : (
              <MissingThumb key={one.fileId} name={one.name} />
            ),
          )}
          {more === 0 ? null : <MoreThumb more={more} onOpen={onOpenImage === null || sixth?.state !== "ready" ? null : () => { onOpenImage(sixth.file.fileId); }} />}
        </div>
      )}
      {others.length + links.length === 0 ? null : (
        <div className="mt-2.5 flex flex-wrap gap-2 max-sm:flex-col" data-testid="ticket-file-chips">
          {others.map((one) => (one.state === "ready" ? <FileChipLink key={one.file.fileId} file={one.file} agent={agent} /> : <MissingChip key={one.fileId} name={one.name} />))}
          {links.map((link, index) => (
            <LinkChip key={`${link.url}-${String(index)}`} title={link.title === "" ? link.url : link.title} href={link.url} />
          ))}
        </div>
      )}
    </>
  );
};

/** What didn't load: a 2px red rule, the names and why, Retry for the driver. */
const Failed = ({ attachments, round, tracker, retry }: {
  readonly attachments: readonly TicketAttachmentView[];
  readonly round: TicketRoundView;
  readonly tracker: string;
  readonly retry: { readonly run: () => void; readonly pending: boolean } | null;
}) => {
  const names = attachments.flatMap((one) => (one.state === "failed" ? [one.name] : []));
  if (names.length === 0) return null;
  const joiners = nameJoiners(names.length);
  return (
    <div className="mt-2.5 border-l-2 border-red pl-3" data-testid="ticket-files-failed">
      <p className="flex items-center gap-2 text-ui font-medium text-red">
        <CircleAlertIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75]" />
        {plural(names.length, "task.ticketContext.failedOne", "task.ticketContext.failed", { tracker })}
      </p>
      <p className="mt-[3px] text-[13.5px] text-muted">
        {names.map((name, index) => (
          <Fragment key={`${name}-${String(index)}`}>
            <span className="font-mono text-ui text-text">{name}</span>
            {joiners[index]}
          </Fragment>
        ))}
        {t("task.ticketContext.failedWhy", { why: failureText(round.failure, tracker) })}
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
const LastLine = ({ prompt, imagesAsFilesFor }: { readonly prompt: string | null; readonly imagesAsFilesFor: string | null }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13.5px] text-muted" data-testid="ticket-context-where">
        <PaperclipIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" />
        <span className="min-w-0">
          {t("task.ticketContext.inTheBox")} <span className="font-mono text-ui text-text">{TICKET_FOLDER}</span>
          {t("task.ticketContext.inTheBoxWith")}
          {imagesAsFilesFor === null ? null : t("task.ticketContext.imagesAsFiles", { model: imagesAsFilesFor })}
        </span>
        {prompt === null ? null : (
          <>
            <span aria-hidden className="text-faint">·</span>
            <button type="button" aria-expanded={open} onClick={() => { setOpen((now) => !now); }} className="inline-flex items-center gap-[3px] text-teal hover:underline" data-action="show-prompt">
              {open ? t("task.ticketContext.hidePrompt") : t("task.ticketContext.showPrompt")}
              <ChevronDownIcon aria-hidden className={cn("size-[14px] stroke-[1.75] transition-transform", open && "rotate-180")} />
            </button>
          </>
        )}
      </p>
      {open && prompt !== null ? (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3.5 py-2.5 font-mono text-xs leading-[1.6] text-text" data-testid="ticket-prompt">
          {prompt}
        </pre>
      ) : null}
    </>
  );
};

export const TicketContextMessage = ({ view, tracker, agent, now, retry, fileOf, onOpenImage, by = null, at = null, title = null, defaultOpen = false }: {
  readonly view: TicketContextView;
  /** The tracker's name, as the key line has it: `Linear`. */
  readonly tracker: string;
  readonly agent: string;
  readonly now: number;
  /** Retry (`tasks.retryTicketFiles`), for the driver while a failed file waits; `null` otherwise. */
  readonly retry: { readonly run: () => void; readonly pending: boolean } | null;
  /** A file of the task by its ID (`tasks.files`): a Retry's fetched file, a description's picture. */
  readonly fileOf: (fileId: MessageFileId) => MessageFileView | undefined;
  readonly onOpenImage: ((fileId: MessageFileId) => void) | null;
  /** Milestone 10 (ticket 12): the member the first message is written as, and its time, over the bubble. */
  readonly by?: string | null;
  readonly at?: number | null;
  /** The ticket's title, the bubble's 600 line (a ticket task's title is its ticket's). */
  readonly title?: string | null;
  /** Opened at first: everything the agent got, not only its summary. */
  readonly defaultOpen?: boolean;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const round = view.rounds[0] ?? null;
  const attachments = round === null ? [] : shownAttachments(round, fileOf);
  const counts = round === null ? null : ticketCounts({ attachments, links: round.links, comments: round.comments });
  const leftOut = attachments.flatMap((one) => (one.state === "left-out" ? [{ name: one.name, reason: one.reason, size: one.size }] : []));
  const pictures = new Map(
    (round?.descriptionFiles ?? []).flatMap((link) => {
      const file = fileOf(link.fileId);
      return file === undefined ? [] : [[link.url, file] as const];
    }),
  );
  const time = at ?? round?.at ?? null;
  const summary = counts === null ? null : contextRowText(counts);
  return (
    // Milestone 10 (F-151, parts.md part 2): "What the agent got" is the thread's first bubble (`.bubble.got`), 82% wide, filled.
    <div id="ticket-context" className="mb-[18px] mt-6 flex scroll-mt-24 flex-col items-end" data-part="ticket-context" data-state={round === null ? "fetching" : "read"} role="group" aria-label={t("task.ticketContext.title")}>
      {by === null && time === null ? null : (
        <div className="mx-1 mb-[5px] flex items-baseline justify-end gap-x-1.5 text-[12.5px] text-faint" data-part="bubble-by">
          {by === null ? null : <span className="font-medium text-muted">{by}</span>}
          {time === null ? null : <span className="font-mono text-xs">{formatClock(time)}</span>}
        </div>
      )}
      <div className="w-[82%] min-w-0 rounded-2xl bg-sel px-3.5 py-[11px] text-body leading-[1.55] text-text" data-part="bubble-got">
        <p className="mb-1 flex min-w-0 flex-wrap items-center gap-x-[7px] text-[12.5px] text-muted" data-part="ticket-source">
          {view.connection === null ? (
            <TicketIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-faint" />
          ) : (
            <TrackerMark kind={view.connection.kind} size={trackerMarkAt.threadMeta.size} mono label={false} className="text-faint" />
          )}
          <span className="font-mono text-xs text-text-2">{view.ticketKey}</span>
          <span>{t("task.ticketContext.from", { tracker })}</span>
        </p>
        {title === null || title === "" ? null : <p className="font-semibold [overflow-wrap:anywhere]">{title}</p>}
        {round === null || counts === null || summary === null ? (
          <p className="mt-1 flex items-center gap-2 text-sm text-faint" data-testid="ticket-context-fetching">
            <LoaderCircleIcon aria-hidden className="size-[11px] animate-spin motion-reduce:animate-none" />
            {t("task.ticketContext.fetching")}
          </p>
        ) : (
          <>
            {round.description === null || round.description.trim() === "" ? null : <Description text={round.description} pictures={pictures} onOpen={onOpenImage} clamp={!open} />}
            <p className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1 text-sm text-faint" data-part="ticket-more">
              <PaperclipIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
              <span className={cn(summary.failed && "text-red")}>{summary.text}</span>
              <span aria-hidden>·</span>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => { setOpen((now) => !now); }}
                className="inline-flex items-center gap-0.5 text-teal hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                data-action="show-it-all"
              >
                {open ? t("task.ticketContext.showLess") : t("task.ticketContext.showItAll")}
                <ChevronRightIcon aria-hidden className={cn("size-[13px] stroke-[1.75]", open && "rotate-90")} />
              </button>
            </p>
            {open ? (
              <>
                {counts.total === 0 ? null : (
                  <Section label={t("task.ticketContext.attachmentsLabel")} count={attachmentsCountText(counts)}>
                    <Files attachments={attachments} links={round.links} ticketKey={view.ticketKey} agent={agent} onOpenImage={onOpenImage} />
                    <LeftOutList notes={leftOut} scope="ticket" limits={view.limits} tracker={tracker} />
                  </Section>
                )}
                {round.filesNotFetched ? (
                  <p className="mt-2.5 flex items-center gap-2 text-[13.5px] text-muted" data-testid="ticket-files-not-fetched">
                    <ImageOffIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" />
                    {t("task.ticketContext.notOffered", { tracker })}
                  </p>
                ) : null}
                {round.comments.length === 0 ? null : (
                  <Section label={t("task.ticketContext.commentsLabel")} count={String(round.comments.length)}>
                    <Comments comments={round.comments} now={now} />
                  </Section>
                )}
                <LastLine prompt={view.prompt} imagesAsFilesFor={round.imagesAsFilesFor} />
              </>
            ) : null}
            {/* What didn't load keeps its place, with Retry for the driver, open or not. */}
            <Failed attachments={attachments} round={round} tracker={tracker} retry={retry} />
          </>
        )}
      </div>
    </div>
  );
};

/** The Ticket group's `Context` row: what the agent got in a few words, a button that scrolls the thread to it. */
export const TicketContextRow = ({ round, fileOf, onShow }: {
  readonly round: Pick<TicketRoundView, "attachments" | "links" | "comments">;
  readonly fileOf: (fileId: MessageFileId) => MessageFileView | undefined;
  readonly onShow: () => void;
}) => {
  const row = contextRowText(ticketCounts({ attachments: shownAttachments(round, fileOf), links: round.links, comments: round.comments }));
  return (
    <PropRow label={t("task.ticketContext.row")}>
      <button type="button" onClick={onShow} aria-label={t("task.ticketContext.rowName", { what: row.text })} className={cn("truncate text-left hover:underline", row.failed ? "text-red" : "text-text")} data-testid="ticket-context-row">
        {row.text}
      </button>
    </PropRow>
  );
};
