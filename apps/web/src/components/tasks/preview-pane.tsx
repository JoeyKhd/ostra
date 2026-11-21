"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindowIcon, CameraIcon, ChevronDownIcon, EllipsisIcon, ExternalLinkIcon, EyeIcon, Maximize2Icon, Minimize2Icon, MonitorIcon, RotateCwIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { appPathSchema, runnerLimits } from "@ostra/protocol";
import type { PreviewPageControl, PreviewViewId, PreviewViewport, StoredEvent, TaskId } from "@ostra/protocol";

import { PreviewFrame } from "@/components/previews/preview-frame";
import { PreviewFramingNotice } from "@/components/previews/preview-framing-notice";
import type { FrameSize, FrameStatus } from "@/components/previews/preview-frame";
import { postPreviewInput } from "@/components/previews/preview-input";
import { boxRefusalWords, previewabilityWords, refusalActionable, routeWords } from "@/components/previews/preview-words";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import {
  framingNoticeStorageKey,
  hostParts,
  isPaneMode,
  isWidthPreset,
  nativeOffered,
  nativeOfferOf,
  nativePaneStateOf,
  paneModeOf,
  paneModeStorageKey,
  paneStateOf,
  presetName,
  reopens,
  screenshotPreset,
  selectedPreview,
  SIGN_IN_FOR_MS,
  viewportFor,
  widthPresets,
} from "./preview-pane-state";
import type { NativeFailure, NativeView, OpenRefusal, PaneMode, PaneState, PaneView, PreviewItem, WidthPreset } from "./preview-pane-state";
import { StateDot, PreviewServicesMenu } from "./preview-services-menu";
import { PreviewShareMenu } from "./preview-share-menu";
import { CrashedBanner, DroppedPill, FailedBlock, NativeFailedBlock, NoneBlock, PreviewSpinner, SigningInBlock, StartingBlock, StoppedBlock, TooOldBlock } from "./preview-state";

// The task page's preview pane (milestone 8, F-141, F-142; task-preview.md; `task-preview-pane`):
// a toolbar (the service switcher, reload, the path, the width preset, Share, a screenshot, a new
// tab, Expand), the viewport, where the frame draws the box's browser, and a footer with the view's
// line, the watchers and the size. The pane opens a view of the chosen preview while it's shown,
// keeps it warm with a heartbeat every 30 s while the tab is visible, and closes it when it goes.
// Expand only changes the page's grid around it: this element never moves, so the stream and the
// app's own state survive it.
//
// Ticket 26 (F-144; preview-native.md): with a preview domain whose check passed, the pane shows the
// app in the member's own browser by default (`&mode=native`, or `stream` for the box's browser,
// kept per member and preview): `previews.enter` mints a one-time code and the frame loads the
// preview host's `/.ostra/enter`, with the framing notice when core replaced the app's framing
// header. "Open in a new tab" makes its own handshake. Core keeps a native view warm itself, so no
// heartbeat goes in this mode, and a screenshot still comes from the box's browser.

/** The heartbeat's interval (Q299): a view without one for 90 s closes, and the box can sleep again. */
export const HEARTBEAT_MS = 30_000;

/** How long the viewport waits after the pane stops resizing before the shared page follows. */
const RESIZE_SETTLE_MS = 400;

type Member = { readonly memberId: string; readonly name: string };

export type PreviewPaneTask = {
  readonly id: TaskId;
  readonly key: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly organizationName: string;
  readonly state: string;
  readonly runnerName: string | null;
  /** A project admin: the switcher links to the environment. */
  readonly projectAdmin: boolean;
};

export type PreviewPaneProps = {
  readonly task: PreviewPaneTask;
  readonly events: readonly StoredEvent[];
  /** The preview and path in the address (`?preview=&path=`), so a link reopens them. */
  readonly previewKey: string | null;
  readonly path: string | null;
  readonly onAddress: (next: { readonly preview: string; readonly path: string }) => void;
  readonly expanded: boolean;
  readonly onExpand: (expanded: boolean) => void;
  /** "Ask the agent to start the app": puts the words into the composer. `null` without the right to send. */
  readonly onAskAgent: (() => void) | null;
  /** The steer bar, drawn over the expanded pane. */
  readonly steer: ReactNode;
  readonly members: readonly Member[];
  readonly now: number;
  /** The phone's toolbar: 44px controls, the width preset and the screenshot under `ellipsis`. */
  readonly phone: boolean;
  /** Ticket 26: the view in the address (`&mode=native|stream`), and the member's choice of it. */
  readonly mode: string | null;
  readonly onMode: (mode: PaneMode) => void;
  /** Whose choice of view this browser keeps; `null` before the member is known. */
  readonly memberId: string | null;
  /** An instance admin: while the preview domain's check isn't passing, the footer links its settings. */
  readonly instanceAdmin: boolean;
};

/** Reads one of this browser's own keys: `null` where storage isn't allowed. */
const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStored = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A browser that keeps nothing: the choice lasts this page.
  }
};

