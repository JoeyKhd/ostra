"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, ClockIcon, InfoIcon, LoaderCircleIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { AgentProfileId, ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { ProjectSettingsTabs } from "./settings-tabs";

// A project's Review settings (app-targets/m6/review-settings.md; F-100, F-101, F-040, F-035,
// ticket 35): the AI review switch (a project admin's), the review and refine profiles, the round
// limits the install sets, "Outside tasks need approval" (an organization admin turns it off), and
// each repo's CI as ostra last saw it. Each control saves on its own: no Save button.

type Settings = RouterOutputs["projects"]["reviewSettings"];
type RepoCi = Settings["repos"][number];

const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "error"]);

const Section = ({ title, aside, description, end, children }: { readonly title: ReactNode; readonly aside?: ReactNode; readonly description?: ReactNode; readonly end?: ReactNode; readonly children?: ReactNode }) => (
  <section className="border-t border-line py-5">
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-text">{title}{aside}</h2>
        {description === undefined ? null : <div className="mt-1 max-w-[600px] text-sm text-muted">{description}</div>}
      </div>
      {end}
    </div>
    {children}
  </section>
);

const CiVerdict = ({ ci }: { readonly ci: RepoCi["ci"] }) => {
  if (ci === null) return <span className="flex items-center gap-1.5 text-ui text-muted"><CircleDashedIcon aria-hidden className="size-[15px] text-faint" />{t("reviewSettings.ciNotSeen")}</span>;
  switch (ci.state) {
    case "passed":
      return <span className="flex items-center gap-1.5 text-ui text-text"><CircleCheckIcon aria-hidden className="size-[15px] text-green" />{t("reviewSettings.ciPassed")}</span>;
    case "failed":
      return <span className="flex items-center gap-1.5 text-ui text-text"><CircleXIcon aria-hidden className="size-[15px] text-red" />{t("reviewSettings.ciFailed")}</span>;
    case "none":
      return <span className="flex items-center gap-1.5 text-ui text-muted"><CircleDashedIcon aria-hidden className="size-[15px] text-faint" />{t("reviewSettings.ciNone")}</span>;
    case "pending":
      return <span className="flex items-center gap-1.5 text-ui text-muted"><LoaderCircleIcon aria-hidden className="size-[15px] animate-spin" />{t("reviewSettings.ciRunning")}</span>;
    case "timed_out":
      return <span className="flex items-center gap-1.5 text-ui text-muted"><ClockIcon aria-hidden className="size-[15px]" />{t("reviewSettings.ciTimedOut")}</span>;
    default:
      return ci.state satisfies never;
  }
};

const ciDetail = (ci: RepoCi["ci"], now: number): ReactNode => {
  if (ci === null) return t("reviewSettings.ciNeverPushed");
  if (ci.state === "none") return t("reviewSettings.ciNoneDetail");
  const checks = ci.state === "failed" ? ci.checks.filter((check) => check.conclusion !== null && FAILING.has(check.conclusion)) : ci.checks;
  return (
    <>
      <span className="font-mono">{checks.map((check) => check.name).join(", ")}</span>
      {checks.length === 0 ? null : " · "}
      {t("reviewSettings.on")} <Link href={`/tasks/${ci.taskId}`} className="font-mono hover:underline" title={t("reviewSettings.headOf", { key: ci.taskKey ?? ci.taskId.slice(-7) })}>{ci.headSha.slice(0, 7)}</Link>
      {" · "}
      {t("reviewSettings.ago", { age: formatAge(ci.at, now) })}
    </>
  );
};

