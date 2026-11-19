"use client";

import { useQueryClient } from "@tanstack/react-query";
import { skipToken } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { ChangeEntity, LiveTextFrame, SegmentId, StoredEvent } from "@ostra/protocol";

import { useTRPC } from "@/lib/trpc";

import { queryScopesOf } from "./change-scopes";
import type { QueryScope } from "./change-scopes";
import type { Connection } from "./stream-state";

// One subscription over SSE per tab (ADR 0035, ticket 33): the organization's change notices and,
// while a task page is open, that task's committed events and live text. tRPC's link resumes from
// the last `tracked` id after a drop, and after 20 s without a frame (the server's
// `reconnectAfterInactivityMs`), so a reconnect has no gap and no duplicate.

/** What the open task page receives. */
export type TaskListener = {
  readonly events: (events: readonly StoredEvent[]) => void;
  readonly live: (frame: LiveTextFrame) => void;
  readonly liveEnd: (segmentId: SegmentId) => void;
  readonly connection: (connection: Connection) => void;
};

type Watch = { readonly taskId: string; readonly afterSeq: number; readonly listener: TaskListener };

type StreamContextValue = {
  /** Opens the task's events on the tab's stream, after `afterSeq`. Returns the unwatch. */
  readonly watchTask: (watch: Watch) => () => void;
};

const StreamContext = createContext<StreamContextValue | null>(null);

export const useStream = (): StreamContextValue => {
  const value = useContext(StreamContext);
  if (value === null) throw new Error("StreamProvider is missing");
  return value;
};

const NOTICE_FLUSH_MS = 250;

export const StreamProvider = ({ children }: { readonly children: ReactNode }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [watch, setWatch] = useState<Watch | null>(null);
  const listener = useRef<TaskListener | null>(null);
  const pendingEvents = useRef<StoredEvent[]>([]);
  const frame = useRef<number | null>(null);
  const notices = useRef(new Set<ChangeEntity>());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Committed events are handed over once per animation frame, so a burst folds once.
  const flushEvents = useCallback(() => {
    frame.current = null;
    const batch = pendingEvents.current;
    pendingEvents.current = [];
    if (batch.length > 0) listener.current?.events(batch);
  }, []);

  const flushNotices = useCallback(() => {
    noticeTimer.current = null;
    const entities = [...notices.current];
    notices.current.clear();
    const scopes = new Set<QueryScope>(entities.flatMap(queryScopesOf));
    void queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
    for (const scope of scopes) void queryClient.invalidateQueries({ queryKey: trpc[scope].pathKey() });
  }, [queryClient, trpc]);

  const input = watch === null ? {} : { taskId: watch.taskId, afterSeq: watch.afterSeq };
  const subscription = useSubscription(
    trpc.stream.subscribe.subscriptionOptions(typeof window === "undefined" ? skipToken : input, {
      onData: (item) => {
        // A committed event comes wrapped as tRPC's `{ id, data }`: the id is its seq.
        const message = "data" in item ? item.data : item;
        switch (message.type) {
          case "event":
            pendingEvents.current.push(message.event);
            frame.current ??= requestAnimationFrame(flushEvents);
            break;
          case "live":
            listener.current?.live(message.frame);
            break;
          case "live-end":
            listener.current?.liveEnd(message.segmentId);
            break;
          case "change":
            notices.current.add(message.entity);
            noticeTimer.current ??= setTimeout(flushNotices, NOTICE_FLUSH_MS);
            break;
          default:
            message satisfies never;
        }
      },
    }),
  );

  const status = subscription.status;
  useEffect(() => {
    listener.current?.connection(status === "pending" ? "live" : status === "connecting" ? (subscription.data === undefined ? "connecting" : "reconnecting") : "reconnecting");
  }, [status, subscription.data]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const value = useMemo<StreamContextValue>(
    () => ({
      watchTask: (next) => {
        listener.current = next.listener;
        setWatch(next);
        return () => {
          if (listener.current === next.listener) listener.current = null;
          setWatch((current) => (current?.listener === next.listener ? null : current));
        };
      },
    }),
    [],
  );

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
};
