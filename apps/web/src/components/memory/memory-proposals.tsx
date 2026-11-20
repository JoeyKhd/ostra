"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranchIcon, MessageSquareIcon, EqualNotIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { proposalIdSchema } from "@ostra/protocol";
import type { NoteId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { NoteBody } from "./memory-parts";
import { conflictOf, kindWord, memoryBase } from "./memory-words";
import type { MemoryScopeRef } from "./memory-words";

// Proposals (F-111; app-targets/m4/memory-proposals.md): what agents and members asked a scope to
// remember. None reaches an agent until a member decides: approve as a new note, approve and archive
// a related note, merge into one at the version the member opened (`CONFLICT` when it moved on), or
// reject.

type Proposal = RouterOutputs["memory"]["proposals"][number];

const fromWords = (proposal: Proposal): string => {
  const task = proposal.task === null ? "" : proposal.task.taskId.slice(-7);
  switch (proposal.source) {
    case "agent":
      return t("memory.proposalsList.fromAgent", { task });
    case "closing_turn":
      return t("memory.proposalsList.fromClosing", { task });
    case "diff_comment":
      return t("memory.proposalsList.fromDiff", { name: proposal.proposedBy?.name ?? t("memory.someone"), task });
    case "pr_comment":
      return t("memory.proposalsList.fromPr", { name: proposal.proposedBy?.name ?? t("memory.someone"), task });
    case "ai_finding":
      return t("memory.proposalsList.fromFinding", { name: proposal.proposedBy?.name ?? t("memory.someone"), task });
    default:
      return proposal.source satisfies never;
  }
};

const stateWord = (state: Proposal["state"]): string => {
  switch (state) {
    case "proposed":
      return t("memory.proposalsList.open");
    case "approved":
      return t("memory.proposalsList.approved");
    case "merged":
      return t("memory.proposalsList.merged");
    case "rejected":
      return t("memory.proposalsList.rejected");
    default:
      return state satisfies never;
  }
};

const Relation = ({ relation }: { readonly relation: "contradicts" | "refines" | null }) =>
  relation === null ? null : (
    <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] border border-line-2 px-2 text-sm text-muted">
      <EqualNotIcon aria-hidden className="size-[13px]" />
      {relation === "contradicts" ? t("memory.proposalsList.contradicts") : t("memory.proposalsList.refines")}
    </span>
  );