const ProfileRow = ({ label, kind, projectId, current, canEdit }: { readonly label: string; readonly kind: "review" | "refine"; readonly projectId: ProjectId; readonly current: { readonly id: AgentProfileId; readonly name: string; readonly builtInKind: "refine" | "review" | null } | null; readonly canEdit: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const options = useQuery(trpc.agentProfiles.forStart.queryOptions({ projectId, kind }));
  const set = useMutation(trpc.projects.setDefaultProfile.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) }) }));
  return (
    <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3 border-b border-line last:border-b-0 sm:grid-cols-[360px_minmax(0,1fr)]" data-profile-kind={kind}>
      <span className="text-ui text-muted">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <Select
          value={current?.id ?? ""}
          disabled={!canEdit || set.isPending}
          onValueChange={(value) => {
            const picked = options.data?.find((option) => option.profileId === value);
            if (picked !== undefined) set.mutate({ projectId, kind, profileId: picked.profileId });
          }}
        >
          <SelectTrigger className="h-[34px] w-full max-w-[280px]" aria-label={label}>
            <SelectValue placeholder={current?.name ?? "–"} />
          </SelectTrigger>
          <SelectContent>
            {(options.data ?? []).map((option) => (
              <SelectItem key={option.profileId} value={option.profileId}>{option.name}</SelectItem>
            ))}
            {current !== null && !(options.data ?? []).some((option) => option.profileId === current.id) ? <SelectItem value={current.id}>{current.name}</SelectItem> : null}
          </SelectContent>
        </Select>
        {current?.builtInKind === null || current === null ? null : <Chip className="h-5 shrink-0 px-1.5 font-mono text-[11px]">{t("draft.builtIn")}</Chip>}
      </span>
    </div>
  );
};

