"use client";

import { useQuery } from "@tanstack/react-query";

import type { TaskId } from "@ostra/protocol";

import { PropGroup } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

// The task's memory (F-110, F-111; growing app-targets/m1/task): the notes its sessions used and how
// (the index, "always", a search or a read), and the proposals it made with their states.

const VIA_WORDS = { index: "memory.task.viaIndex", always: "memory.task.viaAlways", search: "memory.task.viaSearch", read: "memory.task.viaRead" } as const;
const STATE_WORDS = { proposed: "memory.proposalsList.open", approved: "memory.proposalsList.approved", merged: "memory.proposalsList.merged", rejected: "memory.proposalsList.rejected" } as const;

export const TaskMemory = ({ taskId }: { readonly taskId: TaskId }) => {
  const trpc = useTRPC();
  const memory = useQuery({ ...trpc.tasks.memory.queryOptions({ taskId }), refetchInterval: 30_000 });
  const data = memory.data;
  if (data === undefined) return null;
  // One row per note: the strongest way a session saw it (a read beats a search beats always beats the index).
  const rank = { read: 4, search: 3, always: 2, index: 1 } as const;
  const notes = new Map<string, { readonly title: string; readonly via: keyof typeof rank }>();
  for (const use of data.sessions.flatMap((session) => session.uses)) {
    const seen = notes.get(use.noteId);
    if (seen === undefined || rank[use.via] > rank[seen.via]) notes.set(use.noteId, { title: use.title, via: use.via });
  }
  if (notes.size === 0 && data.proposals.length === 0) return null;
  return (
    <PropGroup title={t("memory.task.title")}>
      <div data-testid="task-memory">
        {[...notes.entries()].map(([noteId, note]) => (
          <div key={noteId} className="flex h-[26px] items-center gap-2 text-[12.5px]" data-testid="task-memory-note">
            <span className="min-w-0 flex-1 truncate text-text">{note.title}</span>
            <span className="shrink-0 text-xs text-faint">{t(VIA_WORDS[note.via])}</span>
          </div>
        ))}
        {data.proposals.map((proposal) => (
          <div key={proposal.proposalId} className="flex h-[26px] items-center gap-2 text-[12.5px]" data-testid="task-memory-proposal">
            <span className="min-w-0 flex-1 truncate text-muted">{t("memory.task.proposed", { title: proposal.title })}</span>
            <span className="shrink-0 text-xs text-faint">{t(STATE_WORDS[proposal.state])}</span>
          </div>
        ))}
      </div>
    </PropGroup>
  );
};
