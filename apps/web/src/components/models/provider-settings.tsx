"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { PersonalRunnersSwitch, formatLabel } from "./add-provider-form";
import { KeyLogo } from "./keys-sections";
import { formatSpend } from "./keys-words";

type Provider = RouterOutputs["providers"]["list"][number];

/**
 * A provider's properties: its endpoint (the token is never shown), and the two settings an admin
 * changes later: the sessions cap and "Allow on personal runners". Both are written optimistically
 * and rolled back if the server refuses.
 */
export const ProviderSettings = ({ provider }: { readonly provider: Provider }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listKey = trpc.providers.list.queryKey();
  const [cap, setCap] = useState(provider.sessionsAtOnce === null ? "" : String(provider.sessionsAtOnce));

  const update = useMutation(
    trpc.providers.update.mutationOptions({
      onMutate: async (input) => {
        await queryClient.cancelQueries({ queryKey: listKey });
        const previous = queryClient.getQueryData(listKey);
        queryClient.setQueryData(listKey, (rows) =>
          rows?.map((row) =>
            row.id === input.providerId
              ? {
                  ...row,
                  ...(input.sessionsAtOnce === undefined ? {} : { sessionsAtOnce: input.sessionsAtOnce }),
                  ...(input.allowOnPersonalRunners === undefined ? {} : { allowOnPersonalRunners: input.allowOnPersonalRunners }),
                }
              : row,
          ),
        );
        return { previous };
      },
      onError: (_error, _input, context) => {
        if (context !== undefined) queryClient.setQueryData(listKey, context.previous);
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
    }),
  );
  const refresh = useMutation(
    trpc.providers.refresh.mutationOptions({
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: listKey }),
          queryClient.invalidateQueries({ queryKey: trpc.providers.models.queryKey({ providerId: provider.id }) }),
        ]),
    }),
  );

  const parsedCap = cap.trim() === "" ? null : Number.parseInt(cap, 10);
  const capChanged = parsedCap !== provider.sessionsAtOnce;

  const models = useQuery(trpc.providers.models.queryOptions({ providerId: provider.id }));
  const listed = (models.data ?? []).filter((model) => model.listed);
  const [editing, setEditing] = useState(false);

  return (
    <div data-testid="provider-settings">
      <h2 className="mb-1 text-xs font-medium text-faint">{t("models.keys.key")}</h2>
      <div className="mb-3 flex items-center gap-2">
        <KeyLogo host={provider.host} />
        <span className="truncate font-mono text-[15px] font-semibold">{provider.name}</span>
      </div>
      <div className="mb-3.5 border-b border-line pb-3.5">
        <PropRow label={t("models.baseUrl")} labelWidth={112}>
          <span className="truncate font-mono text-[12.5px]" title={provider.baseUrl}>{provider.baseUrl}</span>
        </PropRow>
        <PropRow label={t("models.format")} labelWidth={112}>{formatLabel(provider.apiFormat)}</PropRow>
        <PropRow label={t("models.token")} labelWidth={112}>
          <LockIcon aria-hidden className="stroke-[1.75]" />
          {t("models.tokenStored")}
        </PropRow>
        <PropRow label={t("models.keys.atOnceLabel")} labelWidth={112}>
          {provider.sessionsAtOnce === null ? t("models.noCap") : <span className="font-mono">{plural(provider.sessionsAtOnce, "models.keys.sessionsOne", "models.keys.sessionsMany")}</span>}
        </PropRow>
        <PropRow label={t("models.keys.personalLabel")} labelWidth={112}>{provider.allowOnPersonalRunners ? t("models.keys.on") : t("models.keys.off")}</PropRow>
      </div>
      <div className="mb-3.5 border-b border-line pb-3.5" data-testid="provider-projects">
        <h3 className="mb-1.5 flex items-center text-xs font-medium text-faint">
          {t("models.keys.projects")}
          <span className="ml-1.5 font-mono">{provider.projects.length}</span>
        </h3>
        {provider.projects.length === 0 ? (
          <p className="text-sm text-faint">{t("models.keys.noProjects")}</p>
        ) : (
          <>
            <ul>
              {provider.projects.map((project) => (
                <li key={project.projectId} className="flex h-[30px] items-center gap-2 text-ui">
                  <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(project.projectId) }} />
                  <span className="truncate font-mono text-text">{project.name}</span>
                  <span className="ml-auto shrink-0 text-faint">{project.via === "own" ? t("models.keys.viaOwn") : t("models.keys.viaDefault")}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[12.5px] text-faint">{t("models.keys.onlyAdmins")}</p>
          </>
        )}
      </div>
      <div className="mb-3.5 border-b border-line pb-3.5">
        <h3 className="mb-1.5 flex items-center text-xs font-medium text-faint">
          {t("models.keys.modelsItLists")}
          <span className="ml-1.5 font-mono">{listed.length}</span>
        </h3>
        <ul>
          {listed.map((model) => (
            <li key={model.id} className="flex min-h-[30px] items-center gap-2 text-ui">
              {model.logoPath === null ? null : <img src={model.logoPath} alt="" className="size-[15px] shrink-0 opacity-75 invert" />}
              <span className={model.displayName === null ? "truncate font-mono" : "truncate"}>{model.displayName ?? model.endpointModelId}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mb-3.5 border-b border-line pb-3.5">
        <h3 className="mb-1.5 text-xs font-medium text-faint">{t("models.keys.thisMonthLabel")}</h3>
        <PropRow label={t("models.keys.spent")} labelWidth={112}><span className="ml-auto font-mono">{formatSpend(provider.monthSpentMicroUsd / 1_000_000)}</span></PropRow>
        <PropRow label={t("models.keys.tasks")} labelWidth={112}><span className="ml-auto font-mono">{provider.monthTaskCount}</span></PropRow>
      </div>
      {editing ? null : <Button onClick={() => { setEditing(true); }}>{t("models.keys.editProvider")}</Button>}
      {editing ? (
      <>
      <PropGroup title={t("models.endpoint")}>
        <PropRow label={t("models.baseUrl")}>
          <span className="truncate font-mono text-sm" title={provider.baseUrl}>{provider.baseUrl}</span>
        </PropRow>
        <PropRow label={t("models.format")}>{formatLabel(provider.apiFormat)}</PropRow>
        <PropRow label={t("models.auth")}>
          <span className="font-mono text-sm">{provider.authScheme}</span>
        </PropRow>
        <PropRow label={t("models.token")}>
          <span className="text-faint">{t("models.tokenStored")}</span>
        </PropRow>
        <PropRow label={t("models.models")}>
          <span className="font-mono">{provider.modelCount}</span>
          {provider.modelsRefreshedAt === null ? null : (
            <span className="text-faint">{t("models.refreshedAgo", { age: formatAge(provider.modelsRefreshedAt) })}</span>
          )}
        </PropRow>
        <Button size="sm" className="mt-2" onClick={() => { refresh.mutate({ providerId: provider.id }); }} disabled={refresh.isPending}>
          <RefreshCwIcon /> {refresh.isPending ? t("models.refreshing") : t("models.refresh")}
        </Button>
        {refresh.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(refresh.error)}</p>}
      </PropGroup>
      <PropGroup title={t("models.limits")}>
        <Field id="settings-cap" label={t("models.sessionsCap")} help={t("models.sessionsCapHelp")}>
          <div className="flex gap-2">
            <Input id="settings-cap" inputMode="numeric" className="font-mono" value={cap} onChange={(e) => { setCap(e.target.value.replace(/\D/g, "")); }} placeholder={t("models.noCap")} />
            <Button
              disabled={!capChanged || update.isPending}
              onClick={() => { update.mutate({ providerId: provider.id, sessionsAtOnce: parsedCap }); }}
            >
              {t("common.save")}
            </Button>
          </div>
        </Field>
        <PersonalRunnersSwitch
          id="settings-personal"
          checked={provider.allowOnPersonalRunners}
          onChange={(value) => { update.mutate({ providerId: provider.id, allowOnPersonalRunners: value }); }}
        />
        {update.error === null ? null : <p role="alert" className="text-sm text-red">{errorText(update.error)}</p>}
      </PropGroup>
      </>
      ) : null}
    </div>
  );
};
