"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { TaskId } from "@ostra/protocol";

import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { AttachmentViewer } from "./attachment-viewer";
import type { AttachmentView } from "./attachment-words";

// The thread's pictures (F-121, milestone 8's ticket 17): the task's attachments as core stored
// them (`tasks.attachments`, read again when a new `attachment.added` arrives), what the rows and the
// viewer need of the task (its key, project and PR), "Add to draft" on a refine task, and the
// viewer itself, which `?attachment={id}` opens so a link opens it. A picture is shown from the
// panel's download route only, never a URL of the agent's.

export type AttachmentsContextValue = {
  readonly taskId: TaskId;
  /** `null` until the list is read. */
  readonly views: readonly AttachmentView[] | null;
  readonly byId: ReadonlyMap<string, AttachmentView>;
  readonly taskKey: string;
  readonly projectId: string | null;
  readonly projectName: string;
  /** The task's PR whose description links its pictures, or `null` before it opens. */
  readonly pr: { readonly number: number; readonly url: string } | null;
  /** The first picture in the thread: the PR's link (`#attachments`) lands on its row. */
  readonly firstId: string | null;
  readonly open: (attachmentId: string) => void;
  /** "Add to draft" (F-099): on a refine task with a draft, for a screenshot. */
  readonly addToDraft: ((attachmentId: string) => void) | null;
  readonly addingId: string | null;
  readonly addError: string | null;
};

const AttachmentsContext = createContext<AttachmentsContextValue | null>(null);

/** The thread's pictures, or `null` outside a task's thread (the rows then show their placeholders). */
export const useAttachments = (): AttachmentsContextValue | null => useContext(AttachmentsContext);

/** The agent's name for the viewer's header (`OpenCode's turn at 14:31`). */
export const AttachmentsProvider = ({ taskId, added, agentName, children }: { readonly taskId: TaskId; readonly added: number; readonly agentName: string; readonly children: ReactNode }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const list = useQuery(trpc.tasks.attachments.queryOptions({ taskId }));
  const task = useQuery(trpc.tasks.get.queryOptions({ taskId }));
  const project = useQuery(trpc.projects.get.queryOptions(task.data === undefined ? skipToken : { projectId: task.data.projectId }));
  const refine = task.data?.kind === "refine";
  const draft = useQuery(trpc.drafts.get.queryOptions(refine ? { taskId, version: null } : skipToken));
  const { refetch } = list;

  // A new picture's event: read the list again, so its row has its file.
  useEffect(() => {
    if (added > 0) void refetch();
  }, [added, refetch]);

  const addMutation = useMutation(
    trpc.tasks.attachmentToDraft.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.tasks.attachments.queryKey({ taskId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.drafts.get.queryKey({ taskId, version: null }) }),
        ]);
      },
    }),
  );
  const [addingId, setAddingId] = useState<string | null>(null);

  const views = list.data?.attachments ?? null;
  const byId = useMemo(() => new Map<string, AttachmentView>((views ?? []).map((view) => [view.attachmentId, view] as const)), [views]);
  const openId = params.get("attachment");
  const setParam = useCallback(
    (value: string | null) => {
      const query = new URLSearchParams(params.toString());
      if (value === null) query.delete("attachment");
      else query.set("attachment", value);
      const search = query.toString();
      router.replace(search === "" ? pathname : `${pathname}?${search}`, { scroll: false });
    },
    [params, pathname, router],
  );
  const open = useCallback((attachmentId: string) => { setParam(attachmentId); }, [setParam]);

  const pr = useMemo(() => {
    const repo = task.data?.repos.find((one) => one.pr !== null);
    return repo?.pr === null || repo?.pr === undefined ? null : { number: repo.pr.number, url: repo.pr.url };
  }, [task.data?.repos]);
  const draftId = draft.data?.draft?.draftId ?? null;
  const latest = draft.data?.latestVersion === draft.data?.draft?.version;
  const addToDraft = useMemo(
    () =>
      refine && draftId !== null && latest && task.data?.state !== "done"
        ? (attachmentId: string) => {
            setAddingId(attachmentId);
            addMutation.mutate({ taskId, attachmentId, draftId }, { onSettled: () => { setAddingId(null); } });
          }
        : null,
    [refine, draftId, latest, task.data?.state, addMutation, taskId],
  );

  const value = useMemo<AttachmentsContextValue>(
    () => ({
      taskId,
      views,
      byId,
      taskKey: task.data?.key ?? "",
      projectId: task.data?.projectId ?? null,
      projectName: project.data?.name ?? "",
      pr,
      firstId: views?.find((view) => view.turn !== null || view.takenBy !== null)?.attachmentId ?? null,
      open,
      addToDraft,
      addingId,
      addError: addMutation.error === null ? null : (errorText(addMutation.error) ?? t("errors.unknown")),
    }),
    [taskId, views, byId, task.data?.key, task.data?.projectId, project.data?.name, pr, open, addToDraft, addingId, addMutation.error],
  );

  // `#attachments` (the PR's link): once the rows are drawn, the first picture's row comes into view.
  const firstId = value.firstId;
  useEffect(() => {
    if (firstId === null || typeof window === "undefined" || window.location.hash !== "#attachments") return undefined;
    let frame = 0;
    let tries = 0;
    const find = () => {
      const row = document.getElementById("attachments");
      if (row === null) {
        tries += 1;
        if (tries < 60) frame = requestAnimationFrame(find);
        return;
      }
      row.scrollIntoView({ block: "center" });
    };
    find();
    return () => { cancelAnimationFrame(frame); };
  }, [firstId]);

  const shown = openId === null ? undefined : views?.find((view) => view.attachmentId === openId);
  return (
    <AttachmentsContext.Provider value={value}>
      {children}
      {shown === undefined || views === null ? null : (
        <AttachmentViewer
          views={views}
          openId={shown.attachmentId}
          taskKey={value.taskKey}
          agentName={agentName}
          projectName={value.projectName}
          pr={pr}
          onSelect={open}
          onClose={() => { setParam(null); }}
          addToDraft={addToDraft === null ? null : { run: addToDraft, pending: addingId, error: value.addError }}
        />
      )}
    </AttachmentsContext.Provider>
  );
};
