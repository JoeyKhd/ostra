"use client";

import { ChevronLeftIcon, ChevronRightIcon, Columns2Icon, DownloadIcon, ImagePlusIcon, LinkIcon, LockIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { KeyCap } from "@/components/shell/actions/kbd-sequence";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";
import { safeHref } from "@/task/renderers";

import { AttachmentThumb } from "./attachment-thumb";
import { FILM_HEIGHT, bytesText, durationText, earlierOf, viewTargetText, viewerSet } from "./attachment-words";
import type { AttachmentView } from "./attachment-words";
import { RecordingPlayer } from "./recording-player";

// The viewer (task-attachments.md, "The viewer"): a dialog over the task page, opened on one
// picture with the turn's others in its filmstrip. A screenshot fits the stage and toggles to 100%;
// "Compare with" turns the stage into a before/after slider of an earlier capture of the same route
// and width. A recording plays in ostra's player, its steps beside it. ← and → move, Home and End
// jump, Escape closes and gives the focus back.

type Steps = { readonly words: readonly string[]; readonly starts: readonly number[]; readonly playing: number; readonly seek: (ms: number) => void } | null;

/** One property row of the facts: `Width  1280 × 800`. */
const Fact = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="grid min-h-7 grid-cols-[92px_minmax(0,1fr)] items-center gap-2 text-ui">
    <span className="text-muted">{label}</span>
    <span className="flex min-w-0 items-center gap-1.5 text-text">{children}</span>
  </div>
);

/** Who took it: the agent, ostra after the turn, or a member from the pane. */
const takenBy = (view: AttachmentView, agentName: string): string => {
  switch (view.source) {
    case "agent":
      return t("task.attachments.byAgent", { name: agentName });
    case "after-turn":
      return t("task.attachments.byAfterTurn");
    case "member":
      return t("task.attachments.byAgent", { name: view.takenBy?.name ?? t("taskPage.someone") });
    default:
      return view.source satisfies never;
  }
};

const seconds = (at: number): string => {
  const date = new Date(at);
  return `${formatClock(at)}:${String(date.getSeconds()).padStart(2, "0")}`;
};

/** The before/after slider of two captures of one route and width (`slider`, ← and → move it 5%). */
const Compare = ({ before, after }: { readonly before: AttachmentView; readonly after: AttachmentView }) => {
  const [at, setAt] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const move = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return;
    setAt(Math.max(0, Math.min(100, Math.round(((clientX - rect.left) / rect.width) * 100))));
  };
  return (
    <div
      ref={box}
      className="relative max-h-full max-w-full select-none overflow-hidden rounded-[6px] border border-line-2 bg-white"
      style={{ aspectRatio: `${String(after.width)} / ${String(after.height)}` }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event.clientX);
      }}
      onPointerMove={(event) => { if (event.buttons === 1) move(event.clientX); }}
      data-testid="attachment-compare"
    >
      <img src={after.downloadPath} alt={t("task.attachments.after")} className="block h-full w-full object-contain" />
      <img src={before.downloadPath} alt={t("task.attachments.before")} className="absolute inset-0 h-full w-full object-contain" style={{ clipPath: `inset(0 ${String(100 - at)}% 0 0)` }} />
      <span className="absolute left-2 top-2 rounded-[4px] bg-[rgba(13,14,16,0.78)] px-1.5 font-mono text-xs text-[#f2f3f4]">{formatClock(before.createdAt)}</span>
      <span className="absolute right-2 top-2 rounded-[4px] bg-[rgba(13,14,16,0.78)] px-1.5 font-mono text-xs text-[#f2f3f4]">{formatClock(after.createdAt)}</span>
      <div
        role="slider"
        tabIndex={0}
        aria-label={t("task.attachments.compareSlider")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={at}
        aria-valuetext={t("task.attachments.beforeAt", { n: at })}
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 cursor-ew-resize bg-text focus-visible:outline-2 focus-visible:outline-teal"
        style={{ left: `${String(at)}%` }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            setAt((now) => Math.max(0, Math.min(100, now + (event.key === "ArrowLeft" ? -5 : 5))));
          }
        }}
      >
        <span className="absolute left-1/2 top-1/2 grid h-7 w-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-line-2 bg-raise" aria-hidden />
      </div>
    </div>
  );
};

