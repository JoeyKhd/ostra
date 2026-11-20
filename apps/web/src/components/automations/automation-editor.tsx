"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarIcon, CheckIcon, ClockIcon, LoaderCircleIcon, PlayIcon, PlusIcon, Trash2Icon, XIcon, ZapIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { AutomationId, BulkStartId, ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { useFilterNames } from "./automation-data";
import { applyPreset, draftOf, emptyCondition, filterOf, newDraft, poolLabelOk, presetOf, sameDraft, settingsOf } from "./automation-draft";
import type { Condition, ConditionField, Draft, Preset } from "./automation-draft";
import { bulkReasonText, categoryWord, clockText, dryCountText, dryOutcomeText, occurrenceText } from "./automation-words";
import type { Automation } from "./automation-words";

// The rule and schedule editor (automation-edit.md, F-011, F-106, F-107): a name and a trigger, a
// schedule with its sentence and next times, a filter, what each task is, and the dry run beside it
// with "Start all". Saving starts nothing (ADR 0056); "Start all" is a bulk start by hand.

/** `value` once it has stayed the same (by its JSON) for `ms`: an object rebuilt each render doesn't restart the wait. */
const useDebounced = <T,>(value: T, ms: number): T => {
  const [debounced, setDebounced] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  const key = JSON.stringify(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced((current) => (JSON.stringify(current) === key ? current : latest.current));
    }, ms);
    return () => { clearTimeout(timer); };
  }, [key, ms]);
  return debounced;
};

const fields: readonly ConditionField[] = ["labels", "status", "assignee", "board", "project"];

const fieldWord = (field: ConditionField): string => {
  switch (field) {
    case "labels":
      return t("automations.editor.field.labels");
    case "status":
      return t("automations.editor.field.status");
    case "assignee":
      return t("automations.editor.field.assignee");
    case "board":
      return t("automations.editor.field.board");
    case "project":
      return t("automations.editor.field.project");
    default:
      return field satisfies never;
  }
};

const addWord = (field: ConditionField): string => {
  switch (field) {
    case "labels":
      return t("automations.editor.addLabel");
    case "status":
      return t("automations.editor.addStatus");
    case "assignee":
      return t("automations.editor.addAssignee");
    case "board":
      return t("automations.editor.addBoard");
    case "project":
      return t("automations.editor.addProject");
    default:
      return field satisfies never;
  }
};

const presetWord = (preset: Preset): string => {
  switch (preset) {
    case "hourly":
      return t("automations.editor.preset.hourly");
    case "daily":
      return t("automations.editor.preset.daily");
    case "weekdays":
      return t("automations.editor.preset.weekdays");
    case "monday":
      return t("automations.editor.preset.monday");
    case "custom":
      return t("automations.editor.preset.custom");
    default:
      return preset satisfies never;
  }
};
const presets: readonly Preset[] = ["hourly", "daily", "weekdays", "monday", "custom"];

const SectionTitle = ({ title, note, end }: { readonly title: string; readonly note?: string; readonly end?: ReactNode }) => (
  <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
    <h2 className="text-body font-semibold text-text">{title}</h2>
    {note === undefined ? null : <span className="text-sm text-muted">{note}</span>}
    {end}
  </div>
);

/** The editor of a saved automation, or of a new one (`automationId` null, `starts` from the button). */
export const AutomationEditor = ({ projectId, automationId, starts }: { readonly projectId: ProjectId; readonly automationId: AutomationId | null; readonly starts: "match" | "schedule" }) => {
  const trpc = useTRPC();
  const saved = useQuery(trpc.automations.get.queryOptions(automationId === null ? skipToken : { automationId }));
  const list = useQuery(trpc.automations.list.queryOptions({ projectId }));
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const { boardsLoaded, boards } = useFilterNames(projectId);
  const loading = (automationId !== null && saved.data === undefined) || list.data === undefined || !boardsLoaded;
  if (saved.isError) {
    return (
      <PageFrame crumbs={[{ label: project.data?.name ?? "", href: `/projects/${projectId}` }, { label: t("automations.title"), href: `/projects/${projectId}/automations` }]}>
        <p role="alert" className="text-sm text-red">{errorText(saved.error)}</p>
      </PageFrame>
    );
  }
  if (loading) {
    return (
      <PageFrame crumbs={[{ label: project.data?.name ?? "", href: `/projects/${projectId}` }, { label: t("automations.title"), href: `/projects/${projectId}/automations` }]} wideProperties properties={<Skeleton className="h-6 w-40" />}>
        <div aria-busy className="flex flex-col gap-4">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-[34px] w-full max-w-[640px]" />
          <Skeleton className="h-[34px] w-full max-w-[640px]" />
        </div>
      </PageFrame>
    );
  }
  return (
    <EditorForm
      key={`${automationId ?? "new"}-${String(saved.dataUpdatedAt === 0 ? 0 : 1)}`}
      projectId={projectId}
      projectName={project.data?.name ?? ""}
      automation={saved.data ?? null}
      canEdit={automationId === null ? list.data.canEdit : saved.data?.canEdit === true}
      starts={starts}
      hasBoard={(boards?.length ?? 0) > 0}
      limits={list.data.limits}
    />
  );
};

type Limits = RouterOutputs["automations"]["list"]["limits"];

