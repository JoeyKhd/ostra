"use client";

import { useQuery } from "@tanstack/react-query";

import type { TaskId } from "@ostra/protocol";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";

import { bytesText, capturedText, widthsText } from "./attachment-words";

// The task page's "Screenshots and recordings" group (task-attachments.md; F-121): what the task
// holds, its size, where it's kept and the widths, shown once it has any. And, under the task's
// header, the line for a runner too old to run the app (F-121/c11, `tasks.attachments.app`).

export const TaskAttachmentsGroup = ({ taskId, pr }: { readonly taskId: TaskId; readonly pr: { readonly number: number; readonly url: string } | null }) => {
  const trpc = useTRPC();
  const list = useQuery(trpc.tasks.attachments.queryOptions({ taskId }));
  const views = list.data?.attachments ?? [];
  if (views.length === 0) return null;
  const href = pr === null ? null : safeHref(pr.url);
  return (
    <div data-testid="attachments-group">
      <PropGroup title={t("task.attachments.group")}>
        <PropRow label={t("task.attachments.groupCaptured")}><span className="truncate">{capturedText(views)}</span></PropRow>
        <PropRow label={t("task.attachments.groupSize")}><span className="font-mono">{bytesText(views.reduce((sum, view) => sum + view.bytes, 0))}</span></PropRow>
        <PropRow label={t("task.attachments.groupWhere")}><span className="truncate">{t("task.attachments.groupWhereValue")}</span></PropRow>
        {pr === null || href === null ? null : (
          <PropRow label={t("task.attachments.groupInPr")}>
            <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-teal hover:underline">#{pr.number}</a>
            <span className="text-faint">{t("task.attachments.groupDescription")}</span>
          </PropRow>
        )}
        <PropRow label={t("task.attachments.groupWidths")}><span className="truncate font-mono">{widthsText(views)}</span></PropRow>
      </PropGroup>
    </div>
  );
};

/** "This task's runner runs an older ostra": its app, its pictures and its previews need minor 7. */
export const TaskAppSupportLine = ({ taskId }: { readonly taskId: TaskId }) => {
  const trpc = useTRPC();
  const list = useQuery(trpc.tasks.attachments.queryOptions({ taskId }));
  const app = list.data?.app;
  if (app?.kind !== "runner-needs-upgrade") return null;
  return (
    <p className="mt-1.5 text-ui text-muted" data-testid="task-app-upgrade">{app.words}</p>
  );
};
