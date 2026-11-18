"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useState } from "react";

import { useTRPC } from "@/lib/trpc";

import { useStream } from "./stream-provider";
import { initialStreamState, streamReducer } from "./stream-state";
import type { TaskStreamState } from "./stream-state";

export type TaskLog = {
  readonly state: TaskStreamState;
  readonly error: string | null;
  readonly loadingEarlier: boolean;
  readonly loadEarlier: () => Promise<void>;
};

/**
 * A task's log on its page (ADR 0036): the newest 20 turns first, then the live tail on the tab's
 * stream from where that page ended, and "Load earlier turns" paging back.
 */
export const useTaskLog = (taskId: string): TaskLog => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { watchTask } = useStream();
  const [state, dispatch] = useReducer(streamReducer, initialStreamState);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const first = useQuery({
    ...trpc.tasks.history.queryOptions({ taskId }),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const page = first.data;
  useEffect(() => {
    if (page === undefined) return undefined;
    dispatch({ type: "first-page", events: page.events, olderBefore: page.nextBeforeSeq });
    return watchTask({
      taskId,
      afterSeq: page.headSeq ?? 0,
      listener: {
        events: (events) => { dispatch({ type: "events", events }); },
        live: (frame) => { dispatch({ type: "live", frame }); },
        liveEnd: (segmentId) => { dispatch({ type: "live-end", segmentId }); },
        connection: (connection) => { dispatch({ type: "connection", connection }); },
      },
    });
  }, [page, taskId, watchTask]);

  const olderBefore = state.olderBefore;
  const loadEarlier = useCallback(async () => {
    if (olderBefore === null) return;
    setLoadingEarlier(true);
    try {
      const older = await queryClient.query(trpc.tasks.history.queryOptions({ taskId, beforeSeq: olderBefore }));
      dispatch({ type: "older-page", events: older.events, olderBefore: older.nextBeforeSeq });
    } finally {
      setLoadingEarlier(false);
    }
  }, [olderBefore, queryClient, taskId, trpc]);

  return { state, error: first.error?.message ?? null, loadingEarlier, loadEarlier };
};
