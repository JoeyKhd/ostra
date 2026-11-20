"use client";

import { skipToken, useQuery } from "@tanstack/react-query";

import type { NoteId } from "@ostra/protocol";

import { useTRPC } from "@/lib/trpc";

import { MemoryNoteEditor } from "./memory-note-editor";
import { MemoryProposals } from "./memory-proposals";
import { MemoryView } from "./memory-view";
import type { MemoryScopeRef } from "./memory-words";

// Memory's routes (F-109, F-111): each page names its scope; the organization's and the project's
// names come from the member's own reads.

const useNames = (memoryRef: MemoryScopeRef): { readonly projectName: string | null; readonly organizationName: string } => {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.get.queryOptions());
  const project = useQuery(trpc.projects.get.queryOptions(memoryRef.scope === "project" ? { projectId: memoryRef.projectId } : skipToken));
  return { projectName: memoryRef.scope === "project" ? (project.data?.name ?? null) : null, organizationName: me.data?.organization?.name ?? "" };
};

export const MemoryPage = ({ memoryRef }: { readonly memoryRef: MemoryScopeRef }) => <MemoryView memoryRef={memoryRef} {...useNames(memoryRef)} />;

export const MemoryNotePage = ({ memoryRef, noteId, startScope }: { readonly memoryRef: MemoryScopeRef; readonly noteId: NoteId | null; readonly startScope?: "organization" | "project" }) => (
  <MemoryNoteEditor memoryRef={memoryRef} noteId={noteId} {...useNames(memoryRef)} {...(startScope === undefined ? {} : { startScope })} />
);

export const MemoryProposalsPage = ({ memoryRef }: { readonly memoryRef: MemoryScopeRef }) => <MemoryProposals memoryRef={memoryRef} {...useNames(memoryRef)} />;
