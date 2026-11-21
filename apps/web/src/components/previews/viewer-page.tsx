"use client";

import { useMutation } from "@tanstack/react-query";
import { ClockIcon, EyeIcon, MousePointerClickIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { PreviewFrame } from "./preview-frame";
import type { FrameSize, FrameStatus } from "./preview-frame";
import { ViewerEnded, ViewerNotRunning, shortDate } from "./viewer-ended";
import { expiryWords, learnedEnd, viewerOf } from "./viewer-state";
import type { PreviewViewerData, Shown, Viewer } from "./viewer-state";

// The page a signed-out person opens from a preview link (milestone 8, F-142; preview-viewer.md;
// `preview-viewer`, `preview-viewer-states`): the ostra lockup, the preview's label, the
// organization's name, whether they watch or may use it, the expiry, and the shared page's
// pictures. Nothing else of the task: its route reaches only the link's own procedures
// (`previews.link.open`, `.heartbeat`, `.close`) and the view's stream and input routes, with the
// link's token. A link that ends while the page is open loses the stream at once and says why.
//
// Ticket 26 (F-142, F-144): a link that allows input, on an install whose preview domain works,
// frames the app on its preview host instead (`state: "native"`), as the pane does. Core keeps that
// view itself, so the page asks only the link's state every 30 s (`previews.link.state`), and a new
// one-time code on `Try again` (`previews.link.enter`).

/** The heartbeat (Q299): it keeps the box warm while someone watches, and learns of a link's end. */
const HEARTBEAT_MS = 30_000;
/** How often a page with no app running asks again whether it runs. */
const NOT_RUNNING_POLL_MS = 15_000;

/** A 26px chip of the top bar: a button that only shows its tooltip, so the keyboard reaches it. */
const Chip = ({ icon, children, tip, strong = false, testId }: { readonly icon: ReactNode; readonly children: ReactNode; readonly tip: string; readonly strong?: boolean; readonly testId: string }) => (
  <Tooltip content={tip} delay={500} side="bottom">
    <button
      type="button"
      data-testid={testId}
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-control-line px-[9px] text-[13px] font-medium max-sm:h-11 [&_svg]:size-[14px] [&_svg]:stroke-[1.75] [&_svg]:text-faint",
        strong ? "text-text-2" : "text-muted",
      )}
    >
      {icon}
      {children}
    </button>
  </Tooltip>
);

const Label = ({ shown }: { readonly shown: Shown }) => (
  <span className="font-mono text-[14.5px] font-medium text-text">
    {shown.label}
    {shown.port === null ? null : <span className="font-normal text-faint"> :{shown.port}</span>}
  </span>
);

