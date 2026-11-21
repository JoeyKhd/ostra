"use client";

import { DownloadIcon, LinkIcon, LockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ImagesNotSent } from "@ostra/protocol";

import { Avatar } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { FILM_HEIGHT, bytesText } from "./attachment-words";
import { FileThumb } from "./file-thumb";
import { agentGotText, typeLabel, viewerTitle } from "./file-words";
import { Fact, ViewerFrame } from "./viewer-frame";

// A member's or a ticket's pictures in milestone 8's viewer (message-attachments.md, "The viewer"):
// titled `Attachments` (the ticket's `The ticket's attachments`, the tray's `Not sent yet`), the
// message's pictures alone in the filmstrip (the files download), and the picture's facts: its
// name where a capture shows its route, its size, who sent it, its message, what the agent got and
// where it is in the box. Download and Copy link; no Compare, which is for captures of one route.

/** One picture the viewer moves through. */
export type ViewerImage = {
  readonly key: string;
  readonly name: string;
  /** The panel's download route, or the browser's copy of an unsent one. */
  readonly src: string;
  readonly size: number;
  /** Whether it went to the model as a picture; `null` while it isn't sent. */
  readonly asImage: boolean | null;
};

/** Where the pictures are from, which sets the title, the header's line and the facts. */
export type FileViewerSource =
  | {
      readonly kind: "message";
      readonly taskKey: string;
      readonly author: string;
      readonly at: number;
      /** The message's folder in the box: `.ostra/attachments/4/`. */
      readonly folder: string;
      readonly imagesNotSent: ImagesNotSent | null;
      /** Closes the viewer and scrolls to the message. */
      readonly toMessage: () => void;
    }
  | {
      readonly kind: "ticket";
      readonly taskKey: string;
      readonly tracker: string;
      readonly folder: string;
      readonly imagesNotSent: ImagesNotSent | null;
      /** Where each picture came from on the ticket: `Marcus Lee's comment`, `the description`. */
      readonly from: (key: string) => string;
    }
  | { readonly kind: "unsent" };

