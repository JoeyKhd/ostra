"use client";

import { AppWindowIcon, CameraIcon, ClapperboardIcon, ImageIcon, ImageOffIcon, PaperclipIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { attachmentSkippedWords, noBrowserWords } from "@ostra/protocol";
import type { AppProcessData, AttachmentSkippedData, AttachmentsData, NoBrowserData } from "@ostra/task-view";

import { AppLogTail } from "@/components/tasks/app-log-tail";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTaskContext } from "@/task/task-context";

import { AttachmentThumb } from "./attachment-thumb";
import { THUMB_HEIGHT, captions, captureSubject, durationText, targetText, thumbName } from "./attachment-words";
import { useAttachments } from "./attachments-context";
import { useFrameReel } from "./recording-player";

// The thread's pictures and the app's lines (task-attachments.md, "The thread"; F-121, F-140): a
// run of screenshots or a recording at its place in the turn, its capture row, its strip of
// thumbnails, its browser's line, and under the turn's last run where they're kept; the after-turn
// screenshots that weren't taken; a box with no browser; and each app process's start as a quiet
// line, a failed one with its log's tail. Each picture is the stored attachment's: one core refused
// isn't shown.

/** How to add a browser to an environment's image: the docs. */
const BROWSER_DOCS = "https://github.com/JoeyKhd/ostra/blob/main/docs/configuration.md#the-runner";

/** The most thumbnails before a `+n` tile. */
const STRIP_MAX = 6;

/** One activity line, as the thread's tool rows draw it: a 32px icon column, the 72px verb, the subject, its end. */
const Line = ({ icon, verb, children, end, tone, id }: { readonly icon: ReactNode; readonly verb?: ReactNode; readonly children: ReactNode; readonly end?: ReactNode; readonly tone?: "red" | "muted"; readonly id?: string | undefined }) => (
  <div id={id} className={cn("flex min-h-7 min-w-0 scroll-mt-24 items-center text-body", tone === "red" && "text-red", tone === "muted" && "text-muted")}>
    <span className="flex w-8 shrink-0 pl-1.5 text-faint [&_svg]:size-[14px] [&_svg]:stroke-[1.75]">{icon}</span>
    {verb === undefined ? null : <span data-verb className="w-[72px] shrink-0 text-muted">{verb}</span>}
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      {children}
      {end === undefined ? null : <span className="ml-1 shrink-0 font-mono text-sm text-faint">{end}</span>}
    </span>
  </div>
);

/** A recording's `0:42 · 4 steps`: the steps once its reel is read. */
const RecordingEnd = ({ path, durationMs }: { readonly path: string | null; readonly durationMs: number | null }) => {
  const reel = useFrameReel(path ?? "", path !== null);
  const steps = reel.data?.header.steps.length;
  return <>{steps === undefined ? durationText(durationMs) : `${durationText(durationMs)} · ${t("task.attachments.steps", { n: steps })}`}</>;
};

/** Where the pictures are kept: in the PR's description, and with the task. */
const WhereLine = () => {
  const context = useAttachments();
  const pr = context?.pr ?? null;
  return (
    <p className="mb-0.5 ml-8 mt-1.5 flex items-center gap-2 text-[13.5px] text-muted" data-testid="attachments-where">
      <PaperclipIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" />
      {pr === null ? (
        <span>{t("task.attachments.whereNoPr")}</span>
      ) : (
        <span>
          {t("task.attachments.whereBefore")} <span className="font-mono text-ui text-text">#{pr.number}</span>
          {t("task.attachments.whereAfter")} <span className="text-faint">{t("task.attachments.signIn")}</span>
        </span>
      )}
    </p>
  );
};

