"use client";

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpIcon, EllipsisIcon, PauseIcon, SquareIcon, SquareTerminalIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ModelImageInput } from "@ostra/domain";
import type { FileLimits } from "@ostra/domain/file-limits";
import type { MessageFileId, TaskId } from "@ostra/protocol";
import type { MessageFileView } from "@ostra/task-view";

import { FileViewer } from "@/components/tasks/attachments/file-viewer";
import { AttachButton } from "@/components/tasks/composer/attach-button";
import { dropToText, limitsText, trayNoteOf, waitingText } from "@/components/tasks/composer/attach-words";
import type { SendState, TrayHint } from "@/components/tasks/composer/attach-words";
import { ComposerTray, TrayHintLine, TrayNoteLine } from "@/components/tasks/composer/composer-tray";
import { DropZone } from "@/components/tasks/composer/drop-zone";
import { projectUploader } from "@/components/tasks/composer/upload-file";
import { useAttachments } from "@/components/tasks/composer/use-attachments";
import type { TrayItem } from "@/components/tasks/composer/use-attachments";
import { useDropZone } from "@/components/tasks/composer/use-drop-zone";
import { usePasteFiles } from "@/components/tasks/composer/use-paste-files";
import { TakeItLocalCard, usePhone } from "@/components/tasks/take-it-local";
import type { LocalLoad } from "@/components/tasks/take-it-local";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import type { ComposerWords } from "./composer-words";

// Owner: ticket 11 (milestone 10, F-151: the composer as one box, parts.md part 14, choice 14). One
// box, 52px, radius 12px, a `--control-line` edge: the paperclip, the field growing to 8 lines, then
// `Interrupt and send` (outline, labelled) while a turn runs and Send, a 32px `--primary` square
// with `arrow-up`; both asleep while the field is empty. Milestone 9's tray sits inside the box,
// above the field. Under it, 7px: the hint at the left and the next turn's model and level at the
// right. Below 768 the box docks under the chat (`s6.md`): a hairline above, the paperclip 44px,
// Send 40px.

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

/**
 * `s6.md`'s `…` menu on a phone (milestone 2's rule for `Stop`): `Interrupt and send` is the
 * composer's own, and `Stop` and `Take it local` come from the page, which holds them.
 */
export type PhoneMenuActions = {
  readonly stop: { readonly run: () => void; readonly stopping: boolean; readonly pending: boolean } | null;
  readonly local: { readonly load: LocalLoad; readonly onOpen: () => void } | null;
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

/** One row of the phone's `…` menu: 44px, its icon and words, and nothing else. */
const MenuRow = ({ icon, label, onPress, disabled = false }: { readonly icon: ReactNode; readonly label: string; readonly onPress: () => void; readonly disabled?: boolean }) => (
  <li className="border-b border-line last:border-b-0">
    <button
      type="button"
      disabled={disabled}
      onClick={onPress}
      className="flex min-h-11 w-full items-center gap-2.5 text-left text-ui text-text disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted"
    >
      {icon}
      {label}
    </button>
  </li>
);

/**
 * The line under the box at its left: why Send can't go yet (a failed upload, `10 of 10 files`, a
 * heavy message), Send waiting for uploads (`Uploading 1 of 2…`), a send that failed, or else the
 * composer's own hint.
 */
const HintLine = ({ hint, own, state, error }: { readonly hint: TrayHint; readonly own: string; readonly state: SendState; readonly error: string | null }) => {
  if (error !== null) {
    return <span role="alert" className="min-w-0 flex-1 truncate text-red" data-testid="composer-error">{error}</span>;
  }
  if (state.kind === "waiting") {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1.5" data-testid="composer-hint" data-hint="waiting">
        <span aria-hidden className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent motion-reduce:animate-none" />
        <span className="truncate">{waitingText(state)}</span>
      </span>
    );
  }
  return <TrayHintLine hint={hint} own={own} className="text-[12.5px] max-md:text-xs" />;
};

/**
 * The composer, pinned under the thread (task.md, "Composer"; parts.md part 14). ostra's own Send:
 * assistant-ui's stock Send never fires while a turn runs (spike 7, ADR 0036). `Interrupt and send`
 * shows only while a turn runs and the driver may interrupt it (`showsInterrupt`). Milestone 9
 * (ticket 15): files by the paperclip, paste and a drop on the chat column, in the tray at the top
 * of the box; Send waits for uploads in flight, and files with no words are a message.
 */
