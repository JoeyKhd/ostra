"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";

import type { BoardId, RefineDraft, TaskId } from "@ostra/protocol";

import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatClock, formatElapsed } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { DraftList, DraftSubTickets, FieldLabel } from "./draft-field-list";
import type { Editor } from "./draft-field-list";
import { DraftImages, imageTypes } from "./draft-images";
import { DraftPreview } from "./draft-preview";
import { footnote, partlyAppliedText, shownChips, siblingUrl, versionChip, versionWho } from "./draft-words";
import type { DraftView as DraftData } from "./draft-words";

// A refine task's Draft tab (app-targets/m6/refine-draft.md; F-099, milestone 6's ticket 34): the
// version line, the draft's typed fields, each editable, its images, a preview of what the ticket
// will say, and "Update ticket", "Mark ready" or, for a prompt, "Create ticket"; then the applied
// state, with links. A member's edits save themselves a second after typing stops (`drafts.save`),
// as one version of theirs (ticket 34's open point 1). Nothing reaches the tracker before a member
// presses a button. A draft's text is untrusted: it's shown as text, never as HTML.

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The member's edits not yet saved, and the version they're on. */
type Local = { readonly base: number; readonly fields: RefineDraft; readonly rev: number; readonly savedRev: number };

/** What the server takes: no empty item, and no sub-ticket without a title. */
const cleaned = (draft: RefineDraft): RefineDraft => ({
  description: draft.description,
  acceptanceCriteria: draft.acceptanceCriteria.filter((item) => item.trim() !== ""),
  edgeCases: draft.edgeCases.filter((item) => item.trim() !== ""),
  openQuestions: draft.openQuestions.filter((item) => item.trim() !== ""),
  subTickets: draft.subTickets.filter((sub) => sub.title.trim() !== ""),
});

const toBase64 = (file: File): Promise<string> =>
  file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let text = "";
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(text);
  });

const isImageType = (type: string): type is (typeof imageTypes)[number] => imageTypes.some((one) => one === type);

export type DraftBoard = { readonly boardId: BoardId; readonly name: string };