/** One proposal: its text, the related notes, and the four decisions. */
const ProposalDetail = ({ proposalId, memoryRef }: { readonly proposalId: Proposal["proposalId"]; readonly memoryRef: MemoryScopeRef }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const detail = useQuery(trpc.memory.proposal.queryOptions({ proposalId }));
  const [merging, setMerging] = useState<{ readonly noteId: NoteId; readonly title: string; readonly version: number } | null>(null);
  const [mergedBody, setMergedBody] = useState("");
  const decide = useMutation(
    trpc.memory.decide.mutationOptions({
      onSuccess: async ({ noteId }) => {
        await queryClient.invalidateQueries({ queryKey: trpc.memory.pathKey() });
        if (noteId !== null) router.push(`${memoryBase(memoryRef)}?note=${noteId}${memoryRef.scope === "project" && detail.data?.scope === "organization" ? "&tab=organization" : ""}`);
      },
    }),
  );
  const data = detail.data;
  if (data === undefined) return detail.error === null ? <Skeleton className="mt-6 h-24 w-full" /> : <p role="alert" className="mt-6 text-red">{errorText(detail.error)}</p>;
  const open = data.state === "proposed";
  const declared = data.related.find((note) => note.relation !== null) ?? data.related[0];
  const conflict = conflictOf(decide.error?.message);
  return (
    <div className="mt-6 border-t border-line pt-5" data-testid="proposal-detail">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-medium text-faint">{t("memory.proposalsList.proposed")}</h3>
          <p className="mt-1 text-[17px] font-semibold text-text">{data.title}</p>
          <p className="mt-1.5 flex items-center gap-2 text-sm text-muted">
            <Chip>{kindWord(data.kind)}</Chip>
            {data.scope === "organization" ? t("memory.proposalsList.forOrganization") : t("memory.proposalsList.forProject")}
          </p>
          <NoteBody body={data.body} className="mt-3" />
        </div>
        <div>
          <h3 className="text-xs font-medium text-faint">{t("memory.proposalsList.related")} <span className="font-normal">{t("memory.proposalsList.rankedBy")}</span></h3>
          {data.related.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t("memory.proposalsList.noRelated")}</p>
          ) : (
            <ul className="mt-1">
              {data.related.map((note) => (
                <li key={note.noteId} className="flex items-center gap-2 border-b border-line py-2 text-ui">
                  <span className="min-w-0 flex-1 truncate font-medium text-text">{note.title}</span>
                  <Relation relation={note.relation} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {open ? (
        <div className="mt-5 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={decide.isPending} onClick={() => { decide.mutate({ proposalId, decision: "approve" }); }} data-testid="approve-proposal">
              {t("memory.proposalsList.approve")}
            </Button>
            {declared === undefined ? null : (
              <>
                <Button variant="outline" disabled={decide.isPending} onClick={() => { decide.mutate({ proposalId, decision: "approve_and_archive", archiveNoteId: declared.noteId }); }}>
                  {t("memory.proposalsList.approveArchive", { title: declared.title })}
                </Button>
                <Button
                  variant="outline"
                  disabled={decide.isPending}
                  aria-expanded={merging !== null}
                  onClick={() => {
                    setMerging({ noteId: declared.noteId, title: declared.title, version: declared.version });
                    setMergedBody(data.body);
                  }}
                >
                  {t("memory.proposalsList.mergeInto", { title: declared.title })}
                </Button>
              </>
            )}
            <Button variant="ghost" disabled={decide.isPending} onClick={() => { decide.mutate({ proposalId, decision: "reject" }); }}>
              {t("memory.proposalsList.reject")}
            </Button>
          </div>
          {merging === null ? null : (
            <div className="mt-4">
              <label htmlFor="merged-body" className="text-sm text-muted">{t("memory.proposalsList.mergedLabel", { version: merging.version + 1, title: merging.title })}</label>
              <Textarea id="merged-body" rows={4} className="mt-1.5 font-mono text-[14px]" value={mergedBody} onChange={(event) => { setMergedBody(event.target.value); }} />
              <div className="mt-3 flex items-center gap-3">
                <Button
                  variant="primary"
                  disabled={decide.isPending || mergedBody.trim() === ""}
                  onClick={() => { decide.mutate({ proposalId, decision: "merge", intoNoteId: merging.noteId, expectedVersion: merging.version, title: merging.title, body: mergedBody.trim() }); }}
                >
                  {t("memory.proposalsList.mergeAs", { version: merging.version + 1 })}
                </Button>
                <Button variant="ghost" onClick={() => { setMerging(null); }}>{t("common.cancel")}</Button>
                <span className="text-sm text-faint">{t("memory.proposalsList.mergeHelp")}</span>
              </div>
            </div>
          )}
          {decide.error === null ? null : (
            <p role="alert" className="mt-3 text-sm text-red" data-testid="proposal-error">
              {conflict === null ? errorText(decide.error) : t("memory.proposalsList.conflict", { name: conflict.name, version: conflict.version })}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-5 border-t border-line pt-4 text-sm text-muted">
          {stateWord(data.state)}
          {data.decidedBy === null ? null : ` · ${data.decidedBy.name}`}
          {data.resultNoteId === null ? null : (
            <>
              {" · "}
              <Link href={`${memoryBase(memoryRef)}?note=${data.resultNoteId}`} className="text-teal hover:underline">{t("memory.proposalsList.openNote")}</Link>
            </>
          )}
        </p>
      )}
    </div>
  );
};

/** A scope's proposals. */
export const MemoryProposals = ({ memoryRef, projectName, organizationName }: { readonly memoryRef: MemoryScopeRef; readonly projectName: string | null; readonly organizationName: string }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get("tab") === "decided" ? "decided" : "open";
  const scopeInput = memoryRef.scope === "project" ? { scope: "project" as const, projectId: memoryRef.projectId } : { scope: "organization" as const };
  const list = useQuery({ ...trpc.memory.proposals.queryOptions(scopeInput), refetchInterval: 15_000 });
  const all = list.data ?? [];
  const shown = all.filter((proposal) => (tab === "open" ? proposal.state === "proposed" : proposal.state !== "proposed"));
  const parsed = proposalIdSchema.safeParse(params.get("proposal"));
  const selectedId = parsed.success ? parsed.data : (shown[0]?.proposalId ?? null);
  const selected = shown.find((proposal) => proposal.proposalId === selectedId) ?? null;
  const now = list.dataUpdatedAt;
  const scopeName = memoryRef.scope === "project" ? (projectName ?? "") : organizationName;
  const go = (change: Readonly<Record<string, string | null>>): void => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(change)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const text = next.toString();
    router.replace(text === "" ? pathname : `${pathname}?${text}`, { scroll: false });
  };
  const crumbs = [
    ...(memoryRef.scope === "project" ? [{ label: organizationName }, { label: projectName ?? "", href: `/projects/${memoryRef.projectId}` }] : [{ label: organizationName }]),
    { label: t("memory.title"), href: memoryBase(memoryRef) },
    { label: t("memory.proposalsList.title") },
  ];
  return (
    <PageFrame
      crumbs={crumbs}
      properties={
        selected === null ? undefined : (
          <div data-testid="proposal-panel">
            <h3 className="mb-1 text-xs font-medium text-faint">{t("memory.proposalsList.proposal")}</h3>
            <PropRow label={t("memory.proposalsList.state")} labelWidth={96}>{stateWord(selected.state)}</PropRow>
            <PropRow label={t("memory.proposalsList.kind")} labelWidth={96}>{kindWord(selected.kind)}</PropRow>
            <PropRow label={t("memory.panel.scope")} labelWidth={96}>{selected.scope === "project" ? scopeName : organizationName}</PropRow>
            <PropRow label={t("memory.proposalsList.proposedAt")} labelWidth={96}><span className="font-mono" suppressHydrationWarning>{formatAge(selected.createdAt, now)}</span></PropRow>
            <div className="mt-3 border-t border-line pt-3">
              <h3 className="mb-1 text-xs font-medium text-faint">{t("memory.panel.source")}</h3>
              <PropRow label={t("memory.note.from")} labelWidth={96}>{fromWords(selected)}</PropRow>
              {selected.task === null ? null : (
                <PropRow label={t("memory.note.task")} labelWidth={96}>
                  <Link href={`/tasks/${selected.task.taskId}`} className="truncate text-teal hover:underline" data-testid="proposal-task">{selected.task.title}</Link>
                </PropRow>
              )}
            </div>
            <p className="mt-3 border-t border-line pt-3 text-sm text-muted">{t("memory.proposalsList.reachesNext")}</p>
          </div>
        )
      }
    >
      <PageHeading title={t("memory.proposalsList.title")} lede={t("memory.proposalsList.lede", { scope: scopeName })} />
      <UnderlineTabs
        className="mt-4"
        idPrefix="proposals"
        label={t("memory.proposalsList.title")}
        selected={tab}
        onSelect={(next) => { go({ tab: next === "open" ? null : next, proposal: null }); }}
        tabs={[
          { id: "open", label: t("memory.proposalsList.open"), extra: <span className="font-mono text-xs text-faint">{all.filter((one) => one.state === "proposed").length}</span> },
          { id: "decided", label: t("memory.proposalsList.decided") },
        ]}
      />
      {list.data === undefined ? (
        <div className="mt-4 space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
      ) : shown.length === 0 ? (
        <p className="mt-6 text-ui text-muted" data-testid="proposals-empty">{tab === "open" ? t("memory.proposalsList.none") : t("memory.proposalsList.noneDecided")}</p>
      ) : (
        <ul role="listbox" aria-label={t("memory.proposalsList.title")} className="mt-3" data-testid="proposals-list">
          {shown.map((proposal) => (
            <li
              key={proposal.proposalId}
              role="option"
              aria-selected={proposal.proposalId === selected?.proposalId}
              tabIndex={0}
              data-proposal={proposal.title}
              onClick={() => { go({ proposal: proposal.proposalId }); }}
              onKeyDown={(event) => { if (event.key === "Enter") go({ proposal: proposal.proposalId }); }}
              className={cn(
                "grid min-h-10 cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-2 py-1.5 hover:bg-raise md:grid-cols-[18px_minmax(0,1fr)_minmax(0,260px)_110px_44px]",
                proposal.proposalId === selected?.proposalId && "rounded-[6px] bg-sel hover:bg-sel",
              )}
            >
              {proposal.source === "diff_comment" || proposal.source === "pr_comment" ? <MessageSquareIcon aria-hidden className="size-4 text-muted" /> : <GitBranchIcon aria-hidden className="size-4 text-muted" />}
              <span className="truncate text-[14.5px] font-medium text-text">{proposal.title}</span>
              <span className="hidden truncate text-sm text-muted md:block">{fromWords(proposal)}</span>
              <span className="hidden md:block">{proposal.relatesTo === null ? null : <Relation relation={proposal.relatesTo.relation} />}</span>
              <span className="text-right font-mono text-sm text-faint" suppressHydrationWarning>{formatAge(proposal.createdAt, now)}</span>
            </li>
          ))}
        </ul>
      )}
      {selected === null ? null : <ProposalDetail key={selected.proposalId} proposalId={selected.proposalId} memoryRef={memoryRef} />}
    </PageFrame>
  );
};

export const proposalsHref = (memoryRef: MemoryScopeRef): string => `${memoryBase(memoryRef)}/proposals`;
