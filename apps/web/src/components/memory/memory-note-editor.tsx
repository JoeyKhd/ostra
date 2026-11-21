"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, Building2Icon, CircleAlertIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { MemoryKind, NoteId, ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropRow } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { KindIcon } from "./memory-parts";
import { MEMORY_KINDS, NOTE_BODY_MAX_BYTES, bodySize, conflictOf, kindWord, memoryBase, secretFoundOf, sourceFilterOf, sourceWord, usedText, versionSourceParts } from "./memory-words";
import type { MemoryScopeRef } from "./memory-words";

// A memory note (F-109; app-targets/m4/memory-note.md): write one, or edit one at the version the
// member opened. A save that holds a credential is refused with the kind named, never the value; a
// save from a stale version says who saved first and keeps the member's text in the editor.

type Draft = { readonly title: string; readonly body: string; readonly kind: MemoryKind; readonly always: boolean };
type Version = RouterOutputs["memory"]["note"]["versions"][number];

/** `1.4` KiB, or `0.2`: the always notes' share of the block's 8 KiB, one decimal. */
const kibText = (bytes: number): string => (Math.round((bytes / 1024) * 10) / 10).toString();

/** A version's What column (memory-note.md, Versions): how it came to be. */
const versionWhat = (version: Version): string =>
  version.proposalId !== null
    ? version.version === 1
      ? t("memory.note.whatApproved")
      : t("memory.note.whatMerged")
    : version.version === 1
      ? t("memory.note.whatWritten")
      : t("memory.note.whatEdited");

const sameDraft = (x: Draft, y: Draft): boolean => x.title === y.title && x.body === y.body && x.kind === y.kind && x.always === y.always;

/** The refusal's words, under the editor: a credential's kind, or who saved first. */
const Refusal = ({ message, memoryRef, projectName }: { readonly message: string; readonly memoryRef: MemoryScopeRef; readonly projectName: string | null }) => {
  const found = secretFoundOf(message);
  const conflict = conflictOf(message);
  if (found !== null) {
    const control = found === "a model-control token";
    return (
      <div role="alert" className="mt-3 flex items-start gap-2 text-sm" data-testid="note-secret">
        <CircleAlertIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 text-red" />
        <span>
          <span className="block text-red">{control ? t("memory.note.controlFound") : t("memory.note.secretFound", { found })}</span>
          <span className="block text-muted">
            {t("memory.note.nothingSaved")}
            {control || memoryRef.scope === "organization" ? null : (
              <>
                {" "}
                {t("memory.note.belongsIn")}{" "}
                <Link href={`/projects/${memoryRef.projectId}/environment#secrets`} className="text-teal hover:underline">
                  {t("memory.note.environmentSecrets", { project: projectName ?? "" })}
                </Link>
                .
              </>
            )}
          </span>
        </span>
      </div>
    );
  }
  if (conflict !== null) {
    return (
      <p role="alert" className="mt-3 text-sm text-red" data-testid="note-conflict">
        {t("memory.note.conflict", { name: conflict.name, version: conflict.version })}{" "}
        <button type="button" className="text-teal hover:underline" onClick={() => { window.location.reload(); }}>
          {t("memory.note.reload")}
        </button>
      </p>
    );
  }
  return <p role="alert" className="mt-3 text-sm text-red">{message}</p>;
};