export const FileViewer = ({ images, openKey, source, agent, projectName, link, onSelect, onClose }: {
  readonly images: readonly ViewerImage[];
  readonly openKey: string;
  readonly source: FileViewerSource;
  readonly agent: string;
  readonly projectName: string;
  /** The panel link Copy link copies (it needs a sign-in, ADR 0043); `null` for an unsent picture. */
  readonly link: ((key: string) => string) | null;
  readonly onSelect: (key: string) => void;
  readonly onClose: () => void;
}) => {
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pixels, setPixels] = useState<{ readonly width: number; readonly height: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setFull(false);
    setCopied(false);
    setPixels(null);
  }, [openKey]);
  const index = images.findIndex((image) => image.key === openKey);
  const open = images[index];
  if (open === undefined) return null;
  const where = (() => {
    switch (source.kind) {
      case "message":
        return t("task.files.viewerWhere", { key: source.taskKey, author: source.author, time: formatClock(source.at), n: index + 1, of: images.length });
      case "ticket":
        return t("task.files.viewerTicketWhere", { key: source.taskKey, tracker: source.tracker, n: index + 1, of: images.length });
      case "unsent":
        return t("task.files.viewerUnsentWhere", { n: index + 1, of: images.length });
      default:
        return source satisfies never;
    }
  })();
  const copy = link === null ? null : () => { void navigator.clipboard.writeText(link(open.key)).then(() => { setCopied(true); }); };
  return (
    <ViewerFrame
      title={viewerTitle(source.kind)}
      where={where}
      kind="image"
      index={index}
      count={images.length}
      onGo={(to) => {
        const next = images[to];
        if (next !== undefined && next.key !== open.key) onSelect(next.key);
      }}
      onClose={onClose}
      focusStage={() => stage.current}
      stage={
        <div
          ref={stage}
          tabIndex={0}
          aria-label={t("task.files.stage", { name: open.name })}
          className={cn("relative flex min-h-0 flex-1 px-14 py-[18px] focus-visible:-outline-offset-2", full ? "overflow-auto" : "items-center justify-center overflow-hidden")}
          data-testid="viewer-stage"
        >
          <img
            src={open.src}
            alt={open.name}
            data-testid="viewer-picture"
            className={cn("rounded-[6px] border border-line-2 bg-white", full ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")}
            style={full && pixels !== null ? { width: pixels.width } : undefined}
            onLoad={(event) => { setPixels({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }}
            onClick={() => { setFull((now) => !now); }}
          />
        </div>
      }
      filmstrip={images.map((image) => (
        <FileThumb key={image.key} src={image.src} name={t("task.files.showImage", { name: image.name })} height={FILM_HEIGHT} caption={image.name} selected={image.key === open.key} onOpen={() => { onSelect(image.key); }} />
      ))}
      facts={
        <>
          <p className="text-xs font-medium text-faint">{t("task.files.kindImage")}</p>
          <p className="mt-1 break-all font-mono text-[15px] text-text">{open.name}</p>
          <div className="mt-3 max-[1179px]:grid max-[1179px]:grid-cols-2 max-[1179px]:gap-x-6">
            <Fact label={t("task.files.size")}><span className="font-mono">{pixels === null ? "–" : `${String(pixels.width)} × ${String(pixels.height)}`}</span></Fact>
            <Fact label={t("task.attachments.file")}><span className="font-mono">{`${typeLabel(open.name)} · ${bytesText(open.size)}`}</span></Fact>
            {(() => {
              switch (source.kind) {
                case "message":
                  return (
                    <>
                      <Fact label={t("task.files.from")}><Avatar name={source.author} className="size-5 text-[9px]" /><span className="truncate">{source.author}</span></Fact>
                      <Fact label={t("task.files.message")}>
                        <button type="button" className="truncate text-teal hover:underline" onClick={source.toMessage}>{t("task.files.messageLink", { author: source.author, time: formatClock(source.at) })}</button>
                      </Fact>
                      <Fact label={t("task.files.agentGot")}><span className="truncate">{agentGotText(open.asImage === true, source.imagesNotSent, agent)}</span></Fact>
                      <Fact label={t("task.files.inTheBox")}><span className="truncate font-mono text-[12.5px]">{source.folder}</span></Fact>
                    </>
                  );
                case "ticket":
                  return (
                    <>
                      <Fact label={t("task.files.from")}><span className="truncate">{source.from(open.key)}</span></Fact>
                      <Fact label={t("task.files.agentGot")}><span className="truncate">{agentGotText(open.asImage === true, source.imagesNotSent, agent)}</span></Fact>
                      <Fact label={t("task.files.inTheBox")}><span className="truncate font-mono text-[12.5px]">{source.folder}</span></Fact>
                    </>
                  );
                case "unsent":
                  return null;
                default:
                  return source satisfies never;
              }
            })()}
          </div>
          {source.kind === "unsent" ? null : (
            <div className="mt-4 flex flex-col gap-2 max-[1179px]:flex-row max-[1179px]:flex-wrap">
              <a href={open.src} download={open.name} className={cn(buttonVariants({ size: "sm" }), "justify-start")} data-action="download">
                <DownloadIcon aria-hidden />
                {t("task.attachments.download")}
              </a>
              {copy === null ? null : (
                <Button size="sm" className="justify-start" onClick={copy} data-action="copy-link">
                  <LinkIcon aria-hidden />
                  {copied ? t("task.attachments.copied") : t("task.attachments.copyLink")}
                </Button>
              )}
            </div>
          )}
          <p className="mt-3.5 flex gap-2 text-[12.5px] text-faint">
            <LockIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
            {source.kind === "unsent" ? t("task.files.unsentNote") : t("task.attachments.note", { project: projectName })}
          </p>
        </>
      }
    />
  );
};