export const ReviewSettingsView = ({ projectId }: { readonly projectId: ProjectId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.projects.reviewSettings.queryOptions({ projectId }));
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const me = useQuery(trpc.me.get.queryOptions());
  const approval = useQuery(trpc.tasks.needsApproval.queryOptions(settings.data === undefined ? skipToken : { projectId }));
  const [now] = useState(() => Date.now());
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const settingsKey = trpc.projects.reviewSettings.queryKey({ projectId });
  const setAi = useMutation(
    trpc.projects.setAiReview.mutationOptions({
      onMutate: async ({ on }) => {
        await queryClient.cancelQueries({ queryKey: settingsKey });
        queryClient.setQueryData(settingsKey, (old) => (old === undefined ? old : { ...old, aiReview: on }));
      },
      onSuccess: ({ aiReview }) => { setAiNote(aiReview ? t("reviewSettings.aiOnNote") : t("reviewSettings.aiOffNote")); },
      onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
    }),
  );
  const setOutside = useMutation(trpc.projects.setOutsideApproval.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.tasks.needsApproval.queryKey({ projectId }) }) }));
  useEffect(() => {
    if (aiNote === null) return;
    const timer = setTimeout(() => { setAiNote(null); }, 6000);
    return () => { clearTimeout(timer); };
  }, [aiNote]);

  const name = project.data?.name ?? "";
  const data = settings.data;
  const orgAdmin = me.data?.organization?.role === "admin";
  const outside = approval.data?.outsideApproval ?? null;
  const reviewProfile = project.data?.defaultProfiles.review ?? null;
  const refineProfile = project.data?.defaultProfiles.refine ?? null;
  const canEdit = data?.canChange ?? false;
  const crumbs = [{ label: name, href: `/projects/${projectId}` }, { label: t("projectSettings.title"), href: `/projects/${projectId}/settings` }, { label: t("reviewSettings.title") }];

  const aiSwitch = (
    <Switch
      aria-label={t("reviewSettings.aiTitle")}
      checked={data?.aiReview ?? false}
      disabled={data === undefined || !canEdit || setAi.isPending}
      onCheckedChange={(on) => { setAi.mutate({ projectId, on }); }}
      data-testid="ai-review-switch"
    />
  );

  return (
    <PageFrame
      crumbs={crumbs}
      properties={
        data === undefined ? null : (
          <div data-testid="review-settings-panel">
            <PropGroup title={t("reviewSettings.howTitle")}>
              <ol className="space-y-2">
                {[t("reviewSettings.how1"), data.aiReview ? t("reviewSettings.how2") : t("reviewSettings.how2Off"), t("reviewSettings.how3"), t("reviewSettings.how4")].map((step, index) => (
                  <li key={step} className="grid grid-cols-[24px_minmax(0,1fr)] text-ui">
                    <span className="font-mono text-xs leading-5 text-faint">{index + 1}</span>
                    <span className={index === 1 && !data.aiReview ? "text-faint" : "text-muted"}>{step}</span>
                  </li>
                ))}
              </ol>
            </PropGroup>
            <PropGroup title={t("reviewSettings.thisProject")}>
              <PropRow label={t("reviewSettings.aiTitle")} labelWidth={120}><span>{data.aiReview ? t("reviewSettings.on1") : t("reviewSettings.off1")}</span></PropRow>
              <PropRow label={t("reviewSettings.reviewProfile")} labelWidth={120}><span className="truncate">{reviewProfile?.name ?? "–"}</span></PropRow>
              <PropRow label={t("reviewSettings.model")} labelWidth={120}><span className="truncate">{reviewProfile?.model?.name ?? "–"}</span></PropRow>
              {outside === null ? null : <PropRow label={t("reviewSettings.outsideRow")} labelWidth={120}><span>{outside.on ? t("reviewSettings.needApproval") : t("reviewSettings.startAtOnce")}</span></PropRow>}
              {outside?.changedByName === null || outside === null ? null : <PropRow label={t("reviewSettings.changedBy")} labelWidth={120}><span className="truncate">{outside.changedByName}</span></PropRow>}
            </PropGroup>
          </div>
        )
      }
    >
      <div className="max-w-[760px]" data-testid="review-settings">
        <ProjectSettingsTabs projectId={projectId} admin={project.data?.role === "admin"} />
        <PageHeading title={t("reviewSettings.title")} lede={t("reviewSettings.lede")} />
        {settings.error === null ? null : (
          <p role="alert" className="mt-2 text-red">
            {errorText(settings.error)} <button type="button" className="text-teal hover:underline" onClick={() => void settings.refetch()}>{t("reviewSettings.retry")}</button>
          </p>
        )}
        <div className="mt-6">
          <Section
            title={t("reviewSettings.aiTitle")}
            description={
              <>
                <p>{t("reviewSettings.aiBody")}</p>
                {aiNote === null ? null : <p className="mt-1 text-xs text-faint" role="status">{aiNote}</p>}
                {setAi.error === null ? null : <p className="mt-1 text-xs text-red" role="alert">{errorText(setAi.error)}</p>}
              </>
            }
            end={data === undefined ? <Skeleton className="h-5 w-9" /> : canEdit ? aiSwitch : <Tooltip content={t("reviewSettings.adminOnly", { project: name })}><span>{aiSwitch}</span></Tooltip>}
          />
          <Section title={t("reviewSettings.profilesTitle")}>
            <div className="mt-2">
              <ProfileRow label={t("reviewSettings.reviewProfile")} kind="review" projectId={projectId} current={reviewProfile === null ? null : { id: reviewProfile.id, name: reviewProfile.name, builtInKind: reviewProfile.builtInKind }} canEdit={canEdit} />
              <ProfileRow label={t("reviewSettings.refineProfile")} kind="refine" projectId={projectId} current={refineProfile === null ? null : { id: refineProfile.id, name: refineProfile.name, builtInKind: refineProfile.builtInKind }} canEdit={canEdit} />
            </div>
            <p className="mt-2 text-xs text-faint">{t("reviewSettings.profilesNote")}</p>
          </Section>
          <Section title={t("reviewSettings.roundsTitle")} aside={<span className="flex items-center gap-1 text-xs font-normal text-faint"><LockIcon aria-hidden className="size-[13px]" />{t("reviewSettings.setByInstall")}</span>}>
            {data === undefined ? (
              <div className="mt-2 space-y-2"><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-full" /></div>
            ) : (
              <ul className="mt-2" data-testid="round-limits">
                {[
                  { label: t("reviewSettings.ciRounds"), value: data.limits.ciRounds, setting: "OSTRA_CI_ROUNDS", unused: false },
                  { label: t("reviewSettings.reviewRounds"), value: data.limits.reviewRounds, setting: "OSTRA_REVIEW_ROUNDS", unused: !data.aiReview },
                  { label: t("reviewSettings.automaticTurns"), value: data.limits.automaticTurns, setting: "OSTRA_AUTOMATIC_TURNS", unused: false },
                ].map((row) => (
                  <li key={row.setting} className="grid min-h-10 grid-cols-[minmax(0,1fr)_48px_minmax(0,1fr)] items-center gap-3 border-b border-line last:border-b-0 sm:grid-cols-[360px_120px_minmax(0,1fr)]" data-limit={row.setting}>
                    <span className="text-ui text-muted">{row.label}</span>
                    <span className={cn("font-mono text-ui", row.unused ? "text-faint" : "text-text")}>{row.value}</span>
                    <span className="truncate font-mono text-xs text-faint">{row.unused ? t("reviewSettings.unused") : row.setting}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-faint">{t("reviewSettings.roundsNote")}</p>
          </Section>
          {outside === null ? null : (
            <Section
              title={t("reviewSettings.outsideTitle")}
              description={
                <>
                  <p>{outside.on ? t("reviewSettings.outsideOnBody", { project: name }) : t("reviewSettings.outsideOffBody", { project: name })}</p>
                  {orgAdmin ? null : <p className="mt-1 flex items-center gap-1 text-xs text-faint"><LockIcon aria-hidden className="size-3" />{t("reviewSettings.outsideOrgAdmin")}</p>}
                  {!outside.on && outside.changedByName !== null ? <p className="mt-1 text-xs text-faint">{t("reviewSettings.turnedOffBy", { name: outside.changedByName })}</p> : null}
                </>
              }
              end={
                <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
                  <Switch
                    aria-label={t("reviewSettings.outsideTitle")}
                    checked={outside.on}
                    disabled={!orgAdmin || setOutside.isPending}
                    onCheckedChange={(on) => {
                      if (on) setOutside.mutate({ projectId, on });
                      else setConfirmOff(true);
                    }}
                  />
                  <AlertDialogContent
                    title={t("reviewSettings.confirmTitle")}
                    body={t("reviewSettings.confirmBody", { project: name })}
                    cancel={t("reviewSettings.cancel")}
                    action={t("reviewSettings.confirmAction")}
                    onAction={() => { setOutside.mutate({ projectId, on: false }); setConfirmOff(false); }}
                  />
                </AlertDialog>
              }
            />
          )}
          <Section title={t("reviewSettings.ciTitle")}>
            {data === undefined ? (
              <div className="mt-2 space-y-2"><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-full" /></div>
            ) : (
              <ul className="mt-2" data-testid="ci-seen">
                {data.repos.map((repo) => (
                  <li key={repo.repoId} className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-line py-1.5 last:border-b-0 sm:grid-cols-[300px_150px_minmax(0,1fr)]" data-repo={repo.fullName} data-ci={repo.ci?.state ?? "unseen"}>
                    <span className="truncate font-mono text-ui text-text">{repo.fullName}</span>
                    <CiVerdict ci={repo.ci} />
                    <span className="col-span-2 truncate text-sm text-faint sm:col-span-1">{ciDetail(repo.ci, now)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3.5 flex items-center gap-1.5 text-xs text-faint"><InfoIcon aria-hidden className="size-[13px]" />{t("reviewSettings.ciNote")}</p>
          </Section>
        </div>
      </div>
    </PageFrame>
  );
};