/** The app's last `app.process` state for a process, in the box the pane shows; `null` before the box says. */
const processState = (events: readonly StoredEvent[], item: PreviewItem | null): "starting" | "ready" | "failed" | null => {
  if (item === null || !("process" in item.target)) return null;
  const name = item.target.process;
  const last = events.findLast(({ event }) => event.kind === "app.process" && event.name === name)?.event;
  if (last?.kind !== "app.process") return null;
  const state = last.state;
  switch (state) {
    case "starting":
    case "ready":
      return state;
    case "failed":
    case "exited":
    case "stopped":
      return "failed";
    default:
      return state satisfies never;
  }
};

const openRefusalKey = {
  "no-box": "task.preview.open.no-box",
  "port-not-allowed": "task.preview.open.port-not-allowed",
  "runner-needs-upgrade": "task.preview.open.runner-needs-upgrade",
  "runner-cannot-preview": "task.preview.open.runner-cannot-preview",
  "level-unknown": "task.preview.open.level-unknown",
} as const satisfies Record<OpenRefusal, string>;

const startRefusalKey = {
  "no-app-processes": "task.preview.startRefused.no-app-processes",
  "no-runner": "task.preview.startRefused.no-runner",
  "runner-needs-upgrade": "task.preview.startRefused.runner-needs-upgrade",
  "runner-cannot-preview": "task.preview.startRefused.runner-cannot-preview",
  forbidden: "task.preview.startRefused.forbidden",
  "core-unreachable": "task.preview.startRefused.core-unreachable",
} as const;

const nativeFailureKey = {
  "no-preview-domain": "task.preview.native.refused.no-preview-domain",
  "no-box": "task.preview.native.refused.no-box",
  "port-not-allowed": "task.preview.native.refused.port-not-allowed",
  "watch-only": "task.preview.native.refused.watch-only",
  "runner-cannot-tunnel": "task.preview.native.refused.runner-cannot-tunnel",
  "runner-needs-upgrade": "task.preview.native.refused.runner-needs-upgrade",
  "runner-cannot-preview": "task.preview.native.refused.runner-cannot-preview",
  "level-unknown": "task.preview.native.refused.level-unknown",
  timeout: "task.preview.native.refused.timeout",
  error: "task.preview.native.refused.error",
} as const satisfies Record<NativeFailure, string>;

/** The preview's host, its middle cut when the footer is narrow: the preview's part shrinks, the domain stays. */
const HostText = ({ host }: { readonly host: string }) => {
  const { head, tail } = hostParts(host);
  return (
    <span className="flex min-w-0 font-mono text-[12.5px] text-muted" title={host} data-testid="preview-host">
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0">{tail}</span>
    </span>
  );
};

const screenshotRefusalKey = {
  "no-box": "task.preview.screenshot.no-box",
  "port-not-allowed": "task.preview.screenshot.port-not-allowed",
  "runner-needs-upgrade": "task.preview.screenshot.runner-needs-upgrade",
  "runner-cannot-preview": "task.preview.screenshot.runner-cannot-preview",
} as const;

/** A 28px icon button of the toolbar (44px on a phone), its words as its name and its title. */
const ToolButton = ({ label, onClick, disabled = false, children, action, className }: { readonly label: string; readonly onClick: () => void; readonly disabled?: boolean; readonly children: ReactNode; readonly action: string; readonly className?: string }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    disabled={disabled}
    data-action={action}
    className={cn(
      "grid size-7 shrink-0 place-items-center rounded-sm text-muted hover:bg-hover hover:text-text disabled:pointer-events-none disabled:opacity-45 max-lg:size-11 [&_svg]:size-[15px] [&_svg]:stroke-[1.75]",
      className,
    )}
  >
    {children}
  </button>
);