/** A run of screenshots, or a recording, at its place in the turn; a member's from the pane as its own row. */
export const AttachmentsRow = ({ data }: { readonly data: AttachmentsData }) => {
  const context = useAttachments();
  const { memberName } = useTaskContext();
  const views = context?.views ?? null;
  // Once the list is read, a picture core didn't store (a refused event) isn't drawn.
  const items = views === null ? data.items : data.items.filter((item) => context?.byId.has(item.attachmentId) === true);
  if (items.length === 0) return null;
  const [first] = items;
  if (first === undefined) return null;
  const anchor = context?.firstId !== null && items.some((item) => item.attachmentId === context?.firstId) ? "attachments" : undefined;
  const texts = captions(items);
  const shown = items.length > STRIP_MAX ? items.slice(0, STRIP_MAX - 1) : items;
  const more = items.length - shown.length;
  const caption = items.findLast((item) => item.caption !== null)?.caption ?? null;
  const subject = captureSubject(items);
  const head =
    data.source === "member" ? (
      <Line icon={<CameraIcon />} id={anchor}>
        <span className="text-text">{memberName(first.memberId ?? "")}</span>
        <span className="text-muted">{t("task.attachments.memberShot")}</span>
        <span className="font-mono text-ui text-text">{first.path}</span>
      </Line>
    ) : data.kind === "recording" ? (
      <Line icon={<ClapperboardIcon />} verb={t("task.attachments.recorded")} id={anchor} end={<RecordingEnd path={context?.byId.get(first.attachmentId)?.downloadPath ?? null} durationMs={first.durationMs} />}>
        <span className="min-w-0 break-words text-text">{first.caption ?? first.path}</span>
      </Line>
    ) : (
      <Line icon={<ImageIcon />} verb={t("task.attachments.captured")} id={anchor} end={targetText(first.target)}>
        <span className="text-text">{subject.words}</span>
        {subject.route === null ? null : <span className="font-mono text-ui text-text">{subject.route}</span>}
      </Line>
    );
  return (
    <div data-part="attachments" data-kind={data.kind} data-source={data.source} className="my-0.5">
      {head}
      <div className="ml-8 mt-1.5 flex items-end gap-3 overflow-x-auto pb-1" data-testid="attachment-strip">
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
              className="grid size-[110px] place-items-center rounded-[6px] border border-control-line bg-surface font-mono text-ui text-muted hover:border-faint focus-visible:outline-2 focus-visible:outline-teal"
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
      <p className="ml-8 mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-faint" data-testid="attachment-browser">
        {caption === null || data.kind === "recording" ? null : <span className="min-w-0 break-words text-muted">{caption}</span>}
        <span className="font-mono">{t("task.attachments.takenIn", { browser: `${first.browser.name} ${first.browser.version}` })}</span>
      </p>
      {data.lastInTurn ? <WhereLine /> : null}
    </div>
  );
};

/** The after-turn screenshots (or a member's) that weren't taken, and why. */
export const SkippedLine = ({ data }: { readonly data: AttachmentSkippedData }) => (
  <div data-part="attachment-skipped" data-reason={data.reason}>
    <Line icon={<ImageOffIcon />} tone="muted">
      {attachmentSkippedWords(data)}
    </Line>
  </div>
);

/** "No screenshots: the box has no browser", once per task, with how to add one. */
export const NoBrowserLine = ({ data }: { readonly data: NoBrowserData }) => (
  <div data-part="no-browser" title={noBrowserWords(data.reason)}>
    <Line icon={<ImageOffIcon />} tone="muted">
      <span>{t("task.attachments.noBrowser")}</span>
      <a href={BROWSER_DOCS} target="_blank" rel="noopener noreferrer" className="text-teal hover:underline">{t("environment.app.howToAddBrowser")}</a>
    </Line>
  </div>
);

/** An app process's line: starting, ready on its port, then exited, failed or stopped; a failed one with its log's tail. */
export const AppProcessLine = ({ data }: { readonly data: AppProcessData }) => {
  const context = useAttachments();
  const failed = data.state === "exited" || data.state === "failed";
  const text = (() => {
    switch (data.state) {
      case "starting":
        return t("task.app.starting", { name: data.name, port: data.port });
      case "ready":
        return t("task.app.ready", { name: data.name, port: data.port });
      case "exited":
      case "failed":
        return data.reason === "ready-timeout"
          ? t("task.app.didntAnswer", { name: data.name })
          : data.exitCode === null
            ? t("task.app.failed", { name: data.name })
            : t("task.app.exited", { name: data.name, code: data.exitCode });
      case "stopped":
        return t("task.app.stopped", { name: data.name });
      default:
        return data.state satisfies never;
    }
  })();
  return (
    <div data-part="app-process" data-state={data.state} data-name={data.name}>
      <Line icon={<AppWindowIcon />} tone={failed ? "red" : "muted"} end={data.state === "ready" && data.readyAfterMs !== null ? t("environment.app.last.seconds", { n: Math.max(1, Math.round(data.readyAfterMs / 1000)) }) : undefined}>
        <span>{text}</span>
        {failed && context?.projectId !== null && context?.projectId !== undefined ? (
          <Link href={`/projects/${context.projectId}/environment?tab=app&process=${encodeURIComponent(data.name)}`} className="text-sm text-teal hover:underline">
            {t("task.app.openProcess")}
          </Link>
        ) : null}
      </Line>
      {failed && data.logBlobId !== null && context !== null ? <AppLogTail taskId={context.taskId} blobId={data.logBlobId} className="ml-8" /> : null}
    </div>
  );
};
