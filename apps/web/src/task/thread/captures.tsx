"use client";

import type { AttachmentsData } from "@ostra/task-view";

import { AttachmentThumb } from "@/components/tasks/attachments/attachment-thumb";
import { THUMB_HEIGHT, captions, thumbName } from "@/components/tasks/attachments/attachment-words";
import { useAttachments } from "@/components/tasks/attachments/attachments-context";

// Owner: ticket 10 (milestone 10, F-151: captures under their run's line, choice 13). Ticket 09's
// stub, with its final props: milestone 8's thumbnails flush with the prose, each captioned with
// its width and its own route (`1280 · /history`). Ticket 10 brings the strip's `+n` tile, a
// recording's reel and where the pictures are kept.

export const Captures = ({ attachments }: { readonly attachments: AttachmentsData }) => {
  const context = useAttachments();
  // Once the list is read, a picture core didn't store (a refused event) isn't drawn.
  const views = context?.views ?? null;
  const items = views === null ? attachments.items : attachments.items.filter((item) => context?.byId.has(item.attachmentId) === true);
  if (items.length === 0) return null;
  const texts = captions(items);
  return (
    <div data-part="captures" data-kind={attachments.kind} className="mb-1.5 mt-2 flex items-end gap-3 overflow-x-auto pb-1" data-testid="attachment-strip">
      {items.map((item, index) => (
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
    </div>
  );
};
