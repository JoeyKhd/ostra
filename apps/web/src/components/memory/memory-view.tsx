"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, CircleAlertIcon, LightbulbIcon, PinIcon, PlusIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { memoryKindSchema, noteIdSchema } from "@ostra/protocol";
import type { MemoryKind, NoteId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { AlwaysChip, KindIcon, NoteBody } from "./memory-parts";
import { MEMORY_KINDS, SOURCE_FILTERS, kindWord, memoryBase, sourceFilterOf, sourceWord } from "./memory-words";
import type { MemoryScopeRef, SourceFilter } from "./memory-words";

// Memory (F-109; app-targets/m4/memory.md): a scope's notes, searched by full text (the search an
// agent's `memory_search` runs), filtered by kind, source and "always", with the selected note in the
// panel: its Always switch, source, versions and archive. The tab, the search, the filters and the
// selection live in the URL.

type Note = RouterOutputs["memory"]["notes"]["notes"][number];
type Tab = "project" | "organization" | "archived" | "notes";

const sourceKey = (note: Note): string | null => (note.source.taskId === null ? null : note.source.taskId.slice(-7));

/** Without a search: "always" notes first, then by last read, newest first, then never-read notes by last edit (ADR 0044). */
export const indexOrder = (notes: readonly Note[]): readonly Note[] =>
  [...notes].sort((x, y) => {
    if (x.always !== y.always) return x.always ? -1 : 1;
    if ((x.lastUsedAt === null) !== (y.lastUsedAt === null)) return x.lastUsedAt === null ? 1 : -1;
    if (x.lastUsedAt !== null && y.lastUsedAt !== null && x.lastUsedAt !== y.lastUsedAt) return y.lastUsedAt - x.lastUsedAt;
    return y.updatedAt - x.updatedAt;
  });

const useDebounced = (value: string, ms: number): string => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(value); }, ms);
    return () => { clearTimeout(timer); };
  }, [value, ms]);
  return debounced;
};

const useWide = (): boolean => {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const list = window.matchMedia("(min-width: 1280px)");
    setWide(list.matches);
    const onChange = (): void => { setWide(list.matches); };
    list.addEventListener("change", onChange);
    return () => { list.removeEventListener("change", onChange); };
  }, []);
  return wide;
};

const SourceCell = ({ note }: { readonly note: Note }) => {
  if (note.source.kind === "member") {
    return note.author === null ? <span className="text-faint">–</span> : (
      <span className="flex min-w-0 items-center gap-2 text-muted">
        <Avatar name={note.author.name} className="size-[22px] text-[10px]" />
        <span className="truncate">{note.author.name}</span>
      </span>
    );
  }
  const key = sourceKey(note);
  return key === null || note.source.taskId === null ? (
    <span className="text-muted">{sourceWord(sourceFilterOf(note.source.kind))}</span>
  ) : (
    <Link href={`/tasks/${note.source.taskId}`} onClick={(event) => { event.stopPropagation(); }} className="font-mono text-sm text-muted hover:text-text" title={sourceWord(sourceFilterOf(note.source.kind))}>
      {key}
    </Link>
  );
};

const NoteRow = ({ note, selected, onSelect, now, archived }: { readonly note: Note; readonly selected: boolean; readonly onSelect: () => void; readonly now: number; readonly archived: boolean }) => (
  <li
    role="option"
    aria-selected={selected}
    tabIndex={0}
    data-note={note.title}
    onClick={onSelect}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
      }
    }}
    className={cn(
      "grid min-h-10 cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3.5 border-b border-line px-2 py-1.5 hover:bg-raise focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted md:grid-cols-[16px_minmax(0,1fr)_110px_170px_70px] md:py-0",
      selected && "rounded-[6px] bg-sel hover:bg-sel",
    )}
  >
    <KindIcon kind={note.kind} />
    <span className="flex min-w-0 items-center gap-2.5">
      <span className={cn("truncate text-[14.5px]", archived ? "text-muted" : "text-text")}>{note.title}</span>
      {note.always && !archived ? <AlwaysChip /> : null}
    </span>
    <span className="hidden text-muted md:block">{kindWord(note.kind)}</span>
    <span className="hidden min-w-0 md:block"><SourceCell note={note} /></span>
    <span className="text-right font-mono text-sm text-faint" title={note.lastUsedAt === null ? undefined : new Date(note.lastUsedAt).toISOString()} suppressHydrationWarning>
      {note.lastUsedAt === null ? t("memory.never") : formatAge(note.lastUsedAt, now)}
    </span>
  </li>
);