/** The note editor: a new note (`noteId` null) or an existing one. */
export const MemoryNoteEditor = ({ memoryRef, noteId, projectName, organizationName, startScope }: {
  readonly memoryRef: MemoryScopeRef;
  readonly noteId: NoteId | null;
  readonly projectName: string | null;
  readonly organizationName: string;
  /** A new note from the project page's Organization tab starts in the organization's scope. */
  readonly startScope?: "organization" | "project";
}) => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const note = useQuery(trpc.memory.note.queryOptions(noteId === null ? skipToken : { noteId }));
  const loaded: Draft | null = note.data === undefined ? null : { title: note.data.title, body: note.data.body, kind: note.data.kind, always: note.data.always };
  const empty: Draft = { title: "", body: "", kind: "convention", always: false };
  const [draft, setDraft] = useState<Draft | null>(noteId === null ? empty : null);
  // The scope's "always" notes in the block, counted by the domain's index builder (memory-note.md, Always).
  const index = useQuery(trpc.memory.index.queryOptions(memoryRef.scope === "project" ? { scope: "project", projectId: memoryRef.projectId } : { scope: "organization" }));
  /** The version whose text is open under its row (one at a time). */
  const [opened, setOpened] = useState<number | null>(null);
  const [scope, setScope] = useState<"organization" | "project">(startScope ?? memoryRef.scope);
  // The version the member opened: a later save names it, so a save after someone else's is refused.
  const [openedVersion, setOpenedVersion] = useState<number | null>(null);
  useEffect(() => {
    if (loaded !== null && draft === null) {
      setDraft(loaded);
      setOpenedVersion(note.data?.version ?? null);
    }
  }, [loaded, draft, note.data?.version]);
  const save = useMutation(
    trpc.memory.save.mutationOptions({
      onSuccess: async (saved) => {
        await queryClient.invalidateQueries({ queryKey: trpc.memory.pathKey() });
        setOpenedVersion(saved.version);
        if (noteId === null) router.push(`${memoryBase(memoryRef)}/${saved.noteId}?saved=1`);
      },
    }),
  );
  const archive = useMutation(trpc.memory.archive.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.memory.pathKey() }) }));
  const current = draft ?? empty;
  const size = bodySize(current.body);
  const archived = note.data?.status === "archived";
  const changed = noteId === null ? current.title.trim() !== "" && current.body.trim() !== "" : loaded !== null && !sameDraft(current, loaded);
  const canSave = changed && size.bytes <= NOTE_BODY_MAX_BYTES && current.title.trim() !== "" && current.body.trim() !== "" && !save.isPending && !archived;
  const noteScope = note.data?.scope ?? scope;
  const projectId: ProjectId | null = noteScope === "project" && memoryRef.scope === "project" ? memoryRef.projectId : (note.data?.projectId ?? null);
  const submit = (): void => {
    if (!canSave) return;
    save.mutate({
      noteId,
      expectedVersion: noteId === null ? null : (openedVersion ?? note.data?.version ?? null),
      scope: noteScope,
      projectId: noteScope === "project" ? projectId : null,
      title: current.title.trim(),
      body: current.body.trim(),
      kind: current.kind,
      always: current.always,
    });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  });

  const scopeName = memoryRef.scope === "project" ? (projectName ?? "") : organizationName;
  const title = noteId === null ? (current.title.trim() === "" ? t("memory.note.newTitle") : current.title) : (note.data?.title ?? "");
  const crumbs = [
    ...(memoryRef.scope === "project" ? [{ label: organizationName }, { label: projectName ?? "", href: `/projects/${memoryRef.projectId}` }] : [{ label: organizationName }]),
    { label: t("memory.title"), href: memoryBase(memoryRef) },
    { label: title },
  ];
  const now = Date.now();
  const saved = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).has("saved") && !changed;

  const panel =
    noteId !== null && note.data === undefined ? (
      <div className="space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-48" /></div>
    ) : (
      <div data-testid="note-editor-panel">
        <h3 className="mb-1 text-xs font-medium text-faint">{t("memory.note.noteGroup")}</h3>
        <PropRow label={t("memory.note.status")} labelWidth={116}>
          {note.data === undefined ? (
            <Status tone="grey" className="text-muted">{t("memory.note.notSaved")}</Status>
          ) : archived ? (
            <Status tone="grey">{t("memory.note.archived")}</Status>
          ) : (
            <Status tone="green">{t("memory.note.active")}</Status>
          )}
        </PropRow>
        {note.data === undefined ? null : (
          <>
            <PropRow label={t("memory.panel.version")} labelWidth={116}><span className="font-mono">{note.data.version}</span></PropRow>
            <PropRow label={t("memory.panel.lastUsed")} labelWidth={116}>
              {note.data.lastUsedAt === null ? <span className="text-muted">{t("memory.never")}</span> : <span className="font-mono" suppressHydrationWarning>{formatAge(note.data.lastUsedAt, now)}</span>}
            </PropRow>
            <PropRow label={t("memory.panel.used")} labelWidth={116}>
              {note.data.useCount === 0 ? <span className="text-faint">–</span> : <span data-testid="note-used">{usedText(note.data.useCount, note.data.usedInTasks)}</span>}
            </PropRow>
          </>
        )}
        <div className="mt-3 border-t border-line pt-3">
          <h3 className="mb-1 text-xs font-medium text-faint">{t("memory.panel.always")}</h3>
          <div className="flex items-center justify-between gap-3">
            <span id="note-always-label" className="text-ui text-text">{t("memory.note.alwaysWhole")}</span>
            <Switch aria-labelledby="note-always-label" checked={current.always} disabled={archived} onCheckedChange={(always) => { setDraft({ ...current, always }); }} data-testid="note-editor-always" />
          </div>
          <p className="mt-1 text-sm text-faint">
            {t("memory.note.alwaysHelp")}
            {index.data === undefined ? null : ` ${t("memory.note.alwaysUse", { scope: noteScope === "project" ? scopeName : organizationName, used: kibText(index.data.alwaysBytes) })}`}
          </p>
        </div>
        {note.data === undefined ? null : (
          <div className="mt-3 border-t border-line pt-3" data-testid="note-source">
            <h3 className="mb-1 text-xs font-medium text-faint">{t("memory.panel.source")}</h3>
            <PropRow label={t("memory.note.from")} labelWidth={116}>
              {note.data.source.kind === "member" ? t("memory.note.writtenBy", { name: note.data.author?.name ?? t("memory.someone") }) : sourceWord(sourceFilterOf(note.data.source.kind))}
            </PropRow>
            {note.data.source.taskId === null ? null : (
              <PropRow label={t("memory.note.task")} labelWidth={116}>
                <Link href={`/tasks/${note.data.source.taskId}`} className="font-mono text-teal hover:underline">{note.data.source.taskId.slice(-7)}</Link>
              </PropRow>
            )}
          </div>
        )}
        {note.data === undefined || !note.data.canArchive || archived ? null : (
          <div className="mt-3 border-t border-line pt-3">
            <h3 className="mb-1 text-xs font-medium text-faint">{t("memory.note.archiveGroup")}</h3>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" className="-ml-2 h-[30px] text-muted hover:text-red">
                  <ArchiveIcon aria-hidden className="stroke-[1.75]" />
                  {t("memory.archive")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent
                title={t("memory.archiveTitle", { title: note.data.title })}
                body={t("memory.archiveBody")}
                cancel={t("common.cancel")}
                action={t("memory.archiveAction")}
                pending={{ busy: archive.isPending, label: t("memory.archiving"), error: archive.error === null ? null : (errorText(archive.error) ?? null) }}
                onAction={() => { archive.mutate({ noteId: note.data.noteId }); }}
              />
            </AlertDialog>
            <p className="text-sm text-faint">{t("memory.note.archiveHelp")}</p>
          </div>
        )}
      </div>
    );

  return (
    <PageFrame
      crumbs={crumbs}
      wideProperties
      properties={panel}
      actions={
        archived ? null : (
          <span className="flex items-center gap-2">
            {changed && noteId !== null ? (
              <Button variant="ghost" onClick={() => { setDraft(loaded); save.reset(); }}>{t("memory.note.discard")}</Button>
            ) : null}
            <Button variant="primary" disabled={!canSave} onClick={submit} data-testid="save-note">
              {save.isPending ? t("memory.note.saving") : t("memory.note.save")}
            </Button>
          </span>
        )
      }
    >
      <div className="max-w-[760px]">
        <PageHeading
          eyebrow={
            <span className="font-mono">
              {noteId === null ? t("memory.note.eyebrowNew") : note.data === undefined ? "" : t("memory.note.eyebrow", { version: note.data.version, age: formatAge(note.data.updatedAt, now) })}
            </span>
          }
          title={title}
          lede={t("memory.note.lede", { scope: noteScope === "project" ? scopeName : organizationName })}
        />
        {saved ? <p className="mt-2 text-sm text-muted" role="status">{t("memory.note.savedAs", { version: note.data?.version ?? 1 })}</p> : null}
        {draft === null ? (
          <div className="mt-6 space-y-3"><Skeleton className="h-8 w-full" /><Skeleton className="h-32 w-full" /></div>
        ) : (
          <form
            className="mt-6"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <h2 className="mb-2 text-body font-semibold text-text">{t("memory.note.noteGroup")}</h2>
            <div className="grid gap-3 sm:grid-cols-[1fr_200px_200px]">
              <Field id="note-title" label={t("memory.note.titleLabel")}>
                <Input id="note-title" value={current.title} readOnly={archived} maxLength={120} onChange={(event) => { setDraft({ ...current, title: event.target.value }); }} />
              </Field>
              <Field id="note-kind" label={t("memory.note.kindLabel")}>
                <Select value={current.kind} disabled={archived} onValueChange={(value) => { const kind = MEMORY_KINDS.find((one) => one === value); if (kind !== undefined) setDraft({ ...current, kind }); }}>
                  <SelectTrigger id="note-kind" className="w-full"><KindIcon kind={current.kind} className="size-[15px]" /><SelectValue /></SelectTrigger>
                  <SelectContent>{MEMORY_KINDS.map((one) => <SelectItem key={one} value={one}>{kindWord(one)}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field id="note-scope" label={t("memory.note.scopeLabel")}>
                {noteId !== null || memoryRef.scope === "organization" ? (
                  // A note keeps its scope: the same box, read-only, with no chevron (memory-note.md).
                  <span id="note-scope" className="flex h-[34px] items-center gap-2 rounded-[7px] border border-line-2 bg-surface px-3 text-ui text-text">
                    {noteScope === "project" && projectId !== null ? (
                      <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(projectId) }} />
                    ) : (
                      <Building2Icon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
                    )}
                    <span className="truncate">{noteScope === "project" ? (projectName ?? "") : t("memory.tabs.organization")}</span>
                  </span>
                ) : (
                <Select value={noteScope} onValueChange={(value) => { setScope(value === "organization" ? "organization" : "project"); }}>
                  <SelectTrigger id="note-scope" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project">{projectName ?? ""}</SelectItem>
                    <SelectItem value="organization">{organizationName}</SelectItem>
                  </SelectContent>
                </Select>
                )}
              </Field>
            </div>
            <h2 className="mb-2 mt-5 text-body font-semibold text-text">
              <label htmlFor="note-body">{t("memory.note.bodyLabel")}</label>
            </h2>
            <Textarea
              id="note-body"
              value={current.body}
              readOnly={archived}
              rows={5}
              className={cn("font-mono text-[14px] leading-[1.7]", save.error !== null && secretFoundOf(save.error.message) !== null && "border-red")}
              onChange={(event) => { setDraft({ ...current, body: event.target.value }); }}
            />
            <p className={cn("mt-1 text-right font-mono text-xs", size.bytes > NOTE_BODY_MAX_BYTES ? "text-red" : "text-faint")}>{size.text}</p>
            {save.error === null ? null : <Refusal message={save.error.message || (errorText(save.error) ?? "")} memoryRef={memoryRef} projectName={projectName} />}
          </form>
        )}
        {note.data === undefined ? null : (
          <section className="mt-7" data-testid="note-versions">
            <h2 className="flex items-baseline gap-2 text-body font-semibold text-text">
              {t("memory.panel.versions")} <span className="font-mono text-sm font-normal text-faint">{note.data.versions.length}</span>
              <span className="text-sm font-normal text-muted">{t("memory.note.versionsHelp")}</span>
            </h2>
            <ul className="mt-2.5 border-t border-line">
              {note.data.versions.map((version) => (
                <li key={version.version} className="border-b border-line">
                  <div className="grid min-h-10 grid-cols-[48px_minmax(0,1fr)_64px_40px] items-center gap-x-3 text-ui sm:grid-cols-[48px_180px_120px_minmax(0,1fr)_64px_40px]">
                    <span className="font-mono text-[13px] text-faint">v{version.version}</span>
                    <span className="truncate text-text">{versionWhat(version)}</span>
                    <span className="hidden truncate text-muted sm:inline">{version.editedBy?.name ?? t("memory.someone")}</span>
                    {/* Source: where a version from a proposal came from, the task's key a link (memory-note.md). */}
                    {/* The words give way before the key, which stays whole. */}
                    <span className="hidden min-w-0 items-center whitespace-pre text-sm text-muted sm:flex" data-testid="version-source">
                      {version.source === null
                        ? null
                        : versionSourceParts(version.source).map((part, i) =>
                            "task" in part ? (
                              <Link key={`task-${String(i)}`} href={`/tasks/${part.task.taskId}`} className="shrink-0 font-mono text-teal hover:underline">{part.task.key}</Link>
                            ) : (
                              <span key={`text-${String(i)}`} className="min-w-0 truncate">{part.text}</span>
                            ),
                          )}
                    </span>
                    <span className="text-right font-mono text-xs text-faint" suppressHydrationWarning>{formatAge(version.at, now)}</span>
                    <button type="button" aria-expanded={opened === version.version} className="text-right text-teal hover:underline" onClick={() => { setOpened(opened === version.version ? null : version.version); }}>
                      {opened === version.version ? t("memory.note.hide") : t("memory.note.view")}
                    </button>
                  </div>
                  {opened === version.version ? (
                    <div className="mb-3 border-l-2 border-line-2 pl-3" data-testid="note-version-text">
                      <p className="text-ui text-text">{version.title}</p>
                      <p className="mt-1 flex gap-1.5">
                        <span className="rounded-md border border-line-2 px-1.5 text-xs text-muted">{kindWord(version.kind)}</span>
                        {version.always ? <span className="rounded-md border border-line-2 px-1.5 text-xs text-muted">{t("memory.note.alwaysChip")}</span> : null}
                      </p>
                      <p className="mt-1.5 whitespace-pre-wrap font-mono text-[13px] text-muted">{version.body}</p>
                      {archived ? null : (
                        <button type="button" className="mt-1.5 text-sm text-teal hover:underline" onClick={() => { setDraft({ title: version.title, body: version.body, kind: version.kind, always: version.always }); }}>
                          {t("memory.note.useText")}
                        </button>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {changed ? <p className="mt-2 text-sm text-faint">{t("memory.note.unsaved", { version: note.data.version + 1 })}</p> : null}
          </section>
        )}
        <p className="mt-6 flex items-start gap-2 text-sm text-faint">
          <ShieldCheckIcon aria-hidden className="mt-0.5 size-[14px] shrink-0" />
          {t("memory.note.scanned", { scope: noteScope === "project" ? scopeName : organizationName })}
        </p>
      </div>
    </PageFrame>
  );
};
