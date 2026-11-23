"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { PeopleFiles, TaskFileView, TicketContextView, TicketFileFrom } from "@ostra/api";
import { FILES_ROOT_DIR, MESSAGE_FILES_FOLDER, TICKET_FILES_FOLDER } from "@ostra/protocol";
import type { ImagesNotSent, MessageFileId, TaskId } from "@ostra/protocol";
import { MESSAGE_FILE_LINK_PARAM, messageFileLinkPath } from "@ostra/task-view";

import { trackerName } from "@/components/tasks/task-ticket";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { AttachmentViewer } from "./attachment-viewer";
import type { AttachmentView } from "./attachment-words";
import { FileViewer } from "./file-viewer";
import type { FileViewerSource, ViewerImage } from "./file-viewer";

// The thread's pictures and files (F-121, milestone 8's ticket 17; F-148, F-149, milestone 9's
// ticket 16): the task's attachments as core stored them (`tasks.attachments`, read again when a
// new `attachment.added` arrives), the files sent with its messages (`tasks.files`, read again when
// a message brings some) and its ticket's context (`tasks.ticketContext`); what the rows and the
// viewers need of the task (its key, project and PR); "Add to draft" on a refine task; and the
// viewers themselves: `?attachment={id}` opens a capture, `?file={id}` a message's or the ticket's
// picture, so a link opens either. A picture is shown from the panel's download route only.

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
  /** Milestone 9: the files sent with the task's messages, `null` until read, and people's counts. */
  readonly files: readonly TaskFileView[] | null;
  readonly people: PeopleFiles | null;
  /** Opens a message's or the ticket's picture in the viewer (`?file=`). */
  readonly openFile: (fileId: MessageFileId) => void;
  /** The ticket's context (`tasks.ticketContext`): `null` for a task with no ticket, or until read. */
  readonly ticketContext: TicketContextView | null;
};

const AttachmentsContext = createContext<AttachmentsContextValue | null>(null);

/** The thread's pictures, or `null` outside a task's thread (the rows then show their placeholders). */
export const useAttachments = (): AttachmentsContextValue | null => useContext(AttachmentsContext);

/** Where on the ticket a picture was, for the viewer's `From`. */
export const fromText = (from: TicketFileFrom): string => {
  switch (from.where) {
    case "description":
      return t("task.files.fromDescription");
    case "comment":
      return from.author === null ? t("task.files.fromComment") : t("task.files.fromCommentBy", { author: from.author });
    case "attachment":
    case null:
      return t("task.files.fromAttachments");
    default:
      return from.where satisfies never;
  }
};

/** A message's picture's facts in the viewer: whose message, when, and what the agent got. */
export type MessageFacts = { readonly memberName: string; readonly at: number; readonly imagesNotSent: ImagesNotSent | null };

