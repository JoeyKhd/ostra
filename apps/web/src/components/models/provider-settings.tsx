"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { PersonalRunnersSwitch, formatLabel } from "./add-provider-form";

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

  return (
    <div data-testid="provider-settings">
      <h2 className="mb-1 text-xs font-medium text-faint">{t("models.provider")}</h2>
      <div className="mb-4 flex items-center gap-2">
        <ServerIcon className="size-[15px] text-muted" />
        <span className="text-[15px] font-semibold">{provider.name}</span>
      </div>
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
    </div>
  );
};
