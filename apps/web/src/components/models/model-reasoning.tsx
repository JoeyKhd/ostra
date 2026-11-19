"use client";

import { InfoIcon } from "lucide-react";
import { useState } from "react";

import { EFFORT_SCALE, clampEffort } from "@ostra/protocol";
import type { EffortLevel, EffortScaleLevel, ReasoningControls } from "@ostra/protocol";

import { andList, effortLabel, levelsLine } from "@/components/effort/effort-words";
import { PropGroup } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatPrice } from "@/lib/format";
import { t } from "@/lib/messages";

// A model's reasoning on the Models page (F-137, F-088; model-reasoning.md): whether it reasons,
// the levels it takes and where they come from (the catalog, or an organization admin), and the
// form that sets them for a custom model or overrides a catalog model's on one key's listing
// (ADR 0066). Until an admin says, a custom model doesn't reason.

/** One model listing's reasoning, as the page reads it. */
export type ModelReasoning = {
  /** The controls in force: the admin's, else the catalog's; `null` for a custom model nobody set. */
  readonly controls: ReasoningControls | null;
  /** Where `controls` come from; `null` with `controls`. */
  readonly source: "catalog" | "admin" | null;
  /** The catalog's own controls, kept beside an override; `null` for a custom model. */
  readonly catalog: ReasoningControls | null;
  /** The catalog lists a reasoning price apart from output (models.dev's `cost.reasoning`). */
  readonly reasoningPricePerMTok: number | null;
};

/** The catalog lists a reasoning price different from the output price. */
export const priceDiffers = (reasoning: ModelReasoning, outputPricePerMTok: number | null): boolean =>
  reasoning.reasoningPricePerMTok !== null && reasoning.reasoningPricePerMTok !== outputPricePerMTok;

/** The levels a model's controls list, on models.dev's scale, plus `on` for a toggle with none. */
export const levelsOfControls = (controls: ReasoningControls | null): readonly EffortLevel[] => {
  if (!controls?.supported) return [];
  const effort = controls.effort ?? [];
  if (effort.length > 0) return effort;
  return controls.toggle === true ? ["none", "on"] : [];
};

/** The table's first line: the levels, `Doesn't reason`, `Not set`, or `Only on or off`. */
export const reasoningLine = (controls: ReasoningControls | null): { readonly text: string; readonly muted: boolean } => {
  if (controls === null) return { text: t("models.reasoning.notSet"), muted: true };
  if (!controls.supported) return { text: t("models.reasoning.doesntReason"), muted: true };
  const effort = controls.effort ?? [];
  if (effort.length > 0) return { text: levelsLine(effort), muted: false };
  if (controls.toggle === true) return { text: t("models.reasoning.onlyToggle"), muted: false };
  return { text: t("models.reasoning.reasonsNoLevels"), muted: false };
};

/** The table's second line: where the controls come from. */
export const sourceLine = (reasoning: ModelReasoning): string => {
  switch (reasoning.source) {
    case null:
      return t("models.reasoning.unsetNote");
    case "catalog":
      return t("models.reasoning.fromCatalog");
    case "admin":
      return t("models.reasoning.byAdmin");
    default:
      return reasoning.source satisfies never;
  }
};

// ---- the form ----------------------------------------------------------------------------

export type ReasoningForm = {
  readonly reasons: boolean;
  /** The ticked levels, in models.dev's order. */
  readonly levels: readonly EffortScaleLevel[];
  /** `Only on or off`: a toggle with no levels, exclusive with them. */
  readonly toggleOnly: boolean;
};

/** The form prefilled from controls (a custom model unset reads `No`). */
export const formOf = (controls: ReasoningControls | null): ReasoningForm => {
  if (!controls?.supported) return { reasons: false, levels: [], toggleOnly: false };
  const levels = controls.effort ?? [];
  return { reasons: true, levels, toggleOnly: levels.length === 0 && controls.toggle === true };
};

/** Ticks or unticks a level, kept in models.dev's order. */
export const toggleLevel = (form: ReasoningForm, level: EffortScaleLevel): ReasoningForm => {
  const on = form.levels.includes(level);
  const levels = EFFORT_SCALE.filter((candidate) => (candidate === level ? !on : form.levels.includes(candidate)));
  return { ...form, levels };
};

