"use client";

import { useState } from "react";

import { t } from "@/lib/messages";

import { AttachmentThumb } from "./attachment-thumb";
import { AttachmentViewer } from "./attachment-viewer";
import { FILM_HEIGHT, captions, thumbName } from "./attachment-words";
import type { AttachmentView } from "./attachment-words";

// A review finding's pictures (review-screen.md grown in milestone 8; F-121): the screenshots and
// recordings `submit_review` named, the review task's own, as a small strip under the finding that
// opens the same viewer as the thread's.

export const FindingAttachments = ({ views, taskKey, agentName, projectName }: { readonly views: readonly AttachmentView[]; readonly taskKey: string; readonly agentName: string; readonly projectName: string }) => {
  const [open, setOpen] = useState<string | null>(null);
  if (views.length === 0) return null;
  const items = views.map((view) => ({ kind: view.kind, path: view.path, width: view.width, height: view.height, durationMs: view.durationMs, at: view.createdAt }));
  const texts = captions(items);
  return (
    <div className="mt-2 flex flex-wrap items-end gap-3" data-testid="finding-attachments" aria-label={t("review.finding.attachments")}>
      {views.map((view, index) => (
        <AttachmentThumb
          key={view.attachmentId}
          view={view}
          size={{ width: view.width, height: view.height, kind: view.kind, durationMs: view.durationMs }}
          height={FILM_HEIGHT}
          caption={texts[index] ?? ""}
          name={thumbName({ kind: view.kind, path: view.path, width: view.width, at: view.createdAt })}
          onOpen={() => { setOpen(view.attachmentId); }}
        />
      ))}
      {open === null ? null : (
        <AttachmentViewer views={views} openId={open} taskKey={taskKey} agentName={agentName} projectName={projectName} pr={null} onSelect={setOpen} onClose={() => { setOpen(null); }} addToDraft={null} />
      )}
    </div>
  );
};
