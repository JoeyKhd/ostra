"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlertIcon, Trash2Icon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { appProcessSchema } from "@ostra/domain/app-processes";
import type { ProjectId, RepoId } from "@ostra/protocol";

import { AppLogTail } from "@/components/tasks/app-log-tail";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import type { DeclaredProcess, FoundProcess, KeptProcess } from "./app-process-row";
import { addressesNote, emptyForm, formOf, issuesFromRules, listWith, processFormIssues, processOf } from "./environment-app-words";
import type { ProcessField, ProcessForm, ProcessIssues, ReadyKind, SavedProcess } from "./environment-app-words";

// A process's editor sheet (environment-app-processes.md, "The editor sheet"): a right sheet, 440
// wide, in its modes: edit a saved process, a new one, review one kept from a task (Accept), or add
// one detection found. It checks the process as the API will (`processFormIssues`), shows a refusal
// on blur or on save, never while typing, and saves the whole list in its start order, the primary
// moved here when this one is. A member reads it, with `Close`.

export type SheetMode =
  | { readonly kind: "edit"; readonly process: DeclaredProcess }
  | { readonly kind: "new" }
  | { readonly kind: "keep"; readonly kept: KeptProcess }
  | { readonly kind: "add"; readonly found: FoundProcess };

/** The sheet's first form, by its mode. */
const initialForm = (mode: SheetMode, firstRepo: string, hasPrimary: boolean): ProcessForm => {
  switch (mode.kind) {
    case "edit":
      return formOf(mode.process);
    case "new":
      return emptyForm(firstRepo, !hasPrimary);
    case "keep":
      // "Keep it" couldn't know the command the agent started it with: the admin names it.
      return { ...formOf(mode.kept.process), command: mode.kept.waitsForCommand ? "" : mode.kept.process.command };
    case "add": {
      const found = mode.found.process;
      return {
        ...emptyForm(mode.found.repoId, found.primary && !hasPrimary),
        name: found.name,
        label: found.label,
        folder: found.folder,
        command: found.command ?? "",
        port: String(found.port),
        readyKind: found.ready.kind,
        readyPath: found.ready.kind === "http" ? found.ready.path : "/",
      };
    }
    default:
      return mode satisfies never;
  }
};

const Hairline = () => <div className="my-3.5 h-px bg-line" />;

/** A label over its control, the help or the refusal under it. */
const SheetField = ({ id, label, help, error, className, children }: { readonly id: string; readonly label: string; readonly help?: ReactNode; readonly error?: string | undefined; readonly className?: string; readonly children: ReactNode }) => (
  <div className={cn("mb-[13px]", className)}>
    <label htmlFor={id} className="mb-1.5 block text-ui font-medium text-muted">{label}</label>
    {children}
    {error === undefined ? null : (
      <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-red">
        <CircleAlertIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
        {error}
      </p>
    )}
    {help === undefined ? null : <p className="mt-1.5 text-[12.5px] text-faint">{help}</p>}
  </div>
);

const inputClass = "h-8 font-mono text-ui";