/** The selected note in the panel (memory.md, "Properties panel"). */
const NotePanel = ({ note, base, projectName, archived }: { readonly note: Note; readonly base: string; readonly projectName: string | null; readonly archived: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const detail = useQuery(trpc.memory.note.queryOptions({ noteId: note.noteId }));
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: trpc.memory.pathKey() });
  };
  const save = useMutation(trpc.memory.save.mutationOptions({ onSettled: refresh }));
  const archive = useMutation(trpc.memory.archive.mutationOptions({ onSuccess: refresh }));
  const [always, setAlways] = useState(note.always);
  useEffect(() => { setAlways(note.always); }, [note.always, note.noteId]);
  const now = Date.now();
  const versions = detail.data?.versions ?? [];
  const current = versions.find((version) => version.version === note.version);
  return (
    <div data-testid="note-panel">
      <div className="flex items-center gap-2 text-sm text-muted">
        <KindIcon kind={note.kind} className="size-[15px]" />
        {kindWord(note.kind)}
        {archived ? null : (
          <Link href={`${base}/${note.noteId}`} className="ml-auto text-teal hover:underline">
            {t("memory.edit")}
          </Link>
        )}
      </div>
      <h2 className="mt-1.5 text-[17px] font-semibold text-text">{note.title}</h2>
      <NoteBody body={note.body} className="mt-2" />
      <div className="mt-4 border-t border-line pt-3">
        <PropRow label={t("memory.panel.scope")} labelWidth={96}>
          {note.scope === "project" ? t("memory.panel.projectScope", { project: projectName ?? "" }) : t("memory.panel.organizationScope")}
        </PropRow>
        {archived ? null : (
          <PropRow label={t("memory.panel.always")} labelWidth={96}>
            <span className="flex items-center gap-2">
              <Switch
                checked={always}
                aria-label={t("memory.panel.always")}
                disabled={save.isPending}
                data-testid="note-always"
                onCheckedChange={(next) => {
                  setAlways(next);
                  save.mutate(
                    { noteId: note.noteId, expectedVersion: note.version, scope: note.scope, projectId: note.projectId, title: note.title, body: note.body, kind: note.kind, always: next },
                    { onError: () => { setAlways(!next); } },
                  );
                }}
              />
              <span className="text-muted">{always ? t("memory.on") : t("memory.off")}</span>
            </span>
          </PropRow>
        )}
        <PropRow label={t("memory.panel.source")} labelWidth={96}>
          {note.source.kind === "member" ? (
            <span className="flex items-center gap-2"><Avatar name={note.author?.name ?? "?"} className="size-[22px] text-[10px]" />{note.author?.name ?? ""}</span>
          ) : (
            <span className="truncate">
              {note.source.taskId === null ? null : <Link href={`/tasks/${note.source.taskId}`} className="font-mono text-teal hover:underline">{note.source.taskId.slice(-7)}</Link>}
              <span className="text-muted"> · {sourceWord(sourceFilterOf(note.source.kind))}</span>
            </span>
          )}
        </PropRow>
        <PropRow label={t("memory.panel.version")} labelWidth={96}>
          <span className="font-mono">{note.version}</span>
          {current?.proposalId === null || current === undefined ? null : <span className="text-muted">&nbsp;· {t("memory.panel.fromProposal")}</span>}
        </PropRow>
        {note.version > 1 ? (
          <PropRow label={t("memory.panel.edited")} labelWidth={96}>
            <span className="font-mono" suppressHydrationWarning>{formatAge(note.updatedAt, now)}</span>
            {current?.editedBy === null || current === undefined ? null : <span className="text-muted">&nbsp;{t("memory.panel.by", { name: current.editedBy.name })}</span>}
          </PropRow>
        ) : null}
        <PropRow label={t("memory.panel.lastUsed")} labelWidth={96}>
          {note.lastUsedAt === null ? <span className="text-muted">{t("memory.never")}</span> : <span className="font-mono" suppressHydrationWarning>{formatAge(note.lastUsedAt, now)}</span>}
        </PropRow>
        <PropRow label={t("memory.panel.used")} labelWidth={96}>
          <span className="font-mono">{note.useCount}</span>
          <span className="text-muted">&nbsp;{t("memory.panel.reads")}</span>
        </PropRow>
        {save.error === null ? null : (
          <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-red">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-[13px] shrink-0" />
            {errorText(save.error)}
          </p>
        )}
      </div>
      <div className="mt-3 border-t border-line pt-3">
        <h3 className="mb-1 text-xs font-medium text-faint">{t("memory.panel.versions")}</h3>
        {detail.data === undefined ? (
          <Skeleton className="h-4 w-40" />
        ) : (
          <ul>
            {versions.slice(0, 3).map((version) => (
              <li key={version.version} className="flex h-[30px] items-center gap-3 text-ui">
                <span className="w-10 font-mono text-sm text-faint">v{version.version}</span>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {version.proposalId !== null
                    ? t("memory.versionMerged", { name: version.editedBy?.name ?? t("memory.someone") })
                    : version.version === 1
                      ? t("memory.versionWrote", { name: version.editedBy?.name ?? t("memory.someone") })
                      : t("memory.versionEdited", { name: version.editedBy?.name ?? t("memory.someone") })}
                </span>
                <span className="font-mono text-sm text-faint" suppressHydrationWarning>{formatAge(version.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {note.canArchive && !archived ? (
        <div className="mt-3 border-t border-line pt-3">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button type="button" className="flex items-center gap-1.5 text-ui text-teal hover:underline" data-testid="archive-note">
                <ArchiveIcon aria-hidden className="size-[14px]" />
                {t("memory.archive")}
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent
              title={t("memory.archiveTitle", { title: note.title })}
              body={t("memory.archiveBody")}
              cancel={t("common.cancel")}
              action={t("memory.archiveAction")}
              pending={{ busy: archive.isPending, label: t("memory.archiving"), error: archive.error === null ? null : (errorText(archive.error) ?? null) }}
              onAction={() => { archive.mutate({ noteId: note.noteId }); }}
            />
          </AlertDialog>
          {archive.error === null ? null : <p role="alert" className="mt-1 text-sm text-red">{errorText(archive.error)}</p>}
        </div>
      ) : null}
    </div>
  );
};

/** A scope's Memory page. */
export const MemoryView = ({ memoryRef, projectName, organizationName }: { readonly memoryRef: MemoryScopeRef; readonly projectName: string | null; readonly organizationName: string }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const wide = useWide();
  const isProject = memoryRef.scope === "project";
  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "archived" ? "archived" : isProject && tabParam === "organization" ? "organization" : isProject ? "project" : "notes";
  const [q, setQ] = useState(params.get("q") ?? "");
  const query = useDebounced(q, 250);
  const kindParam = memoryKindSchema.safeParse(params.get("kind"));
  const kind: MemoryKind | null = kindParam.success ? kindParam.data : null;
  const sourceParam = params.get("source");
  const source: SourceFilter | null = SOURCE_FILTERS.find((one) => one === sourceParam) ?? null;
  const alwaysOnly = params.get("always") === "1";
  const listScope = tab === "organization" || !isProject ? { scope: "organization" as const } : { scope: "project" as const, projectId: memoryRef.projectId };
  const notes = useQuery(
    trpc.memory.notes.queryOptions({
      ...listScope,
      ...(query.trim() === "" ? {} : { query: query.trim() }),
      ...(kind === null ? {} : { kinds: [kind] }),
      status: tab === "archived" ? "archived" : "active",
    }),
  );
  // The tab counts: each scope's active notes, and the archived ones of this page's scope.
  const counts = {
    own: useQuery(trpc.memory.notes.queryOptions(isProject ? { scope: "project", projectId: memoryRef.projectId } : { scope: "organization" })),
    organization: useQuery(trpc.memory.notes.queryOptions(isProject ? { scope: "organization" } : skipToken)),
    archived: useQuery(trpc.memory.notes.queryOptions(isProject ? { scope: "project", projectId: memoryRef.projectId, status: "archived" } : { scope: "organization", status: "archived" })),
  };
  const all = notes.data?.notes ?? [];
  const filtered = all.filter((note) => (source === null || sourceFilterOf(note.source.kind) === source) && (!alwaysOnly || note.always));
  const shown = query.trim() === "" ? indexOrder(filtered) : filtered;
  const selectedParam = noteIdSchema.safeParse(params.get("note"));
  const selectedId: NoteId | null = selectedParam.success ? selectedParam.data : (wide ? (shown[0]?.noteId ?? null) : null);
  const selected = shown.find((note) => note.noteId === selectedId) ?? null;
  const base = memoryBase(memoryRef);
  const proposals = counts.own.data?.openProposals ?? 0;
  const filtering = query.trim() !== "" || kind !== null || source !== null || alwaysOnly;

  const go = (change: Readonly<Record<string, string | null>>): void => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(change)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const text = next.toString();
    router.replace(text === "" ? pathname : `${pathname}?${text}`, { scroll: false });
  };
  useEffect(() => {
    if ((params.get("q") ?? "") !== query) go({ q: query, note: null });
    // Only the debounced search writes the URL.
  }, [query]);

  const panel = selected === null ? null : <NotePanel key={selected.noteId} note={selected} base={memoryRef.scope === "project" && selected.scope === "organization" ? "/organization/memory" : base} projectName={projectName} archived={tab === "archived"} />;
  const crumbs = [{ label: isProject ? (projectName ?? "") : organizationName }, { label: t("memory.title") }];
  const tabs = isProject
    ? [
        { id: "project" as const, label: t("memory.tabs.project"), extra: <span className="font-mono text-xs text-faint">{counts.own.data?.notes.length ?? ""}</span> },
        { id: "organization" as const, label: t("memory.tabs.organization"), extra: <span className="font-mono text-xs text-faint">{counts.organization.data?.notes.length ?? ""}</span> },
        { id: "archived" as const, label: t("memory.tabs.archived"), extra: <span className="font-mono text-xs text-faint">{counts.archived.data?.notes.length ?? ""}</span> },
      ]
    : [
        { id: "notes" as const, label: t("memory.tabs.notes"), extra: <span className="font-mono text-xs text-faint">{counts.own.data?.notes.length ?? ""}</span> },
        { id: "archived" as const, label: t("memory.tabs.archived"), extra: <span className="font-mono text-xs text-faint">{counts.archived.data?.notes.length ?? ""}</span> },
      ];
  const newHref = `${base}/new${tab === "organization" ? "?scope=organization" : ""}`;
  const empty = notes.data !== undefined && all.length === 0 && !filtering;

  return (
    <PageFrame
      crumbs={crumbs}
      wideProperties
      actions={
        <span className="flex items-center gap-2">
          <Link href={`${base}/proposals`} className={buttonVariants({ variant: "outline" })} data-testid="proposals-link">
            <LightbulbIcon aria-hidden />
            {t("memory.proposals")}
            {proposals === 0 ? null : <span className="font-mono text-[13px] text-faint">{proposals}</span>}
          </Link>
          <Link href={newHref} className={buttonVariants({ variant: "primary" })}>
            <PlusIcon aria-hidden />
            {t("memory.newNote")}
          </Link>
        </span>
      }
      {...(wide && !empty ? { properties: panel ?? <p className="text-sm text-muted">{t("memory.pick")}</p> } : {})}
    >
      <PageHeading title={t("memory.title")} lede={isProject ? t("memory.ledeProject", { project: projectName ?? "" }) : t("memory.ledeOrganization")} />
      <UnderlineTabs className="mt-4" idPrefix="memory" label={t("memory.tabsLabel")} selected={tab} onSelect={(next) => { go({ tab: next === "project" || next === "notes" ? null : next, note: null }); }} tabs={tabs} />
      {empty ? (
        <div className="mt-10 max-w-[560px]" data-testid="memory-empty">
          <p className="text-[15px] font-semibold text-text">{t("memory.emptyTitle")}</p>
          <p className="mt-2 text-sm text-muted">{t("memory.emptyBody", { scope: isProject && tab !== "organization" ? (projectName ?? "") : organizationName })}</p>
          {proposals === 0 ? null : <Link href={`${base}/proposals`} className="mt-2 inline-block text-sm text-teal hover:underline">{t("memory.proposalsWaiting", { n: proposals })}</Link>}
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label className="relative w-full sm:w-[260px]">
              <span className="sr-only">{t("memory.search")}</span>
              <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-[15px] -translate-y-1/2 text-faint" />
              <Input value={q} onChange={(event) => { setQ(event.target.value); }} placeholder={t("memory.search")} className="h-[30px] pl-8" data-testid="memory-search" />
            </label>
            <Select value={kind ?? "all"} onValueChange={(value) => { go({ kind: value === "all" ? null : value, note: null }); }}>
              <SelectTrigger aria-label={t("memory.kindFilter")} className="h-[30px]" data-testid="memory-kind">
                <span className="text-muted">{t("memory.kindFilter")}:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("memory.all")}</SelectItem>
                {MEMORY_KINDS.map((one) => <SelectItem key={one} value={one}>{kindWord(one)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={source ?? "all"} onValueChange={(value) => { go({ source: value === "all" ? null : value, note: null }); }}>
              <SelectTrigger aria-label={t("memory.sourceFilter")} className="h-[30px]">
                <span className="text-muted">{t("memory.sourceFilter")}:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("memory.all")}</SelectItem>
                {SOURCE_FILTERS.map((one) => <SelectItem key={one} value={one}>{sourceWord(one)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" aria-pressed={alwaysOnly} className={cn("h-[30px]", alwaysOnly && "bg-sel text-text")} onClick={() => { go({ always: alwaysOnly ? null : "1", note: null }); }}>
              <PinIcon aria-hidden />
              {t("memory.alwaysOnly")}
            </Button>
            <span className="ml-auto font-mono text-[13px] text-faint" data-testid="memory-count">{notes.data === undefined ? "" : t("memory.count", { n: shown.length })}</span>
          </div>
          {notes.error === null ? null : <p role="alert" className="mt-6 text-red">{errorText(notes.error)}</p>}
          {notes.data === undefined ? (
            <div className="mt-3.5 space-y-2" aria-busy>{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
          ) : shown.length === 0 ? (
            <p className="mt-6 text-ui text-muted" data-testid="memory-no-match">
              {tab === "archived" && !filtering ? t("memory.nothingArchived") : query.trim() === "" ? t("memory.noMatchFilters") : t("memory.noMatch", { q: query.trim() })}{" "}
              {filtering ? <button type="button" className="text-teal hover:underline" onClick={() => { setQ(""); go({ q: null, kind: null, source: null, always: null }); }}>{t("memory.clearFilters")}</button> : null}
            </p>
          ) : (
            <ul role="listbox" aria-label={t("memory.title")} className="mt-3.5" data-testid="memory-list">
              {shown.map((note) => (
                <NoteRow key={note.noteId} note={note} selected={note.noteId === selected?.noteId} now={notes.dataUpdatedAt} archived={tab === "archived"} onSelect={() => { go({ note: note.noteId }); }} />
              ))}
            </ul>
          )}
        </>
      )}
      {wide ? null : (
        <Sheet open={selected !== null && params.has("note")} onOpenChange={(open) => { if (!open) go({ note: null }); }}>
          <SheetContent side="right" title={t("memory.title")} className="w-[min(380px,100vw)] p-5">{panel}</SheetContent>
        </Sheet>
      )}
    </PageFrame>
  );
};