/** ← and → move along the toolbar's buttons (a field keeps its own arrows). */
const moveAlong = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (event.target instanceof HTMLInputElement) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
  const at = items.findIndex((item) => item === document.activeElement);
  if (at < 0) return;
  const next = items[(at + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
};

export const PreviewPane = ({ task, events, previewKey, path: addressPath, onAddress, expanded, onExpand, onAskAgent, steer, members, now, phone, mode: addressMode, onMode, memberId, instanceAdmin }: PreviewPaneProps) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listKey = trpc.previews.list.queryKey({ taskId: task.id });
  const list = useQuery({ ...trpc.previews.list.queryOptions({ taskId: task.id }), refetchInterval: 10_000 });
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: listKey }), [queryClient, listKey]);
  const open = useMutation(trpc.previews.open.mutationOptions());
  const close = useMutation(trpc.previews.close.mutationOptions());
  const heartbeat = useMutation(trpc.previews.heartbeat.mutationOptions());
  const startApp = useMutation(trpc.previews.startApp.mutationOptions({ onSettled: refresh }));
  const screenshot = useMutation(trpc.previews.takeScreenshot.mutationOptions());
  const keep = useMutation(trpc.tasks.keepPreview.mutationOptions({ onSettled: refresh }));
  const enter = useMutation(trpc.previews.enter.mutationOptions());

  const data = list.data;
  const previews = data?.previews ?? [];
  const selected = selectedPreview(previews, previewKey);
  const selectedKey = selected?.key ?? null;
  const [preset, setPreset] = useState<WidthPreset>("fit");
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{ readonly id: PreviewViewId; readonly input: boolean } | null>(null);
  const [paneView, setPaneView] = useState<PaneView>({ kind: "idle" });
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null);
  const [crashedAt, setCrashedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waitSince, setWaitSince] = useState<number>(() => Date.now());
  const viewport = useRef<HTMLDivElement | null>(null);
  const toolbar = useRef<HTMLDivElement | null>(null);
  const room = useRef<{ width: number; height: number }>({ width: 800, height: 600 });
  const [roomNow, setRoomNow] = useState(room.current);
  const sentViewport = useRef<string | null>(null);

  const path = addressPath !== null && appPathSchema.safeParse(addressPath).success ? addressPath : (selected?.path ?? "/");
  const [pathField, setPathField] = useState(path);
  useEffect(() => { setPathField(path); }, [path]);

  // Ticket 26: which view the pane shows. The member's own choice is read once the page is in the browser.
  const offered = data !== undefined && nativeOffered(data);
  const modeKey = memberId === null || selectedKey === null ? null : paneModeStorageKey(memberId, task.id, selectedKey);
  const [storedMode, setStoredMode] = useState<PaneMode | null>(null);
  // Until the choice is read, no code is minted: a member who chose the box's browser never signs in.
  const [modeRead, setModeRead] = useState(false);
  useEffect(() => {
    const stored = modeKey === null ? null : readStored(modeKey);
    setStoredMode(isPaneMode(stored) ? stored : null);
    setModeRead(modeKey !== null);
  }, [modeKey]);
  const mode = paneModeOf(offered, addressMode, storedMode);
  const native = mode === "native";
  const chooseMode = (next: PaneMode) => {
    if (modeKey !== null) writeStored(modeKey, next);
    setStoredMode(next);
    onMode(next);
  };

  const running = !native && data?.box === "running" && !("refused" in data.can) && data.can.stream;
  const nativeRunning = native && modeRead && data?.box === "running";

  // The room the viewport has, for `Fit` (less its 10px padding).
  useEffect(() => {
    const node = viewport.current;
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const next = { width: Math.max(1, Math.floor(entry.contentRect.width)), height: Math.max(1, Math.floor(entry.contentRect.height)) };
      room.current = next;
      setRoomNow(next);
    });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, []);

  // A view of the chosen preview while the box runs: opened, and closed when it goes.
  const { mutateAsync: openView } = open;
  const { mutate: closeView } = close;
  useEffect(() => {
    if (!running || selectedKey === null) {
      setView(null);
      setPaneView({ kind: "idle" });
      return;
    }
    let cancelled = false;
    let opened: PreviewViewId | null = null;
    setPaneView({ kind: "opening" });
    setWaitSince(Date.now());
    setCrashedAt(null);
    sentViewport.current = null;
    const size = viewportFor(preset, room.current);
    void openView({ taskId: task.id, key: selected?.key ?? selectedKey, viewport: size })
      .then((answer) => {
        if (!answer.ok) {
          if (!cancelled) setPaneView({ kind: "refused", reason: answer.reason });
          return;
        }
        opened = answer.viewId;
        if (cancelled) {
          closeView({ viewId: answer.viewId });
          return;
        }
        setView({ id: answer.viewId, input: answer.input });
        setPaneView({ kind: "open", frame: { kind: "connecting" } });
      })
      .catch(() => {
        if (!cancelled) setPaneView({ kind: "open", frame: { kind: "refused", code: null } });
      });
    return () => {
      cancelled = true;
      if (opened !== null) closeView({ viewId: opened });
    };
    // `preset` and `selected` are read when the view opens; changing them later moves the page instead.
  }, [running, selectedKey, task.id, attempt, openView, closeView]);

  // The heartbeat, every 30 s while the pane is open and the tab visible: it keeps the box warm.
  const { mutateAsync: beat } = heartbeat;
  const viewId = view?.id ?? null;
  useEffect(() => {
    if (viewId === null) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void beat({ viewId }).then((answer) => {
        if (answer.state === "closed") setAttempt((n) => n + 1);
      }).catch(() => undefined);
    };
    const timer = setInterval(tick, HEARTBEAT_MS);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [viewId, beat]);

  // Ticket 26: the native view. A one-time code for the preview host while the box runs; the frame
  // loads it once, and a new code comes only on `Try again` (`nativeAttempt`).
  const [nativeView, setNativeView] = useState<NativeView>({ kind: "idle" });
  const [nativeAttempt, setNativeAttempt] = useState(0);
  const [nav, setNav] = useState<{ readonly url: string; readonly seq: number } | null>(null);
  const { mutateAsync: enterNative } = enter;
  const startPath = useRef(path);
  startPath.current = path;
  useEffect(() => {
    if (!nativeRunning || selectedKey === null) {
      setNativeView({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setNativeView({ kind: "entering" });
    setNav(null);
    void enterNative({ taskId: task.id, key: selectedKey, path: startPath.current })
      .then((answer) => {
        if (cancelled) return;
        setNativeView(answer.ok ? { kind: "framed", url: answer.url, host: answer.host, loaded: false } : { kind: "failed", reason: answer.reason });
      })
      .catch(() => {
        if (!cancelled) setNativeView({ kind: "failed", reason: "error" });
      });
    return () => { cancelled = true; };
  }, [nativeRunning, selectedKey, task.id, nativeAttempt, enterNative]);

  // The sign-in is one redirect: a frame that hasn't loaded in 10 s failed (preview-native.md).
  const signingIn = nativeView.kind === "framed" && !nativeView.loaded;
  useEffect(() => {
    if (!signingIn) return;
    const timer = setTimeout(() => { setNativeView({ kind: "failed", reason: "timeout" }); }, SIGN_IN_FOR_MS);
    return () => { clearTimeout(timer); };
  }, [signingIn]);
  const onNativeLoad = useCallback(() => {
    setNativeView((current) => (current.kind === "framed" && !current.loaded ? { ...current, loaded: true } : current));
  }, []);
  const nativeOrigin = nativeView.kind === "framed" ? new URL(nativeView.url).origin : null;
  const nativeHost = nativeView.kind === "framed" ? nativeView.host : null;

  // The framing notice: shown until dismissed, per preview, in this browser.
  const noticeKey = selectedKey === null ? null : framingNoticeStorageKey(task.id, selectedKey);
  const [noticeDismissed, setNoticeDismissed] = useState(true);
  useEffect(() => { setNoticeDismissed(noticeKey === null || readStored(noticeKey) !== null); }, [noticeKey]);
  const dismissNotice = () => {
    if (noticeKey !== null) writeStored(noticeKey, "dismissed");
    setNoticeDismissed(true);
  };

  // The frame's news: a view core closed for a reason not the app's opens again.
  const onStatus = useCallback((status: FrameStatus) => {
    setPaneView({ kind: "open", frame: status });
    if (status.kind === "closed" && (status.close.reason === "app-stopped" || status.close.reason === "page-crashed")) setCrashedAt(Date.now());
    if (reopens(status)) setTimeout(() => { setAttempt((n) => n + 1); }, 1_000);
    if (status.kind === "live") setCrashedAt(null);
  }, []);

  // One of the page's controls, for a viewer who may give input. In the native view the frame is the
  // member's own page: a path and a reload load it again on the preview's host (its cookie is set).
  const control = useCallback(async (body: PreviewPageControl) => {
    if (native) {
      if (nativeOrigin === null || (body.kind !== "navigate" && body.kind !== "reload")) return;
      const target = body.kind === "navigate" ? body.path : startPath.current;
      setNav((current) => ({ url: `${nativeOrigin}${target}`, seq: (current?.seq ?? 0) + 1 }));
      return;
    }
    if (!view?.input) return;
    const answer = await postPreviewInput(view.id, null, { control: body });
    if (!answer.ok) setNotice(routeWords(answer.code));
  }, [view, native, nativeOrigin]);

  // The width preset, and `Fit` following the pane's size once it settles. The page is shared
  // (Q314): the pane moves it only when its own choice changes, never to undo another viewer's.
  const wanted: PreviewViewport = viewportFor(preset, roomNow);
  const wantedKey = `${String(wanted.width)}x${String(wanted.height)}`;
  const pageKey = frameSize === null ? null : `${String(frameSize.width)}x${String(frameSize.height)}`;
  useEffect(() => {
    if (view === null || !view.input || pageKey === null || sentViewport.current === wantedKey) return;
    if (pageKey === wantedKey) {
      sentViewport.current = wantedKey;
      return;
    }
    const timer = setTimeout(() => {
      sentViewport.current = wantedKey;
      void control({ kind: "viewport", viewport: viewportFor(preset, room.current) });
    }, RESIZE_SETTLE_MS);
    return () => { clearTimeout(timer); };
  }, [wantedKey, pageKey, view, control, preset]);

  // A link's path (`?path=`) opens on the shared page once the view draws.
  const navigated = useRef<PreviewViewId | null>(null);
  const firstFrame = pageKey !== null;
  useEffect(() => {
    if (view === null || !view.input || !firstFrame || addressPath === null || navigated.current === view.id) return;
    navigated.current = view.id;
    const parsed = appPathSchema.safeParse(addressPath);
    if (parsed.success && parsed.data !== "/") void control({ kind: "navigate", path: parsed.data });
  }, [view, firstFrame, addressPath, control]);

  const goTo = (next: string) => {
    const parsed = appPathSchema.safeParse(next.startsWith("/") ? next : `/${next}`);
    if (!parsed.success || selected === null) {
      setNotice(t("task.preview.pathInvalid"));
      return;
    }
    setNotice(null);
    onAddress({ preview: selected.key, path: parsed.data });
    void control({ kind: "navigate", path: parsed.data });
  };

  /**
   * "Open in a new tab": with the native preview on, the preview's own host after its own one-time
   * code (a frame's cookie is partitioned, so a tab signs in again; ADR 0068). The tab is opened at
   * once, so the browser counts it as the click's, and sent on once the code comes. Without it, the
   * task's pane expanded.
   */
  const openNewTab = () => {
    if (selected === null) return;
    if (!offered) {
      const query = new URLSearchParams({ pane: "preview", preview: selected.key, path, view: "full" });
      window.open(`/tasks/${task.id}?${query.toString()}`, "_blank", "noopener,noreferrer");
      return;
    }
    const tab = window.open("about:blank", "_blank");
    if (tab === null) {
      setNotice(t("task.preview.native.newTabBlocked"));
      return;
    }
    tab.opener = null;
    void enterNative({ taskId: task.id, key: selected.key, path })
      .then((answer) => {
        if (answer.ok) {
          tab.location.href = answer.url;
          return;
        }
        tab.close();
        setNotice(t(nativeFailureKey[answer.reason]));
      })
      .catch(() => {
        tab.close();
        setNotice(t(nativeFailureKey.error));
      });
  };

  const startTheApp = () => {
    setNotice(null);
    startApp.mutate({ taskId: task.id });
  };
  const startRefusal = startApp.data !== undefined && !startApp.data.ok ? t(startRefusalKey[startApp.data.reason]) : errorText(startApp.error);

  const takeScreenshot = () => {
    if (selected === null) return;
    setNotice(null);
    screenshot.mutate(
      { taskId: task.id, key: selected.key, path, width: screenshotPreset(preset, frameSize?.width ?? roomNow.width) },
      { onSuccess: (answer) => { setNotice(answer.ok ? t("task.preview.screenshot.asked") : t(screenshotRefusalKey[answer.reason])); } },
    );
  };

  const state: PaneState = data === undefined
    ? { kind: "starting" }
    : native
      ? nativePaneStateOf(data, task.state, nativeView, { failed: (reason) => t(nativeFailureKey[reason]) })
      : paneStateOf(data, task.state, paneView, {
          failed: (failed) => {
            if (failed.kind === "refused") return t(openRefusalKey[failed.reason]);
            if (failed.kind === "open" && failed.frame.kind === "refused") return routeWords(failed.frame.code);
            return routeWords(null);
          },
        });
  // The native view's app stopped answering: its process failed while the frame shows it.
  const nativeCrashed = native && state.kind === "live" && processState(events, selected) === "failed";
  const live = state.kind === "live" || state.kind === "dropped" || state.kind === "crashed";
  const frameShown = view !== null && (state.kind === "live" || state.kind === "dropped" || state.kind === "crashed" || state.kind === "starting");
  const nativeShown = native && nativeView.kind === "framed" && (state.kind === "live" || state.kind === "signing-in");
  const inert = selected === null || state.kind === "none" || state.kind === "too-old";
  const canControl = native ? state.kind === "live" : view?.input === true && live;
  const runner = task.runnerName;
  const environmentHref = `/projects/${task.projectId}/environment`;

  // The seconds the app has been waited on, while it starts.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (state.kind !== "starting") return;
    const timer = setInterval(() => { setTick(Date.now()); }, 1_000);
    return () => { clearInterval(timer); };
  }, [state.kind]);

  const nativeFrameName = selected === null ? "" : t("task.preview.native.frameName", { label: selected.label, port: selected.port, path });
  const frameName = selected === null ? "" : t("task.preview.frameName", { label: selected.label, port: selected.port, path, state: state.kind === "live" ? t("task.preview.foot.live").toLowerCase() : t("task.preview.foot.starting").toLowerCase() });
  const focusToolbar = () => { toolbar.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])")?.focus(); };

  const block = (): ReactNode => {
    switch (state.kind) {
      case "none":
        return <NoneBlock projectName={task.projectName} environmentHref={environmentHref} onAsk={onAskAgent} />;
      case "too-old":
        return <TooOldBlock words={previewabilityWords(state.reason, runner)} docsHref={null} />;
      case "stopped":
        return (
          <StoppedBlock
            asleep={state.asleep}
            projectName={task.projectName}
            screenshot={data?.lastScreenshot === null || data?.lastScreenshot === undefined ? null : `/api/tasks/${task.id}/attachments/${data.lastScreenshot.attachmentId}`}
            onStart={startTheApp}
            starting={startApp.isPending}
            error={startRefusal}
          />
        );
      case "starting":
        // The frame draws behind it as soon as it has a picture; until then, the steps.
        return selected === null ? null : (
          <StartingBlock
            label={selected.label}
            port={selected.port}
            runner={runner}
            boxReady={data?.box === "running"}
            process={data?.box === "running" ? processState(events, selected) : null}
            waitedMs={Math.max(0, tick - waitSince)}
            onRestart={startTheApp}
            restarting={startApp.isPending}
          />
        );
      case "refused": {
        const action = refusalActionable(state.refusal);
        return (
          <FailedBlock
            title={t("task.preview.refusedTitle")}
            words={boxRefusalWords(state.refusal)}
            action={action === null || action === "close-another" ? null : action === "start-again" ? { label: t("task.preview.stopped.start"), run: startTheApp, pending: startApp.isPending } : { label: t("task.preview.again"), run: () => { setAttempt((n) => n + 1); }, pending: false }}
          />
        );
      }
      case "failed":
        return <FailedBlock title={t("task.preview.failedTitle")} words={state.words} action={{ label: t("task.preview.again"), run: () => { setAttempt((n) => n + 1); }, pending: false }} />;
      case "signing-in":
        return selected === null ? null : <SigningInBlock label={selected.label} port={selected.port} host={nativeHost} />;
      case "native-failed":
        return <NativeFailedBlock words={state.words} onRetry={() => { setNativeAttempt((n) => n + 1); }} onUseBox={data !== undefined && !("refused" in data.can) && data.can.stream ? () => { chooseMode("stream"); } : null} />;
      case "live":
      case "dropped":
      case "crashed":
        return null;
      default:
        return state satisfies never;
    }
  };

  const footLine = (): { readonly dot: ReactNode; readonly word: string; readonly line: string } => {
    const grey = <StateDot live={false} />;
    switch (state.kind) {
      case "live":
        return { dot: <StateDot live />, word: t("task.preview.foot.live"), line: data?.carrier === "http" ? t("task.preview.foot.http", { n: runnerLimits.httpCarrierFramesPerSecond }) : t("task.preview.foot.stream") };
      case "dropped":
        return { dot: <PreviewSpinner />, word: state.lost ? t("task.preview.foot.lost") : t("task.preview.foot.reconnecting"), line: t("task.preview.foot.stream") };
      case "crashed":
        return { dot: grey, word: t("task.preview.foot.crashed"), line: t("task.preview.foot.crashedLine") };
      case "starting":
        return { dot: <PreviewSpinner />, word: t("task.preview.foot.starting"), line: t("task.preview.foot.startingLine") };
      case "stopped":
        return { dot: grey, word: state.asleep ? t("task.preview.foot.asleep") : t("task.preview.foot.stopped"), line: data?.lastScreenshot === null ? t("task.preview.foot.stoppedLine") : t("task.preview.foot.asleepLine") };
      case "none":
        return { dot: grey, word: t("task.preview.foot.none"), line: t("task.preview.foot.noneLine") };
      case "too-old":
        return { dot: grey, word: t("task.preview.foot.tooOld"), line: t("task.preview.foot.tooOldLine") };
      case "refused":
      case "failed":
      case "native-failed":
        return { dot: grey, word: t("task.preview.foot.failed"), line: t("task.preview.foot.failedLine") };
      case "signing-in":
        return { dot: <PreviewSpinner />, word: t("task.preview.foot.starting"), line: t("task.preview.native.inYourBrowser") };
      default:
        return state satisfies never;
    }
  };
  const foot = footLine();

  /** The stream footer's right end: the way to the native preview, or why there's none (ticket 26). */
  const nativeOfferView = (): ReactNode => {
    if (data === undefined) return null;
    const offer = nativeOfferOf(data, instanceAdmin);
    switch (offer.kind) {
      case "none":
        return null;
      case "open-here":
        return (
          <Button variant="ghost" size="sm" className="-mr-1.5 text-teal hover:text-teal" onClick={() => { chooseMode("native"); }} data-action="preview-open-here">
            <AppWindowIcon aria-hidden className="size-[14px]" /> {t("task.preview.native.openHere")}
          </Button>
        );
      case "http-only":
        return (
          <span className="max-w-[320px] truncate text-faint" data-testid="preview-native-http">
            {runner === null ? t("task.preview.native.httpOnlyNoRunner") : t("task.preview.native.httpOnly", { runner })}
          </span>
        );
      case "settings":
        return (
          <Link href="/instance/previews" className="inline-flex h-[26px] items-center gap-1.5 rounded-sm px-2 text-teal hover:bg-sel" data-action="preview-settings">
            <AppWindowIcon aria-hidden className="size-[14px]" /> {t("task.preview.native.settings")}
          </Link>
        );
      default:
        return offer satisfies never;
    }
  };
  const watchers = selected?.watchers ?? 0;
  const scale = frameSize === null ? 100 : Math.round(Math.min(1, roomNow.width / frameSize.width, roomNow.height / frameSize.height) * 100);

  const presetMenu = (
    <DropdownMenuRadioGroup value={preset} onValueChange={(value) => { if (isWidthPreset(value)) setPreset(value); }}>
      {widthPresets.map((each) => <DropdownMenuRadioItem key={each} value={each} data-preset={each}>{presetName(each)}</DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup>
  );

  return (
    <section
      aria-label={t("task.preview.pane")}
      data-testid="preview-pane"
      data-state={state.kind}
      data-expanded={expanded ? "true" : "false"}
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-bg"
    >
      <div
        ref={toolbar}
        role="toolbar"
        aria-label={t("task.preview.toolbar")}
        onKeyDown={moveAlong}
        className="flex h-[46px] shrink-0 items-center gap-1.5 border-b border-line px-2.5 max-lg:h-[54px]"
      >
        <PreviewServicesMenu
          taskKey={task.key}
          projectName={task.projectName}
          previews={previews}
          selected={selected}
          live={state.kind === "live"}
          compact={phone}
          onSelect={(item) => { onAddress({ preview: item.key, path: item.path }); }}
          onKeep={(item) => { keep.mutate({ taskId: task.id, key: item.key }, { onSuccess: () => { setNotice(t("task.preview.kept", { project: task.projectName })); } }); }}
          environmentHref={task.projectAdmin ? environmentHref : null}
        />
        <ToolButton label={t("task.preview.reload")} action="preview-reload" disabled={!canControl} onClick={() => { void control({ kind: "reload" }); }} className={cn(phone && "order-3")}>
          <RotateCwIcon aria-hidden />
        </ToolButton>
        <form
          className={cn("min-w-[60px] flex-1", phone && "order-2")}
          onSubmit={(event) => {
            event.preventDefault();
            goTo(pathField);
          }}
        >
          <input
            value={inert ? "" : pathField}
            onChange={(event) => { setPathField(event.target.value); }}
            disabled={inert || !canControl}
            aria-label={t("task.preview.path")}
            placeholder={inert ? "–" : undefined}
            spellCheck={false}
            data-testid="preview-path"
            className="h-[30px] w-full rounded-md border border-control-line bg-surface px-2.5 font-mono text-[13.5px] text-text placeholder:text-faint disabled:opacity-45 max-lg:h-11"
          />
        </form>
        {phone ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inert}
              title={t("task.preview.width.title", { name: presetName(preset) })}
              data-testid="preview-width"
              className="inline-flex h-[30px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] font-medium text-muted hover:bg-hover hover:text-text disabled:opacity-45"
            >
              <MonitorIcon aria-hidden className="size-[15px] stroke-[1.75]" />
              <span className="ml-1">{presetName(preset)}</span>
              <ChevronDownIcon aria-hidden className="size-3 text-faint" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[200px]">
              <DropdownMenuLabel>{t("task.preview.width.label")}</DropdownMenuLabel>
              {presetMenu}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {selected === null ? (
          // Nothing to preview: the share button stays, at 45% and inert, as the toolbar's others (task-preview.md, "Nothing to preview").
          <Button size="sm" disabled aria-label={t("task.preview.share.button", { level: t("task.preview.share.short.members") })} className={cn("h-[26px] shrink-0 gap-1.5 px-2 disabled:opacity-45 max-lg:h-11 max-lg:px-3", phone && "order-4")}>
            <UsersIcon aria-hidden />
            <span className="max-sm:hidden">{t("task.preview.share.short.members")}</span>
            <ChevronDownIcon aria-hidden className="size-3! text-faint" />
          </Button>
        ) : data === undefined ? null : (
          <div className={cn(phone && "order-4")}>
            <PreviewShareMenu
              taskId={task.id}
              taskKey={task.key}
              projectName={task.projectName}
              organizationName={task.organizationName}
              item={selected}
              publicLinks={data.publicLinks}
              linkMaxDays={data.linkMaxDays}
              members={members}
              now={now}
            />
          </div>
        )}
        {phone ? (
          <DropdownMenu>
            <DropdownMenuTrigger aria-label={t("task.preview.more")} className="order-5 grid size-11 shrink-0 place-items-center rounded-sm text-muted hover:bg-hover">
              <EllipsisIcon aria-hidden className="size-[17px] stroke-[1.75]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[220px]">
              <DropdownMenuLabel>{t("task.preview.width.label")}</DropdownMenuLabel>
              {presetMenu}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!live} onSelect={takeScreenshot}><CameraIcon aria-hidden /> {t("task.preview.screenshot.take")}</DropdownMenuItem>
              {offered ? (
                native ? (
                  <DropdownMenuItem onSelect={() => { chooseMode("stream"); }} data-action="preview-use-box"><MonitorIcon aria-hidden /> {t("task.preview.native.useBox")}</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => { chooseMode("native"); }} data-action="preview-open-here"><AppWindowIcon aria-hidden /> {t("task.preview.native.openHere")}</DropdownMenuItem>
                )
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <>
            <ToolButton label={t("task.preview.screenshot.take")} action="preview-screenshot" disabled={!live || screenshot.isPending} onClick={takeScreenshot}>
              <CameraIcon aria-hidden />
            </ToolButton>
            <ToolButton
              label={offered ? t("task.preview.native.newTabTip") : t("task.preview.newTab")}
              action="preview-new-tab"
              disabled={inert}
              onClick={openNewTab}
            >
              <ExternalLinkIcon aria-hidden />
            </ToolButton>
            <ToolButton label={expanded ? t("task.preview.collapse") : t("task.preview.expand")} action="preview-expand" onClick={() => { onExpand(!expanded); }}>
              {expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
            </ToolButton>
          </>
        )}
      </div>
      {native && selected?.framing !== null && selected?.framing !== undefined && !noticeDismissed && (state.kind === "live" || state.kind === "signing-in") ? (
        <PreviewFramingNotice label={selected.label} framing={selected.framing} onDismiss={dismissNotice} />
      ) : null}
      <div
        ref={viewport}
        className={cn("relative min-h-0 flex-1 bg-surface p-2.5", expanded && "pb-[124px]")}
        data-testid="preview-viewport"
        data-mode={mode}
      >
        {frameShown && selected !== null ? (
          <div className="size-full rounded-lg border border-line-2">
            <PreviewFrame
              mode="stream"
              viewId={view.id}
              linkToken={null}
              input={view.input}
              name={frameName}
              attempt={attempt}
              onStatus={onStatus}
              onSize={setFrameSize}
              onLeave={focusToolbar}
              dimmed={state.kind === "crashed"}
              overlay={state.kind === "dropped" ? <DroppedPill lost={state.lost} onRetry={() => { setAttempt((n) => n + 1); }} /> : null}
            />
          </div>
        ) : null}
        {nativeShown && selected !== null ? (
          <div className="size-full rounded-lg border border-line-2">
            <PreviewFrame
              key={nativeView.url}
              mode="native"
              host={nativeView.host}
              enterUrl={nativeView.url}
              name={nativeFrameName}
              onLoad={onNativeLoad}
              nav={nav}
              size={preset === "fit" ? null : viewportFor(preset, roomNow)}
            />
          </div>
        ) : null}
        {nativeCrashed && selected !== null ? (
          <CrashedBanner label={selected.label} port={selected.port} at={now} onRestart={startTheApp} restarting={startApp.isPending} />
        ) : null}
        {state.kind === "crashed" && selected !== null ? (
          <CrashedBanner label={selected.label} port={selected.port} at={crashedAt ?? now} onRestart={startTheApp} restarting={startApp.isPending} />
        ) : null}
        {block()}
      </div>
      {notice === null ? null : (
        <p role="status" className="shrink-0 border-t border-line px-3 py-1.5 text-[12.5px] text-muted" data-testid="preview-notice">{notice}</p>
      )}
      {native && (state.kind === "live" || state.kind === "signing-in" || state.kind === "native-failed") ? (
        <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 border-t border-line px-3 text-[13px] text-muted max-lg:py-1.5 max-lg:pb-[max(6px,env(safe-area-inset-bottom))]" data-testid="preview-foot" data-mode="native">
          <span className="flex min-w-0 flex-1 items-center gap-2 max-lg:basis-full">
            {foot.dot}
            <span className="shrink-0 font-medium text-text">{foot.word}</span>
            <span className="shrink-0 text-faint">· {t("task.preview.native.inYourBrowser")}{nativeHost === null || phone ? "" : " ·"}</span>
            {nativeHost === null || phone ? null : <HostText host={nativeHost} />}
          </span>
          {nativeHost === null || !phone ? null : <span className="flex min-w-0 basis-full pl-[15px]"><HostText host={nativeHost} /></span>}
          {phone ? null : (
            <Button variant="ghost" size="sm" className="ml-auto shrink-0 text-teal hover:text-teal" onClick={() => { chooseMode("stream"); }} data-action="preview-use-box">
              <MonitorIcon aria-hidden className="size-[14px]" /> {t("task.preview.native.useBox")}
            </Button>
          )}
        </div>
      ) : (
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-3 text-[13px] text-muted max-lg:pb-[env(safe-area-inset-bottom)]" data-testid="preview-foot" data-mode="stream">
        {foot.dot}
        <span className="font-medium text-text">{foot.word}</span>
        <span className="min-w-0 truncate text-faint">· {foot.line}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {watchers > 1 ? (
            <span className="inline-flex items-center gap-[5px]" data-testid="preview-watchers">
              <EyeIcon aria-hidden className="size-[14px] stroke-[1.75]" />
              {t("task.preview.foot.watching", { n: watchers })}
            </span>
          ) : null}
          {frameSize === null || !live ? null : (
            <>
              {watchers > 1 ? <span aria-hidden className="text-faint">·</span> : null}
              <span className="font-mono text-[12.5px] text-faint" data-testid="preview-size">
                {frameSize.width} × {frameSize.height}{scale < 100 ? ` · ${String(scale)}%` : ""}
              </span>
            </>
          )}
          {runner === null || phone ? null : (
            <>
              {watchers > 1 || (frameSize !== null && live) ? <span aria-hidden className="text-faint">·</span> : null}
              <span className="font-mono text-[12.5px] text-faint">{runner}</span>
            </>
          )}
          {phone ? null : nativeOfferView()}
        </span>
      </div>
      )}
      {expanded ? steer : null}
    </section>
  );
};
