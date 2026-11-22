"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { FileLimits } from "@ostra/domain/file-limits";
import type { MessageFileId } from "@ostra/protocol";

import { useTRPC } from "@/lib/trpc";

import { projectUploader } from "./upload-file";
import { useAttachments } from "./use-attachments";
import type { Attachments } from "./use-attachments";
import { useDropZone } from "./use-drop-zone";
import { usePasteFiles } from "./use-paste-files";

// A new task's box's files (new-task-attachments.md; F-148, ticket 15), on the project page and the
// new-task page: the tray against the server's limits (`files.limits`), uploads to the project the
// box starts the task in, paste into the words, and the box as the drop zone. A task needs words:
// files alone don't start one (the maintainer's choice 4.2). When the project changes, the tray
// stays and its files upload again to the new one.

/** No limits while they're read: the tray takes nothing until they come. */
export const NO_LIMITS: FileLimits = { maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0 };

export type BoxFiles = {
  readonly attachments: Attachments;
  /** The server's limits, `null` until read. */
  readonly limits: FileLimits | null;
  readonly onPaste: ReturnType<typeof usePasteFiles>;
  /** Files are being dragged over the page: the box shows its drop zone. */
  readonly dropping: boolean;
  readonly canAttach: boolean;
};

export const useBoxFiles = (projectId: string | undefined, enabled = true): BoxFiles => {
  const trpc = useTRPC();
  const limits = useQuery(trpc.files.limits.queryOptions(undefined, { staleTime: Number.POSITIVE_INFINITY }));
  const { mutate } = useMutation(trpc.files.discard.mutationOptions());
  const discard = useCallback((fileId: MessageFileId) => { mutate({ fileId }); }, [mutate]);
  const upload = useMemo(() => projectUploader(projectId ?? "", null), [projectId]);
  const canAttach = enabled && projectId !== undefined && limits.data !== undefined;
  const attachments = useAttachments({ limits: limits.data ?? NO_LIMITS, upload, discard, enabled: canAttach, wordsRequired: true });
  const onPaste = usePasteFiles({ enabled: canAttach && !attachments.waiting, onFiles: attachments.add });
  const dropping = useDropZone({ enabled: canAttach && !attachments.waiting, onDrop: attachments.add });
  // An upload belongs to its project: the box's files go again to the project it now starts the task in.
  const uploadedTo = useRef(projectId);
  const { restart } = attachments;
  useEffect(() => {
    if (uploadedTo.current === projectId) return;
    uploadedTo.current = projectId;
    restart();
  }, [projectId, restart]);
  return { attachments, limits: limits.data ?? null, onPaste, dropping, canAttach };
};