export const AppProcessSheet = ({ projectId, mode, processes, repos, serviceCount, canEdit, onClose, onDone }: {
  readonly projectId: ProjectId;
  readonly mode: SheetMode;
  /** The saved list, in its start order. */
  readonly processes: readonly SavedProcess[];
  readonly repos: readonly { readonly repoId: RepoId; readonly fullName: string }[];
  readonly serviceCount: number;
  readonly canEdit: boolean;
  readonly onClose: () => void;
  /** After a save, an accept or a dismissal: what to say on the page. */
  readonly onDone: (said: string | null) => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = useId();
  const editing = mode.kind === "edit" ? mode.process.name : null;
  const others = processes.filter((process) => process.name !== editing);
  const primaryNow = processes.find((process) => process.primary && process.name !== editing) ?? null;
  const [form, setForm] = useState<ProcessForm>(() => initialForm(mode, repos[0]?.repoId ?? "", processes.some((process) => process.primary)));
  const [initial] = useState(form);
  const [touched, setTouched] = useState<ReadonlySet<ProcessField>>(new Set());
  const [refused, setRefused] = useState<ProcessIssues>({});
  const [leaving, setLeaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const repoIds = repos.map((repo) => repo.repoId);
  const issues = processFormIssues(form, others, repoIds);
  const shown = (field: ProcessField): string | undefined => refused[field] ?? (touched.has(field) ? issues[field] : undefined);
  const anyShown = (["name", "label", "repo", "folder", "command", "port", "ready"] as const).some((field) => shown(field) !== undefined);
  const changed = JSON.stringify(form) !== JSON.stringify(initial);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.environments.appProcesses.list.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.environments.appProcesses.detected.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.environments.screenshots.get.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.environments.proposal.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.environments.onboarding.queryKey({ projectId }) }),
    ]);
  };
  const save = useMutation(trpc.environments.appProcesses.save.mutationOptions());
  const acceptKept = useMutation(trpc.environments.appProcesses.acceptKept.mutationOptions());
  const decide = useMutation(trpc.environments.decideProposal.mutationOptions());
  const pending = save.isPending || acceptKept.isPending || decide.isPending;
  const error = save.error ?? acceptKept.error ?? decide.error;

  const set = (change: Partial<ProcessForm>) => {
    setForm((now) => ({ ...now, ...change }));
    // A refusal the server gave goes once the field changes; a typed one waits for the blur.
    setRefused((now) => {
      const changed = new Set<string | null>(
        Object.keys(change).map((key): ProcessField | null =>
          key === "repoId" ? "repo" : key === "readyKind" || key === "readyPath" || key === "readyCommand" ? "ready" : key === "name" || key === "label" || key === "folder" || key === "command" || key === "port" ? key : null,
        ),
      );
      return Object.fromEntries(Object.entries(now).filter(([field]) => !changed.has(field)));
    });
  };
  const blur = (field: ProcessField) => () => { setTouched((now) => new Set([...now, field])); };

  const submit = () => {
    if (!canEdit || pending) return;
    setTouched(new Set(["name", "label", "repo", "folder", "command", "port", "ready"]));
    const parsed = appProcessSchema.safeParse(processOf(form));
    if (Object.keys(issues).length > 0 || !parsed.success) return;
    const process: SavedProcess = parsed.data;
    if (mode.kind === "keep") {
      acceptKept.mutate(
        { projectId, proposalId: mode.kept.proposalId, process },
        {
          onSuccess: () => {
            void invalidate().then(() => { onDone(t("environment.app.acceptedSaid", { name: process.name })); });
          },
        },
      );
      return;
    }
    save.mutate(
      { projectId, processes: listWith(processes, process, editing) },
      {
        onSuccess: (result) => {
          if (!result.ok) {
            setRefused(issuesFromRules(result.issues));
            return;
          }
          void invalidate().then(() => { onDone(null); });
        },
      },
    );
  };
  const dismiss = () => {
    if (mode.kind !== "keep") return;
    decide.mutate(
      { proposalId: mode.kept.proposalId, decision: "reject", edited: null, reason: null },
      { onSuccess: () => { void invalidate().then(() => { onDone(null); }); } },
    );
  };
  const remove = () => {
    if (editing === null) return;
    save.mutate({ projectId, processes: others }, { onSuccess: () => { void invalidate().then(() => { onDone(null); }); } });
  };

  const title =
    mode.kind === "edit" ? t("environment.app.sheet.edit") : mode.kind === "new" ? t("environment.app.sheet.new") : mode.kind === "keep" ? t("environment.app.sheet.keep") : t("environment.app.sheet.add");
  const titleName = mode.kind === "edit" ? mode.process.name : mode.kind === "keep" ? mode.kept.process.name : mode.kind === "add" ? mode.found.process.name : null;
  const readyHelp = form.readyKind === "command" ? t("environment.app.sheet.readyCommandHelp") : form.readyKind === "http" ? t("environment.app.sheet.readyHttpHelp") : t("environment.app.sheet.readyPortHelp");
  const lastBox = mode.kind === "edit" ? mode.process.lastBox : null;
  const failed = lastBox !== null && (lastBox.state === "exited" || lastBox.state === "failed") ? lastBox : null;
  const logName = form.name.trim() === "" ? "<name>" : form.name.trim();

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-(--scrim)" />
      <Dialog.Content
        aria-describedby={undefined}
        data-testid="app-process-sheet"
        className="fixed inset-y-0 right-0 z-50 flex w-[min(440px,100vw)] flex-col border-l border-line-2 bg-bg shadow-(--shadow-palette) focus:outline-none max-sm:inset-x-0 max-sm:top-auto max-sm:h-[100dvh] max-sm:w-full max-sm:border-l-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => { document.getElementById(`${id}-name`)?.focus(); });
        }}
        onEscapeKeyDown={(event) => {
          if (changed && canEdit) {
            event.preventDefault();
            setLeaving(true);
          }
        }}
        onInteractOutside={(event) => {
          if (changed && canEdit) {
            event.preventDefault();
            setLeaving(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <div className="flex h-[54px] shrink-0 items-center gap-2 border-b border-line px-5">
          <Dialog.Title className="text-[16px] font-semibold text-text">
            {title}
            {titleName === null ? null : <>{" "}<span className="font-mono font-medium">{titleName}</span></>}
          </Dialog.Title>
          <Dialog.Close className="ml-auto rounded-sm p-1 text-faint hover:text-text" aria-label={t("common.close")}>
            <XIcon aria-hidden className="size-4" />
          </Dialog.Close>
        </div>
        <form
          id={`${id}-form`}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {failed === null ? null : (
            <div className="mb-3.5 border-l-2 border-red pl-3" data-testid="sheet-failed">
              <p className="text-ui text-text">
                {failed.reason === "ready-timeout" ? t("environment.app.sheet.didntAnswer") : failed.exitCode === null ? t("environment.app.last.failed") : t("environment.app.sheet.exited", { code: failed.exitCode })}
              </p>
              {failed.logBlobId === null ? null : <AppLogTail taskId={failed.taskId} blobId={failed.logBlobId} label={t("environment.app.log.showTheLog")} className="mt-1" />}
            </div>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-x-2.5">
            <SheetField id={`${id}-name`} label={t("environment.app.sheet.name")} error={shown("name")} className="mb-0">
              <Input
                id={`${id}-name`}
                className={inputClass}
                value={form.name}
                readOnly={!canEdit}
                aria-invalid={shown("name") !== undefined}
                placeholder="web"
                onChange={(event) => { set({ name: event.target.value }); }}
                onBlur={blur("name")}
              />
            </SheetField>
            <SheetField id={`${id}-label`} label={t("environment.app.sheet.label")} error={shown("label")} className="mb-0">
              <Input id={`${id}-label`} className="h-8 text-ui" value={form.label} readOnly={!canEdit} aria-invalid={shown("label") !== undefined} placeholder={t("environment.app.sheet.labelPlaceholder")} onChange={(event) => { set({ label: event.target.value }); }} onBlur={blur("label")} />
            </SheetField>
          </div>
          <p className="mb-[13px] mt-1.5 text-[12.5px] text-faint">{t("environment.app.sheet.nameHelp")}</p>
          <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-x-2.5">
            <SheetField id={`${id}-repo`} label={t("environment.app.sheet.repo")} error={shown("repo")}>
              <Select value={form.repoId} disabled={!canEdit} onValueChange={(repoId) => { set({ repoId }); }}>
                <SelectTrigger id={`${id}-repo`} className="h-8 w-full font-mono text-ui">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repos.map((repo) => <SelectItem key={repo.repoId} value={repo.repoId} className="font-mono">{repo.fullName}</SelectItem>)}
                </SelectContent>
              </Select>
            </SheetField>
            <SheetField id={`${id}-folder`} label={t("environment.app.sheet.folder")} error={shown("folder")}>
              <Input id={`${id}-folder`} className={inputClass} value={form.folder} readOnly={!canEdit} aria-invalid={shown("folder") !== undefined} onChange={(event) => { set({ folder: event.target.value }); }} onBlur={blur("folder")} />
            </SheetField>
          </div>
          <SheetField id={`${id}-command`} label={t("environment.app.sheet.command")} error={shown("command")} help={t("environment.app.sheet.commandHelp", { log: `.ostra/app/${logName}.log` })}>
            <Input id={`${id}-command`} className={inputClass} value={form.command} readOnly={!canEdit} aria-invalid={shown("command") !== undefined} placeholder="pnpm dev" onChange={(event) => { set({ command: event.target.value }); }} onBlur={blur("command")} />
          </SheetField>
          <SheetField id={`${id}-port`} label={t("environment.app.sheet.port")} error={shown("port")}>
            <Input id={`${id}-port`} inputMode="numeric" className={cn(inputClass, "w-[120px]")} value={form.port} readOnly={!canEdit} aria-invalid={shown("port") !== undefined} placeholder="5173" onChange={(event) => { set({ port: event.target.value }); }} onBlur={blur("port")} />
          </SheetField>
          <SheetField id={`${id}-ready`} label={t("environment.app.sheet.readyWhen")} error={shown("ready")} help={readyHelp}>
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                type="single"
                aria-label={t("environment.app.sheet.readyWhen")}
                className="h-8"
                value={form.readyKind}
                disabled={!canEdit}
                onValueChange={(value) => {
                  const kind: ReadyKind | null = value === "http" || value === "command" || value === "port" ? value : null;
                  if (kind !== null) set({ readyKind: kind });
                }}
              >
                <ToggleGroupItem value="http">{t("environment.app.sheet.readyHttp")}</ToggleGroupItem>
                <ToggleGroupItem value="command">{t("environment.app.sheet.readyCommand")}</ToggleGroupItem>
                <ToggleGroupItem value="port">{t("environment.app.sheet.readyPort")}</ToggleGroupItem>
              </ToggleGroup>
              {form.readyKind === "port" ? null : (
                <Input
                  id={`${id}-ready`}
                  aria-label={form.readyKind === "http" ? t("environment.app.sheet.readyPathLabel") : t("environment.app.sheet.readyCommandLabel")}
                  className={cn(inputClass, "min-w-[120px] flex-1")}
                  value={form.readyKind === "http" ? form.readyPath : form.readyCommand}
                  readOnly={!canEdit}
                  aria-invalid={shown("ready") !== undefined}
                  onChange={(event) => { set(form.readyKind === "http" ? { readyPath: event.target.value } : { readyCommand: event.target.value }); }}
                  onBlur={blur("ready")}
                />
              )}
            </div>
          </SheetField>
          <Hairline />
          <label className="mb-3 flex gap-3">
            <Switch className="mt-0.5" checked={form.primary} disabled={!canEdit} aria-label={t("environment.app.sheet.primary")} onCheckedChange={(primary) => { set({ primary }); }} />
            <span>
              <span className="block text-body font-medium text-text">{t("environment.app.sheet.primary")}</span>
              <span className="block text-[12.5px] text-faint">{primaryNow === null ? t("environment.app.sheet.primaryHelp") : t("environment.app.sheet.primaryMoves", { name: primaryNow.name })}</span>
            </span>
          </label>
          <label className="flex gap-3">
            <Switch className="mt-0.5" checked={form.hostRewrite} disabled={!canEdit} aria-label={t("environment.app.sheet.hostRewrite")} onCheckedChange={(hostRewrite) => { set({ hostRewrite }); }} />
            <span>
              <span className="block text-body font-medium text-text">{t("environment.app.sheet.hostRewrite")}</span>
              <span className="block text-[12.5px] text-faint">{t("environment.app.sheet.hostRewriteHelp", { host: `localhost:${form.port.trim() === "" ? "<port>" : form.port.trim()}` })}</span>
            </span>
          </label>
          <Hairline />
          <p className="mb-1.5 text-ui font-medium text-muted">{t("environment.app.sheet.addresses")}</p>
          <p className="text-[12.5px] text-faint" data-testid="sheet-addresses">{addressesNote(form.name, form.port, others, serviceCount)}</p>
          {error === null ? null : <p role="alert" className="mt-3 text-sm text-red">{errorText(error)}</p>}
        </form>
        <div className="flex h-[60px] shrink-0 items-center gap-2 border-t border-line px-5 max-sm:[&_button]:h-11">
          {!canEdit ? (
            <Dialog.Close asChild><Button className="ml-auto">{t("common.close")}</Button></Dialog.Close>
          ) : (
            <>
              {mode.kind === "edit" ? (
                <Button variant="ghost" className="hover:text-red" disabled={pending} onClick={() => { if (mode.process.primary) setRemoving(true); else remove(); }}>
                  <Trash2Icon aria-hidden className="stroke-[1.75]" />
                  {t("environment.app.sheet.remove", { name: mode.process.name })}
                </Button>
              ) : null}
              <span className="flex-1" />
              {mode.kind === "keep" ? (
                <Button variant="ghost" disabled={pending} onClick={dismiss} data-action="dismiss-kept">{t("environment.app.dismiss")}</Button>
              ) : (
                <Dialog.Close asChild><Button variant="ghost" disabled={pending}>{t("environment.svc.cancel")}</Button></Dialog.Close>
              )}
              <Button type="submit" form={`${id}-form`} variant="primary" disabled={pending || anyShown} data-action="save-process">
                {pending ? t("common.saving") : mode.kind === "keep" ? t("environment.app.sheet.accept") : mode.kind === "add" ? t("environment.app.sheet.addProcess") : t("environment.app.sheet.save")}
              </Button>
            </>
          )}
        </div>
      </Dialog.Content>
      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent title={t("environment.app.sheet.leaveTitle")} body={t("environment.app.sheet.leaveBody")} cancel={t("environment.app.sheet.keepEditing")} action={t("environment.app.sheet.leave")} onAction={onClose} />
      </AlertDialog>
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        {mode.kind === "edit" ? (
          <AlertDialogContent
            title={t("environment.app.removeTitle", { name: mode.process.name })}
            body={t("environment.app.removePrimary", { name: mode.process.name, next: others[0]?.name ?? "" })}
            cancel={t("environment.svc.cancel")}
            action={t("environment.svc.removeAction")}
            onAction={remove}
          />
        ) : null}
      </AlertDialog>
    </Dialog.Portal>
  );
};
