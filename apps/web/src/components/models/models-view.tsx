"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CpuIcon, PlusIcon, ServerIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Chip, Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatPrice, formatTokens } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { AddProviderForm } from "./add-provider-form";
import { ModelEditor, modelReasoningOf } from "./model-editor";
import { priceDiffers } from "./model-reasoning";
import { PriceFootnote, ReasoningCell } from "./models-table";
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
    // Drawn light grey on dark (between --muted and --text), so the vendors' marks read as one family.
    <img src={path} alt="" className="size-[15px] shrink-0 opacity-75 invert" />
  );

/** Organization › Models (F-088): providers, their models, and the form in the properties panel. */
export const ModelsView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const providers = useQuery(trpc.providers.list.queryOptions());
  const profiles = useQuery(trpc.agentProfiles.list.queryOptions());
  const models = useQueries({
    queries: (providers.data ?? []).map((provider) => trpc.providers.models.queryOptions({ providerId: provider.id })),
  });
  const [selection, setSelection] = useState<Selection | null>(null);
  // F-137: `?model=` opens that model (the profile editor's `Set it in Models`); a row's `Use the catalog's` opens its confirmation.
  const params = useSearchParams();
  const [confirmCatalog, setConfirmCatalog] = useState<string | null>(null);
  const admin = me.data?.organization?.role === "admin";

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
  const linked = params.get("model");
  const linkedRow = linked === null ? undefined : rows.find((row) => row.model.id === linked);
  const effective: Selection | null =
    selection ?? (noProviders ? { kind: "add" } : linkedRow === undefined ? null : { kind: "model", providerId: linkedRow.provider.id, modelId: linkedRow.model.id });
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
        key={`${selectedRow.model.id}:${confirmCatalog === selectedRow.model.id ? "confirm" : ""}`}
        model={selectedRow.model}
        providerId={selectedRow.provider.id}
        isDefault={selectedRow.model.id === defaultModelId}
        settingDefault={setDefault.isPending}
        onUseAsDefault={() => { setDefault.mutate({ modelId: selectedRow.model.id }); }}
        canEditReasoning={admin}
        profileLevels={(profiles.data ?? []).filter((profile) => profile.model?.id === selectedRow.model.id).map((profile) => profile.effort)}
        confirmCatalog={confirmCatalog === selectedRow.model.id}
      />
    ) : (
      <p className="text-sm text-muted">{t("models.selectHint")}</p>
    );

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("shell.models") }]}
      actions={
        <Button onClick={() => { setSelection({ kind: "add" }); }}>
          <PlusIcon /> {t("models.add")}
        </Button>
      }
      properties={properties}
      wideProperties
    >
      <PageHeading title={t("models.title")} lede={t("models.lede")} />

      <Section title={t("models.providers")} {...(providers.data === undefined ? {} : { count: providers.data.length })}>
        {providers.isPending ? (
          <SkeletonRows height="h-10" />
        ) : noProviders ? (
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
                    className={cn("flex h-10 w-full items-center gap-3 px-1 text-left hover:bg-raise", on && "bg-sel hover:bg-sel")}
                  >
                    <ServerIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
                    <span className="w-[150px] shrink-0 truncate">{provider.name}</span>
                    <span className="hidden min-w-0 flex-1 truncate font-mono text-ui text-faint md:block" title={provider.baseUrl}>{provider.baseUrl}</span>
                    <span className="ml-auto shrink-0 text-muted">{plural(provider.modelCount, "models.countOne", "models.countMany")}</span>
                    {provider.allowOnPersonalRunners ? <Chip className="ml-1 hidden sm:inline-flex">{t("models.personalAllowed")}</Chip> : null}
                    <Status tone="green" className="ml-2 shrink-0">{t("models.connectedShort")}</Status>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {providers.isPending ? (
        <Section title={t("models.enabled")}>
          <SkeletonRows height="h-10" />
        </Section>
      ) : rows.length === 0 ? null : (
        <Section title={t("models.enabled")} count={rows.length}>
          {setDefault.error === null ? null : <p role="alert" className="mb-2 text-sm text-red">{errorText(setDefault.error)}</p>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-body">
              <thead>
                <tr className="h-[30px] border-b border-line text-left text-[12.5px] font-medium text-faint">
                  <th className="pr-3 font-medium">{t("models.model")}</th>
                  <th className="pr-3 font-medium">{t("models.provider")}</th>
                  <th className="pr-3 text-right font-medium">{t("models.context")}</th>
                  <th className="pr-3 text-right font-medium">{t("models.inputPrice")}</th>
                  <th className="pr-3 text-right font-medium">{t("models.outputPrice")}</th>
                  <th className="pl-3 font-medium">{t("models.reasoning.reasoning")}</th>
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
                      className={cn("h-10 cursor-pointer border-b border-line hover:bg-raise", on && "bg-sel hover:bg-sel")}
                    >
                      <td className="pr-3">
                        <span className="flex items-center gap-2.5">
                          <ModelLogo path={model.logoPath} />
                          <button
                            type="button"
                            className={cn("truncate text-left", model.displayName === null && "font-mono text-ui")}
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
                      <td className="pr-3 text-right font-mono text-ui">{formatTokens(model.contextWindow)}</td>
                      <td className="pr-3 text-right font-mono text-ui">{formatPrice(model.inputPricePerMTok)}</td>
                      <td className="pr-3 text-right font-mono text-ui">{formatPrice(model.outputPricePerMTok)}</td>
                      <ReasoningCell
                        reasoning={modelReasoningOf(model)}
                        onUseCatalog={admin ? () => { setConfirmCatalog(model.id); setSelection({ kind: "model", providerId: provider.id, modelId: model.id }); } : null}
                      />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.some((row) => priceDiffers(modelReasoningOf(row.model))) ? <PriceFootnote /> : null}
        </Section>
      )}
    </PageFrame>
  );
};
