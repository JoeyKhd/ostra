"use client";

import { XIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

import type { RecordedUpload } from "@ostra/domain";

import { FileText, FileTile, TextMark } from "@/components/tasks/attachments/file-chip";
import { fileMeta, typeLabel, TRAY_NAME_CHARS } from "@/components/tasks/attachments/file-words";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { itemName } from "./attach-words";
import type { TrayEntry, TrayUpload } from "./attach-words";

// One file in the message box's tray (composer-attachments.md, "The tray"): a picture as a 52px
// square from the browser's own copy, any other file as a 52-tall chip; each with its `x`, its
// upload's bar, and a failed upload's red edge and Retry. The item is focusable: Delete or
// Backspace removes it, Enter opens a picture in the viewer.

/** An item as the tray draws it: what core answered matters only for its text's mark. */
export type TrayItemView = TrayEntry<Pick<RecordedUpload, "kind" | "text">> & {
  readonly key: string;
  /** A picture's `blob:` URL, the browser's copy. */
  readonly previewUrl: string | null;
};

/** The upload's 2px bar: `--teal` on a `--line-2` track, 5px in, 4px up. */
const Bar = ({ progress }: { readonly progress: number }) => (
  <span aria-hidden className="absolute inset-x-[5px] bottom-1 h-0.5 overflow-hidden rounded-[1px] bg-line-2">
    <i className="block h-full bg-teal" style={{ width: `${String(Math.round(progress * 100))}%` }} />
  </span>
);

/** The second line: the type and size, the upload's progress, or `Didn't upload` and Retry. */
const Meta = ({ name, size, upload, onRetry }: { readonly name: string; readonly size: number; readonly upload: TrayUpload<Pick<RecordedUpload, "kind" | "text">>; readonly onRetry: () => void }) => {
  switch (upload.state) {
    case "uploading":
      return <span className="text-muted">{t("task.composer.attach.uploading", { n: Math.round(upload.progress * 100) })}</span>;
    case "ready":
      return (
        <>
          {fileMeta(name, size)}
          <TextMark state={upload.uploaded.text.state} />
        </>
      );
    case "failed":
      return (
        <span className="font-sans text-[12.5px] text-red">
          {t("task.composer.attach.failed")}
          <button
            type="button"
            className="ml-1.5 text-teal hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            data-action="retry-upload"
          >
            {t("task.composer.attach.retry")}
          </button>
        </span>
      );
    default:
      return upload satisfies never;
  }
};

export const TrayItem = ({ item, touch, onRemove, onRetry, onOpen, onKeyRemove }: {
  readonly item: TrayItemView;
  /** A touch screen: the `x` is in the tab order (there's no Delete key), with a 44px hit area. */
  readonly touch: boolean;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
  /** Opens a picture in the viewer, titled `Not sent yet`. */
  readonly onOpen: (() => void) | null;
  /** Delete or Backspace on the item: removes it, and the tray moves the focus on. */
  readonly onKeyRemove: () => void;
}) => {
  const uploading = item.upload.state === "uploading";
  const failed = item.upload.state === "failed";
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onKeyRemove();
    } else if (event.key === "Enter" && onOpen !== null) {
      event.preventDefault();
      onOpen();
    }
  };
  const remove = (
    <button
      type="button"
      tabIndex={touch ? 0 : -1}
      aria-label={t("task.composer.attach.remove", { name: item.name })}
      onClick={(event) => {
        event.stopPropagation();
        onRemove();
      }}
      className="absolute -right-[11px] -top-[11px] z-[1] grid size-7 place-items-center pointer-coarse:-right-[19px] pointer-coarse:-top-[19px] pointer-coarse:size-11"
      data-action="remove-file"
    >
      <span className="grid size-5 place-items-center rounded-full border border-line-2 bg-raise text-muted hover:text-text">
        <XIcon aria-hidden className="size-3 stroke-2" />
      </span>
    </button>
  );
  const common = {
    role: "listitem",
    tabIndex: 0,
    "aria-label": itemName(item, typeLabel(item.name)),
    title: item.upload.state === "failed" && item.upload.reason !== null ? item.upload.reason : item.name,
    onKeyDown,
    "data-tray-item": item.key,
    "data-state": item.upload.state,
  } as const;
  switch (item.look) {
    case "image":
      return (
        <div
          {...common}
          data-look="image"
          onDoubleClick={onOpen ?? undefined}
          className={cn(
            "relative size-[52px] shrink-0 rounded-[6px] border bg-white outline-offset-2 focus-visible:outline-2 focus-visible:outline-teal max-md:size-14",
            failed ? "border-red" : "border-line-2",
          )}
        >
          <span className={cn("absolute inset-0 overflow-hidden rounded-[5px]", uploading && "opacity-50")}>
            {item.previewUrl === null ? null : <img src={item.previewUrl} alt="" className="size-full object-cover" draggable={false} />}
          </span>
          {item.upload.state === "uploading" ? <Bar progress={item.upload.progress} /> : null}
          {remove}
        </div>
      );
    case "file":
      return (
        <div
          {...common}
          data-look="file"
          className={cn(
            "relative flex h-[52px] max-w-[280px] shrink-0 items-center gap-2.5 rounded-lg border bg-bg pl-2 pr-3.5 outline-offset-2 focus-visible:outline-2 focus-visible:outline-teal max-md:h-14 max-md:max-w-[264px]",
            failed ? "border-red" : "border-line-2",
          )}
        >
          <FileTile name={item.name} tone={failed ? "failed" : "type"} />
          <FileText name={item.name} meta={<Meta name={item.name} size={item.size} upload={item.upload} onRetry={onRetry} />} cut={TRAY_NAME_CHARS} />
          {item.upload.state === "uploading" ? <Bar progress={item.upload.progress} /> : null}
          {remove}
        </div>
      );
    default:
      return item.look satisfies never;
  }
};
