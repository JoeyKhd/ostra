"use client";

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PauseIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { ModelImageInput } from "@ostra/domain";
import type { FileLimits } from "@ostra/domain/file-limits";
import type { MessageFileId, TaskId } from "@ostra/protocol";
import type { MessageFileView } from "@ostra/task-view";

import { FileViewer } from "@/components/tasks/attachments/file-viewer";
import { AttachButton } from "@/components/tasks/composer/attach-button";
import { dropToText, limitsText, trayNoteOf } from "@/components/tasks/composer/attach-words";
import { ComposerBox, PhoneSendButton, SendFace } from "@/components/tasks/composer/composer-box";
import { ComposerTray, TrayHintLine, TrayNoteLine } from "@/components/tasks/composer/composer-tray";
import { DropZone } from "@/components/tasks/composer/drop-zone";
import { projectUploader } from "@/components/tasks/composer/upload-file";
import { useAttachments } from "@/components/tasks/composer/use-attachments";
import type { TrayItem } from "@/components/tasks/composer/use-attachments";
import { useDropZone } from "@/components/tasks/composer/use-drop-zone";
import { usePasteFiles } from "@/components/tasks/composer/use-paste-files";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

// Owner: ticket 11 (milestone 10, F-151: the composer as one box, parts.md part 14). Ticket 09
// moved it here from `task-thread.tsx` unchanged, so ticket 11 can restyle it on its own.

/** What the composer needs to take files (F-148, ticket 15): where they upload, and what the task's model and runner can do with them. */
export type ComposerFiles = {
  readonly projectId: string;
  readonly taskId: TaskId;
  readonly agent: string;
  /** `tasks.get`'s `messageFiles`: the model's image input, whether the agent takes images, and a runner too old for files. */
  readonly messageFiles: { readonly model: { readonly name: string; readonly imageInput: ModelImageInput } | null; readonly agentTakesImages: boolean; readonly oldRunner: string | null };
  /** A question waits on the driver: the drop zone says the files go in the reply. */
  readonly replying: boolean;
};

/** The files a message goes with: their IDs for the API, and the browser's copies for its first frame in the thread. */
export type SentFiles = { readonly fileIds: readonly MessageFileId[]; readonly previews: readonly MessageFileView[] };

/** No limits while they're read: the tray takes nothing until they come. */
const NO_LIMITS: FileLimits = { maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0 };

/** The files a message carries while it sends, drawn from the browser's own copies. */
const previewsOf = (items: readonly TrayItem[]): readonly MessageFileView[] =>
  items.flatMap((item): MessageFileView[] =>
    item.upload.state === "ready"
      ? [
          {
            fileId: item.upload.uploaded.fileId,
            name: item.upload.uploaded.name,
            kind: item.upload.uploaded.kind,
            contentType: item.upload.uploaded.contentType,
            size: item.upload.uploaded.size,
            origin: "member",
            asImage: false,
            text: item.upload.uploaded.text.state,
            downloadPath: item.previewUrl,
            textWords: item.upload.uploaded.text.words,
            textReason: item.upload.uploaded.text.reason,
          },
        ]
      : [],
  );

/**
 * The composer, pinned under the thread (task.md, "Composer"). ostra's own Send: assistant-ui's stock
 * Send never fires while a turn runs (spike 7, ADR 0036). `Interrupt and send` shows only while a turn
 * runs and the driver may interrupt it. Milestone 9 (ticket 15): files by the paperclip, paste and a
 * drop on the chat column, in a tray under the words; Send waits for uploads in flight, and files
 * with no words are a message.
 */