export const Composer = ({ interrupt, onSend, reopen = false, words = null, nextTurn = null, phoneMenu = null, files }: {
  readonly interrupt: boolean;
  readonly onSend: (text: string, interrupt: boolean, sent: SentFiles) => Promise<void>;
  /** The message reopens the task (`tasks.reopen`) instead of reaching a going session. */
  readonly reopen?: boolean;
  /** Its placeholder, the hint under it and Send's name (`composerWordsOf`); `null`: milestone 1's. */
  readonly words?: ComposerWords | null;
  /** Under the box at its right: the next turn's model and level (`NextTurnMenu`, F-137). */
  readonly nextTurn?: ReactNode;
  /** A phone's `…` menu (s6.md): Stop and Take it local, beside the composer's own Interrupt and send. */
  readonly phoneMenu?: PhoneMenuActions | null;
  readonly files: ComposerFiles | null;
}) => {
  const text = useAuiState((state) => state.composer.text);
  const aui = useAui();
  const trpc = useTRPC();
  const phone = usePhone();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStep, setMenuStep] = useState<"actions" | "local">("actions");
  const phoneStop = phoneMenu?.stop ?? null;
  const phoneLocal = phoneMenu?.local ?? null;
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
  const said = words ?? {
    placeholder: reopen ? t("taskPage.composer.reopenPlaceholder") : t("task.composer.placeholder"),
    hint: t("task.composer.hint"),
    send: reopen ? t("taskPage.composer.reopen") : t("task.composer.send"),
  };
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
  const waiting = sendState.kind === "waiting";
  const sendName = waiting ? waitingText(sendState) : busy && reopen ? t("taskPage.composer.reopening") : said.send;
  return (
    <ComposerPrimitive.Root
      onSubmit={(event) => { event.preventDefault(); send(false); }}
      data-part="composer-dock"
      className="max-md:border-t max-md:border-line max-md:bg-bg max-md:px-2.5 max-md:pb-3 max-md:pt-2"
    >
      <div
        data-part="composer"
        className="focus-box rounded-xl border border-control-line bg-surface py-[9px] pl-[7px] pr-[9px] max-md:rounded-[14px] max-md:py-0.5 max-md:pl-0.5 max-md:pr-1"
      >
        {/* Milestone 9's tray and its note, inside the box above the field (choice 14). */}
        <div className="flex flex-col gap-2 px-0.5 has-[[data-testid=composer-note]]:pb-2 has-[[role=list]]:pb-2 max-md:has-[[role=list]]:pt-1">
          <ComposerTray
            items={attachments.items}
            announcement={attachments.announcement}
            onRemove={attachments.remove}
            onRetry={attachments.retry}
            onOpen={(key) => { setViewing(key); }}
            returnFocus={() => { document.querySelector<HTMLElement>("[data-part='composer'] textarea")?.focus(); }}
            className="max-md:mr-0 max-md:pb-1 max-md:pr-0 max-md:pt-0"
          />
          <TrayNoteLine note={note} onDismiss={attachments.dismiss} />
        </div>
        <div className="flex items-end gap-1 max-md:items-center">
          {files === null ? null : (
            <AttachButton
              onFiles={attachments.add}
              full={attachments.full}
              max={limits.data?.maxFiles ?? 0}
              disabled={!canAttach || attachments.waiting}
              className="ml-0 size-8 max-md:border-0 max-md:bg-transparent"
            />
          )}
          <div className="min-w-0 flex-1 px-1.5 py-[5px] max-md:px-0.5 max-md:py-0">
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
              placeholder={said.placeholder}
              minRows={1}
              maxRows={8}
              className="block w-full resize-none bg-transparent text-body leading-[22px] text-text placeholder:text-faint focus:outline-none focus-visible:outline-none max-md:py-[11px] max-md:text-[15.5px]"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {interrupt ? (
              <Button
                type="button"
                onClick={() => { send(true); }}
                disabled={blocked}
                data-action="interrupt-and-send"
                className="h-8 gap-1.5 rounded-lg border-line-2 px-2.5 text-sm disabled:opacity-45 [&_svg]:size-[14px] max-md:hidden"
              >
                <PauseIcon aria-hidden /> {t("task.composer.interruptAndSend")}
              </Button>
            ) : null}
            {/* s6.md: a phone's `…` menu, left of Send, holds `Interrupt and send`, `Stop` and `Take it local`. */}
            {!phone || (phoneStop === null && phoneLocal === null && !interrupt) ? null : (
              <Sheet open={menuOpen} onOpenChange={(open) => { setMenuOpen(open); if (!open) setMenuStep("actions"); }}>
                <SheetTrigger asChild>
                  <Button
                    type="button"
                    aria-label={t("task.composer.menu")}
                    data-action="composer-menu"
                    className="size-10 rounded-[10px] border-0 bg-transparent p-0 text-muted [&_svg]:size-[18px] [&_svg]:stroke-[1.75]"
                  >
                    <EllipsisIcon aria-hidden />
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" title={t("task.composer.menu")} className="px-4 pb-6 pt-4">
                  {menuStep === "local" && phoneLocal !== null ? (
                    <TakeItLocalCard load={phoneLocal.load} />
                  ) : (
                    <ul>
                      {interrupt ? (
                        <MenuRow icon={<PauseIcon aria-hidden />} label={t("task.composer.interruptAndSend")} onPress={() => { setMenuOpen(false); send(true); }} disabled={blocked} />
                      ) : null}
                      {phoneStop === null ? null : (
                        <MenuRow
                          icon={<SquareIcon aria-hidden />}
                          label={phoneStop.stopping ? t("taskPage.stopping") : t("taskPage.stop")}
                          onPress={() => { setMenuOpen(false); phoneStop.run(); }}
                          disabled={phoneStop.stopping || phoneStop.pending}
                        />
                      )}
                      {phoneLocal === null ? null : (
                        <MenuRow icon={<SquareTerminalIcon aria-hidden />} label={t("takeLocal.button")} onPress={() => { setMenuStep("local"); phoneLocal.onOpen(); }} />
                      )}
                    </ul>
                  )}
                </SheetContent>
              </Sheet>
            )}
            <Button
              type="button"
              variant="primary"
              onClick={() => { send(false); }}
              disabled={blocked}
              aria-label={sendName}
              title={sendName}
              data-action={reopen ? "reopen" : "send"}
              className="size-8 rounded-lg p-0 disabled:opacity-35 [&_svg]:size-[17px] [&_svg]:stroke-2 max-md:size-10 max-md:rounded-[10px]"
            >
              {waiting || busy ? (
                <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent opacity-80 motion-reduce:animate-none" />
              ) : (
                <ArrowUpIcon aria-hidden />
              )}
            </Button>
          </div>
        </div>
      </div>
      <div data-part="composer-under" className="mt-[7px] flex items-center gap-2 whitespace-nowrap px-1 text-[12.5px] text-faint max-md:mt-1.5 max-md:text-xs">
        {/* Until the box takes files (no limits read yet), the tray has nothing to say: `0 of 0 files` isn't a hint. */}
        <HintLine
          hint={canAttach ? attachments.hint : { kind: "own" }}
          // s6.md's short hint: `Send reaches OpenCode after your answer.` reads `Reaches …` on a phone.
          own={!phone || !said.hint.startsWith("Send ") ? said.hint : said.hint.charAt(5).toUpperCase() + said.hint.slice(6)}
          state={sendState}
          error={error}
        />
        {nextTurn === null ? null : <span className="ml-auto flex min-w-0 shrink-0 items-center">{nextTurn}</span>}
      </div>
      {column === null || files === null || limits.data === undefined
        ? null
        : createPortal(<DropZone variant="column" to={dropToText(files.agent, files.replying)} limits={limitsText(limits.data)} />, column)}
      {viewing === null ? null : (
        <FileViewer images={pictures} openKey={viewing} source={{ kind: "unsent" }} agent={files?.agent ?? ""} projectName="" link={null} onSelect={setViewing} onClose={() => { setViewing(null); }} />
      )}
    </ComposerPrimitive.Root>
  );
};
