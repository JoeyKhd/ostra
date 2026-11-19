"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { SubmitEvent } from "react";

import type { EffortLevel } from "@ostra/protocol";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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

export const ModelEditor = ({ model, providerId, isDefault, onUseAsDefault, settingDefault, canEditReasoning, profileLevels, confirmCatalog }: {
  readonly model: Model;
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
    inputPrice: text(model.inputPricePerMTok),
    outputPrice: text(model.outputPricePerMTok),
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
      inputPricePerMTok: numberOrNull(form.inputPrice),
      outputPricePerMTok: numberOrNull(form.outputPrice),
    });
  };
  const set = (key: keyof typeof form) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div data-testid="model-editor">
      <h2 className="mb-1 text-xs font-medium text-faint">{t("models.model")}</h2>
      <div className="mb-1 text-[16.5px] font-semibold">{model.displayName ?? model.endpointModelId}</div>
      <div className="mb-4 font-mono text-sm text-faint">{model.endpointModelId}</div>
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
              <Field id="model-in" label={t("models.inputPrice")}>
                <Input id="model-in" inputMode="decimal" className="font-mono" value={form.inputPrice} onChange={(e) => { set("inputPrice")(e.target.value); }} />
              </Field>
              <Field id="model-out" label={t("models.outputPrice")}>
                <Input id="model-out" inputMode="decimal" className="font-mono" value={form.outputPrice} onChange={(e) => { set("outputPrice")(e.target.value); }} />
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
          <PropRow label={t("models.inputPrice")}><span className="font-mono">{formatPrice(model.inputPricePerMTok)}</span></PropRow>
          <PropRow label={t("models.outputPrice")}><span className="font-mono">{formatPrice(model.outputPricePerMTok)}</span></PropRow>
        </PropGroup>
      )}
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