export const Composer = ({ interrupt, onSend, reopen = false, hint = null, files }: {
  readonly interrupt: boolean;
  readonly onSend: (text: string, interrupt: boolean, sent: SentFiles) => Promise<void>;
  readonly reopen?: boolean;
  readonly hint?: string | null;
  readonly files: ComposerFiles | null;
}) => {
  const text = useAuiState((state) => state.composer.text);
  const aui = useAui();
  const trpc = useTRPC();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const limits = useQuery(trpc.files.limits.queryOptions(undefined, { enabled: files !== null, staleTime: Number.POSITIVE_INFINITY }));
  const { mutate: discardFile } = useMutation(trpc.files.discard.mutationOptions());
  const discard = useCallback((fileId: MessageFileId) => { discardFile({ fileId }); }, [discardFile]);
  const projectId = files?.projectId ?? null;
  const taskId = files?.taskId ?? null;
  const upload = useMemo(() => projectUploader(projectId ?? "", taskId), [projectId, taskId]);
  const canAttach = files !== null && limits.data !== undefined;
  const attachments = useAttachments({ limits: limits.data ?? NO_LIMITS, upload, discard, enabled: canAttach });
  const onPaste = usePasteFiles({ enabled: canAttach && !attachments.waiting, onFiles: attachments.add });
  const dropping = useDropZone({ enabled: canAttach && !attachments.waiting, onDrop: attachments.add });
  const sendState = attachments.sendState(text);
  const note = trayNoteOf({
    refusal: attachments.refusal,
    entries: attachments.items,
    model: files?.messageFiles.model ?? null,
    agentWithoutImages: files === null || files.messageFiles.agentTakesImages ? null : files.agent,
    oldRunner: files?.messageFiles.oldRunner ?? null,
  });
  // A runner too old for files takes the words alone: with files in the tray, Send waits for an update or their removal.
  const blocked = busy || sendState.kind === "empty" || sendState.kind === "blocked" || note?.kind === "runner";
  const send = (interruptNow: boolean) => {
    if (blocked) return;
    const value = text.trim();
    attachments.press((fileIds) => {
      setError(null);
      setBusy(true);
      onSend(value, interruptNow, { fileIds, previews: previewsOf(attachments.items) }).then(
        () => {
          aui.composer.setText("");
          attachments.clear();
          setBusy(false);
        },
        (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : t("errors.unknown"));
          setBusy(false);
        },
      );
    });
  };
  const column = dropping && typeof document !== "undefined" ? document.querySelector("[data-chat-column]") : null;
  const pictures = attachments.items.flatMap((item) => (item.look === "image" && item.previewUrl !== null ? [{ key: item.key, name: item.name, src: item.previewUrl, size: item.size, asImage: null }] : []));
  return (
    <ComposerPrimitive.Root onSubmit={(event) => { event.preventDefault(); send(false); }}>
      <ComposerBox
        data-part="composer"
        field={
          <ComposerPrimitive.Input
            onKeyDown={(event) => {
              // Ticket 16: Escape leaves the composer (Enter sends, Shift+Enter is a new line); while
              // Send waits for uploads, it goes back to editing first.
              if (event.key !== "Escape") return;
              if (attachments.waiting) attachments.cancel();
              else event.currentTarget.blur();
            }}
            onPaste={onPaste}
            readOnly={attachments.waiting}
            aria-label={t("task.composer.label")}
            placeholder={reopen ? t("taskPage.composer.reopenPlaceholder") : t("task.composer.placeholder")}
            rows={attachments.items.length > 0 ? 1 : 2}
            className="block w-full resize-none bg-transparent text-body text-text placeholder:text-faint focus:outline-none focus-visible:outline-none"
          />
        }
        tray={
          <>
            <ComposerTray
              items={attachments.items}
              announcement={attachments.announcement}
              onRemove={attachments.remove}
              onRetry={attachments.retry}
              onOpen={(key) => { setViewing(key); }}
              returnFocus={() => { document.querySelector<HTMLElement>("[data-part='composer'] textarea")?.focus(); }}
            />
            {error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{error}</p>}
          </>
        }
        note={<TrayNoteLine note={note} onDismiss={attachments.dismiss} />}
        attach={files === null ? null : <AttachButton onFiles={attachments.add} full={attachments.full} max={limits.data?.maxFiles ?? 0} disabled={!canAttach || attachments.waiting} />}
        hint={<TrayHintLine hint={attachments.hint} own={hint ?? t("task.composer.hint")} />}
        actions={
          <>
            {interrupt ? (
              <Button type="button" onClick={() => { send(true); }} disabled={blocked}>
                <PauseIcon /> {t("task.composer.interruptAndSend")}
              </Button>
            ) : null}
            {reopen ? (
              <Button type="button" variant="primary" onClick={() => { send(false); }} disabled={blocked} data-action="reopen">
                {sendState.kind === "waiting" ? <SendFace state={sendState} label="" /> : <><RotateCcwIcon /> {busy ? t("taskPage.composer.reopening") : t("taskPage.composer.reopen")}</>}
              </Button>
            ) : (
              <Button type="button" variant="primary" onClick={() => { send(false); }} disabled={blocked} data-action="send">
                <SendFace state={sendState} label={t("task.composer.send")} />
              </Button>
            )}
          </>
        }
        phoneSend={reopen ? null : <PhoneSendButton state={blocked ? { kind: "empty" } : sendState} onPress={() => { send(false); }} />}
      />
      {column === null || files === null || limits.data === undefined
        ? null
        : createPortal(<DropZone variant="column" to={dropToText(files.agent, files.replying)} limits={limitsText(limits.data)} />, column)}
      {viewing === null ? null : (
        <FileViewer images={pictures} openKey={viewing} source={{ kind: "unsent" }} agent={files?.agent ?? ""} projectName="" link={null} onSelect={setViewing} onClose={() => { setViewing(null); }} />
      )}
    </ComposerPrimitive.Root>
  );
};