export const DraftView = ({ taskId, meId, needsYou, running, ticket, boards, readyStatusName, newRefineHref, now }: {
  readonly taskId: TaskId;
  readonly meId: string | null;
  /** The task waits on its draft: the amber rule and "Update ticket". */
  readonly needsYou: boolean;
  /** A turn is running: the agent is drafting its next version. */
  readonly running: boolean;
  readonly ticket: { readonly key: string; readonly url: string } | null;
  /** The project's boards, for "Create ticket" on a prompt refine task. */
  readonly boards: readonly DraftBoard[];
  /** The name of the board's ready status, once the board's statuses are read. */
  readonly readyStatusName: string | null;
  /** New task with the kind `refine` and the ticket: "start a new refine task". */
  readonly newRefineHref: string;
  readonly now: number;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<number | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [local, setLocal] = useState<Local | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, string>>(new Map());
  const [uploading, setUploading] = useState<readonly string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // Ticket 17 (F-121): a screenshot "Add to draft" put among the images shows as itself, from its download.
  const attachments = useQuery(trpc.tasks.attachments.queryOptions({ taskId }));
  const pictures = useMemo(
    () => new Map((attachments.data?.attachments ?? []).flatMap((view) => (view.draftImageId === null ? [] : [[view.draftImageId, view.downloadPath] as const]))),
    [attachments.data],
  );
  const task = useQuery({ ...trpc.tasks.get.queryOptions({ taskId }), refetchInterval: (query) => (query.state.data?.sync.some((write) => write.state === "pending") === true ? 2000 : false) });
  const draft = useQuery({
    ...trpc.drafts.get.queryOptions({ taskId, version: shown }),
    // Core writes an applied version in the background: the page follows it. A running turn may hand in the next version.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      const applied = data.versions.some((version) => version.appliedAt !== null);
      return (applied && data.written === null && data.ticket !== null) || running ? 2500 : false;
    },
  });
  const settle = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: trpc.drafts.pathKey() }), queryClient.invalidateQueries({ queryKey: trpc.tasks.get.queryKey({ taskId }) })]);
  };
  const save = useMutation(trpc.drafts.save.mutationOptions());
  const addImage = useMutation(trpc.drafts.addImage.mutationOptions({ onSettled: settle }));
  const removeImage = useMutation(trpc.drafts.removeImage.mutationOptions({ onSettled: settle }));
  const updateTicket = useMutation(trpc.drafts.updateTicket.mutationOptions({ onSettled: settle }));
  const markReady = useMutation(trpc.drafts.markReady.mutationOptions({ onSettled: settle }));
  const retrySync = useMutation(trpc.drafts.retrySync.mutationOptions({ onSettled: settle }));
  const createTicket = useMutation(trpc.drafts.createTicket.mutationOptions({ onSettled: settle }));

  const data: DraftData | undefined = draft.data;
  const latest = data?.latestVersion ?? null;

  // Save a second after typing stops, on the version the edits are on.
  const saving = useRef(false);
  useEffect(() => {
    if (local === null || local.rev === local.savedRev || saving.current) return;
    const sent = local;
    const timer = setTimeout(() => {
      saving.current = true;
      save.mutate(
        { taskId, baseVersion: sent.base, fields: cleaned(sent.fields) },
        {
          onSuccess: (saved) => {
            setLocal((now) => (now === null ? null : { ...now, base: saved.version, savedRev: Math.max(now.savedRev, sent.rev) }));
            setSavedAt(Date.now());
            setShown(null);
          },
          onSettled: () => {
            saving.current = false;
            void settle();
          },
        },
      );
    }, 1000);
    return () => { clearTimeout(timer); };
    // The edits drive the save; `save` and `settle` are read as they are when it fires.
  }, [local, save.isPending, taskId]);

  // Someone else's newer version (the agent's next one): the member's saved edits give way to it.
  useEffect(() => {
    if (local !== null && latest !== null && latest > local.base && local.rev === local.savedRev && !save.isPending) setLocal(null);
  }, [latest, local, save.isPending]);

  if (draft.error !== null) return <p role="alert" className="mt-4 text-red">{errorText(draft.error)}</p>;
  if (data === undefined) {
    return (
      <div className="mt-3.5 space-y-5" aria-busy data-testid="draft-loading">
        <div className="flex gap-2"><Skeleton className="h-6 w-20" /><Skeleton className="h-6 w-20" /></div>
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="space-y-2"><Skeleton className="w-24" /><Skeleton className="h-8 w-full" /></div>
        ))}
      </div>
    );
  }
  if (data.draft === null) return <p className="mt-4 text-ui text-faint" data-testid="draft-empty">{t("draft.none")}</p>;

  const shownDraft = data.draft;
  const shownVersion = data.versions.find((version) => version.version === shownDraft.version);
  const appliedVersion = data.versions.findLast((version) => version.appliedAt !== null);
  const isApplied = appliedVersion !== undefined;
  const isLatest = shownDraft.version === latest;
  const editable = !data.done && !isApplied && isLatest;
  const fields = editable && local !== null ? local.fields : shownDraft.fields;
  const dirty = local !== null && local.rev !== local.savedRev;
  const busy = updateTicket.isPending || markReady.isPending || createTicket.isPending;
  const chosenWho = shownVersion === undefined ? null : versionWho(shownVersion, meId);
  const editor: Editor | null =
    editable && local !== null && shownDraft.source === "agent"
      ? { you: true, name: "" }
      : chosenWho === null || chosenWho.kind === "agent"
        ? null
        : { you: chosenWho.kind === "you", name: chosenWho.kind === "member" ? chosenWho.name : "" };
  const agent = data.agentDraft?.fields ?? null;
  const prompt = data.ticket === null;
  const ticketKey = data.ticket?.key ?? data.written?.ticketKey ?? data.createdTicketKey ?? null;
  const readyAt = appliedVersion?.readyAt ?? data.versions.findLast((version) => version.readyAt !== null)?.readyAt ?? null;
  const moveWrite = task.data?.sync.findLast((write) => write.kind === "move");
  const moved = readyAt !== null && moveWrite?.state === "done";

  const edit = (next: RefineDraft) => {
    setLocal((now) => ({ base: now?.base ?? shownDraft.version, fields: next, rev: (now?.rev ?? 0) + 1, savedRev: now?.savedRev ?? 0 }));
  };
  const retrySave = () => {
    setLocal((now) => (now === null ? null : { ...now, rev: now.rev + 1 }));
  };

  const upload = (files: readonly File[]) => {
    setUploadError(null);
    const room = data.imagesMax - shownDraft.images.length - uploading.length;
    for (const file of files.slice(0, Math.max(0, room))) {
      if (!isImageType(file.type)) {
        setUploadError(t("draft.wrongType", { name: file.name }));
        continue;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        setUploadError(t("draft.tooLarge", { name: file.name }));
        continue;
      }
      const contentType = file.type;
      setUploading((now) => [...now, file.name]);
      void toBase64(file).then((encoded) => {
        addImage.mutate(
          { taskId, name: file.name, contentType, data: encoded },
          {
            onSuccess: ({ imageId }) => {
              setThumbs((now) => new Map([...now, [imageId, URL.createObjectURL(file)]]));
            },
            onError: (error) => { setUploadError(errorText(error)); },
            onSettled: () => { setUploading((now) => now.filter((name) => name !== file.name)); },
          },
        );
      });
    }
    if (files.length > room) setUploadError(t("draft.imagesMax", { max: data.imagesMax }));
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!editable) return;
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      upload(files);
    }
  };
  const onDrop = (event: DragEvent) => {
    if (!editable) return;
    const files = [...event.dataTransfer.files];
    if (files.length > 0) {
      event.preventDefault();
      upload(files);
    }
  };

  const chips = shownChips(data.versions);
  const versionChipOf = (version: (typeof data.versions)[number]) => (
    <button
      key={version.version}
      type="button"
      aria-pressed={version.version === shownDraft.version}
      data-version={version.version}
      onClick={() => {
        setShown(version.version === latest ? null : version.version);
        setMode("edit");
      }}
      className={cn(
        "inline-flex h-6 items-center whitespace-nowrap rounded-sm border px-2 text-sm",
        version.version === shownDraft.version ? "border-line-2 bg-sel font-medium text-text" : "border-line-2 text-muted hover:text-text",
      )}
    >
      {versionChip(version, meId)}
    </button>
  );

  const savedLine = save.error !== null ? (
    <span className="flex items-center gap-2 text-sm text-red" role="alert">
      {t("draft.notSaved", { error: errorText(save.error) ?? t("errors.unknown") })}
      <Button variant="link" className="text-sm" onClick={retrySave}>{t("draft.tryAgain")}</Button>
    </span>
  ) : save.isPending || dirty ? (
    <span className="text-sm text-faint" data-testid="draft-saved">{t("draft.saving")}</span>
  ) : isApplied && appliedVersion.appliedAt !== null ? (
    <span className="text-sm text-faint" data-testid="draft-saved">{t("draft.appliedAgo", { age: formatElapsed(appliedVersion.appliedAt, now) })}</span>
  ) : (
    <span className="text-sm text-faint" data-testid="draft-saved">
      {(() => {
        const at = savedAt ?? shownVersion?.createdAt ?? now;
        return Date.now() - at < 45_000 ? t("draft.savedNow") : t("draft.savedAgo", { age: formatElapsed(at, now) });
      })()}
    </span>
  );

  const appliedBy = appliedVersion?.appliedBy?.name ?? t("taskPage.someone");
  const subTicketKeys = data.written?.subTickets ?? null;
  const parent = data.ticket === null ? null : { key: data.ticket.key, url: data.ticket.url };
  const footer = footnote({
    version: shownDraft.version,
    ticketKey: prompt ? null : (ticket?.key ?? data.ticket?.key ?? null),
    boardName: boards[0]?.name ?? data.board?.name ?? null,
    subTickets: fields.subTickets.length,
    subIssues: data.subIssues,
    readyStatus: !prompt && data.readyStatus ? readyStatusName : null,
  });
  const canMarkReady = data.ticket !== null && data.readyStatus && readyAt === null;

  return (
    <div className="mt-3.5 pb-4" id="task-tab-draft" data-testid="draft-tab" data-version={shownDraft.version} onPaste={onPaste} onDrop={onDrop} onDragOver={(event) => { if (editable) event.preventDefault(); }}>
      {/* 1. The version line. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 min-[1280px]:flex-nowrap">
        <span className="mr-1 text-[12.5px] text-muted">{t("draft.version")}</span>
        {chips.more.length === 0 ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex h-6 items-center gap-1 rounded-sm border border-line-2 px-2 text-sm text-muted hover:text-text">
                {t("draft.more", { n: chips.more.length })} <ChevronDownIcon aria-hidden className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {chips.more.map((version) => (
                <DropdownMenuItem key={version.version} onSelect={() => { setShown(version.version); }}>{versionChip(version, meId)}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {chips.shown.map(versionChipOf)}
        <span className="ml-1">{savedLine}</span>
        {running && !isApplied ? (
          <span className="flex items-center gap-1.5 text-sm text-muted" data-testid="draft-drafting">
            {t("draft.drafting", { n: (latest ?? 0) + 1 })} <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
          </span>
        ) : null}
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => { if (value === "edit" || value === "preview") setMode(value); }}
          aria-label={t("draft.modeLabel")}
          className="h-[26px] w-full min-[1280px]:ml-auto min-[1280px]:w-auto sm:ml-auto sm:w-auto"
        >
          <ToggleGroupItem value="edit" className="text-sm">{editable ? t("draft.edit") : t("draft.fields")}</ToggleGroupItem>
          <ToggleGroupItem value="preview" className="text-sm">{t("draft.preview")}</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* 2. The draft block. */}
      <div className={cn("mt-3 border-l-2 pl-3", needsYou && !isApplied && !data.done ? "border-amber" : "border-line-2")} data-testid="draft-block">
        {isApplied && data.applyFailed !== null && data.written === null ? (
          <p role="alert" className="mb-3 flex flex-wrap items-center gap-x-1.5 text-ui text-text" data-testid="draft-partly">
            <TriangleAlertIcon aria-hidden className="size-[15px] stroke-[1.75] text-red" />
            <span>{partlyAppliedText(appliedVersion.version, ticketKey ?? "", data.applyFailed.part)}</span>
            <Button variant="link" className="h-auto px-0 text-ui" disabled={retrySync.isPending} onClick={() => { retrySync.mutate({ taskId }); }} data-testid="draft-retry-sync">
              {retrySync.isPending ? t("draft.retrying") : t("draft.retrySync")}
            </Button>
          </p>
        ) : isApplied ? (
          <p className="mb-3 flex flex-wrap items-center gap-x-1.5 text-ui text-text" data-testid="draft-applied">
            {data.written === null && !prompt ? (
              <TriangleAlertIcon aria-hidden className="size-[15px] stroke-[1.75] text-faint" />
            ) : (
              <CheckIcon aria-hidden className="size-[15px] stroke-[2] text-green" />
            )}
            <span>{t("draft.appliedLine", { n: appliedVersion.version, key: ticketKey ?? "", name: appliedBy })}</span>
            {appliedVersion.appliedAt === null ? null : <span className="font-mono text-faint">· {formatClock(appliedVersion.appliedAt)}</span>}
            {moved ? <span className="text-muted">· {t("draft.movedLower", { status: readyStatusName ?? "" })}</span> : null}
          </p>
        ) : null}
        {!isLatest && !isApplied ? (
          <p className="mb-3 text-[12.5px] text-muted" data-testid="draft-older">{t("draft.older")}</p>
        ) : null}
        {mode === "preview" && data.preview !== null && isLatest ? (
          <DraftPreview preview={data.preview} criteriaInDescription={data.preview.acceptanceCriteria === null} criteriaCount={fields.acceptanceCriteria.length} />
        ) : (
          <div className="space-y-[18px]">
            <section>
              <FieldLabel label={t("draft.description")} {...(editable ? { htmlFor: "draft-description" } : {})} />
              {editable ? (
                <Textarea
                  id="draft-description"
                  className="min-h-[76px] max-h-[264px] resize-none text-ui leading-[1.5] [field-sizing:content]"
                  value={fields.description}
                  onChange={(event) => { edit({ ...fields, description: event.target.value }); }}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words text-body text-text" data-testid="draft-description">{fields.description}</p>
              )}
            </section>
            <DraftList field="acceptanceCriteria" label={t("draft.criteria")} add="draft.addCriterion" items={fields.acceptanceCriteria} agent={agent?.acceptanceCriteria ?? null} editor={editor} editable={editable} onChange={(items) => { edit({ ...fields, acceptanceCriteria: [...items] }); }} />
            <DraftList field="edgeCases" label={t("draft.edgeCases")} add="draft.addEdgeCase" items={fields.edgeCases} agent={agent?.edgeCases ?? null} editor={editor} editable={editable} onChange={(items) => { edit({ ...fields, edgeCases: [...items] }); }} />
            <DraftList field="openQuestions" label={t("draft.questions")} add="draft.addQuestion" items={fields.openQuestions} agent={agent?.openQuestions ?? null} editor={editor} editable={editable} onChange={(items) => { edit({ ...fields, openQuestions: [...items] }); }} />
            <DraftSubTickets
              items={fields.subTickets}
              editable={editable}
              onChange={(items) => { edit({ ...fields, subTickets: [...items] }); }}
              applied={subTicketKeys === null ? null : subTicketKeys.map((key) => ({ key, url: siblingUrl(parent, key) }))}
            />
            <DraftImages
              images={shownDraft.images}
              max={data.imagesMax}
              editable={editable}
              applied={isApplied}
              thumbs={pictures.size === 0 ? thumbs : new Map([...pictures, ...thumbs])}
              uploading={uploading}
              error={uploadError}
              onUpload={upload}
              onRemove={(imageId) => { removeImage.mutate({ taskId, imageId }); }}
            />
          </div>
        )}

        {/* The buttons, or what's left once applied. */}
        {running && editable ? <p className="mt-4 text-[12.5px] text-muted">{t("draft.draftingNote")}</p> : null}
        {isApplied || data.done ? (
          <div className="mt-4">
            {canMarkReady ? (
              <div className="mb-2 flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => { markReady.mutate({ taskId }); }} data-action="mark-ready">
                  {markReady.isPending ? <><LoaderCircleIcon aria-hidden className="animate-spin" /> {t("draft.markingReady")}</> : t("draft.markReady")}
                </Button>
              </div>
            ) : null}
            {isApplied ? (
              <p className="text-sm text-muted">
                {t("draft.afterApplyBefore")} <Link href={newRefineHref} className="text-teal hover:underline">{t("draft.afterApplyLink")}</Link> {t("draft.afterApplyAfter")}
              </p>
            ) : (
              <p className="text-sm text-muted">{t("draft.neverApplied")}</p>
            )}
          </div>
        ) : !isLatest ? (
          <div className="mt-4">
            <Button variant="link" className="text-[12.5px]" onClick={() => { setLocal({ base: latest ?? shownDraft.version, fields: shownDraft.fields, rev: 1, savedRev: 0 }); setShown(null); }}>
              {t("draft.editFrom", { n: shownDraft.version })}
            </Button>
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {prompt ? (
                boards.length > 1 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant={needsYou ? "amber" : "primary"} disabled={busy || dirty || save.isPending} data-action="create-ticket">
                        {createTicket.isPending ? t("draft.creating") : t("draft.createTicket")} <ChevronDownIcon aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {boards.map((board) => (
                        <DropdownMenuItem key={board.boardId} onSelect={() => { createTicket.mutate({ taskId, version: shownDraft.version, boardId: board.boardId }); }}>
                          {t("draft.createOn", { board: board.name })}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <Button
                    variant={needsYou ? "amber" : "primary"}
                    disabled={busy || dirty || save.isPending || boards[0] === undefined}
                    data-action="create-ticket"
                    onClick={() => { const board = boards[0]; if (board !== undefined) createTicket.mutate({ taskId, version: shownDraft.version, boardId: board.boardId }); }}
                  >
                    {createTicket.isPending ? <><LoaderCircleIcon aria-hidden className="animate-spin" /> {t("draft.creating")}</> : t("draft.createTicket")}
                  </Button>
                )
              ) : (
                <Button variant={needsYou ? "amber" : "primary"} disabled={busy || dirty || save.isPending} data-action="update-ticket" onClick={() => { updateTicket.mutate({ taskId, version: shownDraft.version }); }}>
                  {updateTicket.isPending ? <><LoaderCircleIcon aria-hidden className="animate-spin" /> {t("draft.updating")}</> : t("draft.updateTicket")}
                </Button>
              )}
              {canMarkReady ? (
                <Button disabled={busy || dirty} onClick={() => { markReady.mutate({ taskId }); }} data-action="mark-ready">
                  {markReady.isPending ? <><LoaderCircleIcon aria-hidden className="animate-spin" /> {t("draft.markingReady")}</> : t("draft.markReady")}
                </Button>
              ) : null}
              {shownDraft.source === "member" && data.agentDraft !== null ? (
                <AlertDialog open={discarding} onOpenChange={setDiscarding}>
                  <Button variant="ghost" onClick={() => { setDiscarding(true); }}>{t("draft.discard")}</Button>
                  <AlertDialogContent
                    title={t("draft.discardTitle")}
                    body={t("draft.discardBody", { n: data.agentDraft.version })}
                    cancel={t("draft.cancel")}
                    action={t("draft.discardConfirm")}
                    onAction={() => {
                      const agentFields = data.agentDraft?.fields;
                      if (agentFields !== undefined) edit(agentFields);
                      setDiscarding(false);
                    }}
                  />
                </AlertDialog>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-faint" data-testid="draft-footnote">{footer}</p>
          </>
        )}
        {[updateTicket.error, markReady.error, createTicket.error].map((error, index) =>
          error === null ? null : <p key={index} role="alert" className="mt-2 text-sm text-red">{errorText(error)}</p>,
        )}
      </div>
      {isApplied && data.written !== null ? (
        <p role="status" className="mt-3 text-sm text-muted" data-testid="draft-written">
          {t("draft.updated", { key: data.written.ticketKey })}{" "}
          {data.written.subTickets.length === 0 ? null : plural(data.written.subTickets.length, "draft.subIssuesCreated.one", "draft.subIssuesCreated.other")}
        </p>
      ) : null}
    </div>
  );
};
