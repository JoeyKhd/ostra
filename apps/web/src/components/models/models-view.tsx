"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CpuIcon, PlusIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Chip, Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatPrice, formatTokens } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { AddProviderForm } from "./add-provider-form";
import { ModelEditor } from "./model-editor";
import { ProviderSettings } from "./provider-settings";

type Provider = RouterOutputs["providers"]["list"][number];
type Model = RouterOutputs["providers"]["models"][number];

type Selection =
  | { readonly kind: "add" }
  | { readonly kind: "provider"; readonly providerId: string }
  | { readonly kind: "model"; readonly providerId: string; readonly modelId: string };

/** A model's logo, served by ostra (never the vendor's server), or a plain chip icon. */
const ModelLogo = ({ path }: { readonly path: string | null }) =>
  path === null ? (
    <CpuIcon aria-hidden className="size-[15px] shrink-0 text-muted" />
  ) : (
    <img src={path} alt="" className="size-[15px] shrink-0 opacity-90 invert" />
  );

/** Organization › Models (F-088): providers, their models, and the form in the properties panel. */
export const ModelsView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const providers = useQuery(trpc.providers.list.queryOptions());
  const profiles = useQuery(trpc.agentProfiles.list.queryOptions());
  const models = useQueries({
    queries: (providers.data ?? []).map((provider) => trpc.providers.models.queryOptions({ providerId: provider.id })),
  });
  const [selection, setSelection] = useState<Selection | null>(null);

  const builtIn = profiles.data?.find((profile) => profile.builtIn && profile.adapter === "opencode");
  const defaultModelId = builtIn?.model?.id ?? null;
  const profilesKey = trpc.agentProfiles.list.queryKey();
  const setDefault = useMutation(
    trpc.agentProfiles.setDefaultModel.mutationOptions({
      onMutate: async ({ modelId }) => {
        await queryClient.cancelQueries({ queryKey: profilesKey });
        const previous = queryClient.getQueryData(profilesKey);
        const chosen = rows.find((row) => row.model.id === modelId);
        queryClient.setQueryData(profilesKey, (list) =>
          list?.map((profile) =>
            profile.builtIn && profile.adapter === "opencode" && chosen !== undefined
              ? {
                  ...profile,
                  model: {
                    id: chosen.model.id,
                    endpointModelId: chosen.model.endpointModelId,
                    displayName: chosen.model.displayName,
                    providerId: chosen.provider.id,
                    providerName: chosen.provider.name,
                    apiFormat: chosen.provider.apiFormat,
                  },
                }
              : profile,
          ),
        );
        return { previous };
      },
      onError: (_error, _input, context) => {
        if (context !== undefined) queryClient.setQueryData(profilesKey, context.previous);
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: profilesKey }),
    }),
  );

  const rows: { provider: Provider; model: Model }[] = (providers.data ?? []).flatMap((provider, i) =>
    (models[i]?.data ?? []).filter((model) => model.listed).map((model) => ({ provider, model })),
  );

  const noProviders = providers.data?.length === 0;
  const effective: Selection | null = selection ?? (noProviders ? { kind: "add" } : null);
  const selectedProvider =
    effective?.kind === "provider" ? providers.data?.find((p) => p.id === effective.providerId) : undefined;
  const selectedRow =
    effective?.kind === "model" ? rows.find((row) => row.model.id === effective.modelId) : undefined;

  const properties =
    effective?.kind === "add" ? (
      <AddProviderForm onCreated={(providerId) => { setSelection({ kind: "provider", providerId }); }} />
    ) : selectedProvider !== undefined ? (
      <ProviderSettings key={selectedProvider.id} provider={selectedProvider} />
    ) : selectedRow !== undefined ? (
      <ModelEditor
        key={selectedRow.model.id}
        model={selectedRow.model}
        providerId={selectedRow.provider.id}
        isDefault={selectedRow.model.id === defaultModelId}
        settingDefault={setDefault.isPending}
        onUseAsDefault={() => { setDefault.mutate({ modelId: selectedRow.model.id }); }}
      />
    ) : (
      <p className="text-sm text-muted">{t("models.selectHint")}</p>
    );

  return (
    <PageFrame
      crumbs={[{ label: t("shell.organization") }, { label: t("shell.models") }]}
      actions={
        <Button onClick={() => { setSelection({ kind: "add" }); }}>
          <PlusIcon /> {t("models.add")}
        </Button>
      }
      properties={properties}
      wideProperties
    >
      <PageHeading title={t("models.title")} lede={t("models.lede")} />

      <Section title={t("models.providers")} count={providers.data?.length ?? 0}>
        {noProviders ? (
          <p className="border-t border-line py-3 text-muted">{t("models.noProviders")}</p>
        ) : (
          <ul className="rows">
            {providers.data?.map((provider) => {
              const on = effective?.kind === "provider" && effective.providerId === provider.id;
              return (
                <li key={provider.id}>
                  <button
                    type="button"
                    onClick={() => { setSelection({ kind: "provider", providerId: provider.id }); }}
                    aria-pressed={on}
                    className={cn("flex min-h-10 w-full items-center gap-3 px-1 text-left hover:bg-raise", on && "bg-sel")}
                  >
                    <ServerIcon className="size-[15px] shrink-0 text-muted" />
                    <span className="w-36 shrink-0 truncate font-medium">{provider.name}</span>
                    <span className="hidden min-w-0 flex-1 truncate font-mono text-sm text-faint md:block">{provider.baseUrl}</span>
                    <span className="ml-auto shrink-0 text-muted">{plural(provider.modelCount, "models.countOne", "models.countMany")}</span>
                    {provider.allowOnPersonalRunners ? <Chip className="hidden sm:inline-flex">{t("models.personalAllowed")}</Chip> : null}
                    <Status tone="green" className="shrink-0">{t("models.connectedShort")}</Status>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {rows.length === 0 ? null : (
        <Section title={t("models.enabled")} count={rows.length}>
          {setDefault.error === null ? null : <p role="alert" className="mb-2 text-sm text-red">{errorText(setDefault.error)}</p>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-body">
              <thead>
                <tr className="h-[30px] border-b border-line text-left text-[11.5px] font-medium text-faint">
                  <th className="pr-3 font-medium">{t("models.model")}</th>
                  <th className="pr-3 font-medium">{t("models.provider")}</th>
                  <th className="pr-3 text-right font-medium">{t("models.context")}</th>
                  <th className="pr-3 text-right font-medium">{t("models.inputPrice")}</th>
                  <th className="pr-3 text-right font-medium">{t("models.outputPrice")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ provider, model }) => {
                  const on = effective?.kind === "model" && effective.modelId === model.id;
                  return (
                    <tr
                      key={model.id}
                      data-model={model.endpointModelId}
                      onClick={() => { setSelection({ kind: "model", providerId: provider.id, modelId: model.id }); }}
                      className={cn("h-10 cursor-pointer border-b border-line hover:bg-raise", on && "bg-sel")}
                    >
                      <td className="pr-3">
                        <span className="flex items-center gap-2.5">
                          <ModelLogo path={model.logoPath} />
                          <button
                            type="button"
                            className="truncate text-left"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelection({ kind: "model", providerId: provider.id, modelId: model.id });
                            }}
                          >
                            {model.displayName ?? model.endpointModelId}
                          </button>
                          {model.id === defaultModelId ? <Chip>{t("models.default")}</Chip> : null}
                          {model.custom ? <Chip>{t("models.custom")}</Chip> : null}
                        </span>
                      </td>
                      <td className="pr-3 text-muted">{provider.name}</td>
                      <td className="pr-3 text-right font-mono text-[12.5px]">{formatTokens(model.contextWindow)}</td>
                      <td className="pr-3 text-right font-mono text-[12.5px]">{formatPrice(model.inputPricePerMTok)}</td>
                      <td className="pr-3 text-right font-mono text-[12.5px]">{formatPrice(model.outputPricePerMTok)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </PageFrame>
  );
};