const EditorForm = ({
  projectId,
  projectName,
  automation,
  canEdit,
  starts,
  hasBoard,
  limits,
}: {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly automation: (Automation & { readonly canEdit: boolean }) | null;
  readonly canEdit: boolean;
  readonly starts: "match" | "schedule";
  readonly hasBoard: boolean;
  readonly limits: Limits;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [initial] = useState<Draft>(() => (automation === null ? newDraft(hasBoard ? starts : "schedule", hasBoard) : draftOf(automation)));
  const [base, setBase] = useState<Draft>(initial);
  const [draft, setDraft] = useState<Draft>(initial);
  const [savedAt, setSavedAt] = useState<number | null>(automation?.updatedAt ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cronRef = useRef<HTMLInputElement>(null);
  const isNew = automation === null;
  const dirty = !sameDraft(draft, base);
  const update = (patch: Partial<Draft>) => { setDraft((current) => ({ ...current, ...patch })); };
  const schedule = draft.starts === "schedule";
  const promptSchedule = schedule && draft.does === "prompt";

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); };
  }, [dirty]);

  const profiles = useQuery(trpc.agentProfiles.forStart.queryOptions({ projectId, kind: draft.taskKind }));
  const { names, filters, boards } = useFilterNames(projectId);
  const knownLabels = useMemo(() => new Set(automation?.poolLabels ?? []), [automation]);

  const cronInput = useDebounced({ cron: draft.cron.trim(), timeZone: draft.timeZone }, 250);
  const preview = useQuery({ ...trpc.automations.previewSchedule.queryOptions(cronInput), enabled: schedule && cronInput.cron !== "" });
  const refusal = preview.data?.refusal ?? null;
  const fiveFields = /[LW#]/.test(draft.cron) || draft.cron.trim().split(/\s+/).length > 5;

  const settings = settingsOf(draft);
  const valid = settings.ok && !(schedule && (refusal !== null || fiveFields || preview.data === undefined));
  const listKey = trpc.automations.pathKey();
  const afterSave = (result: Automation) => {
    void queryClient.invalidateQueries({ queryKey: listKey });
    setSaveError(null);
    setSavedAt(Date.now());
    if (isNew) {
      router.replace(`/projects/${projectId}/automations/${result.id}`);
      return;
    }
    setBase(draft);
  };
  const create = useMutation(trpc.automations.create.mutationOptions({ onSuccess: afterSave, onError: (error) => { setSaveError(errorText(error)); } }));
  const save = useMutation(trpc.automations.update.mutationOptions({ onSuccess: afterSave, onError: (error) => { setSaveError(errorText(error)); } }));
  const remove = useMutation(
    trpc.automations.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: listKey });
        router.push(`/projects/${projectId}/automations`);
      },
    }),
  );
  const resume = useMutation(trpc.automations.resume.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: listKey }) }));
  const saving = create.isPending || save.isPending;
  const onSave = () => {
    if (!settings.ok) return;
    if (isNew) create.mutate({ projectId, settings: settings.settings });
    else save.mutate({ automationId: automation.id, settings: settings.settings });
  };

  const title = draft.name.trim() === "" ? (isNew ? (schedule ? t("automations.editor.newScheduleTitle") : t("automations.editor.newRuleTitle")) : automation.name) : draft.name;
  const saveLabel = saving ? t("automations.editor.saving") : isNew ? (schedule ? t("automations.editor.createSchedule") : t("automations.editor.createRule")) : schedule ? t("automations.editor.saveSchedule") : t("automations.editor.saveRule");
  const eyebrow = (
    <span suppressHydrationWarning>
      {t("automations.editor.eyebrow")} ·{" "}
      {dirty ? <span className="text-muted">{t("automations.editor.dirty")}</span> : savedAt === null ? t("automations.editor.notSaved") : Date.now() - savedAt < 45_000 ? t("automations.editor.savedNow") : t("automations.editor.savedAgo", { age: formatAge(savedAt) })}
    </span>
  );
  const paused = automation?.paused ?? null;
  const usedFields = new Set(draft.conditions.filter((condition) => !(condition.field === "labels" && condition.op === "none")).map((condition) => condition.field));
  const disabled = !canEdit || saving;

  return (
    <PageFrame
      crumbs={[
        { label: projectName, href: `/projects/${projectId}` },
        { label: t("automations.title"), href: `/projects/${projectId}/automations` },
        { label: isNew ? (schedule ? t("automations.editor.newScheduleTitle") : t("automations.editor.newRuleTitle")) : automation.name },
      ]}
      actions={
        canEdit ? (
          <Button variant="primary" disabled={!valid || (!dirty && !isNew) || saving} onClick={onSave}>
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
            {saveLabel}
          </Button>
        ) : null
      }
      wideProperties
      properties={
        promptSchedule ? (
          <OccurrencesColumn next={preview.data?.next ?? []} zone={draft.timeZone} title={draft.title} />
        ) : (
          <DryRunColumn projectId={projectId} draft={draft} automation={automation} dirty={dirty} canEdit={canEdit} />
        )
      }
    >
      <div className="max-w-[760px]">
        <PageHeading eyebrow={eyebrow} title={title} lede={promptSchedule ? t("automations.editor.ledePrompt") : t("automations.editor.lede")} />
        {saveError === null ? null : <p role="alert" className="mt-2 text-sm text-red">{saveError}</p>}
        {canEdit ? null : <p className="mt-2 text-sm text-faint">{t("automations.editor.readOnly")}</p>}
        {paused === null ? null : (
          <div className="mt-[18px] flex min-h-11 flex-wrap items-center gap-3 rounded-lg border border-line-2 bg-surface px-3.5 py-2" data-testid="editor-paused">
            <span className="min-w-0 flex-1 text-ui text-text">
              {paused.reason === "hourly_limit"
                ? t("automations.editor.pausedLimit", { n: limits.startsPerHour })
                : paused.byName === null
                  ? t("automations.editor.pausedSomeone", { date: occurrenceText(paused.at) })
                  : t("automations.editor.pausedMember", { name: paused.byName, date: occurrenceText(paused.at) })}
            </span>
            {canEdit ? (
              <Button variant="primary" onClick={() => { if (automation !== null) resume.mutate({ automationId: automation.id }); }} disabled={resume.isPending}>
                <PlayIcon /> {t("automations.editor.resume")}
              </Button>
            ) : null}
          </div>
        )}

        {/* 1. Name and trigger */}
        <section className="mt-[26px]">
          <SectionTitle title={t("automations.editor.sectionTrigger")} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="automation-name">{t("automations.editor.name")}</Label>
              <Input id="automation-name" value={draft.name} maxLength={80} disabled={disabled} required onChange={(event) => { update({ name: event.target.value }); }} />
            </div>
            <div>
              <Label id="automation-starts-label">{t("automations.editor.starts")}</Label>
              <ToggleGroup
                type="single"
                aria-labelledby="automation-starts-label"
                value={draft.starts}
                disabled={disabled}
                onValueChange={(value) => { if (value === "match" || value === "schedule") update({ starts: value }); }}
                className="grid h-[34px] w-full grid-cols-2"
              >
                {hasBoard ? (
                  <ToggleGroupItem value="match" className="flex items-center justify-center gap-2">
                    <ZapIcon aria-hidden className="size-[15px] stroke-[1.75]" /> {t("automations.editor.onAMatch")}
                  </ToggleGroupItem>
                ) : (
                  <Tooltip content={t("automations.editor.noBoardFilter")}>
                    <span className="flex items-center justify-center gap-2 text-ui text-faint opacity-60">
                      <ZapIcon aria-hidden className="size-[15px] stroke-[1.75]" /> {t("automations.editor.onAMatch")}
                    </span>
                  </Tooltip>
                )}
                <ToggleGroupItem value="schedule" className="flex items-center justify-center gap-2 data-[state=on]:font-semibold">
                  <ClockIcon aria-hidden className="size-[15px] stroke-[1.75]" /> {t("automations.editor.onASchedule")}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
        </section>

        {/* 2. Schedule */}
        {schedule ? (
          <section className="mt-[26px]" data-testid="editor-schedule">
            <SectionTitle
              title={t("automations.editor.sectionSchedule")}
              note={(preview.data?.minIntervalMinutes ?? limits.minIntervalMinutes) >= 60 ? t("automations.editor.apartHour") : t("automations.editor.apartMinutes", { n: preview.data?.minIntervalMinutes ?? limits.minIntervalMinutes })}
            />
            <ToggleGroup
              type="single"
              aria-label={t("automations.editor.presets")}
              value={presetOf(draft.cron)}
              disabled={disabled}
              onValueChange={(value) => {
                if (value === "custom") {
                  cronRef.current?.focus();
                  return;
                }
                if (value === "hourly" || value === "daily" || value === "weekdays" || value === "monday") update({ cron: applyPreset(value, draft.cron) });
              }}
              className="h-auto flex-wrap gap-2 border-0 bg-transparent p-0"
            >
              {presets.map((preset) => (
                <ToggleGroupItem key={preset} value={preset} className="h-[30px] rounded-[7px] border border-control-line bg-surface data-[state=on]:border-text data-[state=on]:bg-surface data-[state=on]:shadow-none">
                  {presetWord(preset)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="mt-3.5 grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
              <div>
                <Label htmlFor="automation-cron">{t("automations.editor.cron")}</Label>
                <Input
                  id="automation-cron"
                  ref={cronRef}
                  className="font-mono"
                  value={draft.cron}
                  disabled={disabled}
                  aria-invalid={refusal !== null || fiveFields}
                  onChange={(event) => { update({ cron: event.target.value }); }}
                />
              </div>
              <div>
                <Label id="automation-zone-label">{t("automations.editor.timeZone")}</Label>
                <ZonePicker value={draft.timeZone} disabled={disabled} onChange={(zone) => { update({ timeZone: zone }); }} />
              </div>
            </div>
            {fiveFields ? (
              <p role="alert" className="mt-1.5 text-[12.5px] text-red">{t("automations.editor.fiveFields")}</p>
            ) : refusal !== null ? (
              <p role="alert" className="mt-1.5 text-[12.5px] text-red" data-testid="cron-refusal">{refusal.message}</p>
            ) : preview.data === undefined ? null : (
              <>
                <p className="mt-3 flex items-center gap-2 text-[14px] text-text" data-testid="cron-sentence">
                  <CalendarIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
                  {preview.data.sentence}
                </p>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                  <span className="text-[12.5px] text-muted">{t("automations.editor.next")}</span>
                  {preview.data.next.map((at) => (
                    <span key={at} className="font-mono text-[13px] text-faint" data-testid="next-occurrence" title={t("automations.editor.yourTime", { time: clockText(at) })}>
                      {occurrenceText(at, draft.timeZone)}
                    </span>
                  ))}
                </div>
              </>
            )}
            <div className="mt-4">
              <Label id="automation-does-label">{t("automations.editor.eachTime")}</Label>
              <RadioGroup
                aria-labelledby="automation-does-label"
                value={draft.does}
                disabled={disabled}
                onValueChange={(value) => { if (value === "filter" || value === "prompt") update({ does: value }); }}
                className="mt-1 flex flex-col gap-2"
              >
                <label className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui", !hasBoard && "opacity-50")}>
                  <RadioGroupItem value="filter" disabled={!hasBoard} />
                  {t("automations.editor.checkFilter")}
                  <span className="text-sm text-muted">{t("automations.editor.checkFilterNote", { n: limits.bulkStartMax })}</span>
                </label>
                <label className="flex items-center gap-2 text-ui">
                  <RadioGroupItem value="prompt" />
                  {t("automations.editor.startPrompt")}
                </label>
              </RadioGroup>
            </div>
            <label className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui">
              <Checkbox tone="teal" checked={draft.skipWhileOpen} disabled={disabled} onCheckedChange={(checked) => { update({ skipWhileOpen: checked === true }); }} />
              {t("automations.editor.skipWhileOpen")}
              <span className="text-sm text-muted">{t("automations.editor.skipWhileOpenNote")}</span>
            </label>
          </section>
        ) : null}

        {/* 3. Prompt, or Filter */}
        {promptSchedule ? (
          <section className="mt-[26px]">
            <SectionTitle title={t("automations.editor.sectionPrompt")} note={t("automations.editor.promptNote")} />
            <Label htmlFor="automation-title">{t("automations.editor.taskTitle")}</Label>
            <Input id="automation-title" value={draft.title} maxLength={512} disabled={disabled} onChange={(event) => { update({ title: event.target.value }); }} />
            <div className="mt-3">
              <Label htmlFor="automation-prompt">{t("automations.editor.promptText")}</Label>
              <Textarea id="automation-prompt" rows={6} value={draft.prompt} disabled={disabled} onChange={(event) => { update({ prompt: event.target.value }); }} />
            </div>
          </section>
        ) : (
          <section className="mt-[26px]" data-testid="editor-filter">
            <SectionTitle title={t("automations.editor.sectionFilter")} note={schedule ? t("automations.editor.filterNoteSchedule") : t("automations.editor.filterNoteRule")} />
            {!hasBoard ? (
              <p className="text-sm text-muted">
                {t("automations.editor.noBoardFilter")}{" "}
                <Link href={`/projects/${projectId}/boards`} className="text-teal hover:underline">{t("automations.editor.goBoards")}</Link>
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {draft.conditions.map((condition, index) => (
                    <ConditionRow
                      key={condition.key}
                      n={index + 1}
                      condition={condition}
                      disabled={disabled}
                      usedFields={usedFields}
                      options={optionsFor(condition, filters, boards)}
                      onChange={(next) => { update({ conditions: draft.conditions.map((one) => (one.key === condition.key ? next : one)) }); }}
                      onRemove={() => { update({ conditions: draft.conditions.filter((one) => one.key !== condition.key) }); }}
                    />
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  {canEdit ? (
                    <AddCondition used={usedFields} boardCount={names.boardCount} onAdd={(field) => { update({ conditions: [...draft.conditions, emptyCondition(field)] }); }} />
                  ) : <span />}
                  {names.boardCount === 1 ? <span className="text-sm text-muted">{t("automations.editor.boardOne", { name: [...names.boards.values()][0] ?? "" })}</span> : null}
                </div>
              </>
            )}
          </section>
        )}

        {/* 4. Each task */}
        <section className="mt-[26px] border-t border-line pt-[22px]">
          <SectionTitle title={t("automations.editor.sectionTask")} />
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label id="automation-kind-label">{t("automations.editor.kind")}</Label>
              <Select value={draft.taskKind} disabled={disabled} onValueChange={(value) => { if (value === "code" || value === "refine") update({ taskKind: value, agentProfileId: null }); }}>
                <SelectTrigger aria-labelledby="automation-kind-label" className="h-[34px] w-full bg-surface">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="code">{t("automations.kindLabel.code")}</SelectItem>
                  <SelectItem value="refine">{t("automations.kindLabel.refine")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label id="automation-profile-label">{t("automations.editor.profile")}</Label>
              <Select
                value={draft.agentProfileId ?? "default"}
                disabled={disabled}
                onValueChange={(value) => { update({ agentProfileId: value === "default" ? null : (profiles.data?.find((one) => one.profileId === value)?.profileId ?? null) }); }}
              >
                <SelectTrigger aria-labelledby="automation-profile-label" className="h-[34px] w-full bg-surface">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t("automations.defaultProfile")}</SelectItem>
                  {(profiles.data ?? []).map((profile) => (
                    <SelectItem key={profile.profileId} value={profile.profileId}>{profile.name}</SelectItem>
                  ))}
                  {draft.agentProfileId !== null && profiles.data?.some((one) => one.profileId === draft.agentProfileId) !== true ? (
                    <SelectItem value={draft.agentProfileId}>{automation?.agentProfile?.name ?? draft.agentProfileId}</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="automation-pool-label">{t("automations.editor.poolLabels")}</Label>
              <PoolLabels
                labels={draft.poolLabels}
                disabled={disabled}
                onChange={(labels) => { update({ poolLabels: labels }); }}
              />
            </div>
          </div>
          {(automation?.labelsNoRunnerHas ?? []).filter((label) => draft.poolLabels.includes(label) && knownLabels.has(label)).map((label) => (
            <p key={label} className="mt-1.5 text-[12.5px] text-muted">{t("automations.editor.labelWaits", { label })}</p>
          ))}
          <label className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui">
            <Switch checked={draft.requireApproval} disabled={disabled} onCheckedChange={(on) => { update({ requireApproval: on }); }} aria-label={t("automations.editor.approval")} />
            {t("automations.editor.approval")}
            <span className="text-sm text-muted">{draft.requireApproval ? t("automations.editor.approvalOn") : t("automations.editor.approvalOff")}</span>
          </label>
        </section>

        {/* 5. Delete */}
        {isNew || !canEdit ? null : (
          <section className="mt-[26px] flex flex-wrap items-center gap-3 border-t border-line pt-[22px]">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost">
                  <Trash2Icon /> {schedule ? t("automations.editor.deleteSchedule") : t("automations.editor.deleteRule")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent
                title={t("automations.editor.deleteTitle", { name: automation.name })}
                body={t("automations.editor.deleteBody")}
                cancel={t("automations.editor.cancel")}
                action={t("automations.editor.delete")}
                onAction={() => { remove.mutate({ automationId: automation.id }); }}
                pending={{ busy: remove.isPending, label: t("automations.editor.deleting"), error: remove.isError ? errorText(remove.error) : null }}
              />
            </AlertDialog>
            <span className="text-[12.5px] text-faint">{t("automations.editor.deleteNote")}</span>
          </section>
        )}
      </div>
    </PageFrame>
  );
};

type Option = { readonly value: string; readonly label: string };
type Filters = RouterOutputs["inbox"]["filters"] | undefined;
type Boards = RouterOutputs["boards"]["get"]["boards"] | undefined;

const categories = ["open", "started", "done", "cancelled"] as const;

/** What a condition's value picker offers. Labels and the tracker's projects are typed as well. */
const optionsFor = (condition: Condition, filters: Filters, boards: Boards): { readonly options: readonly Option[]; readonly free: boolean } => {
  switch (condition.field) {
    case "labels":
      return { options: (filters?.labels ?? []).map((label) => ({ value: label, label })), free: true };
    case "status":
      return condition.op === "is"
        ? { options: (filters?.statuses ?? []).map((status) => ({ value: status.id, label: status.name })), free: false }
        : { options: categories.map((category) => ({ value: category, label: categoryWord(category) })), free: false };
    case "assignee":
      return {
        options: [
          { value: "unassigned", label: t("automations.words.unassignedValue") },
          { value: "app", label: t("automations.words.app") },
          ...(filters?.assignees ?? []).map((assignee) => ({ value: `user:${assignee.id}`, label: assignee.name })),
        ],
        free: false,
      };
    case "board":
      return { options: (boards ?? []).map((board) => ({ value: String(board.id), label: board.name })), free: false };
    case "project":
      return { options: [], free: true };
    default:
      return condition satisfies never;
  }
};

const ConditionRow = ({
  n,
  condition,
  disabled,
  usedFields,
  options,
  onChange,
  onRemove,
}: {
  readonly n: number;
  readonly condition: Condition;
  readonly disabled: boolean;
  readonly usedFields: ReadonlySet<ConditionField>;
  readonly options: { readonly options: readonly Option[]; readonly free: boolean };
  readonly onChange: (next: Condition) => void;
  readonly onRemove: () => void;
}) => {
  const ops: readonly { readonly value: string; readonly label: string }[] =
    condition.field === "labels"
      ? [{ value: "any", label: t("automations.editor.op.any") }, { value: "all", label: t("automations.editor.op.all") }, { value: "none", label: t("automations.editor.op.none") }]
      : condition.field === "status"
        ? [{ value: "is", label: t("automations.editor.op.is") }, { value: "category", label: t("automations.editor.op.category") }]
        : [{ value: "is", label: t("automations.editor.op.is") }];
  const op = condition.field === "labels" || condition.field === "status" ? condition.op : "is";
  const setOp = (value: string) => {
    if (condition.field === "labels" && (value === "any" || value === "all" || value === "none")) onChange({ ...condition, op: value });
    else if (condition.field === "status" && (value === "is" || value === "category") && value !== condition.op) onChange({ ...condition, op: value, values: [] });
  };
  const labelOf = (value: string) => options.options.find((one) => one.value === value)?.label ?? value;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_30px] gap-2 sm:grid-cols-[190px_120px_minmax(0,1fr)_30px]" data-testid="condition" data-field={condition.field}>
      <Select
        value={condition.field}
        disabled={disabled}
        onValueChange={(value) => {
          const field = fields.find((one) => one === value);
          if (field !== undefined && field !== condition.field) onChange(emptyCondition(field));
        }}
      >
        <SelectTrigger aria-label={t("automations.editor.fieldOf", { n })} className="h-[38px] w-full bg-surface">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((field) => (
            <SelectItem key={field} value={field} disabled={field !== condition.field && usedFields.has(field) && field !== "labels"}>{fieldWord(field)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={op} disabled={disabled || ops.length === 1} onValueChange={setOp}>
        <SelectTrigger aria-label={t("automations.editor.opOf", { n })} className="h-[38px] w-full bg-surface max-sm:order-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((one) => <SelectItem key={one.value} value={one.value}>{one.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <div className="col-span-2 flex min-h-[38px] min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-control-line bg-surface px-1.5 py-1 max-sm:order-last sm:col-span-1">
        {condition.values.map((value) => (
          <Chip key={value} className="h-[26px] bg-bg text-text">
            {labelOf(value)}
            {disabled ? null : (
              <button type="button" aria-label={t("automations.editor.removeValue", { value: labelOf(value) })} className="text-faint hover:text-text" onClick={() => { onChange({ ...condition, values: condition.values.filter((one) => one !== value) }); }}>
                <XIcon aria-hidden />
              </button>
            )}
          </Chip>
        ))}
        {disabled ? null : (
          <AddValue
            label={t("automations.editor.valuesOf", { n })}
            placeholder={addWord(condition.field)}
            options={options.options.filter((one) => !condition.values.includes(one.value))}
            free={options.free}
            onAdd={(value) => { if (!condition.values.includes(value)) onChange({ ...condition, values: [...condition.values, value] }); }}
          />
        )}
      </div>
      <Button variant="ghost" size="icon" className="h-[38px]" disabled={disabled} aria-label={t("automations.editor.removeCondition", { n })} onClick={onRemove}>
        <XIcon />
      </Button>
    </div>
  );
};

/** The inline `+ label` combobox: typed (labels, projects) or picked from a list. */
const AddValue = ({ label, placeholder, options, free, onAdd }: { readonly label: string; readonly placeholder: string; readonly options: readonly Option[]; readonly free: boolean; readonly onAdd: (value: string) => void }) => {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const needle = typed.trim().toLowerCase();
  const listed = needle === "" ? options : options.filter((option) => option.label.toLowerCase().includes(needle));
  const add = (value: string) => {
    onAdd(value);
    setTyped("");
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setTyped(""); }}>
      <PopoverTrigger className="inline-flex h-[26px] items-center gap-1 rounded-sm px-1.5 text-ui text-faint hover:text-text" aria-label={label}>
        <PlusIcon aria-hidden className="size-[14px] stroke-[1.75]" /> {placeholder}
      </PopoverTrigger>
      <PopoverContent className="w-[260px]" align="start">
        <Input
          autoFocus
          aria-label={label}
          value={typed}
          onChange={(event) => { setTyped(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const exact = listed.find((option) => option.label.toLowerCase() === needle) ?? (listed.length === 1 ? listed[0] : undefined);
            if (exact !== undefined) add(exact.value);
            else if (free && typed.trim() !== "") add(typed.trim());
          }}
          className="mb-1 h-8"
        />
        <div role="listbox" aria-label={label} className="max-h-[240px] overflow-y-auto">
          {listed.map((option) => (
            <button key={option.value} type="button" role="option" aria-selected={false} onClick={() => { add(option.value); }} className="flex h-[28px] w-full items-center rounded-sm px-2 text-left text-ui hover:bg-sel">
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};

const AddCondition = ({ used, boardCount, onAdd }: { readonly used: ReadonlySet<ConditionField>; readonly boardCount: number; readonly onAdd: (field: ConditionField) => void }) => {
  const free = fields.filter((field) => (!used.has(field) || field === "labels") && (field !== "board" || boardCount > 1));
  return (
    <Select value="" onValueChange={(value) => { const field = fields.find((one) => one === value); if (field !== undefined) onAdd(field); }}>
      <SelectTrigger className="h-[30px] w-auto text-muted hover:text-text [&>svg:last-child]:hidden" aria-label={t("automations.editor.addCondition")}>
        <PlusIcon aria-hidden /> {t("automations.editor.addCondition")}
      </SelectTrigger>
      <SelectContent>
        {free.map((field) => <SelectItem key={field} value={field}>{fieldWord(field)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
};

const PoolLabels = ({ labels, disabled, onChange }: { readonly labels: readonly string[]; readonly disabled: boolean; readonly onChange: (labels: readonly string[]) => void }) => {
  const [typed, setTyped] = useState("");
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    const label = typed.trim();
    if (label === "") return;
    if (!poolLabelOk(label)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setTyped("");
    if (!labels.includes(label)) onChange([...labels, label]);
  };
  return (
    <>
      <div className="focus-box flex min-h-[34px] flex-wrap items-center gap-1.5 rounded-md border border-control-line bg-surface px-1.5 py-1">
        {labels.map((label) => (
          <Chip key={label} className="h-[24px] bg-bg font-mono text-[12.5px] text-text" data-testid="pool-label">
            {label}
            {disabled ? null : (
              <button type="button" aria-label={t("automations.editor.removeValue", { value: label })} className="text-faint hover:text-text" onClick={() => { onChange(labels.filter((one) => one !== label)); }}>
                <XIcon aria-hidden />
              </button>
            )}
          </Chip>
        ))}
        {disabled ? null : (
          <input
            id="automation-pool-label"
            aria-label={t("automations.editor.addPoolLabel")}
            aria-invalid={invalid}
            value={typed}
            onChange={(event) => { setTyped(event.target.value); setInvalid(false); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
            className="h-[24px] min-w-[80px] flex-1 bg-transparent font-mono text-[12.5px] text-text outline-none placeholder:text-faint"
          />
        )}
      </div>
      {invalid ? <p role="alert" className="mt-1.5 text-[12.5px] text-red">{t("automations.editor.poolLabelInvalid")}</p> : null}
    </>
  );
};

const zones = (): readonly string[] => {
  try {
    return [...Intl.supportedValuesOf("timeZone"), "UTC"].filter((zone, index, all) => all.indexOf(zone) === index);
  } catch {
    return ["UTC"];
  }
};

/** A searchable list of IANA zones, grouped by region (the segment before the first `/`). */
const ZonePicker = ({ value, disabled, onChange }: { readonly value: string; readonly disabled: boolean; readonly onChange: (zone: string) => void }) => {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const all = useMemo(zones, []);
  const needle = typed.trim().toLowerCase().replaceAll(" ", "_");
  const listed = (needle === "" ? all : all.filter((zone) => zone.toLowerCase().includes(needle))).slice(0, 200);
  const groups = new Map<string, string[]>();
  for (const zone of listed) {
    const region = zone.includes("/") ? (zone.split("/")[0] ?? zone) : zone;
    groups.set(region, [...(groups.get(region) ?? []), zone]);
  }
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setTyped(""); }}>
      <PopoverTrigger
        disabled={disabled}
        aria-labelledby="automation-zone-label"
        data-testid="zone-picker"
        className="flex h-[34px] w-full items-center justify-between gap-2 rounded-md border border-control-line bg-surface px-2.5 font-mono text-ui text-text disabled:opacity-60"
      >
        <span className="truncate">{value}</span>
        <ChevronIcon />
      </PopoverTrigger>
      <PopoverContent className="w-[300px]" align="start">
        <Input autoFocus aria-label={t("automations.editor.zoneSearch")} placeholder={t("automations.editor.zoneSearch")} value={typed} onChange={(event) => { setTyped(event.target.value); }} className="mb-1 h-8" />
        <div role="listbox" aria-label={t("automations.editor.timeZone")} className="max-h-[280px] overflow-y-auto">
          {listed.length === 0 ? <p className="px-2 py-1.5 text-sm text-faint">{t("automations.editor.zoneNone")}</p> : null}
          {[...groups.entries()].map(([region, members]) => (
            <div key={region}>
              <p className="px-2 pb-1 pt-2 text-xs font-medium text-faint">{region}</p>
              {members.map((zone) => (
                <button
                  key={zone}
                  type="button"
                  role="option"
                  aria-selected={zone === value}
                  onClick={() => { onChange(zone); setOpen(false); setTyped(""); }}
                  className="flex h-[28px] w-full items-center justify-between rounded-sm px-2 text-left font-mono text-[12.5px] hover:bg-sel"
                >
                  <span className="truncate">{zone}</span>
                  {zone === value ? <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" /> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};

const ChevronIcon = () => (
  <svg aria-hidden viewBox="0 0 24 24" className="size-[15px] shrink-0 fill-none stroke-current stroke-[1.75] text-muted">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const OccurrencesColumn = ({ next, zone, title }: { readonly next: readonly number[]; readonly zone: string; readonly title: string }) => (
  <div className="xl:sticky xl:top-0" data-testid="occurrences">
    <h2 className="text-[13px] font-semibold text-muted">{t("automations.dry.occurrences")}</h2>
    <ul className="mt-3">
      {next.map((at) => (
        <li key={at} className="flex min-h-[44px] flex-col justify-center border-b border-line">
          <span className="text-ui text-text">{occurrenceText(at, zone)}</span>
          <span className="truncate text-sm text-muted">{t("automations.dry.startsPrompt", { title: title.trim() })}</span>
        </li>
      ))}
    </ul>
    <p className="mt-3 text-sm text-muted">{t("automations.dry.promptNote")}</p>
  </div>
);

type BulkItem = RouterOutputs["inbox"]["bulkStart"]["items"][number];

const DryRunColumn = ({
  projectId,
  draft,
  automation,
  dirty,
  canEdit,
}: {
  readonly projectId: ProjectId;
  readonly draft: Draft;
  readonly automation: Automation | null;
  readonly dirty: boolean;
  readonly canEdit: boolean;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const filter = filterOf(draft.conditions);
  const input = useDebounced(filter === null ? null : { projectId, filter, taskKind: draft.taskKind }, 400);
  const dry = useQuery({ ...trpc.automations.dryRun.queryOptions(input ?? skipToken), placeholderData: (previous) => previous });
  const [bulkStartId, setBulkStartId] = useState<BulkStartId | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const bulk = useQuery({
    ...trpc.inbox.bulkStart.queryOptions(bulkStartId === null ? skipToken : { projectId, bulkStartId }),
    refetchInterval: (query) => (query.state.data?.done === true ? false : 1000),
  });
  const startAll = useMutation(
    trpc.automations.startAll.mutationOptions({
      onSuccess: (result) => {
        setBulkStartId(result.bulkStartId);
      },
    }),
  );
  useEffect(() => {
    if (bulk.data?.done === true) {
      void queryClient.invalidateQueries({ queryKey: trpc.automations.pathKey() });
    }
  }, [bulk.data?.done, queryClient, trpc]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 5000);
    return () => { clearInterval(timer); };
  }, []);

  const data = dry.data;
  const wouldStart = data?.wouldStart ?? 0;
  const skipped = (data?.rows.length ?? 0) - wouldStart;
  const results = new Map<string, BulkItem>((bulk.data?.items ?? []).map((item) => [String(item.ticket.id), item] as const));
  const startedCount = bulk.data?.counts.started ?? 0;
  const decided = bulk.data === undefined ? 0 : bulk.data.items.length - bulk.data.counts.pending;
  const done = bulk.data?.done === true;
  const kind = draft.taskKind;

  return (
    <div id="dry-run" className="xl:sticky xl:top-0" data-testid="dry-run">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-muted">{t("automations.dry.title")}</h2>
        {input === null ? null : dry.isFetching ? (
          <span className="flex items-center gap-1.5 font-mono text-[12.5px] text-faint">
            <LoaderCircleIcon aria-hidden className="size-3 animate-spin" /> {t("automations.dry.updating")}
          </span>
        ) : dry.dataUpdatedAt === 0 ? null : (
          <span className="font-mono text-[12.5px] text-faint" suppressHydrationWarning>
            {now - dry.dataUpdatedAt < 45_000 ? t("automations.dry.updatedNow") : t("automations.dry.updated", { age: formatAge(dry.dataUpdatedAt, now) })}
          </span>
        )}
      </div>
      {input === null ? (
        <p className="mt-3 text-sm text-muted">{t("automations.dry.needCondition")}</p>
      ) : dry.isError && data === undefined ? (
        <p role="alert" className="mt-3 text-sm text-red">
          {t("automations.dry.failed", { error: errorText(dry.error) ?? "" })}{" "}
          <Button variant="link" onClick={() => void dry.refetch()}>{t("automations.dry.tryAgain")}</Button>
        </p>
      ) : data === undefined ? (
        <div className="mt-3 flex flex-col gap-2" aria-busy><Skeleton className="h-5 w-40" /><Skeleton className="w-full" /><Skeleton className="w-full" /></div>
      ) : (
        <>
          <p className="mt-1.5 text-[17px] font-semibold text-text" data-testid="dry-count">
            {bulkStartId !== null && done ? plural(startedCount, "automations.dry.startedLine.one", "automations.dry.startedLine.other") : dryCountText(data.total)}
          </p>
          <p className="text-sm text-muted">{t("automations.dry.lede")}</p>
          <ul className="mt-3 border-t border-line">
            {data.rows.map((row) => {
              const result = results.get(String(row.ticketId));
              return (
                <li key={row.ticketId} className="grid min-h-[52px] grid-cols-[80px_minmax(0,1fr)] items-center gap-2 border-b border-line py-1.5" data-testid="dry-row" data-key={row.key}>
                  <span className="font-mono text-[13px] text-muted">{row.key}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] text-text">{row.title}</span>
                    {result === undefined ? (
                      <span className={cn("block text-sm", row.outcome.kind === "would-start" ? "text-muted" : "text-faint")} data-testid="dry-outcome">
                        {dryOutcomeText(row.outcome, kind)}
                        {row.outcome.kind === "would-skip" && row.outcome.reason === "has-task" && row.outcome.taskId !== null ? (
                          <>
                            {" "}
                            <Link href={`/tasks/${row.outcome.taskId}`} className="font-mono text-teal hover:underline">{row.outcome.shortId}</Link>
                          </>
                        ) : null}
                      </span>
                    ) : (
                      <BulkResult item={result} />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {data.total > data.rows.length ? <p className="mt-2 text-sm text-faint">{t("automations.dry.more", { n: data.total - data.rows.length })}</p> : null}
          {canEdit ? (
            <div className="mt-4">
              {bulkStartId !== null && done ? (
                <Button size="xl" className="w-full" disabled>
                  <CheckIcon /> {plural(startedCount, "automations.dry.startedAll.one", "automations.dry.startedAll.other")}
                </Button>
              ) : (
                <Button
                  size="xl"
                  variant="primary"
                  className="w-full"
                  disabled={automation === null || dirty || wouldStart === 0 || startAll.isPending || bulkStartId !== null}
                  onClick={() => { if (automation !== null) startAll.mutate({ automationId: automation.id, requestKey }); }}
                >
                  {bulkStartId !== null || startAll.isPending ? (
                    <>
                      <LoaderCircleIcon className="animate-spin" /> {t("automations.dry.starting", { done: decided, n: bulk.data?.items.length ?? wouldStart })}
                    </>
                  ) : automation === null ? (
                    t("automations.dry.saveFirst")
                  ) : dirty ? (
                    t("automations.dry.saveToStart")
                  ) : (
                    <>
                      <PlayIcon /> {t("automations.dry.startAll", { n: wouldStart })}
                    </>
                  )}
                </Button>
              )}
              {startAll.isError ? <p role="alert" className="mt-2 text-sm text-red">{errorText(startAll.error)}</p> : null}
              {wouldStart > 0 && bulkStartId === null ? (
                <p className="mt-2 text-[12.5px] text-faint">
                  {plural(wouldStart, "automations.dry.summary.one", "automations.dry.summary.other")}
                  {skipped === 0 ? "" : ` ${skipped === 1 ? t("automations.dry.skippedOne") : t("automations.dry.skippedMany", { n: skipped })}`}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};

const BulkResult = ({ item }: { readonly item: BulkItem }) => {
  switch (item.state) {
    case "pending":
      return <span className="block text-sm text-muted" data-testid="dry-result">{t("automations.dry.result.pending")}</span>;
    case "started":
      return (
        <span className="block text-sm text-muted" data-testid="dry-result">
          {t("automations.dry.result.started")}{" "}
          {item.task === null ? null : <Link href={`/tasks/${item.task.id}`} className="font-mono text-teal hover:underline">{item.task.shortId}</Link>}
        </span>
      );
    case "skipped":
      return <span className="block text-sm text-faint" data-testid="dry-result">{t("automations.dry.result.skipped", { reason: bulkReasonText(item.reason) })}</span>;
    case "failed":
      return <span className="block text-sm text-red" data-testid="dry-result">{t("automations.dry.result.failed", { reason: bulkReasonText(item.reason) })}</span>;
    default:
      return item.state satisfies never;
  }
};
