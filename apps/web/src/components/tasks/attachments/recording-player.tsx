"use client";

import { useQuery } from "@tanstack/react-query";
import { MaximizeIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { decodeFrameReel } from "@ostra/protocol";
import type { FrameReelHeader } from "@ostra/protocol";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { durationText, frameAt, stepAt, stepWords } from "./attachment-words";

// A recording's player (task-attachments.md, "A recording"; Q312): the frame reel is downloaded
// once (`/api/tasks/<taskId>/attachments/<id>`), decoded in the page with the protocol's own
// decoder (`decodeFrameReel`), and its JPEG frames drawn at their times as object URLs, which the
// panel's CSP allows (`img-src 'self' blob:`). There's no `<video>`: the box has no encoder. ostra's
// bar plays and pauses it, seeks with the scrubber, its step ticks and the steps' buttons, and sets
// the speed; Space, J and L work while the player has the focus. The steps are the agent's words.

/** A decoded reel, ready to draw: its header, each frame's time and its object URL. */
export type LoadedReel = { readonly header: FrameReelHeader; readonly times: readonly number[]; readonly urls: readonly string[] };

const reelQueryKey = (path: string) => ["frame-reel", path] as const;

/** Downloads and decodes a reel once per page; the URLs live as long as the page does. */
export const useFrameReel = (path: string, enabled = true) =>
  useQuery({
    queryKey: reelQueryKey(path),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async ({ signal }): Promise<LoadedReel> => {
      const response = await fetch(path, { signal, credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      const parsed = decodeFrameReel(new Uint8Array(await response.arrayBuffer()));
      if (!parsed.ok) throw new Error(parsed.reason);
      const { header, frames } = parsed.reel;
      return {
        header,
        times: frames.map((frame) => frame.atMs),
        urls: frames.map((frame) => URL.createObjectURL(new Blob([new Uint8Array(frame.jpeg)], { type: "image/jpeg" }))),
      };
    },
  });

const SPEEDS = [1, 1.5, 2] as const;

export const RecordingPlayer = ({ path, durationMs, onSteps }: {
  readonly path: string;
  readonly durationMs: number;
  /** The steps and the playing one, for the facts column to list (`null` until the reel is read). */
  readonly onSteps?: (steps: { readonly words: readonly string[]; readonly starts: readonly number[]; readonly playing: number; readonly seek: (ms: number) => void } | null) => void;
}) => {
  const reel = useFrameReel(path);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const stage = useRef<HTMLDivElement>(null);
  const clock = useRef<{ readonly start: number; readonly from: number } | null>(null);
  const atNow = useRef(0);
  const length = reel.data?.header.durationMs ?? durationMs;
  useEffect(() => { atNow.current = at; }, [at]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    clock.current = { start: performance.now(), from: atNow.current >= length ? 0 : atNow.current };
    const tick = (now: number) => {
      const started = clock.current;
      if (started === null) return;
      const next = started.from + (now - started.start) * speed;
      if (next >= length) {
        setAt(length);
        setPlaying(false);
        return;
      }
      setAt(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clock.current = null;
    };
  }, [playing, speed, length]);

  const seek = useCallback((ms: number) => {
    const next = Math.max(0, Math.min(length, ms));
    setAt(next);
    if (clock.current !== null) clock.current = { start: performance.now(), from: next };
  }, [length]);

  const words = useMemo(() => reel.data?.header.steps.map((one) => stepWords(one.step)) ?? [], [reel.data]);
  const starts = useMemo(() => reel.data?.header.steps.map((one) => one.atMs) ?? [], [reel.data]);
  const playingStep = stepAt(starts, at);
  useEffect(() => {
    onSteps?.(reel.data === undefined ? null : { words, starts, playing: playingStep, seek });
  }, [onSteps, reel.data, words, starts, playingStep, seek]);

  const toggle = () => {
    if (!playing && at >= length) setAt(0);
    setPlaying((now) => !now);
  };
  const frameUrl = reel.data === undefined ? undefined : reel.data.urls[frameAt(reel.data.times, at)];

  return (
    <div
      ref={stage}
      className="flex min-h-0 flex-1 flex-col bg-surface"
      data-testid="recording-player"
      data-state={playing ? "playing" : "paused"}
      tabIndex={0}
      aria-label={t("task.attachments.player")}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget && event.key === " ") return;
        if (event.key === " " || event.key === "k") {
          event.preventDefault();
          toggle();
        } else if (event.key === "j") {
          seek(at - 5000);
        } else if (event.key === "l") {
          seek(at + 5000);
        }
      }}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center px-14 py-[18px]">
        {reel.isError ? (
          <p role="alert" className="text-ui text-red">{t("task.attachments.reelUnreadable")}</p>
        ) : frameUrl === undefined ? (
          <p className="text-ui text-faint">{t("task.attachments.reelLoading")}</p>
        ) : (
          <img src={frameUrl} alt={t("task.attachments.frameAlt", { time: durationText(at) })} className="max-h-full max-w-full rounded-[6px] border border-line-2 bg-white object-contain" data-testid="recording-frame" />
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-3 border-t border-line bg-raise px-4">
        <button type="button" className="grid size-7 place-items-center rounded-sm text-text hover:bg-sel" aria-label={playing ? t("task.attachments.pause") : t("task.attachments.play")} data-action={playing ? "pause" : "play"} onClick={toggle} disabled={reel.data === undefined}>
          {playing ? <PauseIcon aria-hidden className="size-4" /> : <PlayIcon aria-hidden className="size-4 fill-current" />}
        </button>
        <span className="shrink-0 font-mono text-sm text-muted" data-testid="recording-time">{durationText(at)} / {durationText(length)}</span>
        <div className="relative flex-1">
          <input
            type="range"
            min={0}
            max={Math.max(1, length)}
            step={100}
            value={Math.round(at)}
            aria-label={t("task.attachments.scrubber")}
            aria-valuetext={durationText(at)}
            className="w-full accent-[var(--teal)]"
            onChange={(event) => { seek(Number(event.target.value)); }}
          />
          {starts.map((start, index) => (
            <span key={index} aria-hidden className="pointer-events-none absolute top-0 h-1.5 w-0.5 bg-muted" style={{ left: `${String((start / Math.max(1, length)) * 100)}%` }} />
          ))}
        </div>
        <span className="flex shrink-0 items-center gap-0.5">
          {SPEEDS.map((one) => (
            <button key={one} type="button" aria-pressed={speed === one} className={cn("h-6 rounded-sm px-1.5 font-mono text-xs", speed === one ? "bg-sel text-text" : "text-muted hover:text-text")} onClick={() => { setSpeed(one); }}>
              {`${String(one)}×`}
            </button>
          ))}
        </span>
        <button type="button" className="grid size-7 place-items-center rounded-sm text-muted hover:bg-sel hover:text-text" aria-label={t("task.attachments.fullScreen")} onClick={() => { void stage.current?.requestFullscreen().catch(() => undefined); }}>
          <MaximizeIcon aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
};
