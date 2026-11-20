"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { ProjectId } from "@ostra/protocol";

import { useTRPC } from "@/lib/trpc";

import type { FilterNames } from "./automation-words";

/**
 * The names a project's filters use (its boards, the statuses and assignees of its cached tickets),
 * and the project's boards for the editor's value pickers.
 */
export const useFilterNames = (projectId: ProjectId) => {
  const trpc = useTRPC();
  const filters = useQuery(trpc.inbox.filters.queryOptions({ projectId }));
  const boards = useQuery(trpc.boards.get.queryOptions({ projectId }));
  const names = useMemo<FilterNames>(
    () => ({
      statuses: new Map((filters.data?.statuses ?? []).map((status) => [status.id, status.name] as const)),
      assignees: new Map((filters.data?.assignees ?? []).map((assignee) => [assignee.id, assignee.name] as const)),
      boards: new Map((boards.data?.boards ?? []).map((board) => [String(board.id), board.name] as const)),
      boardCount: boards.data?.boards.length ?? 0,
    }),
    [filters.data, boards.data],
  );
  return { names, filters: filters.data, boards: boards.data?.boards, boardsLoaded: boards.data !== undefined };
};
