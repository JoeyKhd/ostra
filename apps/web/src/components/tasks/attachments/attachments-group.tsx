"use client";

import { useQuery } from "@tanstack/react-query";

import type { PeopleFiles } from "@ostra/api";
import type { TaskId } from "@ostra/protocol";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";

import { bytesText, capturedText } from "./attachment-words";
import type { AttachmentView } from "./attachment-words";
import { peopleText } from "./file-words";

// The task page's `Attachments` group (message-attachments.md, "The properties panel"; F-121,
// F-148): one group for the agent's captures, members' files and the ticket's. From people (a
// member's uploads and the ticket's files), Captured (milestone 8's screenshots and recordings),
// their size together, where they're kept, where people's files are in the box, and the PR whose
// description shows the captures. Shown once the task holds any. And, under the task's header, the
// line for a runner too old to run the app (F-121/c11, `tasks.attachments.app`).

export const AttachmentsGroupView = ({ captures, people, pr }: {
  readonly captures: readonly Pick<AttachmentView, "kind" | "bytes">[];
  readonly people: PeopleFiles | null;
  readonly pr: { readonly number: number; readonly url: string } | null;
}) => {
  const fromPeople = people !== null && people.images + people.files > 0 ? people : null;
  if (captures.length === 0 && fromPeople === null) return null;
  const href = pr === null ? null : safeHref(pr.url);
  const bytes = captures.reduce((sum, view) => sum + view.bytes, 0) + (fromPeople?.bytes ?? 0);
  return (
    <div data-testid="attachments-group">
      <PropGroup title={t("task.files.group")}>
        {fromPeople === null ? null : (
          <PropRow label={t("task.files.groupPeople")}><span className="truncate">{peopleText(fromPeople.images, fromPeople.files)}</span></PropRow>
        )}
        {captures.length === 0 ? null : (
          <PropRow label={t("task.attachments.groupCaptured")}><span className="truncate">{capturedText(captures)}</span></PropRow>
        )}
        <PropRow label={t("task.attachments.groupSize")}><span className="font-mono">{bytesText(bytes)}</span></PropRow>
        <PropRow label={t("task.attachments.groupWhere")}><span className="truncate">{t("task.attachments.groupWhereValue")}</span></PropRow>
        {fromPeople === null || fromPeople.folders.length === 0 ? null : (
          <PropRow label={t("task.files.inTheBox")}><span className="truncate font-mono">{fromPeople.folders.join(" · ")}</span></PropRow>
        )}
        {captures.length === 0 || pr === null || href === null ? null : (
          <PropRow label={t("task.attachments.groupInPr")}>
            <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-teal hover:underline">#{pr.number}</a>
            <span className="text-faint">{t("task.attachments.groupDescription")}</span>
          </PropRow>
        )}
      </PropGroup>
    </div>
  );
};

/** The group on the task page: the captures from `tasks.attachments`, people's files from `tasks.files`. */
export const TaskAttachmentsGroup = ({ taskId, pr }: { readonly taskId: TaskId; readonly pr: { readonly number: number; readonly url: string } | null }) => {
  const trpc = useTRPC();
  const list = useQuery(trpc.tasks.attachments.queryOptions({ taskId }));
  const files = useQuery(trpc.tasks.files.queryOptions({ taskId }));
  return <AttachmentsGroupView captures={list.data?.attachments ?? []} people={files.data?.people ?? null} pr={pr} />;
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
