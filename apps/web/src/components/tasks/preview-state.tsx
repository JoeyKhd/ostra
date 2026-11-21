"use client";

import { AppWindowIcon, ArrowRightIcon, CheckIcon, CircleAlertIcon, MessageSquareIcon, MonitorIcon, MoonIcon, PowerIcon, RotateCwIcon, ServerOffIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

// The pane's states over its viewport (task-preview.md, "The pane's states"): starting, asleep,
// ended, nothing to preview, a runner too old, a view the box refused, the app that stopped
// answering, and the dropped stream. Each block is `--bg` inside the frame's edge, a 36px icon box,
// a 16px title, its line in `--muted`, and at most one row of actions. No amber: nothing here waits
// on a person.

const Spinner = ({ className }: { readonly className?: string }) => (
  <span aria-hidden className={cn("inline-block size-[13px] shrink-0 animate-spin rounded-full border-[1.5px] border-line-2 border-t-muted motion-reduce:animate-none", className)} />
);

export { Spinner as PreviewSpinner };

const IconBox = ({ children }: { readonly children: ReactNode }) => (
  <div aria-hidden className="mb-3.5 grid size-9 place-items-center rounded-[9px] border border-line-2 text-muted [&_svg]:size-[17px] [&_svg]:stroke-[1.75]">{children}</div>
);

/** A state's block: centred in the viewport, in place of the frame. */
export const StateBlock = ({ width = 400, children, testId }: { readonly width?: number; readonly children: ReactNode; readonly testId: string }) => (
  <div className="absolute inset-2.5 grid place-items-center overflow-y-auto rounded-lg border border-line-2 bg-bg p-5" data-testid={testId}>
    <div role="status" className="w-full" style={{ maxWidth: width }}>{children}</div>
  </div>
);

const Title = ({ children }: { readonly children: ReactNode }) => <h3 className="mb-1 text-[16px] font-semibold text-text">{children}</h3>;
const Line = ({ children }: { readonly children: ReactNode }) => <p className="text-[14px] text-muted">{children}</p>;

type Step = { readonly state: "done" | "doing" | "failed"; readonly label: ReactNode };

const StepRow = ({ step }: { readonly step: Step }) => (
  <div className="flex min-h-[30px] items-center gap-2.5 text-[14px] text-text" data-step-state={step.state}>
    {step.state === "done" ? <CheckIcon aria-hidden className="size-[15px] text-green" /> : step.state === "failed" ? <XIcon aria-hidden className="size-[15px] text-red" /> : <Spinner className="mx-px" />}
    <span className={cn("min-w-0", step.state === "failed" && "text-red")}>{step.label}</span>
  </div>
);

/** How long the app has to answer before its step turns red (task-preview.md: 90 s, a working value). */
export const ANSWER_WITHIN_MS = 90_000;

export type StartingProps = {
  readonly label: string;
  readonly port: number;
  readonly runner: string | null;
  readonly boxReady: boolean;
  /** Whether the process is the environment's (it has a "Started" step), and its state. */
  readonly process: "starting" | "ready" | "failed" | null;
  readonly waitedMs: number;
  readonly onRestart: (() => void) | null;
  readonly restarting: boolean;
};

/** Starting (`task-preview-starting`): the box, the process, and the port answering, each a step. */
export const StartingBlock = ({ label, port, runner, boxReady, process, waitedMs, onRestart, restarting }: StartingProps) => {
  const late = waitedMs > ANSWER_WITHIN_MS || process === "failed";
  const steps: Step[] = [
    {
      state: boxReady ? "done" : "doing",
      label: boxReady ? (
        <>
          {t("task.preview.starting.box")} {runner === null ? null : <span className="ml-1 font-mono text-[13px] text-faint">{runner}</span>}
        </>
      ) : t("task.preview.starting.boxWaiting"),
    },
  ];
  if (boxReady && process !== null) {
    steps.push({ state: process === "failed" ? "failed" : "done", label: process === "failed" ? t("task.preview.starting.processFailed", { label }) : t("task.preview.starting.started", { label }) });
  }
  if (boxReady && process !== "failed") {
    steps.push({
      state: late ? "failed" : "doing",
      label: late ? t("task.preview.starting.late", { seconds: Math.round(ANSWER_WITHIN_MS / 1000) }) : (
        <>
          {t("task.preview.starting.waiting")} <span className="font-mono text-[13px]">:{port}</span> {t("task.preview.starting.answer")}{" "}
          <span className="font-mono text-[13px] text-faint">· {t("task.preview.starting.seconds", { n: Math.floor(waitedMs / 1000) })}</span>
        </>
      ),
    });
  }
  return (
    <StateBlock testId="preview-starting">
      <IconBox><Spinner className="size-4 border-2" /></IconBox>
      <Title>{t("task.preview.starting.title", { label })}</Title>
      <Line>{t("task.preview.starting.body")}</Line>
      <div className="mt-4">{steps.map((step, index) => <StepRow key={index} step={step} />)}</div>
      {late && onRestart !== null ? (
        <div className="mt-4 flex gap-2">
          <Button onClick={onRestart} disabled={restarting} data-action="restart-app"><RotateCwIcon aria-hidden /> {t("task.preview.starting.restart", { label })}</Button>
        </div>
      ) : null}
    </StateBlock>
  );
};

export type StoppedProps = {
  /** An idle box that went to sleep (`Wake to preview`), or the task's box is gone (`Start the app`). */
  readonly asleep: boolean;
  readonly projectName: string;
  /** The last screenshot's address, drawn grey behind the card. */
  readonly screenshot: string | null;
  readonly onStart: () => void;
  readonly starting: boolean;
  readonly error: string | null;
};

/** Asleep or ended (`task-preview-stopped`): the last screenshot, grey, behind a card with the one action. */
export const StoppedBlock = ({ asleep, projectName, screenshot, onStart, starting, error }: StoppedProps) => (
  <div className="absolute inset-2.5 grid place-items-center overflow-hidden rounded-lg border border-line-2 bg-bg p-5" data-testid="preview-stopped" data-asleep={asleep ? "true" : "false"}>
    {screenshot === null ? null : (
      // A picture of the app, decorative behind the card: the card says what it is.
      <img src={screenshot} alt="" aria-hidden className="pointer-events-none absolute inset-0 size-full object-cover object-top opacity-10 blur-[1px] grayscale [[data-theme=light]_&]:opacity-35" />
    )}
    <div role="status" className="relative w-full max-w-[420px] rounded-xl border border-line-2 bg-raise px-6 py-[22px] shadow-(--shadow-pop)">
      <IconBox><MoonIcon /></IconBox>
      <Title>{asleep ? t("task.preview.stopped.asleep") : t("task.preview.stopped.gone")}</Title>
      <Line>{asleep ? t("task.preview.stopped.asleepBody") : t("task.preview.stopped.goneBody")}</Line>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={onStart} disabled={starting} data-action="start-app">
          <PowerIcon aria-hidden /> {asleep ? t("task.preview.stopped.wake") : t("task.preview.stopped.start")}
        </Button>
        {screenshot === null ? null : (
          <Button variant="ghost" asChild>
            <a href={screenshot} target="_blank" rel="noopener noreferrer">{t("task.preview.stopped.screenshot")}</a>
          </Button>
        )}
      </div>
      {error === null ? null : <p role="alert" className="mt-3 text-[13px] text-red">{error}</p>}
      <p className="mt-3 text-[12.5px] text-faint">{t("task.preview.stopped.note", { project: projectName })}</p>
    </div>
  </div>
);

export type NoneProps = {
  readonly projectName: string;
  readonly environmentHref: string;
  /** Puts the words into the composer; `null` when the member can't send. */
  readonly onAsk: (() => void) | null;
};

/** Nothing to preview (`task-preview-none`). No detected ports: detecting them comes later (Q313). */
export const NoneBlock = ({ projectName, environmentHref, onAsk }: NoneProps) => (
  <StateBlock width={430} testId="preview-none">
    <IconBox><AppWindowIcon /></IconBox>
    <Title>{t("task.preview.none.title")}</Title>
    <Line>{t("task.preview.none.body", { project: projectName })}</Line>
    <div className="mt-[18px] flex flex-wrap items-center gap-x-3.5 gap-y-2">
      {onAsk === null ? null : (
        <Button size="sm" onClick={onAsk} data-action="ask-agent"><MessageSquareIcon aria-hidden /> {t("task.preview.none.ask")}</Button>
      )}
      <Link href={environmentHref} className="inline-flex items-center gap-1 text-[14px] text-teal hover:underline">
        {t("task.preview.none.declare")} <ArrowRightIcon aria-hidden className="size-[14px]" />
      </Link>
    </div>
  </StateBlock>
);

/** A runner that can't show a preview: it fails closed, never an unprotected view (F-142). */
export const TooOldBlock = ({ words, docsHref }: { readonly words: string; readonly docsHref: string | null }) => (
  <StateBlock width={430} testId="preview-too-old">
    <IconBox><ServerOffIcon /></IconBox>
    <Title>{t("task.preview.tooOld.title")}</Title>
    <Line>{words}</Line>
    {docsHref === null ? null : (
      <a href={docsHref} target="_blank" rel="noopener noreferrer" className="mt-[18px] inline-flex items-center gap-1 text-[14px] text-teal hover:underline">
        {t("task.preview.tooOld.docs")} <ArrowRightIcon aria-hidden className="size-[14px]" />
      </a>
    )}
  </StateBlock>
);

/** The view didn't open, or the box refused it, with why and what to do. */
export const FailedBlock = ({ title, words, action }: { readonly title: string; readonly words: string; readonly action: { readonly label: string; readonly run: () => void; readonly pending: boolean } | null }) => (
  <StateBlock width={430} testId="preview-failed">
    <IconBox><TriangleAlertIcon /></IconBox>
    <Title>{title}</Title>
    <Line>{words}</Line>
    {action === null ? null : (
      <div className="mt-4">
        <Button onClick={action.run} disabled={action.pending} data-action="preview-again"><RotateCwIcon aria-hidden /> {action.label}</Button>
      </div>
    )}
  </StateBlock>
);

/** The app stopped answering: a banner over the dimmed last picture (task-preview.md). */
export const CrashedBanner = ({ label, port, at, onRestart, restarting }: { readonly label: string; readonly port: number; readonly at: number; readonly onRestart: (() => void) | null; readonly restarting: boolean }) => (
  <div role="status" className="absolute inset-x-2.5 top-2.5 z-[2] flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-t-lg border-b border-line-2 bg-raise px-3.5 py-2 text-[13.5px] text-text" data-testid="preview-crashed">
    <span className="min-w-0 flex-1">{t("task.preview.crashed", { label, port, time: formatClock(at) })}</span>
    {onRestart === null ? null : (
      <Button size="sm" onClick={onRestart} disabled={restarting} data-action="restart-app"><RotateCwIcon aria-hidden /> {t("task.preview.starting.restart", { label })}</Button>
    )}
  </div>
);

/** The stream dropped: a pill at the frame's top centre, then `Lost the stream.` with `Retry`. */
export const DroppedPill = ({ lost, onRetry }: { readonly lost: boolean; readonly onRetry: () => void }) => (
  <div role="status" className="absolute left-1/2 top-3 z-[2] flex h-6 -translate-x-1/2 items-center gap-2 rounded-full border border-line-2 bg-raise px-2.5 text-[12.5px] text-text shadow-(--shadow-pop)" data-testid="preview-dropped" data-lost={lost ? "true" : "false"}>
    {lost ? (
      <>
        {t("task.preview.lost")}
        <Button variant="link" className="text-[12.5px]" onClick={onRetry} data-action="preview-retry">{t("task.preview.retry")}</Button>
      </>
    ) : (
      <>
        <Spinner />
        {t("task.preview.reconnecting")}
      </>
    )}
  </div>
);

/**
 * The native preview signing in (ticket 26; preview-native.md, "Signing in"): the starting block,
 * shortened, over the frame while its one-time code redirects. It lasts one redirect.
 */
export const SigningInBlock = ({ label, port, host }: { readonly label: string; readonly port: number; readonly host: string | null }) => (
  <StateBlock width={400} testId="preview-signing-in">
    <IconBox><Spinner className="size-4" /></IconBox>
    <Title>{t("task.preview.native.signingInTitle", { label, port })}</Title>
    {host === null ? null : <Line>{t("task.preview.native.signingInBody", { host })}</Line>}
  </StateBlock>
);

/** The native preview's handshake failed (ticket 26): why, `Try again`, and the box's browser. */
export const NativeFailedBlock = ({ words, onRetry, onUseBox }: { readonly words: string; readonly onRetry: () => void; readonly onUseBox: (() => void) | null }) => (
  <StateBlock width={430} testId="preview-native-failed">
    <div aria-hidden className="mb-3.5 grid size-9 place-items-center rounded-[9px] border border-line-2 text-red [&_svg]:size-[17px] [&_svg]:stroke-[1.75]"><CircleAlertIcon /></div>
    <Title>{t("task.preview.native.failedTitle")}</Title>
    <Line>{words}</Line>
    <div className="mt-4 flex flex-wrap gap-2">
      <Button variant="outline" onClick={onRetry} data-action="preview-native-again"><RotateCwIcon aria-hidden /> {t("task.preview.native.tryAgain")}</Button>
      {onUseBox === null ? null : (
        <Button variant="ghost" className="text-teal hover:text-teal" onClick={onUseBox} data-action="preview-use-box"><MonitorIcon aria-hidden /> {t("task.preview.native.useBox")}</Button>
      )}
    </div>
  </StateBlock>
);
