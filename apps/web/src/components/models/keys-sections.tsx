"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, HandIcon, ListIcon, LoaderCircleIcon, ServerIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Section } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { formatLabel } from "./add-provider-form";
import { followedBy, formatSpend, keyLogoPath } from "./keys-words";

type Provider = RouterOutputs["providers"]["list"][number];
type ToConfirm = RouterOutputs["providers"]["choicesToConfirm"][number];

const STATUS_FOR_MS = 4000;

/** The organization's default list, as `providers.list` gives it: its providers and the projects that follow it. */
export type DefaultList = {
  readonly providers: readonly { readonly providerId: string; readonly name: string }[];
  readonly followers: readonly { readonly projectId: string; readonly name: string }[];
};

/** The default list from `providers.list`: the providers on it, and the projects that use them through it. */
export const defaultListOf = (providers: readonly Provider[] | undefined): DefaultList | undefined => {
  if (providers === undefined) return undefined;
  const followers = new Map<string, string>();
  for (const provider of providers) for (const project of provider.projects) if (project.via === "default") followers.set(project.projectId, project.name);
  return {
    providers: providers.filter((provider) => provider.onDefaultList).map((provider) => ({ providerId: provider.id, name: provider.name })),
    followers: [...followers.entries()].map(([projectId, name]) => ({ projectId, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
};

/** A key's logo: its vendor's, by the base URL's host, else Lucide `server`. */
export const KeyLogo = ({ host }: { readonly host: string }) => {
  const path = keyLogoPath(host);
  return path === null ? (
    <ServerIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
  ) : (
    <img src={path} alt="" className="size-[15px] shrink-0 opacity-75 invert" />
  );
};

const ProjectSquare = ({ projectId }: { readonly projectId: string }) => (
  <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(projectId) }} />
);

/** The default list's row: its keys as chips, and the projects that follow it. */
export const DefaultListSection = ({ list, editing, onEdit, draft, onToggle, providers }: {
  readonly list: DefaultList | undefined;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly draft: ReadonlySet<string>;
  readonly onToggle: (providerId: string, on: boolean) => void;
  readonly providers: readonly Provider[];
}) => {
  const followers = followedBy((list?.followers ?? []).map((project) => project.name));
  return (
    <Section title={t("models.keys.defaultList")} end={list === undefined || editing ? undefined : <button type="button" className="text-teal hover:underline" onClick={onEdit}>{t("models.keys.edit")}</button>}>
      {list === undefined ? (
        <SkeletonRows rows={1} height="h-10" />
      ) : editing ? (
        <ul className="border-y border-line" data-testid="default-list-edit">
          {providers.map((provider) => (
            <li key={provider.id} className="border-b border-line last:border-b-0">
              <label className="flex h-10 cursor-pointer items-center gap-3 px-1">
                <Checkbox checked={draft.has(provider.id)} onCheckedChange={(value) => { onToggle(provider.id, value === true); }} aria-label={provider.name} />
                <span className="w-[200px] shrink-0 truncate font-mono text-ui text-text">{provider.name}</span>
                <span className="min-w-0 truncate text-sm text-muted">
                  <span className="font-mono">{provider.host}</span> · {plural(provider.modelCount, "models.countOne", "models.countMany")}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-y border-line px-1 py-1.5" data-testid="default-list">
          <ListIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
          {list.providers.length === 0 ? (
            <span className="text-faint">{t("models.keys.emptyDefault")}</span>
          ) : (
            list.providers.map((provider) => (
              <span key={provider.providerId} className="inline-flex h-6 items-center rounded-[6px] border border-line-2 px-2 font-mono text-[12.5px] text-text">
                {provider.name}
              </span>
            ))
          )}
          <span className="text-sm text-muted">
            {followers.lead}
            {followers.names.map((name, i) => {
              const project = list.followers[i];
              return (
                <span key={project?.projectId ?? name}>
                  {i === 0 ? " " : ", "}
                  {project === undefined ? (
                    <span className="font-mono text-text">{name}</span>
                  ) : (
                    <Link href={`/projects/${project.projectId}/settings/models`} className="font-mono text-text hover:underline">{name}</Link>
                  )}
                </span>
              );
            })}
            {followers.more === null ? null : ` ${followers.more}`}
          </span>
        </div>
      )}
      {editing ? null : (
        <p className="mt-2 text-sm text-faint">{providers.length === 1 ? t("models.keys.firstOnDefault") : t("models.keys.joinsNoList")}</p>
      )}
    </Section>
  );
};

/** One key: two lines, its host, format, models and spend, then the projects that use it. */
const KeyBlock = ({ provider, selected, onSelect }: { readonly provider: Provider; readonly selected: boolean; readonly onSelect: () => void }) => {
  const viaDefault = provider.projects.filter((project) => project.via === "default");
  const viaOwn = provider.projects.filter((project) => project.via === "own");
  const run = (projects: readonly Provider["projects"][number][], via: string) =>
    projects.length === 0 ? null : (
      <span className="inline-flex flex-wrap items-center gap-x-2">
        {projects.map((project) => (
          <span key={project.projectId} className="inline-flex items-center gap-1.5">
            <ProjectSquare projectId={project.projectId} />
            <span className="font-mono text-text">{project.name}</span>
          </span>
        ))}
        <span className="text-faint">· {via}</span>
      </span>
    );
  return (
    <li className="border-b border-line">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        data-testid="key-block"
        className={cn("block w-full rounded-[6px] px-3 py-2.5 text-left hover:bg-hover", selected && "bg-sel hover:bg-sel")}
      >
        <span className="flex min-h-7 items-center gap-3">
          <KeyLogo host={provider.host} />
          {/* One line at the double sidebar's 744px column (models-keys.webp): the host gives way first, nothing wraps. */}
          <span className="max-w-[120px] shrink-0 truncate font-mono text-[14px] text-text sm:max-w-[180px]">{provider.name}</span>
          <span className="hidden min-w-0 truncate font-mono text-[12.5px] text-faint md:inline">{provider.host}</span>
          <span className="hidden shrink-0 whitespace-nowrap text-sm text-muted lg:inline">{formatLabel(provider.apiFormat)}</span>
          <span className="hidden shrink-0 whitespace-nowrap text-sm text-muted sm:inline">{plural(provider.modelCount, "models.countOne", "models.countMany")}</span>
          <span className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap text-sm">
            <span>
              <span className="font-mono text-text">{formatSpend(provider.monthSpentMicroUsd / 1_000_000)}</span> <span className="text-faint">{t("models.keys.thisMonth")}</span>
            </span>
            {provider.sessionsAtOnce === null ? null : <span className="hidden text-faint sm:inline">{t("models.keys.atOnce", { n: provider.sessionsAtOnce })}</span>}
            {provider.allowOnPersonalRunners ? <Chip className="hidden sm:inline-flex">{t("models.personalAllowed")}</Chip> : null}
          </span>
        </span>
        <span className="mt-0.5 block pl-[27px] text-sm text-faint sm:hidden">
          <span className="font-mono">{provider.host}</span> · {plural(provider.modelCount, "models.countOne", "models.countMany")}
        </span>
        <span className="mt-0.5 flex min-h-6 flex-wrap items-center gap-x-4 pl-[27px] text-sm">
          {provider.projects.length === 0 ? (
            <span className="text-muted">{t("models.keys.onNoList")}</span>
          ) : (
            <>
              <span className="text-faint">{t("models.keys.usedBy")}</span>
              {run(viaDefault, t("models.keys.viaDefault"))}
              {run(viaOwn, t("models.keys.viaOwn"))}
            </>
          )}
        </span>
      </button>
    </li>
  );
};

export const KeysSection = ({ providers, selectedId, onSelect }: {
  readonly providers: readonly Provider[] | undefined;
  readonly selectedId: string | null;
  readonly onSelect: (providerId: string) => void;
}) => (
  <Section title={t("models.keys.title")} {...(providers === undefined ? {} : { count: providers.length })} className="mt-7">
    {providers === undefined ? (
      <div aria-busy className="space-y-2">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[60px] w-full" />)}
      </div>
    ) : providers.length === 0 ? (
      <p className="border-t border-line py-3 text-muted">{t("models.noProviders")}</p>
    ) : (
      <ul className="border-t border-line">
        {[...providers]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((provider) => (
            <KeyBlock key={provider.id} provider={provider} selected={selectedId === provider.id} onSelect={() => { onSelect(provider.id); }} />
          ))}
      </ul>
    )}
  </Section>
);

const choiceTitle = (row: ToConfirm): string =>
  row.project === null ? t("models.confirm.onDefault", { model: row.displayName }) : t("models.confirm.onProject", { model: row.displayName, project: row.project.name });

/** One upgrade choice to confirm, with `Change` (the providers that list it, as radios) and `Confirm`. */
const ConfirmRow = ({ row, onDone }: { readonly row: ToConfirm; readonly onDone: (text: string) => void }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [picked, setPicked] = useState<string>(row.kept.modelId);
  const options = [row.kept, ...row.alternatives];
  const confirm = useMutation(
    trpc.providers.confirmChoice.mutationOptions({
      onSuccess: async (_result, input) => {
        const name = options.find((option) => option.modelId === (input.modelId ?? row.kept.modelId))?.name ?? row.kept.name;
        onDone(t("models.confirm.kept", { key: name }));
        await queryClient.invalidateQueries({ queryKey: trpc.providers.pathKey() });
      },
    }),
  );
  const busy = confirm.isPending;
  return (
    <li className="border-b border-line" data-testid="confirm-row">
      <div className="flex min-h-11 flex-wrap items-center gap-3 border-l-(length:--rule-needs-you) border-amber py-1.5 pl-3">
        <HandIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-amber-text" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-text">{choiceTitle(row)}</span>
          <span className="block text-sm text-muted">
            {t("models.confirm.reasonBefore", { n: options.length })}
            <span className="font-mono">{row.kept.name}</span>
            {t("models.confirm.reasonAfter")}
          </span>
        </span>
        <span className="flex shrink-0 gap-2">
          <Button size="sm" disabled={busy} onClick={() => { setChanging((open) => !open); }}>{t("models.confirm.change")}</Button>
          <Button size="sm" disabled={busy} onClick={() => { confirm.mutate({ projectId: row.project?.projectId ?? null, modelName: row.modelName }); }}>
            {busy ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
            {t("models.confirm.confirm")}
          </Button>
        </span>
      </div>
      {changing ? (
        <div className="py-2 pl-[30px]">
          <RadioGroup value={picked} onValueChange={setPicked} aria-label={choiceTitle(row)}>
            {options.map((option) => (
              <label key={option.modelId} className="flex h-8 cursor-pointer items-center gap-2.5">
                <RadioGroupItem value={option.modelId} />
                <span className="font-mono text-ui">{option.name}</span>
              </label>
            ))}
          </RadioGroup>
          <Button size="sm" variant="primary" className="mt-2" disabled={busy} onClick={() => { const chosen = options.find((option) => option.modelId === picked); if (chosen !== undefined) confirm.mutate({ projectId: row.project?.projectId ?? null, modelName: row.modelName, modelId: chosen.modelId }); }}>
            {t("models.confirm.saveChoice")}
          </Button>
        </div>
      ) : null}
      {confirm.error === null ? null : <p role="alert" className="pb-2 pl-[30px] text-sm text-red">{errorText(confirm.error)}</p>}
    </li>
  );
};

/** The upgrade's choices to confirm: only while one has `needsConfirm`. */
export const ToConfirmSection = ({ rows }: { readonly rows: readonly ToConfirm[] }) => {
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (status === null) return;
    const timer = setTimeout(() => { setStatus(null); }, STATUS_FOR_MS);
    return () => { clearTimeout(timer); };
  }, [status]);
  if (rows.length === 0 && status === null) return null;
  return (
    <Section title={t("models.confirm.title")} count={rows.length} className="mt-7">
      {status === null ? null : (
        <p role="status" className="mb-2 flex items-center gap-1.5 text-ui text-muted">
          <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" /> {status}
        </p>
      )}
      <ul className="border-t border-line">
        {rows.map((row) => <ConfirmRow key={`${row.project?.projectId ?? "default"}-${row.text}`} row={row} onDone={setStatus} />)}
      </ul>
    </Section>
  );
};

/** The default list's preview and save, for the page to hold while the list is edited. */
export const useDefaultListEdit = (list: DefaultList | undefined) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ReadonlySet<string> | null>(null);
  const [conflict, setConflict] = useState(false);
  const saved = new Set((list?.providers ?? []).map((provider) => provider.providerId));
  const current = draft ?? saved;
  const providerIds = [...current].sort();
  const changed = draft !== null && (draft.size !== saved.size || [...draft].some((id) => !saved.has(id)));
  const preview = useQuery(trpc.providers.previewDefaultList.queryOptions({ providerIds }, { enabled: changed }));
  const save = useMutation(
    trpc.providers.setDefaultList.mutationOptions({
      onSuccess: async () => {
        setDraft(null);
        setConflict(false);
        await queryClient.invalidateQueries({ queryKey: trpc.providers.pathKey() });
      },
      onError: async (error) => {
        if (error.data?.code === "CONFLICT") {
          setConflict(true);
          await queryClient.invalidateQueries({ queryKey: trpc.providers.previewDefaultList.queryKey() });
        }
      },
    }),
  );
  return {
    editing: draft !== null,
    changed,
    draft: current,
    conflict,
    preview,
    save,
    start: () => { setDraft(new Set(saved)); },
    cancel: () => { setDraft(null); setConflict(false); },
    toggle: (providerId: string, on: boolean) => {
      const next = new Set(current);
      if (on) next.add(providerId);
      else next.delete(providerId);
      setDraft(next);
      setConflict(false);
    },
    submit: () => {
      if (preview.data !== undefined) save.mutate({ providerIds, version: preview.data.version });
    },
  };
};
