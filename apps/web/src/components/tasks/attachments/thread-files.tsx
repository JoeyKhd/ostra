"use client";

import { useQuery } from "@tanstack/react-query";
import { PaperclipIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { FileLimits } from "@ostra/domain/file-limits";
import type { MessageFilesData } from "@ostra/task-view";

import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import { useTaskContext } from "@/task/task-context";

import { useAttachments } from "./attachments-context";
import { MessageFiles } from "./message-files";
import { trackerLabel } from "./ticket-context-thread";

// A member's message's files in the thread (message-attachments.md; F-148, F-150, ticket 16), from
// the fold's `data-message-files` part: under the message's words, with the viewer the task's
// attachments context opens. And the old `Ticket files ready` row, which a task whose ticket's files
// came as message files no longer shows (`What the agent got` says it).

/** Before the limits are read, the left-out notes word what the message says without numbers. */
const NO_LIMITS: FileLimits = { maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0 };

export const ThreadMessageFiles = ({ data, author }: { readonly data: MessageFilesData; readonly author: string }) => {
  const trpc = useTRPC();
  const context = useAttachments();
  const { agent } = useTaskContext();
  const limits = useQuery(trpc.files.limits.queryOptions(undefined, { staleTime: Number.POSITIVE_INFINITY }));
  const ticket = context?.ticketContext ?? null;
  return (
    <MessageFiles
      files={data.files}
      author={author}
      agent={agent.name}
      model={agent.model ?? agent.name}
      imagesNotSent={data.imagesNotSent}
      leftOut={data.leftOut}
      skipped={data.skipped}
      limits={limits.data ?? NO_LIMITS}
      tracker={ticket === null ? "" : trackerLabel(ticket)}
      onOpenImage={context === null ? null : context.openFile}
    />
  );
};

/**
 * Milestone 2's `Ticket files ready` row: kept for a task started before its ticket's files came as
 * message files; gone once "What the agent got" holds them.
 */
export const TicketFilesRow = ({ paths, line }: { readonly paths: readonly string[]; readonly line: (icon: ReactNode, children: ReactNode) => ReactNode }) => {
  const context = useAttachments();
  if ((context?.ticketContext?.rounds.length ?? 0) > 0) return null;
  return (
    <div data-part="ticket-files">
      {line(
        <PaperclipIcon />,
        <>
          {t("task.ticketFiles")}
          <span className="truncate font-mono text-sm text-faint">{paths.map((path) => `.ostra/ticket/${path}`).join(", ")}</span>
        </>,
      )}
    </div>
  );
};
