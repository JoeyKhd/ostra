"use client";

import {
  CircleAlertIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXIcon,
  Link2Icon,
  MailIcon,
  ScanTextIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { FileTextState } from "@ostra/protocol";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { chipName, fileLookOf, fileMeta, middleCut, textExtractedTip, textFailedTip, THREAD_NAME_CHARS } from "./file-words";
import type { FileLook, ThreadFile } from "./file-words";

// A file's chip (composer-attachments.md, "The tray"; message-attachments.md, "The files";
// ticket-context.md): the 34px type tile, the name cut in the middle, and `DOCX · 48 KB` in mono.
// The tray's item and the thread's link share this inside; the thread's chip downloads the file,
// says `text extracted` on a document ostra read, and a ticket's link says it wasn't fetched.

/** The type's icon, 16px, by the name's extension. */
export const FileLookIcon = ({ look, className }: { readonly look: FileLook; readonly className?: string }) => {
  const props = { "aria-hidden": true, className: cn("size-4 stroke-[1.75]", className) };
  switch (look) {
    case "text":
      return <FileTextIcon {...props} />;
    case "spreadsheet":
      return <FileSpreadsheetIcon {...props} />;
    case "code":
      return <FileCodeIcon {...props} />;
    case "archive":
      return <FileArchiveIcon {...props} />;
    case "video":
      return <FileVideoIcon {...props} />;
    case "mail":
      return <MailIcon {...props} />;
    case "file":
      return <FileIcon {...props} />;
    default:
      return look satisfies never;
  }
};

/** The 34px tile: `--sel` with the type's icon; a failed upload's red alert; a link's or a missing file's outline. */
export type TileTone = "type" | "failed" | "link" | "missing";

export const FileTile = ({ name, tone = "type" }: { readonly name: string; readonly tone?: TileTone }) => {
  const icon = (() => {
    switch (tone) {
      case "type":
        return <FileLookIcon look={fileLookOf(name)} />;
      case "failed":
        return <CircleAlertIcon aria-hidden className="size-4 stroke-[1.75] text-red" />;
      case "link":
        return <Link2Icon aria-hidden className="size-4 stroke-[1.75]" />;
      case "missing":
        return <FileXIcon aria-hidden className="size-4 stroke-[1.75] text-red" />;
      default:
        return tone satisfies never;
    }
  })();
  return (
    <span className={cn("grid size-[34px] shrink-0 place-items-center rounded-[6px] text-muted", tone === "type" ? "bg-sel" : tone === "failed" || tone === "link" ? "border border-line-2" : "")}>
      {icon}
    </span>
  );
};

/** The name over its meta line, both cut to one line. */
export const FileText = ({ name, meta, cut, muted = false }: { readonly name: string; readonly meta: ReactNode; readonly cut: number; readonly muted?: boolean }) => (
  <span className="flex min-w-0 flex-col">
    <span className={cn("truncate text-[13.5px] font-medium leading-[18px]", muted ? "text-muted" : "text-text")}>{middleCut(name, cut)}</span>
    <span className="truncate font-mono text-xs leading-[17px] text-faint">{meta}</span>
  </span>
);

/** After a document's size: `· text extracted` once ostra read its text, `· no text` when it couldn't. */
export const TextMark = ({ state }: { readonly state: FileTextState }) => {
  switch (state) {
    case "ready":
      return (
        <>
          {" · "}
          <span className="font-sans text-xs text-muted" data-part="text-extracted">
            <ScanTextIcon aria-hidden className="mr-[3px] inline size-3 align-[-2px] stroke-[1.75] text-faint" />
            {t("task.files.textExtracted")}
          </span>
        </>
      );
    case "failed":
      return (
        <>
          {" · "}
          <span className="font-sans text-xs text-muted" data-part="no-text">{t("task.files.noText")}</span>
        </>
      );
    case "none":
    case "off":
      return null;
    default:
      return state satisfies never;
  }
};

/** The thread's chip edge: no fill on the page, a `--line-2` edge, `--hover` and `--line-3` on hover. */
const chipClass = "group flex h-[52px] min-w-0 max-w-[320px] items-center gap-2.5 rounded-lg border border-line-2 pl-2 pr-3.5 max-sm:max-w-none";

/**
 * A member's or a ticket's file under its message: a link that downloads it under its own name,
 * with `text extracted` and its tooltip on a document ostra read. Once the task's retention
 * removed it, it keeps its name and loses its link.
 */
export const FileChipLink = ({ file, agent, inBubble = false }: { readonly file: ThreadFile; readonly agent: string; readonly inBubble?: boolean }) => {
  // Milestone 10 (parts.md part 2): above a member's bubble, 48px tall on `--bg`.
  const size = inBubble ? "h-12 bg-bg max-sm:max-w-full" : undefined;
  if (file.downloadPath === null) {
    return (
      <span className={cn(chipClass, "border-dashed border-control-line", size)} data-file={file.fileId} data-state="removed">
        <FileTile name={file.name} tone="missing" />
        <FileText name={file.name} meta={<span className="font-sans">{t("task.files.removed")}</span>} cut={THREAD_NAME_CHARS} muted />
      </span>
    );
  }
  const link = (
    <a
      href={file.downloadPath}
      download={file.name}
      aria-label={chipName(file)}
      className={cn(chipClass, "text-inherit hover:border-line-3 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal", size)}
      data-file={file.fileId}
      data-text={file.text}
    >
      <FileTile name={file.name} />
      <FileText name={file.name} meta={<>{fileMeta(file.name, file.size)}<TextMark state={file.text} /></>} cut={THREAD_NAME_CHARS} />
      <DownloadIcon aria-hidden className="ml-1 hidden size-[15px] shrink-0 stroke-[1.75] text-faint group-hover:block group-focus-visible:block" />
    </a>
  );
  switch (file.text) {
    case "ready":
      return <Tooltip side="bottom" content={textExtractedTip(file, agent)}>{link}</Tooltip>;
    case "failed":
      return <Tooltip side="bottom" content={textFailedTip(file.textReason, agent)}>{link}</Tooltip>;
    case "none":
    case "off":
      return link;
    default:
      return file.text satisfies never;
  }
};

/** A ticket's link (a Sentry issue, a Figma frame): its title, `Link · not fetched`, opening in a new tab. */
export const LinkChip = ({ title, href }: { readonly title: string; readonly href: string }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={t("task.ticketContext.linkName", { title })}
    className={cn(chipClass, "text-inherit hover:border-line-3 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal")}
    data-part="ticket-link"
  >
    <FileTile name={title} tone="link" />
    <FileText name={title} meta={t("task.ticketContext.notFetched")} cut={THREAD_NAME_CHARS} />
  </a>
);

/** A ticket's file that didn't load: its place kept, dashed, `didn't load`. */
export const MissingChip = ({ name }: { readonly name: string }) => (
  <span className={cn(chipClass, "border-dashed border-control-line")} data-part="file-missing">
    <FileTile name={name} tone="missing" />
    <FileText name={name} meta={t("task.ticketContext.didntLoad")} cut={THREAD_NAME_CHARS} muted />
  </span>
);
