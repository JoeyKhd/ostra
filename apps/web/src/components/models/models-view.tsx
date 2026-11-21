"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, PlusIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { AddProviderForm, formatLabel } from "./add-provider-form";
import { DefaultListSection, KeysSection, ToConfirmSection, defaultListOf, useDefaultListEdit } from "./keys-sections";
import { ModelEditor, modelReasoningOf } from "./model-editor";
import { ModelsTable } from "./models-table";
import type { ModelTableRow } from "./models-table";
import { ProviderSettings } from "./provider-settings";
import { ProvidersPreview } from "./providers-preview";

type Provider = RouterOutputs["providers"]["list"][number];
type Model = RouterOutputs["providers"]["models"][number];

type Selection =
  | { readonly kind: "add" }
  | { readonly kind: "provider"; readonly providerId: string }
  | { readonly kind: "model"; readonly providerId: string; readonly modelId: string };

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
  const router = useRouter();
  const pathname = usePathname();
  const tab: "keys" | "models" = params.get("tab") === "models" || params.has("model") ? "models" : "keys";
  const [confirmCatalog, setConfirmCatalog] = useState<string | null>(null);
  const admin = me.data?.organization?.role === "admin";
  const defaultList = defaultListOf(providers.data);
  const toConfirm = useQuery(trpc.providers.choicesToConfirm.queryOptions(undefined, { enabled: me.data?.organization?.role === "admin" }));
  const edit = useDefaultListEdit(defaultList);

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
  // The Models tab: one row per model, the keys that list it together (a custom model is its key's own).
  const groups = new Map<string, { readonly first: { provider: Provider; model: Model }; readonly keys: string[] }>();
  for (const listing of rows) {
    const { provider, model } = listing;
    const key = model.custom || model.catalogId === null ? `${provider.id}:${model.endpointModelId}` : model.catalogId;
    const known = groups.get(key);
    if (known === undefined) groups.set(key, { first: listing, keys: [provider.name] });
    else known.keys.push(provider.name);
  }
  const tableRows: readonly ModelTableRow[] = [...groups.values()].map(({ first: { model }, keys }) => ({
    id: model.id,
    name: model.displayName ?? model.endpointModelId,
    custom: model.custom,
    logoPath: model.logoPath,
    catalogId: model.catalogId,
    listedBy: keys,
    contextWindow: model.contextWindow,
    reasoning: modelReasoningOf(model),
    endpointId: model.endpointModelId,
    isDefault: model.id === defaultModelId,
  }));

  // The models the organization's profiles use, by text: what a change to the default list is about.
  const textOfModelId = new Map(rows.map(({ model }) => [model.id, model.catalogId ?? model.endpointModelId] as const));
  const used = new Set((profiles.data ?? []).flatMap((profile) => {
    const text = profile.model === null ? undefined : textOfModelId.get(profile.model.id);
    return text === undefined ? [] : [text];
  }));
  const noProviders = providers.data?.length === 0;
  const linked = params.get("model");
  const linkedRow = linked === null ? undefined : rows.find((row) => row.model.id === linked);
  const effective: Selection | null =
    selection ?? (noProviders ? { kind: "add" } : linkedRow === undefined ? null : { kind: "model", providerId: linkedRow.provider.id, modelId: linkedRow.model.id });
  const selectedProvider =
    effective?.kind === "provider" ? providers.data?.find((p) => p.id === effective.providerId) : undefined;
  const selectedRow =
    effective?.kind === "model" ? rows.find((row) => row.model.id === effective.modelId) : undefined;

  const properties = edit.changed ? (
    <ProvidersPreview preview={edit.preview.data} error={edit.preview.error === null ? null : errorText(edit.preview.error)} conflict={edit.conflict} used={used} />
  ) : effective?.kind === "add" ? (
      <AddProviderForm first={noProviders} onCreated={(providerId) => { setSelection({ kind: "provider", providerId }); }} />
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
        listedLine={t("models.listedLine", {
          keys: rows
            .filter((row) => (selectedRow.model.custom || selectedRow.model.catalogId === null ? row.model.id === selectedRow.model.id : row.model.catalogId === selectedRow.model.catalogId))
            .map((row) => row.provider.name)
            .join(", "),
          format: formatLabel(selectedRow.provider.apiFormat),
        })}
      />
    ) : (
      <p className="text-sm text-muted">{t("models.selectHint")}</p>
    );

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("shell.models") }]}
      actions={
        edit.editing ? (
          <>
            <Button onClick={edit.cancel} disabled={edit.save.isPending}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={edit.submit} disabled={!edit.changed || edit.preview.data === undefined || edit.save.isPending}>
              {edit.save.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
              {t("models.keys.saveList")}
            </Button>
          </>
        ) : (
          <Button onClick={() => { setSelection({ kind: "add" }); }}>
            <PlusIcon /> {t("models.add")}
          </Button>
        )
      }
      properties={properties}
      wideProperties
    >
      <PageHeading title={t("models.title")} lede={tab === "models" ? t("models.ledeModels") : t("models.lede")} />
      {/* Keys and Models as two tabs (model-reasoning.md, "The Models tab"); the URL keeps the tab. */}
      <UnderlineTabs
        tabs={[
          { id: "keys", label: t("models.tabKeys"), extra: providers.data === undefined ? null : <span className="font-mono text-xs text-faint">{providers.data.length}</span> },
          { id: "models", label: t("models.tabModels"), extra: providers.isPending ? null : <span className="font-mono text-xs text-faint">{tableRows.length}</span> },
        ]}
        selected={tab}
        onSelect={(next) => {
          const query = new URLSearchParams(params.toString());
          query.delete("model");
          if (next === "models") query.set("tab", "models");
          else query.delete("tab");
          const text = query.toString();
          router.replace(text === "" ? pathname : `${pathname}?${text}`, { scroll: false });
        }}
        label={t("models.tabsLabel")}
        idPrefix="models-tab"
        className="mt-5"
      />
      {tab === "keys" ? (
      <>
      <DefaultListSection
        list={defaultList}
        editing={edit.editing}
        onEdit={() => { setSelection(null); edit.start(); }}
        draft={edit.draft}
        onToggle={edit.toggle}
        providers={providers.data ?? []}
      />
      {edit.save.error === null || edit.conflict ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(edit.save.error)}</p>}
      <KeysSection
        providers={providers.data}
        selectedId={effective?.kind === "provider" ? effective.providerId : null}
        onSelect={(providerId) => { setSelection({ kind: "provider", providerId }); }}
      />
      {providers.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(providers.error)}</p>}
      <ToConfirmSection rows={toConfirm.data ?? []} />

      </>
      ) : (
        <div className="mt-6" role="tabpanel" id="models-tab-models" aria-labelledby="models-tab-models-tab">
          {setDefault.error === null ? null : <p role="alert" className="mb-2 text-sm text-red">{errorText(setDefault.error)}</p>}
          <ModelsTable
            rows={providers.isPending ? null : tableRows}
            selectedId={effective?.kind === "model" ? effective.modelId : null}
            loading={providers.isPending}
            onSelect={(id) => {
              const row = rows.find((one) => one.model.id === id);
              if (row !== undefined) setSelection({ kind: "model", providerId: row.provider.id, modelId: row.model.id });
            }}
            onUseCatalog={
              admin
                ? (id) => {
                    const row = rows.find((one) => one.model.id === id);
                    if (row === undefined) return;
                    setConfirmCatalog(id);
                    setSelection({ kind: "model", providerId: row.provider.id, modelId: row.model.id });
                  }
                : null
            }
          />
        </div>
      )}
    </PageFrame>
  );
};
