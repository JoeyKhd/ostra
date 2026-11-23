"use client";

import type { AttachmentsData } from "@ostra/task-view";

import { AttachmentThumb } from "@/components/tasks/attachments/attachment-thumb";
import { THUMB_HEIGHT, captions, thumbName } from "@/components/tasks/attachments/attachment-words";
import { useAttachments } from "@/components/tasks/attachments/attachments-context";
import { t } from "@/lib/messages";

// Owner: ticket 10 (milestone 10, F-151: captures under their run's line, choice 13). Milestone 8's
// strip, flush with the prose, under the line of the run that took them: each thumbnail captioned
// with its width and its own route (`1280 · /history`, the attachment's `target.path`), a recording
// with its play disc and length, and past six a `+n` tile that opens the viewer on the sixth.
// Where the pictures are kept is the panel's Attachments group, not a line in the column.

/** The most thumbnails before a `+n` tile (milestone 8's strip). */
const STRIP_MAX = 6;

export const Captures = ({ attachments }: { readonly attachments: AttachmentsData }) => {
  const context = useAttachments();
  // Once the list is read, a picture core didn't store (a refused event) isn't drawn.
  const views = context?.views ?? null;
  const items = views === null ? attachments.items : attachments.items.filter((item) => context?.byId.has(item.attachmentId) === true);
  if (items.length === 0) return null;
  const texts = captions(items);
  const shown = items.length > STRIP_MAX ? items.slice(0, STRIP_MAX - 1) : items;
  const more = items.length - shown.length;
  const anchor = context?.firstId !== null && items.some((item) => item.attachmentId === context?.firstId) ? "attachments" : undefined;
  return (
    <div id={anchor} data-part="captures" data-kind={attachments.kind} className="mb-1.5 mt-2 flex scroll-mt-24 items-end gap-3 overflow-x-auto pb-1" data-testid="attachment-strip">
      {shown.map((item, index) => (
        <AttachmentThumb
          key={item.attachmentId}
          view={context?.byId.get(item.attachmentId)}
          size={item}
          height={THUMB_HEIGHT}
          caption={texts[index] ?? ""}
          name={thumbName(item)}
          onOpen={context === null ? null : () => { context.open(item.attachmentId); }}
          testid="attachment-thumb"
        />
      ))}
      {more <= 0 ? null : (
        <div className="flex shrink-0 flex-col gap-[5px]">
          <button
            type="button"
            className="grid size-[110px] place-items-center rounded-[6px] border border-control-line bg-surface font-mono text-ui text-muted hover:border-faint"
            aria-label={t("task.attachments.more", { n: more })}
            onClick={() => {
              const sixth = items[STRIP_MAX - 1];
              if (sixth !== undefined) context?.open(sixth.attachmentId);
            }}
          >
            {`+${String(more)}`}
          </button>
          <span className="font-mono text-xs text-transparent" aria-hidden>.</span>
        </div>
      )}
    </div>
  );
};