export const AttachmentViewer = ({ views, openId, taskKey, agentName, projectName, pr, onSelect, onClose, addToDraft }: {
  readonly views: readonly AttachmentView[];
  readonly openId: string;
  readonly taskKey: string;
  readonly agentName: string;
  readonly projectName: string;
  readonly pr: { readonly number: number; readonly url: string } | null;
  readonly onSelect: (attachmentId: string) => void;
  readonly onClose: () => void;
  /** "Add to draft" on a refine task: the action, the picture being added, and a refusal. */
  readonly addToDraft: { readonly run: (attachmentId: string) => void; readonly pending: string | null; readonly error: string | null } | null;
}) => {
  const open = views.find((view) => view.attachmentId === openId);
  const [full, setFull] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [steps, setSteps] = useState<Steps>(null);
  const opener = useRef<HTMLElement | null>(typeof document === "undefined" ? null : document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const stage = useRef<HTMLDivElement>(null);
  const onSteps = useCallback((next: Steps) => { setSteps(next); }, []);
  useEffect(() => {
    setFull(false);
    setComparing(false);
    setCopied(false);
  }, [openId]);
  if (open === undefined) return null;
  const set = viewerSet(views, open);
  const index = set.findIndex((view) => view.attachmentId === open.attachmentId);
  const go = (to: number) => {
    const next = set[Math.max(0, Math.min(set.length - 1, to))];
    if (next !== undefined && next.attachmentId !== open.attachmentId) onSelect(next.attachmentId);
  };
  const earlier = open.kind === "screenshot" ? earlierOf(views, open) : null;
  const prHref = pr === null ? null : safeHref(pr.url);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || (event.target instanceof HTMLElement && event.target.getAttribute("role") === "slider")) return;
    if (event.key === "ArrowLeft") go(index - 1);
    else if (event.key === "ArrowRight") go(index + 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(set.length - 1);
    else return;
    event.preventDefault();
  };
  const turnAt = open.turn === null ? null : formatClock(views.find((view) => view.turn?.turnId === open.turn?.turnId)?.createdAt ?? open.createdAt);
  const toTurn = () => {
    // The turn's message starts at its `turn.started`, the turn's first sequence.
    const startSeq = open.turn?.startSeq;
    onClose();
    if (startSeq === undefined) return;
    requestAnimationFrame(() => { document.querySelector(`[data-role="assistant"][data-first-seq="${String(startSeq)}"]`)?.scrollIntoView({ block: "start" }); });
  };
  const copyLink = () => {
    const link = `${window.location.origin}/tasks/${open.taskId}?attachment=${encodeURIComponent(open.attachmentId)}`;
    void navigator.clipboard.writeText(link).then(() => { setCopied(true); });
  };

  return (
    <Dialog.Root open onOpenChange={(value) => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--scrim)" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="attachment-viewer"
          data-kind={open.kind}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => { (stage.current ?? document.querySelector<HTMLElement>("[data-testid='recording-player']"))?.focus(); });
          }}
          onCloseAutoFocus={(event) => {
            const back = opener.current;
            if (back?.isConnected === true) {
              event.preventDefault();
              back.focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(860px,calc(100dvh-48px))] w-[min(1240px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line-2 bg-raise shadow-(--shadow-palette) focus:outline-none max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:border-0"
        >
          <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line pl-5 pr-4">
            <Dialog.Title className="shrink-0 text-[15px] font-semibold text-text max-sm:sr-only">{t("task.attachments.viewerTitle")}</Dialog.Title>
            <span className="min-w-0 truncate text-ui text-faint" data-testid="viewer-position">
              {turnAt === null
                ? t("task.attachments.viewerWhereNoTurn", { key: taskKey, n: index + 1, of: set.length })
                : t("task.attachments.viewerWhere", { key: taskKey, agent: agentName, time: turnAt, n: index + 1, of: set.length })}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12.5px] text-faint max-sm:hidden">
              <KeyCap>←</KeyCap>
              <KeyCap>→</KeyCap>
              <span className="mr-2.5">{t("task.attachments.toMove")}</span>
            </span>
            <Dialog.Close className="inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-[12.5px] text-faint hover:bg-sel hover:text-text max-sm:ml-auto" aria-label={t("common.close")}>
              <KeyCap>esc</KeyCap>
              {t("common.close")}
            </Dialog.Close>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] max-[1179px]:grid-cols-1 max-[1179px]:grid-rows-[minmax(0,1fr)_auto] max-[1179px]:overflow-y-auto">
            <div className="flex min-h-0 min-w-0 flex-col border-r border-line bg-surface max-[1179px]:min-h-[60vh] max-[1179px]:border-r-0">
              <div className="relative flex min-h-0 flex-1 flex-col">
              {open.kind === "recording" ? (
                <RecordingPlayer key={open.attachmentId} path={open.downloadPath} durationMs={open.durationMs ?? 0} onSteps={onSteps} />
              ) : (
                <div
                  ref={stage}
                  tabIndex={0}
                  aria-label={t("task.attachments.stage", { route: open.path, width: open.width })}
                  className={cn("relative flex min-h-0 flex-1 px-14 py-[18px] focus-visible:-outline-offset-2", full ? "overflow-auto" : "items-center justify-center overflow-hidden")}
                  data-testid="viewer-stage"
                >
                  {comparing && earlier !== null ? (
                    <Compare before={earlier} after={open} />
                  ) : (
                    <img
                      src={open.downloadPath}
                      alt={t("task.attachments.screenshotAlt", { route: open.path, width: open.width })}
                      data-testid="viewer-picture"
                      className={cn("rounded-[6px] border border-line-2 bg-white", full ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")}
                      style={full ? { width: open.width } : undefined}
                      onClick={() => { setFull((now) => !now); }}
                    />
                  )}
                </div>
              )}
              {set.length > 1 ? (
                <>
                  <button type="button" aria-label={t("task.attachments.previous")} disabled={index <= 0} onClick={() => { go(index - 1); }} className="absolute left-3 top-1/2 grid size-[34px] -translate-y-1/2 place-items-center rounded-full border border-line-2 bg-raise text-muted hover:text-text disabled:opacity-40 max-sm:hidden">
                    <ChevronLeftIcon aria-hidden className="size-4" />
                  </button>
                  <button type="button" aria-label={t("task.attachments.next")} disabled={index >= set.length - 1} onClick={() => { go(index + 1); }} className="absolute right-3 top-1/2 grid size-[34px] -translate-y-1/2 place-items-center rounded-full border border-line-2 bg-raise text-muted hover:text-text disabled:opacity-40 max-sm:hidden">
                    <ChevronRightIcon aria-hidden className="size-4" />
                  </button>
                </>
              ) : null}
              </div>
              <div className="flex h-[120px] shrink-0 items-center justify-center gap-3.5 overflow-x-auto border-t border-line bg-raise px-4 max-sm:h-[84px] max-sm:justify-start" data-testid="viewer-filmstrip">
                {set.map((view) => (
                  <AttachmentThumb
                    key={view.attachmentId}
                    view={view}
                    size={{ width: view.width, height: view.height, kind: view.kind, durationMs: view.durationMs }}
                    height={FILM_HEIGHT}
                    caption={view.kind === "recording" ? durationText(view.durationMs) : String(view.width)}
                    name={t("task.attachments.show", { route: view.path, width: view.width })}
                    selected={view.attachmentId === open.attachmentId}
                    onOpen={() => { onSelect(view.attachmentId); }}
                  />
                ))}
              </div>
            </div>
            <div className="overflow-y-auto p-[18px]" data-testid="viewer-facts">
              <p className="text-xs font-medium text-faint">{open.kind === "recording" ? t("task.attachments.kindRecording") : t("task.attachments.kindScreenshot")}</p>
              <p className="mt-1 break-all font-mono text-[16px] text-text">{open.path}</p>
              {open.caption === null ? null : <p className="mt-1.5 whitespace-pre-wrap break-words text-ui text-muted" data-testid="viewer-caption">{open.caption}</p>}
              <div className="mt-3 max-[1179px]:grid max-[1179px]:grid-cols-2 max-[1179px]:gap-x-6">
                <Fact label={t("task.attachments.width")}><span className="font-mono">{`${String(open.width)} × ${String(open.height)}`}</span></Fact>
                <Fact label={t("task.attachments.preview")}><span className="truncate font-mono">{viewTargetText(open.target)}</span></Fact>
                <Fact label={t("task.attachments.taken")}>
                  <span className="font-mono">{seconds(open.createdAt)}</span>
                  <span className="truncate text-faint">{takenBy(open, agentName)}</span>
                </Fact>
                {open.turn === null ? null : (
                  <Fact label={t("task.attachments.turn")}>
                    <button type="button" className="truncate text-teal hover:underline" onClick={toTurn}>{t("task.attachments.turnLink", { agent: agentName, time: turnAt ?? "" })}</button>
                  </Fact>
                )}
                <Fact label={t("task.attachments.file")}><span className="font-mono">{`${open.kind === "recording" ? t("task.attachments.reel") : t("task.attachments.png")} · ${bytesText(open.bytes)}`}</span></Fact>
                <Fact label={t("task.attachments.browser")}><span className="truncate font-mono" data-testid="viewer-browser" title={`${open.browser.name} ${open.browser.version}`}>{`${open.browser.name} ${open.browser.version}`}</span></Fact>
                {pr === null || prHref === null ? null : (
                  <Fact label={t("task.attachments.in")}>
                    <span>{t("task.attachments.pr")}</span>
                    <a href={prHref} target="_blank" rel="noopener noreferrer" className="font-mono text-teal hover:underline">#{pr.number}</a>
                    <span className="text-faint">{t("task.attachments.description")}</span>
                  </Fact>
                )}
              </div>
              {open.kind === "recording" && steps !== null && steps.words.length > 0 ? (
                <ol className="mt-3 space-y-0.5" data-testid="recording-steps">
                  {steps.words.map((words, at) => (
                    <li key={at}>
                      <button
                        type="button"
                        aria-current={steps.playing === at ? "step" : undefined}
                        className={cn("flex w-full items-baseline gap-2 rounded-sm px-1.5 py-1 text-left text-ui hover:bg-hover", steps.playing === at ? "bg-sel text-text" : "text-muted")}
                        onClick={() => { steps.seek(steps.starts[at] ?? 0); }}
                      >
                        <span className="shrink-0 font-mono text-xs text-faint">{at + 1}</span>
                        <span className="min-w-0 break-words">{words}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : null}
              <div className="mt-4 flex flex-col gap-2 max-[1179px]:flex-row max-[1179px]:flex-wrap">
                {earlier === null ? null : (
                  <Button size="sm" className="justify-start" aria-pressed={comparing} onClick={() => { setComparing((now) => !now); }} data-action="compare">
                    <Columns2Icon aria-hidden />
                    {t("task.attachments.compare", { time: formatClock(earlier.createdAt) })}
                  </Button>
                )}
                {addToDraft === null || open.kind !== "screenshot" ? null : (
                  <Button size="sm" className="justify-start" disabled={open.inDraft || addToDraft.pending !== null} onClick={() => { addToDraft.run(open.attachmentId); }} data-action="add-to-draft">
                    <ImagePlusIcon aria-hidden />
                    {open.inDraft ? t("task.attachments.inDraft") : addToDraft.pending === open.attachmentId ? t("task.attachments.adding") : t("task.attachments.addToDraft")}
                  </Button>
                )}
                <a href={open.downloadPath} download className={cn(buttonVariants({ size: "sm" }), "justify-start")} data-action="download">
                  <DownloadIcon aria-hidden />
                  {t("task.attachments.download")}
                </a>
                <Button size="sm" className="justify-start" onClick={copyLink} data-action="copy-link">
                  <LinkIcon aria-hidden />
                  {copied ? t("task.attachments.copied") : t("task.attachments.copyLink")}
                </Button>
              </div>
              {addToDraft?.error === null || addToDraft === null ? null : <p role="alert" className="mt-2 text-sm text-red">{addToDraft.error}</p>}
              <p className="mt-3.5 flex gap-2 text-[12.5px] text-faint">
                <LockIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
                {t("task.attachments.note", { project: projectName })}
              </p>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