export const ViewerPage = ({ token, initial }: { readonly token: string; readonly initial: PreviewViewerData }) => {
  const trpc = useTRPC();
  const [viewer, setViewer] = useState<Viewer>(() => viewerOf(initial));
  const [frame, setFrame] = useState<FrameStatus>({ kind: "connecting" });
  const [size, setSize] = useState<FrameSize | null>(null);
  const [scale, setScale] = useState(100);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const open = useMutation(trpc.previews.link.open.mutationOptions());
  const heartbeat = useMutation(trpc.previews.link.heartbeat.mutationOptions());
  const close = useMutation(trpc.previews.link.close.mutationOptions());
  const linkState = useMutation(trpc.previews.link.state.mutationOptions());
  const enterAgain = useMutation(trpc.previews.link.enter.mutationOptions());
  const { mutateAsync: askState } = linkState;
  const { mutateAsync: askCode } = enterAgain;
  /** The native frame's sign-in: loaded once its redirect finished, or failed after 10 s. */
  const [nativeLoad, setNativeLoad] = useState<"signing-in" | "loaded" | "failed">("signing-in");
  const { mutateAsync: openAgain } = open;
  const { mutateAsync: beat } = heartbeat;
  const { mutate: closeView } = close;
  const current = useRef(viewer);
  current.current = viewer;

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 30_000);
    return () => { clearInterval(timer); };
  }, []);

  /** Opens a view again: the app may have started, or core closed the last one. */
  const reopen = useCallback(async () => {
    const before = current.current.shown;
    try {
      const next = await openAgain({ token, viewport: null });
      setFrame({ kind: "connecting" });
      setViewer(viewerOf(next, before));
    } catch {
      // The next poll or heartbeat tries again.
    }
  }, [openAgain, token]);

  /** What the link's view is now: an ended link shows its block; a closed view opens again. */
  const learn = useCallback(async () => {
    const state = current.current;
    if (state.kind === "native") {
      try {
        const answer = await askState({ token });
        if (answer.state !== "active") setViewer({ kind: "ended", end: learnedEnd(answer.state, state.shown, Date.now()), shown: state.shown });
      } catch {
        // The next tick asks again.
      }
      return;
    }
    if (state.kind !== "live") return;
    try {
      const answer = await beat({ token, viewId: state.viewId });
      switch (answer.state) {
        case "expired":
        case "revoked":
        case "not-allowed":
        case "unknown":
          setViewer({ kind: "ended", end: learnedEnd(answer.state, state.shown, Date.now()), shown: state.shown });
          return;
        case "closed":
          await reopen();
          return;
        case "opening":
        case "open":
          return;
        default:
          answer.state satisfies never;
      }
    } catch {
      // The heartbeat comes again.
    }
  }, [beat, reopen, token, askState]);

  // The heartbeat while the page is visible.
  const liveViewId = viewer.kind === "live" ? viewer.viewId : null;
  useEffect(() => {
    if (liveViewId === null) return;
    const tick = () => { if (document.visibilityState === "visible") void learn(); };
    const timer = setInterval(tick, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", tick);
    const leave = () => { closeView({ token, viewId: liveViewId }); };
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("pagehide", leave);
    };
  }, [liveViewId, learn, closeView, token]);

  // The native view's link, asked about every 30 s while the page is visible.
  const nativeShown = viewer.kind === "native";
  useEffect(() => {
    if (!nativeShown) return;
    const tick = () => { if (document.visibilityState === "visible") void learn(); };
    const timer = setInterval(tick, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [nativeShown, learn]);

  // The sign-in is one redirect: a frame that hasn't loaded in 10 s failed.
  const nativeAttempt = viewer.kind === "native" ? viewer.attempt : -1;
  useEffect(() => {
    if (nativeAttempt < 0) return;
    setNativeLoad("signing-in");
    const timer = setTimeout(() => { setNativeLoad((now) => (now === "loaded" ? now : "failed")); }, 10_000);
    return () => { clearTimeout(timer); };
  }, [nativeAttempt]);

  /** `Try again`: a new one-time code for the link, or the link's end. */
  const nativeAgain = useCallback(async () => {
    const state = current.current;
    if (state.kind !== "native") return;
    try {
      const answer = await askCode({ token });
      if (answer.ok) {
        setViewer({ kind: "native", url: answer.url, host: answer.host, attempt: state.attempt + 1, shown: state.shown });
        return;
      }
      switch (answer.reason) {
        case "link-expired":
          setViewer({ kind: "ended", end: learnedEnd("expired", state.shown, Date.now()), shown: state.shown });
          return;
        case "link-revoked":
          setViewer({ kind: "ended", end: learnedEnd("revoked", state.shown, Date.now()), shown: state.shown });
          return;
        case "not-allowed":
        case "unknown":
          setViewer({ kind: "ended", end: learnedEnd(answer.reason, state.shown, Date.now()), shown: state.shown });
          return;
        case "no-box":
        case "port-not-allowed":
          setViewer({ kind: "not-running", shown: state.shown });
          return;
        case "no-preview-domain":
        case "watch-only":
        case "runner-cannot-tunnel":
        case "runner-needs-upgrade":
        case "runner-cannot-preview":
        case "level-unknown":
          // The browser view instead, as the server's open would give it now.
          await reopen();
          return;
        default:
          answer.reason satisfies never;
      }
    } catch {
      setNativeLoad("failed");
    }
  }, [askCode, reopen, token]);

  // An app that isn't running: asked again until it is.
  const notRunning = viewer.kind === "not-running";
  useEffect(() => {
    if (!notRunning) return;
    const timer = setInterval(() => { void reopen(); }, NOT_RUNNING_POLL_MS);
    return () => { clearInterval(timer); };
  }, [notRunning, reopen]);

  // The expiry passing while the page is open: the link ends now, not at a reload.
  const expiresAt = viewer.kind === "ended" ? null : viewer.shown.expiresAt;
  useEffect(() => {
    if (expiresAt !== null && now >= expiresAt) void learn();
  }, [expiresAt, now, learn]);

  const onStatus = useCallback((status: FrameStatus) => {
    setFrame(status);
    // The view ended under the page: ask why at once (a revoke, a narrowed level, the app stopping).
    if (status.kind === "closed" || status.kind === "refused") void learn();
  }, [learn]);

  const shown = viewer.shown;
  const showChips = viewer.kind !== "ended" && shown !== null;
  const footLive = viewer.kind === "native" ? nativeLoad === "loaded" : frame.kind === "live";
  const expiryChip = showChips && shown.expiresAt !== null ? (
    <Chip icon={<ClockIcon aria-hidden />} tip={t("previewViewer.expiresAt", { date: shortDate(shown.expiresAt), time: formatClock(shown.expiresAt) })} testId="viewer-expiry">
      {expiryWords(shown.expiresAt, now)}
    </Chip>
  ) : null;
  const modeChip = showChips ? (
    shown.input ? (
      <Chip icon={<MousePointerClickIcon aria-hidden />} tip={t("previewViewer.inputTip")} strong testId="viewer-mode">{t("previewViewer.canUse")}</Chip>
    ) : (
      <Chip icon={<EyeIcon aria-hidden />} tip={t("previewViewer.watchTip")} testId="viewer-mode">{t("previewViewer.watchOnly")}</Chip>
    )
  ) : null;

  const stage = (): ReactNode => {
    switch (viewer.kind) {
      case "ended":
        return <ViewerEnded end={viewer.end} now={now} />;
      case "not-running":
        return (
          <div className="relative min-h-0 flex-1 bg-surface">
            <ViewerNotRunning organizationName={viewer.shown.organizationName} />
          </div>
        );
      case "live": {
        const name = t("previewViewer.frameName", { label: viewer.shown.label, port: viewer.shown.port ?? "" });
        const opening = frame.kind === "connecting";
        return (
          <div className="relative min-h-0 flex-1 bg-surface px-3 py-3 sm:px-5 sm:py-[18px]">
            <PreviewFrame
              mode="stream"
              viewId={viewer.viewId}
              linkToken={token}
              input={viewer.shown.input}
              name={name}
              attempt={attempt}
              hug
              onStatus={onStatus}
              onSize={setSize}
              onScale={setScale}
              onLeave={() => { (document.querySelector<HTMLElement>("[data-testid='viewer-mode']") ?? document.body).focus(); }}
              {...(viewer.shown.input ? {} : { wrap: (canvas: ReactNode) => <Tooltip content={t("previewViewer.watchTip")} delay={500}>{canvas}</Tooltip> })}
              overlay={
                frame.kind === "reconnecting" || frame.kind === "lost" ? (
                  <div role="status" className="absolute left-1/2 top-3 z-[2] flex h-6 -translate-x-1/2 items-center gap-2 rounded-full border border-line-2 bg-raise px-2.5 text-[12.5px] text-text shadow-(--shadow-pop)" data-testid="viewer-dropped">
                    {frame.kind === "lost" ? (
                      <>
                        {t("task.preview.lost")}
                        <button type="button" className="text-teal hover:underline" onClick={() => { setAttempt((n) => n + 1); }}>{t("task.preview.retry")}</button>
                      </>
                    ) : t("task.preview.reconnecting")}
                  </div>
                ) : null
              }
            />
            {opening ? (
              <div className="absolute inset-0 grid place-items-center p-5" data-testid="viewer-starting">
                <div role="status" className="w-full max-w-[380px]">
                  <div aria-hidden className="mb-3 grid size-9 place-items-center rounded-[9px] border border-line-2">
                    <span className="inline-block size-4 animate-spin rounded-full border-2 border-line-2 border-t-muted motion-reduce:animate-none" />
                  </div>
                  <h1 className="mb-1 text-[16px] font-semibold text-text">{t("previewViewer.opening", { label: viewer.shown.label, port: viewer.shown.port ?? "" })}</h1>
                  <p className="text-[14px] text-muted">{t("previewViewer.openingBody")}</p>
                </div>
              </div>
            ) : null}
          </div>
        );
      }
      case "native": {
        const name = t("task.preview.native.frameName", { label: viewer.shown.label, port: viewer.shown.port ?? "", path: "/" });
        return (
          <div className="relative min-h-0 flex-1 bg-surface px-3 py-3 sm:px-5 sm:py-[18px]">
            <div className="size-full rounded-lg border border-line-2">
              <PreviewFrame key={viewer.attempt} mode="native" host={viewer.host} enterUrl={viewer.url} name={name} onLoad={() => { setNativeLoad("loaded"); }} />
            </div>
            {nativeLoad === "loaded" ? null : (
              <div className="absolute inset-0 grid place-items-center bg-surface p-5" data-testid={nativeLoad === "failed" ? "viewer-native-failed" : "viewer-starting"}>
                <div role="status" className="w-full max-w-[380px]">
                  {nativeLoad === "failed" ? (
                    <>
                      <p className="mb-3 text-[14px] text-muted">{t("previewViewer.nativeFailed")}</p>
                      <Button variant="outline" onClick={() => { void nativeAgain(); }} data-action="viewer-native-again"><RotateCwIcon aria-hidden /> {t("task.preview.native.tryAgain")}</Button>
                    </>
                  ) : (
                    <>
                      <div aria-hidden className="mb-3 grid size-9 place-items-center rounded-[9px] border border-line-2">
                        <span className="inline-block size-4 animate-spin rounded-full border-2 border-line-2 border-t-muted motion-reduce:animate-none" />
                      </div>
                      <h1 className="mb-1 text-[16px] font-semibold text-text">{t("previewViewer.opening", { label: viewer.shown.label, port: viewer.shown.port ?? "" })}</h1>
                      <p className="text-[14px] text-muted">{t("previewViewer.signingIn", { host: viewer.host })}</p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      }
      default:
        return viewer satisfies never;
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-bg" data-testid="preview-viewer" data-state={viewer.kind === "ended" ? viewer.end.kind : viewer.kind}>
      <header className="flex h-[54px] shrink-0 items-center gap-2.5 whitespace-nowrap border-b border-line pl-4 pr-3 sm:h-14 sm:gap-3.5 sm:pl-[22px] sm:pr-5">
        <span role="img" aria-label="ostra" className="logo-lockup block h-5 w-[95px] shrink-0" />
        {shown === null ? null : (
          <>
            <span aria-hidden className="hidden h-5 w-px shrink-0 bg-line-2 sm:block" />
            <span className="hidden min-w-0 items-baseline gap-2 sm:flex">
              <Label shown={shown} />
              <span className="truncate text-[14px] text-muted">{t("previewViewer.from", { organization: shown.organizationName })}</span>
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span className="max-sm:hidden">{modeChip}</span>
          {expiryChip}
        </span>
      </header>
      {shown === null || viewer.kind === "ended" ? null : (
        <div className="flex h-[46px] shrink-0 items-center gap-2 whitespace-nowrap border-b border-line px-4 sm:hidden">
          <Label shown={shown} />
          <span className="min-w-0 truncate text-[14px] text-muted">{t("previewViewer.fromShort", { organization: shown.organizationName })}</span>
          <span className="ml-auto">{modeChip}</span>
        </div>
      )}
      {stage()}
      {viewer.kind === "live" || viewer.kind === "native" ? (
        <footer className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 whitespace-nowrap border-t border-line px-4 py-2 pb-[max(8px,env(safe-area-inset-bottom))] text-[13px] text-muted sm:h-10 sm:px-[22px] sm:py-0" data-mode={viewer.kind === "native" ? "native" : "stream"}>
          <span aria-hidden className={cn("inline-block size-[7px] rounded-full", footLive ? "bg-green" : "bg-faint")} />
          <span className="font-medium text-text">{footLive ? t("task.preview.foot.live") : t("task.preview.foot.starting")}</span>
          {viewer.kind === "native" ? (
            <>
              <span className="text-faint">· {t("previewViewer.inYourBrowser")} ·</span>
              <span className="min-w-0 truncate font-mono text-[12.5px] text-muted" data-testid="viewer-host">{viewer.host}</span>
            </>
          ) : (
            <span className="text-faint">· {t("previewViewer.streamed")}</span>
          )}
          {size === null || viewer.kind === "native" ? null : (
            <span className="ml-auto font-mono text-[12.5px] text-faint max-sm:hidden" data-testid="viewer-size">
              {size.width} × {size.height} · {scale}%
            </span>
          )}
          {viewer.shown.input ? <span className="basis-full whitespace-normal text-[12.5px] text-faint sm:hidden">{t("previewViewer.inputNote")}</span> : null}
        </footer>
      ) : null}
    </div>
  );
};
