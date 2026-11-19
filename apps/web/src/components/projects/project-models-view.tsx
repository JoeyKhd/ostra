"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, CpuIcon, LoaderCircleIcon, LockIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { modelIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterInputs, RouterOutputs } from "@/lib/trpc";

import { hostOf } from "@/components/models/keys-words";
import { ProvidersPreview } from "@/components/models/providers-preview";

import { followDescription, listChanged, listMark, savedLine } from "./project-models-words";
import { ProjectSettingsTabs } from "./settings-tabs";

type View = RouterOutputs["projects"]["providers"];
type ModelRow = View["models"][number];
type Mode = RouterInputs["projects"]["setProviders"]["mode"];
/** A key's line: its name, where it's used, and (for an organization admin, who reads `providers.list`) how many models it lists. */
type KeyRow = { readonly providerId: string; readonly name: string; readonly host: string; readonly modelCount: number | null };
/** What an organization admin knows of a model name from the keys' model lists: its label, logo, and the rows that serve it. */
type ModelInfo = {
  readonly label: string;
  readonly mono: boolean;
  readonly logoPath: string | null;
  readonly rows: readonly { readonly providerId: string; readonly providerName: string; readonly modelId: string }[];
};

const SAVED_FOR_MS = 4000;

const ModelLogo = ({ path }: { readonly path: string | null }) =>
  path === null ? (
    <CpuIcon aria-hidden className="size-[15px] shrink-0 text-muted" />
  ) : (
    <img src={path} alt="" className="size-[15px] shrink-0 opacity-75 invert" />
  );

/** A model's name: its display name, else its ID in mono. */
const ModelText = ({ info }: { readonly info: ModelInfo }) =>
  info.mono ? <span className="truncate font-mono text-ui">{info.label}</span> : <span className="truncate">{info.label}</span>;

/** One key's row: its name in mono, then `api.openai.com · 1 model`. */
const KeyLine = ({ provider }: { readonly provider: KeyRow }) => (
  <>
    <span className="w-[180px] shrink-0 truncate font-mono text-ui text-text sm:w-[220px]">{provider.name}</span>
    <span className="min-w-0 truncate text-sm text-muted">
      <span className="font-mono">{provider.host}</span>
      {provider.modelCount === null ? null : <> · {plural(provider.modelCount, "models.countOne", "models.countMany")}</>}
    </span>
  </>
);

/** `Change` on a model's row: the providers on the list that list it, as radios, and `Save choice`. */
const ChangeChoice = ({ projectId, model, info, options }: {
  readonly projectId: ProjectId;
  readonly model: ModelRow;
  readonly info: ModelInfo;
  readonly options: ModelInfo["rows"];
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string>(model.served?.modelId ?? "");
  const choose = useMutation(
    trpc.projects.chooseModelProvider.mutationOptions({
      onSuccess: async () => {
        setOpen(false);
        await queryClient.invalidateQueries({ queryKey: trpc.projects.providers.queryKey({ projectId }) });
      },
    }),
  );
  const option = options.find((row) => row.modelId === picked);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="text-ui text-teal hover:underline" aria-label={t("projectModels.models.changeFor", { model: info.label })}>
        {t("projectModels.models.change")}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-3">
        <p className="mb-2 text-xs font-medium text-faint">{t("projectModels.models.servedByLabel", { model: info.label })}</p>
        <RadioGroup value={picked} onValueChange={setPicked} aria-label={t("projectModels.models.servedByLabel", { model: info.label })}>
          {options.map((row) => (
            <label key={row.modelId} className="flex h-8 cursor-pointer items-center gap-2.5">
              <RadioGroupItem value={row.modelId} />
              <span className="truncate font-mono text-ui">{row.providerName}</span>
            </label>
          ))}
        </RadioGroup>
        {choose.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(choose.error)}</p>}
        <Button
          size="sm"
          variant="primary"
          className="mt-2.5"
          disabled={option === undefined || option.modelId === model.served?.modelId || choose.isPending}
          onClick={() => {
            if (option !== undefined) choose.mutate({ projectId, modelId: modelIdSchema.parse(option.modelId) });
          }}
        >
          {choose.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
          {t("projectModels.models.saveChoice")}
        </Button>
      </PopoverContent>
    </Popover>
  );
};

