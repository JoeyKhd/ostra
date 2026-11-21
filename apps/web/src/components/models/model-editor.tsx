"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { SubmitEvent } from "react";

import type { EffortLevel } from "@ostra/protocol";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatPrice, formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { ReasoningGroup } from "./model-reasoning";
import type { ModelReasoning } from "./model-reasoning";

type Model = RouterOutputs["providers"]["models"][number];

const numberOrNull = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
};

const text = (value: number | null): string => (value === null ? "" : String(value));

/**
 * A model's properties. A catalog model shows the catalog's values; a custom model (one the
 * catalog doesn't know) has its name, limits and prices edited here (F-088).
 */
/** The API's reasoning as the page reads it: a custom model nobody set has no controls (F-137). */
export const modelReasoningOf = (model: Pick<Model, "reasoning">): ModelReasoning => ({
  controls: model.reasoning.source === null ? null : model.reasoning.controls,
  source: model.reasoning.source,
  catalog: model.reasoning.catalog,
  reasoningPriceDiffers: model.reasoning.reasoningPriceDiffers,
});

const SOURCE_WORDS = { endpoint: "prices.sourceEndpointShort", catalog: "prices.sourceCatalogShort", admin: "prices.sourceAdminShort" } as const;

/**
 * F-037 (ticket 36): the model's four prices per million tokens and where they came from. They're set
 * on Spend, the page budgets count them on: `Edit price` opens it with the model selected.
 */
const PriceGroup = ({ model, canEdit }: { readonly model: Model; readonly canEdit: boolean }) => (
  <PropGroup title={t("models.priceTitle")}>
    <div data-testid="model-price">
      <PropRow label={t("prices.fresh")}><span className="font-mono">{formatPrice(model.inputPricePerMTok)}</span></PropRow>
      <PropRow label={t("prices.output")}><span className="font-mono">{formatPrice(model.outputPricePerMTok)}</span></PropRow>
      <PropRow label={t("prices.cacheRead")}><span className="font-mono">{formatPrice(model.cacheReadPricePerMTok)}</span></PropRow>
      <PropRow label={t("prices.cacheWrite")}><span className="font-mono">{formatPrice(model.cacheWritePricePerMTok)}</span></PropRow>
      <PropRow label={t("prices.source")}>
        {model.priceSource === null ? <span className="text-faint">{t("prices.sourceNone")}</span> : <span data-testid="model-price-source">{t(SOURCE_WORDS[model.priceSource])}</span>}
      </PropRow>
      {canEdit ? (
        <Link href={`/organization/spend?model=${encodeURIComponent(model.id)}`} className="mt-1.5 inline-block text-ui text-teal hover:underline">
          {t("models.editPrice")}
        </Link>
      ) : null}
    </div>
  </PropGroup>
);

export const ModelEditor = ({ model, providerId, isDefault, onUseAsDefault, settingDefault, canEditReasoning, profileLevels, confirmCatalog, listedLine }: {
  readonly model: Model;
  /** `Listed by globex-openrouter · OpenAI-compatible` under the name (model-reasoning.md, the panel's head). */
  readonly listedLine?: string;
  /** F-137: an organization admin sets the model's reasoning. */
  readonly canEditReasoning: boolean;
  /** The levels saved on the profiles that use this model. */
  readonly profileLevels: readonly EffortLevel[];
  /** Opened from a row's `Use the catalog's`. */
  readonly confirmCatalog: boolean;
  readonly providerId: string;
  readonly isDefault: boolean;
  readonly onUseAsDefault: () => void;
  readonly settingDefault: boolean;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    displayName: model.displayName ?? "",
    contextWindow: text(model.contextWindow),
    maxOutputTokens: text(model.maxOutputTokens),
  });
  const save = useMutation(
    trpc.providers.updateModel.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.providers.models.queryKey({ providerId }) }),
    }),
  );

  const reasoning = useMutation(
    trpc.providers.updateModel.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.providers.models.queryKey({ providerId }) }),
    }),
  );

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const name = form.displayName.trim();
    save.mutate({
      modelId: model.id,
      displayName: name === "" ? null : name,
      contextWindow: numberOrNull(form.contextWindow),
      maxOutputTokens: numberOrNull(form.maxOutputTokens),
    });
  };
  const set = (key: keyof typeof form) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div data-testid="model-editor">
      <h2 className="mb-1 text-xs font-medium text-faint">{model.custom ? t("models.customModelLabel") : t("models.model")}</h2>
      <div className={cn("mb-1 break-all", model.custom && model.displayName === null ? "font-mono text-[20px] font-medium" : "text-[16.5px] font-semibold")}>{model.displayName ?? model.endpointModelId}</div>
      {model.custom && model.displayName === null ? null : <div className="font-mono text-sm text-faint">{model.endpointModelId}</div>}
      {listedLine === undefined ? null : <div className="text-sm text-muted">{listedLine}</div>}
      <div className="mb-4" />
      <div className="mb-4">
        {isDefault ? (
          <span className="text-sm text-green">{t("models.isDefault")}</span>
        ) : (
          <Button onClick={onUseAsDefault} disabled={settingDefault || !model.listed}>
            {t("models.useAsDefault")}
          </Button>
        )}
      </div>
      {model.custom ? (
        <form onSubmit={submit} noValidate>
          <PropGroup title={t("models.customTitle")}>
            <Field id="model-name" label={t("models.displayName")}>
              <Input id="model-name" value={form.displayName} onChange={(e) => { set("displayName")(e.target.value); }} placeholder={model.endpointModelId} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field id="model-context" label={t("models.context")}>
                <Input id="model-context" inputMode="numeric" className="font-mono" value={form.contextWindow} onChange={(e) => { set("contextWindow")(e.target.value); }} />
              </Field>
              <Field id="model-output" label={t("models.maxOutput")}>
                <Input id="model-output" inputMode="numeric" className="font-mono" value={form.maxOutputTokens} onChange={(e) => { set("maxOutputTokens")(e.target.value); }} />
              </Field>
            </div>
            {save.error === null ? null : <p role="alert" className="mb-2 text-sm text-red">{errorText(save.error)}</p>}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t("common.saving") : save.isSuccess ? t("common.saved") : t("common.save")}
            </Button>
          </PropGroup>
        </form>
      ) : (
        <PropGroup title={t("models.fromCatalog")}>
          <PropRow label={t("models.context")}><span className="font-mono">{formatTokens(model.contextWindow)}</span></PropRow>
          <PropRow label={t("models.maxOutput")}><span className="font-mono">{formatTokens(model.maxOutputTokens)}</span></PropRow>
        </PropGroup>
      )}
      <PriceGroup model={model} canEdit={canEditReasoning} />
      <ReasoningGroup
        modelName={model.displayName ?? model.endpointModelId}
        custom={model.custom}
        reasoning={modelReasoningOf(model)}
        canEdit={canEditReasoning}
        profileLevels={profileLevels}
        pending={reasoning.isPending}
        error={reasoning.error === null ? null : errorText(reasoning.error)}
        onSave={(controls) => { reasoning.mutate({ modelId: model.id, reasoning: controls }); }}
        onUseCatalog={() => { reasoning.mutate({ modelId: model.id, reasoning: null }); }}
        initiallyConfirming={confirmCatalog}
      />
    </div>
  );
};