/** The agent's name for the viewer's header (`OpenCode's turn at 14:31`). */
export const AttachmentsProvider = ({ taskId, added, filesAdded = 0, agentName, messageOf = () => null, children }: {
  readonly taskId: TaskId;
  readonly added: number;
  /** How many of the log's messages carry files: the list is read again when one comes. */
  readonly filesAdded?: number;
  readonly agentName: string;
  /** A message by its number in the log: who sent it, when, and its image decision. */
  readonly messageOf?: (seq: number) => MessageFacts | null;
  readonly children: ReactNode;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const list = useQuery(trpc.tasks.attachments.queryOptions({ taskId }));
  const task = useQuery(trpc.tasks.get.queryOptions({ taskId }));
  const project = useQuery(trpc.projects.get.queryOptions(task.data === undefined ? skipToken : { projectId: task.data.projectId }));
  const files = useQuery(trpc.tasks.files.queryOptions({ taskId }));
  const ticketTask = task.data?.source === "ticket";
  const ticket = useQuery(trpc.tasks.ticketContext.queryOptions(ticketTask ? { taskId } : skipToken));
  const refine = task.data?.kind === "refine";
  const draft = useQuery(trpc.drafts.get.queryOptions(refine ? { taskId, version: null } : skipToken));
  const { refetch } = list;
  const { refetch: refetchFiles } = files;
  const { refetch: refetchTicket } = ticket;

  // A new picture's event: read the list again, so its row has its file.
  useEffect(() => {
    if (added > 0) void refetch();
  }, [added, refetch]);
  // A new message with files: the files' list, and the ticket's context when it's a ticket task.
  useEffect(() => {
    if (filesAdded <= 0) return;
    void refetchFiles();
    if (ticketTask) void refetchTicket();
  }, [filesAdded, refetchFiles, refetchTicket, ticketTask]);

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
  const fileId = params.get(MESSAGE_FILE_LINK_PARAM);
  const setParam = useCallback(
    (name: string, value: string | null) => {
      const query = new URLSearchParams(params.toString());
      if (value === null) query.delete(name);
      else query.set(name, value);
      const search = query.toString();
      router.replace(search === "" ? pathname : `${pathname}?${search}`, { scroll: false });
    },
    [params, pathname, router],
  );
  const open = useCallback((attachmentId: string) => { setParam("attachment", attachmentId); }, [setParam]);
  const openFile = useCallback((id: MessageFileId) => { setParam(MESSAGE_FILE_LINK_PARAM, id); }, [setParam]);

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
      files: files.data?.files ?? null,
      people: files.data?.people ?? null,
      openFile,
      ticketContext: ticket.data ?? null,
    }),
    [taskId, views, byId, task.data?.key, task.data?.projectId, project.data?.name, pr, open, addToDraft, addingId, addMutation.error, files.data, openFile, ticket.data],
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
  const fileViewer = (() => {
    const all = files.data?.files ?? [];
    const opened = fileId === null ? undefined : all.find((file) => file.fileId === fileId && file.kind === "image" && file.downloadPath !== null);
    if (opened === undefined) return null;
    // The message's pictures, or the ticket's: the files download from their chips.
    const set = all.filter((file) => file.kind === "image" && file.downloadPath !== null && (opened.origin === "ticket" ? file.origin === "ticket" : file.seq === opened.seq && file.origin === "member"));
    const images: ViewerImage[] = set.flatMap((file) => (file.downloadPath === null ? [] : [{ key: file.fileId, name: file.name, src: file.downloadPath, size: file.size, asImage: file.asImage }]));
    const facts = opened.seq === null ? null : messageOf(opened.seq);
    const ticketFrom = (key: string): string => {
      for (const round of ticket.data?.rounds ?? []) {
        const found = round.attachments.find((one) => one.state === "ready" && one.file.fileId === key);
        if (found !== undefined) return fromText(found.from);
      }
      return fromText({ where: set.find((file) => file.fileId === key)?.ticketWhere ?? null, author: null });
    };
    const ticketConnection = ticket.data?.connection ?? null;
    const source: FileViewerSource =
      opened.origin === "ticket"
        ? {
            kind: "ticket",
            taskKey: value.taskKey,
            tracker: ticketConnection === null ? "" : trackerName(ticketConnection.kind),
            folder: `${FILES_ROOT_DIR}/${TICKET_FILES_FOLDER}/`,
            imagesNotSent: ticket.data?.rounds[0]?.imagesNotSent ?? null,
            from: ticketFrom,
          }
        : {
            kind: "message",
            taskKey: value.taskKey,
            author: facts?.memberName ?? "",
            at: facts?.at ?? 0,
            folder: `${FILES_ROOT_DIR}/${MESSAGE_FILES_FOLDER}/${String(opened.seq ?? 0)}/`,
            imagesNotSent: facts?.imagesNotSent ?? null,
            toMessage: () => {
              setParam(MESSAGE_FILE_LINK_PARAM, null);
              requestAnimationFrame(() => { document.querySelector(`[data-role="user"][data-first-seq="${String(opened.seq ?? 0)}"]`)?.scrollIntoView({ block: "start" }); });
            },
          };
    return (
      <FileViewer
        images={images}
        openKey={opened.fileId}
        source={source}
        agent={agentName}
        projectName={value.projectName}
        link={(key) => `${window.location.origin}${messageFileLinkPath(taskId, key)}`}
        onSelect={(key) => { setParam(MESSAGE_FILE_LINK_PARAM, key); }}
        onClose={() => { setParam(MESSAGE_FILE_LINK_PARAM, null); }}
      />
    );
  })();
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
          onClose={() => { setParam("attachment", null); }}
          addToDraft={addToDraft === null ? null : { run: addToDraft, pending: addingId, error: value.addError }}
        />
      )}
      {fileViewer}
    </AttachmentsContext.Provider>
  );
};
