"use client";

import { ShieldCheckIcon, XIcon } from "lucide-react";

import { tNodes } from "@/lib/message-nodes";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

// The native preview's framing notice (milestone 8, ticket 26, F-144; preview-native.md, "The
// framing notice"): under the pane's toolbar, only when core's proxy replaced a framing header on
// this preview's answers, so a developer doesn't chase a frame that works as a bug. One line, the
// header's name in mono, its value in the line's `title`, and a dismiss that keeps it away for this
// preview in this browser.

export type PreviewFraming = { readonly header: "x-frame-options" | "frame-ancestors"; readonly value: string };

/** The header's name as the app's developer knows it. */
export const framingHeaderName = (header: PreviewFraming["header"]): string => {
  switch (header) {
    case "x-frame-options":
      return "X-Frame-Options";
    case "frame-ancestors":
      return "frame-ancestors";
    default:
      return header satisfies never;
  }
};

const lineKey = (header: PreviewFraming["header"]): MessageKey => {
  switch (header) {
    case "x-frame-options":
      return "task.preview.native.notice.xfo";
    case "frame-ancestors":
      return "task.preview.native.notice.ancestors";
    default:
      return header satisfies never;
  }
};

/** The notice's whole sentence, with the header's value: the line's `title`. */
export const framingTitle = (label: string, framing: PreviewFraming): string =>
  t("task.preview.native.notice.full", { label, header: framingHeaderName(framing.header), value: framing.value });

export const PreviewFramingNotice = ({ label, framing, onDismiss }: { readonly label: string; readonly framing: PreviewFraming; readonly onDismiss: () => void }) => (
  <div
    role="note"
    data-testid="preview-framing-notice"
    data-header={framing.header}
    title={framingTitle(label, framing)}
    className="flex min-h-[34px] shrink-0 items-center gap-2 border-b border-line bg-bg py-1 pl-3 pr-1.5 text-[13px] text-muted max-lg:items-start max-lg:py-2"
  >
    <ShieldCheckIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint max-lg:mt-[3px]" />
    <span className="min-w-0 flex-1 truncate max-lg:line-clamp-2 max-lg:whitespace-normal">
      {tNodes(lineKey(framing.header), { label, header: <span className="font-mono text-[12.5px] text-text-2">{framingHeaderName(framing.header)}</span> })}
    </span>
    <button
      type="button"
      onClick={onDismiss}
      aria-label={t("task.preview.native.notice.dismiss")}
      title={t("task.preview.native.notice.dismiss")}
      data-action="preview-framing-dismiss"
      className="grid size-6 shrink-0 place-items-center rounded-sm text-faint hover:bg-hover hover:text-text max-lg:size-11"
    >
      <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
    </button>
  </div>
);