/** The controls the form saves, or `null` while `Yes` has nothing ticked. */
export const controlsOfForm = (form: ReasoningForm): ReasoningControls | null => {
  if (!form.reasons) return { supported: false };
  if (form.toggleOnly) return { supported: true, toggle: true };
  const [first, ...rest] = form.levels;
  if (first === undefined) return null;
  return { supported: true, effort: [first, ...rest] };
};

/** The levels profiles on the model would offer, `Default` first. */
export const offeredOfForm = (form: ReasoningForm): readonly EffortLevel[] => {
  const controls = controlsOfForm(form);
  return ["default", ...levelsOfControls(controls)];
};

/** `2 profiles are set to Max. Their tasks will run at High.`: the profiles a save leaves on a level it drops. */
export const droppedLines = (profileLevels: readonly EffortLevel[], offered: readonly EffortLevel[]): readonly string[] => {
  const counts = new Map<EffortLevel, number>();
  for (const level of profileLevels) {
    if (!offered.includes(level)) counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  return [...counts].map(([level, n]) => {
    const params = { n, level: effortLabel(level), runAt: effortLabel(clampEffort(level, offered).level) };
    return n === 1 ? t("models.reasoning.droppedOne", params) : t("models.reasoning.droppedMany", params);
  });
};

const offersText = (offered: readonly EffortLevel[]): string => andList(offered.map(effortLabel));

const LevelsForm = ({ form, onChange }: { readonly form: ReasoningForm; readonly onChange: (form: ReasoningForm) => void }) => (
  <div data-testid="reasoning-form">
    <div className="flex h-9 items-center justify-between text-ui">
      <span className="text-muted">{t("models.reasoning.reasons")}</span>
      <ToggleGroup type="single" value={form.reasons ? "yes" : "no"} onValueChange={(value) => {
        if (value === "yes" || value === "no") onChange({ ...form, reasons: value === "yes" });
      }} aria-label={t("models.reasoning.reasons")}>
        <ToggleGroupItem value="no" className="w-[72px]">{t("models.reasoning.no")}</ToggleGroupItem>
        <ToggleGroupItem value="yes" className="w-[72px]">{t("models.reasoning.yes")}</ToggleGroupItem>
      </ToggleGroup>
    </div>
    {form.reasons ? (
      <>
        <p className="mb-1 mt-2 text-sm text-muted">{t("models.reasoning.levelsLabel")}</p>
        {EFFORT_SCALE.map((level) => (
          <label key={level} className="flex h-7 cursor-pointer items-center gap-2.5 text-ui" data-level={level}>
            <Checkbox checked={!form.toggleOnly && form.levels.includes(level)} disabled={form.toggleOnly} onCheckedChange={() => { onChange(toggleLevel(form, level)); }} />
            {effortLabel(level)}
          </label>
        ))}
        <label className="mt-1 flex h-7 cursor-pointer items-center gap-2.5 border-t border-line pt-1 text-ui" data-level="toggle">
          <Checkbox checked={form.toggleOnly} onCheckedChange={(checked) => { onChange({ ...form, toggleOnly: checked === true, levels: checked === true ? [] : form.levels }); }} />
          {t("models.reasoning.onlyToggle")}
        </label>
      </>
    ) : null}
    <p className="mt-2 text-[12.5px] text-faint" data-testid="reasoning-offers">
      {controlsOfForm(form) === null ? t("models.reasoning.tickSome") : t("models.reasoning.offers", { levels: offersText(offeredOfForm(form)) })}
    </p>
  </div>
);

/** The panel's `Reasoning` group: the read view, `Edit` and `Use the catalog's` for an admin, and the form. */
export const ReasoningGroup = ({ modelName, custom, reasoning, outputPricePerMTok, canEdit, profileLevels, pending, error, onSave, onUseCatalog, initiallyEditing = false, initiallyConfirming = false }: {
  readonly modelName: string;
  readonly custom: boolean;
  readonly reasoning: ModelReasoning;
  readonly outputPricePerMTok: number | null;
  readonly canEdit: boolean;
  /** The levels saved on the profiles that use this model: what a save that drops a level warns about. */
  readonly profileLevels: readonly EffortLevel[];
  readonly pending: boolean;
  readonly error: string | null;
  /** `null` goes back to the catalog's controls. */
  readonly onSave: (controls: ReasoningControls) => void;
  readonly onUseCatalog: () => void;
  readonly initiallyEditing?: boolean;
  /** Opened from a row's `Use the catalog's`: the confirmation shows at once. */
  readonly initiallyConfirming?: boolean;
}) => {
  const [editing, setEditing] = useState(initiallyEditing || (custom && canEdit && reasoning.controls === null));
  const [form, setForm] = useState(() => formOf(reasoning.controls ?? reasoning.catalog));
  const [confirm, setConfirm] = useState<"catalog" | "save" | null>(initiallyConfirming && reasoning.source === "admin" ? "catalog" : null);
  const line = reasoningLine(reasoning.controls);
  const saved = controlsOfForm(form);
  const dropped = droppedLines(profileLevels, offeredOfForm(form));
  const save = (): void => {
    if (saved === null) return;
    if (dropped.length > 0 && confirm !== "save") {
      setConfirm("save");
      return;
    }
    setConfirm(null);
    onSave(saved);
  };
  const catalogLevels = ["default", ...levelsOfControls(reasoning.catalog)] satisfies EffortLevel[];
  return (
    <PropGroup title={t("models.reasoning.reasoning")}>
      <div data-testid="model-reasoning" data-source={reasoning.source ?? "unset"}>
        {priceDiffers(reasoning, outputPricePerMTok) && reasoning.reasoningPricePerMTok !== null ? (
          <p className="mb-2 flex items-start gap-1.5 text-[12.5px] text-muted" data-testid="reasoning-price-note">
            <InfoIcon aria-hidden className="mt-0.5 size-[14px] shrink-0" />
            {t("models.reasoning.priceNote", { price: formatPrice(reasoning.reasoningPricePerMTok) })}
          </p>
        ) : null}
        {editing && canEdit ? (
          <>
            <LevelsForm form={form} onChange={(next) => { setForm(next); setConfirm(null); }} />
            {custom || reasoning.catalog === null ? null : (
              <p className="mt-1.5 text-[12.5px] text-faint">
                {reasoning.catalog.supported ? t("models.reasoning.catalogSays", { levels: reasoningLine(reasoning.catalog).text }) : t("models.reasoning.catalogSaysNone")}
              </p>
            )}
            {confirm === "save" ? (
              <div role="alert" className="mt-2 text-ui text-text" data-testid="reasoning-dropped">
                {dropped.map((text) => <p key={text}>{text}</p>)}
              </div>
            ) : null}
            {error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{error}</p>}
            <div className="mt-3 flex gap-2">
              {custom && reasoning.controls === null ? null : (
                <Button onClick={() => { setEditing(false); setForm(formOf(reasoning.controls ?? reasoning.catalog)); setConfirm(null); }}>{t("common.cancel")}</Button>
              )}
              <Button variant="primary" disabled={saved === null || pending} onClick={save} data-action="save-reasoning">
                {pending ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className={line.muted ? "text-[13.5px] text-muted" : "text-[13.5px] text-text"} data-testid="reasoning-levels">{line.text}</p>
            <p className="text-xs text-faint">{sourceLine(reasoning)}</p>
            {confirm === "catalog" && canEdit ? (
              <div className="mt-2 text-ui" data-testid="reasoning-use-catalog">
                <p>{t("models.reasoning.confirmCatalog", { model: modelName, levels: offersText(catalogLevels) })}</p>
                <div className="mt-2 flex gap-2">
                  <Button onClick={() => { setConfirm(null); }}>{t("common.cancel")}</Button>
                  <Button variant="primary" disabled={pending} onClick={() => { setConfirm(null); onUseCatalog(); }} data-action="confirm-use-catalog">{t("models.reasoning.useCatalog")}</Button>
                </div>
              </div>
            ) : null}
            {error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{error}</p>}
            {canEdit && confirm === null ? (
              <div className="mt-3 flex gap-2">
                <Button onClick={() => { setEditing(true); }} data-action="edit-reasoning">{t("models.reasoning.edit")}</Button>
                {reasoning.source === "admin" ? (
                  <Button variant="ghost" onClick={() => { setConfirm("catalog"); }} data-action="use-catalog">{t("models.reasoning.useCatalog")}</Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </PropGroup>
  );
};

/** `reasoning priced apart`: the outlined tag after a row's levels. */
export const PriceMark = () => (
  <span className="ml-2 inline-flex h-5 items-center rounded-[4px] border border-line-2 px-1.5 text-[11.5px] text-muted" data-testid="reasoning-price-mark">
    {t("models.reasoning.priceMark")}
  </span>
);

