"use client";

import { CheckIcon, ChevronDownIcon, CpuIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";

import { projectColour } from "@/components/shell/project-colour";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { disambiguatorsOf, keysText, matchesQuery, noKeyText, sortOptions } from "./model-picker-words";

// The profile's model, chosen by name (F-135, F-021, app-targets/m4/agent-profile-model.md): a
// combobox over the models its provider lists, picked first (ADR 0065 amended 2026-11-20). With no
// provider (a profile saved before), it lists every model name any key lists, each with the keys
// that list it and the projects where no key serves it.

export type ModelOption = RouterOutputs["agentProfiles"]["modelOptions"][number];

const ModelLogo = () => <CpuIcon aria-hidden className="size-[15px] shrink-0 text-muted" />;

/** Whether a model is a custom one, named by its endpoint ID (set in mono). */
const isCustom = (option: ModelOption): boolean => option.name.kind === "custom";

/**
 * A model's name: its display name, or a custom model's endpoint ID in mono. Then, muted, the
 * endpoint ID that tells it from another model of the same name on one of its keys (F-088).
 */
export const ModelLabel = ({ option, endpointId }: { readonly option: ModelOption; readonly endpointId?: string | undefined }) => (
  <>
    {isCustom(option) ? <span className="truncate font-mono text-ui">{option.text}</span> : <span className="truncate">{option.displayName}</span>}
    {endpointId === undefined ? null : <span className="min-w-0 truncate font-mono text-xs text-muted" data-testid="model-endpoint-id">{endpointId}</span>}
  </>
);

/** The keys that list a model, by name. */
const keyNames = (option: ModelOption): readonly string[] => option.providers.map((provider) => provider.name);

export const ModelPicker = ({ options, chosenKey, onPick, onHighlight, labelledBy, loading, provider }: {
  readonly options: readonly ModelOption[] | undefined;
  readonly chosenKey: string | null;
  /** The profile's provider: the options are its models alone, so no key column and no by-name warning. */
  readonly provider: { readonly name: string } | null;
  readonly onPick: (option: ModelOption) => void;
  /** The option the keyboard or the pointer is on while open, so the panel previews it; null when closed. */
  readonly onHighlight: (option: ModelOption | null) => void;
  readonly labelledBy: string;
  readonly loading: boolean;
}) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [custom, setCustom] = useState<string | null>(null);
  const shown = useMemo(() => sortOptions((options ?? []).filter((option) => matchesQuery(option, query))), [options, query]);
  const endpointIds = useMemo(() => disambiguatorsOf(options ?? []), [options]);
  const chosen = options?.find((option) => option.text === chosenKey);

  if (loading || options === undefined) return <Skeleton className="h-8 w-full" />;
  if (options.length === 0 && provider !== null) {
    return (
      <button type="button" disabled className="flex h-8 w-full items-center rounded-[7px] border border-line-2 bg-surface px-2.5 text-left text-faint" data-testid="profile-model">
        {t("agentProfiles.editor.providerNoModels", { provider: provider.name })}
      </button>
    );
  }
  if (options.length === 0) {
    return (
      <>
        <button type="button" disabled className="flex h-8 w-full items-center rounded-[7px] border border-line-2 bg-surface px-2.5 text-left text-faint">
          {t("agentProfiles.editor.modelPicker.noModelYet")}
        </button>
        <Link href="/organization/models" className="mt-1.5 inline-block text-sm text-teal hover:underline">{t("agentProfiles.editor.addProvider")}</Link>
      </>
    );
  }

  const setOpenAndReset = (next: boolean) => {
    setOpen(next);
    setQuery("");
    setActive(0);
    setCustom(null);
    onHighlight(null);
  };
  const move = (index: number) => {
    setActive(index);
    onHighlight(shown[index] ?? null);
  };
  const pick = (option: ModelOption) => {
    onPick(option);
    setOpenAndReset(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(Math.min(active + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(Math.max(active - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = shown[active];
      if (option !== undefined) pick(option);
    }
  };
  const customMatch = custom === null ? undefined : options.find((option) => isCustom(option) && option.text === custom.trim());
  const listId = `${id}-list`;
  const groupLabel = provider === null ? t("agentProfiles.editor.modelPicker.group") : t("agentProfiles.editor.modelPicker.groupOf", { provider: provider.name });

  return (
    <Popover open={open} onOpenChange={setOpenAndReset}>
      <PopoverTrigger
        aria-labelledby={labelledBy}
        data-testid="profile-model"
        className={cn("flex h-8 w-full items-center gap-2 rounded-[7px] border border-line-2 bg-surface px-2.5 text-left text-body", open && "border-text")}
      >
        {chosen === undefined ? (
          <span className="truncate text-faint">{t("agentProfiles.editor.pickModelPlaceholder")}</span>
        ) : (
          <>
            <ModelLogo />
            <ModelLabel option={chosen} endpointId={endpointIds.get(chosen.text)} />
            {chosen.providers.length === 0 ? <TriangleAlertIcon aria-label={t("agentProfiles.editor.modelPicker.noKeyLists")} className="size-[13px] shrink-0 stroke-[1.75] text-red" /> : null}
          </>
        )}
        <ChevronDownIcon aria-hidden className="ml-auto size-[14px] shrink-0 stroke-[1.75] text-faint" />
      </PopoverTrigger>
      <PopoverContent className="w-[min(520px,calc(100vw-32px))] max-h-[min(460px,var(--radix-popover-content-available-height))] bg-surface p-0 shadow-none">
        {custom === null ? (
          <>
            <div className="flex h-10 items-center gap-2 border-b border-line px-3">
              <SearchIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
              <input
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={shown[active] === undefined ? undefined : `${id}-opt-${String(active)}`}
                aria-label={t("agentProfiles.editor.modelPicker.search")}
                placeholder={t("agentProfiles.editor.modelPicker.search")}
                autoFocus
                value={query}
                onChange={(event) => { setQuery(event.target.value); setActive(0); onHighlight(null); }}
                onKeyDown={onKeyDown}
                className="h-full min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-faint"
              />
            </div>
            <p className="px-3 pb-1 pt-2.5 text-xs font-medium text-faint">{groupLabel}</p>
            <ul role="listbox" id={listId} aria-label={groupLabel} className="px-1">
              {shown.length === 0 ? (
                <li className="px-2 py-2.5 text-sm text-muted">{t("agentProfiles.editor.modelPicker.empty", { query })}</li>
              ) : (
                shown.map((option, index) => {
                  const noKey = provider === null ? noKeyText(option.projectsWithout.map((project) => project.name)) : null;
                  return (
                    <li
                      key={option.text}
                      id={`${id}-opt-${String(index)}`}
                      role="option"
                      aria-selected={option.text === chosenKey}
                      data-testid="model-option"
                      onMouseEnter={() => { move(index); }}
                      onMouseDown={(event) => { event.preventDefault(); }}
                      onClick={() => { pick(option); }}
                      className={cn("cursor-pointer rounded-md px-2 py-1.5", index === active && "bg-sel")}
                    >
                      <span className="flex h-[22px] items-center gap-2">
                        <span className="w-[15px] shrink-0">{option.text === chosenKey ? <CheckIcon aria-hidden className="size-[15px] stroke-[1.75] text-green" /> : null}</span>
                        <ModelLogo />
                        <ModelLabel option={option} endpointId={endpointIds.get(option.text)} />
                        {provider === null ? <span className="ml-auto hidden shrink-0 font-mono text-xs text-faint sm:inline">{keysText(keyNames(option))}</span> : null}
                      </span>
                      {provider === null ? <span className="block pl-[46px] font-mono text-xs text-faint sm:hidden">{keysText(keyNames(option))}</span> : null}
                      {noKey === null ? null : (
                        <span className="flex items-center gap-1.5 pl-[46px] text-[12.5px] text-muted">
                          <TriangleAlertIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
                          {noKey}
                        </span>
                      )}
                    </li>
                  );
                })
              )}
            </ul>
            <div className="mt-1 border-t border-line px-1 py-1">
              <button type="button" onClick={() => { setCustom(""); onHighlight(null); }} className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-muted hover:bg-sel">
                <PlusIcon aria-hidden className="size-[15px] stroke-[1.75]" />
                {t("agentProfiles.editor.modelPicker.custom")}
              </button>
            </div>
          </>
        ) : (
          <div className="p-3">
            <label htmlFor={`${id}-custom`} className="mb-1.5 block text-sm font-medium text-muted">{t("agentProfiles.editor.modelPicker.endpointId")}</label>
            <Input id={`${id}-custom`} className="h-8 font-mono" value={custom} onChange={(event) => { setCustom(event.target.value); }} placeholder="acme/sql-coder-ft" />
            <p className="mt-1.5 text-sm text-faint">{t("agentProfiles.editor.modelPicker.endpointHelp")}</p>
            {custom.trim() === "" ? null : customMatch === undefined ? (
              <p className="mt-1.5 text-[12.5px] text-muted">{t("agentProfiles.editor.modelPicker.noKeyListsId")}</p>
            ) : provider !== null || noKeyText(customMatch.projectsWithout.map((project) => project.name)) === null ? null : (
              <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-muted">
                <TriangleAlertIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
                {noKeyText(customMatch.projectsWithout.map((project) => project.name))}
              </p>
            )}
            <Button size="sm" variant="primary" className="mt-2.5" disabled={customMatch === undefined} onClick={() => { if (customMatch !== undefined) pick(customMatch); }}>
              {t("agentProfiles.editor.modelPicker.useId")}
            </Button>
          </div>
        )}
        <p className="border-t border-line px-3 py-2 text-xs text-faint">
          {provider === null ? t("agentProfiles.editor.modelPicker.footer") : t("agentProfiles.editor.modelPicker.footerOf", { provider: provider.name })}
        </p>
      </PopoverContent>
    </Popover>
  );
};

/** One project's line in the panel's group: the key that serves the profile there, or `null` for none. */
export type ProjectKeyLine = { readonly projectId: string; readonly name: string; readonly providerName: string | null };

/**
 * The panel's `{model} in each project`: the key that serves it in each project, or `No key`. With
 * the profile's own provider (ADR 0065 amended 2026-11-20), `{provider} in each project`: the
 * provider where a project allows it, else `Not allowed`.
 */
export const ModelInProjects = ({ option, organizationAdmin, provider }: {
  readonly option: ModelOption | undefined;
  readonly organizationAdmin: boolean;
  /** The profile's provider and each project's allowance, from `agentProfiles.providerOptions`. */
  readonly provider?: { readonly name: string; readonly projects: readonly { readonly projectId: string; readonly name: string; readonly allowed: boolean }[] } | undefined;
}) => {
  if (option === undefined && provider === undefined) return null;
  const lines: readonly ProjectKeyLine[] =
    provider === undefined
      ? (option?.projects ?? [])
      : provider.projects.map((project) => ({ projectId: project.projectId, name: project.name, providerName: project.allowed ? provider.name : null }));
  const missing = lines.filter((project) => project.providerName === null);
  const [only] = missing;
  const title =
    provider === undefined
      ? t("agentProfiles.editor.modelPicker.inEachProject", { model: option === undefined ? "" : isCustom(option) ? option.text : option.displayName })
      : t("agentProfiles.editor.modelPicker.inEachProjectOf", { provider: provider.name });
  const missingWord = provider === undefined ? t("agentProfiles.editor.modelPicker.noKey") : t("agentProfiles.editor.modelPicker.notAllowed");
  return (
    <div className="mb-3.5 border-b border-line pb-3.5" data-testid="model-in-projects">
      <h3 className="mb-2 text-xs font-medium text-faint">{title}</h3>
      <ul>
        {lines.map((project) => (
          <li key={project.projectId} className="flex h-[30px] items-center gap-2 text-ui">
            <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(project.projectId) }} />
            <span className="truncate text-text">{project.name}</span>
            {project.providerName === null ? (
              organizationAdmin ? (
                <Link href={`/projects/${project.projectId}/settings/models`} className="ml-auto flex shrink-0 items-center gap-1 text-teal hover:underline">
                  <TriangleAlertIcon aria-hidden className="size-[13px] stroke-[1.75]" />
                  {missingWord}
                </Link>
              ) : (
                <span className="ml-auto flex shrink-0 items-center gap-1 text-red">
                  <TriangleAlertIcon aria-hidden className="size-[13px] stroke-[1.75]" />
                  {missingWord}
                </span>
              )
            ) : (
              <span className="ml-auto shrink-0 truncate font-mono text-muted">{project.providerName}</span>
            )}
          </li>
        ))}
      </ul>
      {only === undefined ? null : (
        <p className="mt-1.5 text-[12.5px] text-faint">
          {provider === undefined
            ? missing.length === 1
              ? t("agentProfiles.editor.modelPicker.cantStartOne", { project: only.name })
              : t("agentProfiles.editor.modelPicker.cantStartMany", { n: missing.length })
            : missing.length === 1
              ? t("agentProfiles.editor.modelPicker.cantStartOneOf", { project: only.name, provider: provider.name })
              : t("agentProfiles.editor.modelPicker.cantStartManyOf", { n: missing.length, provider: provider.name })}
        </p>
      )}
    </div>
  );
};