/** The panel without changes: who last changed the project's keys, and when. */
const SummaryPanel = ({ view, projectName, projectId, canEdit }: { readonly view: View; readonly projectName: string; readonly projectId: ProjectId; readonly canEdit: boolean }) => (
  <PropGroup title={projectName}>
    <PropRow label={t("projectModels.summary.keys")}>{view.mode === "own" ? t("projectModels.summary.own") : t("projectModels.summary.default")}</PropRow>
    {canEdit ? (
      <Link href={`/projects/${projectId}/settings/audit`} className="mt-2 inline-flex items-center gap-1 text-sm text-teal hover:underline">
        {t("projectModels.summary.auditLog")}
        <ArrowRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
      </Link>
    ) : null}
  </PropGroup>
);

/**
 * A project's settings › Models and keys (F-135, app-targets/m4/project-models-keys.md): which
 * keys its tasks may use and which serves each model. Only an organization admin changes it; every
 * save shows its preview first. Nobody sees a token.
 */
export const ProjectModelsView = ({ projectId }: { readonly projectId: ProjectId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const view = useQuery(trpc.projects.providers.queryOptions({ projectId }));
  const me = useQuery(trpc.me.get.queryOptions());
  const data = view.data;
  // Only an organization admin changes a project's keys (the API refuses anyone else).
  const canEdit = me.data?.organization?.role === "admin";
  // An organization admin reads every key and what each lists; a member reads the project's keys by name only.
  const all = useQuery(trpc.providers.list.queryOptions(undefined, { enabled: canEdit }));
  const listedModels = useQueries({
    queries: (all.data ?? []).map((provider) => trpc.providers.models.queryOptions({ providerId: provider.id })),
  });
  const infoByText = new Map<string, { label: string; mono: boolean; logoPath: string | null; rows: { providerId: string; providerName: string; modelId: string }[] }>();
  (all.data ?? []).forEach((provider, i) => {
    for (const model of listedModels[i]?.data ?? []) {
      if (!model.listed) continue;
      const text = model.catalogId ?? model.endpointModelId;
      const entry = infoByText.get(text) ?? { label: model.displayName ?? model.endpointModelId, mono: model.displayName === null, logoPath: model.logoPath, rows: [] };
      entry.rows.push({ providerId: provider.id, providerName: provider.name, modelId: model.id });
      infoByText.set(text, entry);
    }
  });
  /** A model as the page draws it: the API's name and logo, and (for an organization admin) the key rows that list it. */
  const infoOf = (model: ModelRow): ModelInfo => ({
    label: model.displayName,
    mono: model.name.kind === "custom",
    logoPath: model.logoPath,
    rows: infoByText.get(model.text)?.rows ?? [],
  });
  const allKeys: readonly KeyRow[] = (all.data ?? []).map((provider) => ({ providerId: provider.id, name: provider.name, host: hostOf(provider.baseUrl), modelCount: provider.modelCount }));
  const defaultIds = new Set<string>((all.data ?? []).filter((provider) => provider.onDefaultList).map((provider) => provider.id));
  const onList: readonly KeyRow[] = (data?.providers ?? []).map((provider) => ({
    providerId: provider.providerId,
    name: provider.name,
    host: provider.host,
    modelCount: all.data?.find((row) => row.id === provider.providerId)?.modelCount ?? null,
  }));

  const savedIds = useMemo(() => new Set<string>((data?.providers ?? []).map((row) => row.providerId)), [data]);
  const [draft, setDraft] = useState<{ readonly own: boolean; readonly ids: ReadonlySet<string> } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (saved === null) return;
    const timer = setTimeout(() => { setSaved(null); }, SAVED_FOR_MS);
    return () => { clearTimeout(timer); };
  }, [saved]);

  const savedState = { own: data?.mode === "own", ids: savedIds };
  const current = draft ?? savedState;
  const dirty = data !== undefined && canEdit && listChanged(savedState, current);
  const mode: Mode = current.own ? { kind: "own", providerIds: [...current.ids].sort() } : { kind: "default" };

  const preview = useQuery(trpc.projects.previewProviders.queryOptions({ projectId, mode }, { enabled: dirty }));
  const save = useMutation(
    trpc.projects.setProviders.mutationOptions({
      onSuccess: async (result) => {
        setDraft(null);
        setConflict(false);
        setSaved(savedLine(result.lines.filter((line) => line.change === "moves" || line.change === "gains").length, result.lines.filter((line) => line.change === "loses").length));
        await queryClient.invalidateQueries({ queryKey: trpc.projects.providers.queryKey({ projectId }) });
      },
      onError: async (error) => {
        if (error.data?.code === "CONFLICT") {
          setConflict(true);
          await queryClient.invalidateQueries({ queryKey: trpc.projects.previewProviders.queryKey() });
        }
      },
    }),
  );

  const projectName = project.data?.name ?? "";
  const pickMode = (value: string) => {
    if (value === "own" && !current.own) {
      // Switching to its own list starts from a copy of the default list (ADR 0065).
      setDraft({ own: true, ids: new Set(defaultIds) });
    } else if (value === "default") {
      setDraft({ own: false, ids: current.ids });
    }
    setConflict(false);
  };
  const toggle = (providerId: string, on: boolean) => {
    const ids = new Set(current.ids);
    if (on) ids.add(providerId);
    else ids.delete(providerId);
    setDraft({ own: true, ids });
    setConflict(false);
  };

  const plan = dirty ? preview.data : undefined;
  const afterOf = new Map((plan?.lines ?? []).map((line) => [line.text, line] as const));
  const noKey = (data?.models ?? []).filter((model) => model.served === null);

  const properties =
    data === undefined ? undefined : dirty ? (
      <ProvidersPreview preview={plan} error={preview.error === null ? null : errorText(preview.error)} conflict={conflict} used={new Set(data.models.map((model) => model.text))} />
    ) : (
      <SummaryPanel view={data} projectName={projectName} projectId={projectId} canEdit={canEdit} />
    );

  return (
    <PageFrame
      crumbs={[
        { label: projectName, href: `/projects/${projectId}` },
        { label: t("projectModels.crumbSettings"), href: `/projects/${projectId}/settings` },
        { label: t("projectModels.title") },
      ]}
      {...(dirty
        ? {
            actions: (
              <>
                <Button onClick={() => { setDraft(null); setConflict(false); }} disabled={save.isPending}>{t("projectModels.discard")}</Button>
                <Button
                  variant="primary"
                  disabled={save.isPending || plan === undefined}
                  onClick={() => {
                    if (plan !== undefined) save.mutate({ projectId, mode, version: plan.version });
                  }}
                >
                  {save.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
                  {t("projectModels.saveList")}
                </Button>
              </>
            ),
          }
        : {})}
      {...(properties === undefined ? {} : { properties })}
    >
      <ProjectSettingsTabs projectId={projectId} admin={project.data?.role === "admin"} />
      <PageHeading
        title={t("projectModels.title")}
        lede={
          <>
            {t("projectModels.ledeBefore")}
            <span className="font-mono">{projectName}</span>
            {t("projectModels.ledeAfter")}
          </>
        }
      />
      {saved === null ? null : (
        <p role="status" className="mt-1 flex items-center gap-1.5 text-ui text-muted">
          <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" /> {saved}
        </p>
      )}
      {data !== undefined && !canEdit ? <p className="mt-1 text-sm text-faint">{t("projectModels.readOnly")}</p> : null}
      {view.error === null ? null : <p role="alert" className="mt-3 text-ui text-red">{errorText(view.error)}</p>}
      {save.error === null || conflict ? null : <p role="alert" className="mt-3 text-ui text-red">{errorText(save.error)}</p>}

      <Section title={t("projectModels.keys.title")}>
        {data === undefined ? (
          <div className="space-y-2" aria-busy>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : canEdit ? (
          <>
            <RadioGroup value={current.own ? "own" : "default"} onValueChange={pickMode} aria-label={t("projectModels.keys.title")}>
              {(["default", "own"] as const).map((value) => {
                const chosen = (value === "own") === current.own;
                return (
                  <label
                    key={value}
                    className={cn("flex min-h-12 cursor-pointer flex-wrap items-center gap-x-3 rounded-md px-3 py-2", chosen && "bg-sel")}
                  >
                    <RadioGroupItem value={value} />
                    <span className="w-[260px] font-medium text-text">{value === "own" ? t("projectModels.own.label") : t("projectModels.follow.label")}</span>
                    <span className="text-sm text-muted">
                      {value === "own" ? t("projectModels.own.description") : followDescription(allKeys.filter((key) => defaultIds.has(key.providerId)).map((key) => key.name))}
                    </span>
                  </label>
                );
              })}
            </RadioGroup>
            <ul className="ml-7 mt-1" data-testid="provider-rows">
              {current.own
                ? allKeys.map((provider) => {
                    const ticked = current.ids.has(provider.providerId);
                    const mark = listMark(provider.providerId, savedState.own ? savedIds : new Set(), current.ids);
                    return (
                      <li key={provider.providerId} className="border-b border-line last:border-b-0">
                        <label className="flex h-10 cursor-pointer items-center gap-3 px-1">
                          <Checkbox
                            checked={ticked}
                            onCheckedChange={(value) => { toggle(provider.providerId, value === true); }}
                            aria-label={provider.name}
                          />
                          <KeyLine provider={provider} />
                          {mark === null ? null : (
                            <span className="ml-auto shrink-0 text-xs text-faint">{mark === "added" ? t("projectModels.own.added") : t("projectModels.own.removed")}</span>
                          )}
                        </label>
                      </li>
                    );
                  })
                : allKeys.filter((provider) => defaultIds.has(provider.providerId)).map((provider) => (
                    <li key={provider.providerId} className="flex h-10 items-center gap-3 border-b border-line px-1 last:border-b-0">
                      <KeyLine provider={provider} />
                    </li>
                  ))}
            </ul>
          </>
        ) : (
          <>
            <div className="flex min-h-12 flex-wrap items-center gap-x-3 px-3 py-2">
              <span className="w-[260px] font-medium text-text">{data.mode === "own" ? t("projectModels.own.label") : t("projectModels.follow.label")}</span>
              <span className="text-sm text-muted">
                {data.mode === "own" ? t("projectModels.own.description") : followDescription(onList.map((key) => key.name))}
              </span>
            </div>
            <ul className="ml-3 mt-1" data-testid="provider-rows">
              {onList.map((provider) => (
                <li key={provider.providerId} className="flex h-10 items-center gap-3 border-b border-line px-1 last:border-b-0">
                  <KeyLine provider={provider} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title={t("projectModels.models.title")} {...(data === undefined ? {} : { count: data.models.length })} className="mt-7">
        {noKey.length > 0 && !dirty ? (
          <div className="mb-2 flex items-start gap-2 text-ui" role="status">
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75] text-text" />
            <span>
              <span className="text-text">
                {t("projectModels.noKey.line", { model: noKey.map((model) => model.displayName).join(", "), project: projectName })}
              </span>{" "}
              <span className="text-muted">{canEdit ? t("projectModels.noKey.admin") : t("projectModels.noKey.member")}</span>
            </span>
          </div>
        ) : null}
        {data === undefined ? (
          <SkeletonRows rows={3} height="h-11" />
        ) : data.models.length === 0 ? (
          <p className="border-t border-line py-3 text-muted">{t("projectModels.models.none")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-body">
              <thead>
                <tr className="h-[30px] border-b border-line text-left text-xs font-medium text-faint">
                  <th className="pr-3 font-medium">{t("projectModels.models.model")}</th>
                  <th className="pr-3 font-medium">{t("projectModels.models.servedBy")}</th>
                  <th className="w-[90px]" aria-label={t("projectModels.models.change")} />
                </tr>
              </thead>
              <tbody>
                {data.models.map((model) => {
                  const info = infoOf(model);
                  const options = info.rows.filter((row) => current.ids.has(row.providerId));
                  const line = afterOf.get(model.text);
                  const moving = line !== undefined && line.change !== "keeps";
                  return (
                    <tr key={model.text} className="h-11 border-b border-line" data-model={model.text}>
                      <td className="pr-3">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <ModelLogo path={info.logoPath} />
                          <span className="min-w-0">
                            <ModelText info={info} />
                          </span>
                        </span>
                      </td>
                      <td className="pr-3">
                        {moving ? (
                          <span className="flex items-center gap-2 font-mono text-ui">
                            {line.before === null ? null : <s className="text-faint">{line.before.providerName}</s>}
                            <ArrowRightIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-muted" />
                            {line.after === null ? <span className="text-red">{t("projectModels.models.noKey")}</span> : <span className="text-text">{line.after.providerName}</span>}
                          </span>
                        ) : model.served === null ? (
                          <span className="flex items-center gap-1.5 font-mono text-ui text-red">
                            <TriangleAlertIcon aria-hidden className="size-[13px] stroke-[1.75]" />
                            {t("projectModels.models.noKey")}
                          </span>
                        ) : (
                          <span className="font-mono text-ui text-text">{model.served.providerName}</span>
                        )}
                      </td>
                      <td className="text-right">
                        {!canEdit ? null : data.mode === "default" ? (
                          <Link href="/organization/models" className="text-ui text-teal hover:underline">{t("projectModels.models.setInModels")}</Link>
                        ) : options.length <= 1 ? (
                          <span className="text-xs text-faint">{t("projectModels.models.onlyKey")}</span>
                        ) : (
                          <ChangeChoice projectId={projectId} model={model} info={info} options={options} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3.5 flex items-center gap-2 text-sm text-faint">
          <LockIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
          {t("projectModels.tokenLine")}
        </p>
      </Section>
    </PageFrame>
  );
};
