import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { ReasoningControls } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { ReasoningGroup, controlsOfForm, droppedLines, formOf, offeredOfForm, reasoningLine, sourceLine, toggleLevel } from "./model-reasoning";
import type { ModelReasoning } from "./model-reasoning";
import { ModelsTable, listedByText, sortModelRows } from "./models-table";
import type { ModelTableRow } from "./models-table";

/** The markup with apostrophes as typed, so a message reads as it is in `en.json`. */
const renderToStaticMarkup = (node: ReactElement): string => renderMarkup(node).replaceAll("&#x27;", "'");

// F-137: a model's reasoning on the Models page (model-reasoning.md), each state of the target.

const gpt55: ReasoningControls = { supported: true, effort: ["none", "low", "medium", "high", "xhigh"] };
const deepseekCatalog: ReasoningControls = { supported: true, effort: ["low", "high", "max"] };
const catalog = (controls: ReasoningControls): ModelReasoning => ({ controls, source: "catalog", catalog: controls, reasoningPricePerMTok: null });
const override: ModelReasoning = { controls: { supported: true, effort: ["low", "high"] }, source: "admin", catalog: deepseekCatalog, reasoningPricePerMTok: 2.19 };
const unset: ModelReasoning = { controls: null, source: null, catalog: null, reasoningPricePerMTok: null };

const tableRow = (over: Partial<ModelTableRow>): ModelTableRow => ({
  id: "m1",
  name: "GPT-5.5",
  custom: false,
  logoPath: null,
  catalogId: "openai/gpt-5.5",
  listedBy: ["spare-openai"],
  contextWindow: 1_000_000,
  outputPricePerMTok: 10,
  reasoning: catalog(gpt55),
  ...over,
});

const group = (reasoning: ModelReasoning, over: { custom?: boolean; canEdit?: boolean; editing?: boolean; confirming?: boolean; profileLevels?: readonly ("max" | "high")[] } = {}): string =>
  renderToStaticMarkup(
    <ReasoningGroup
      modelName="DeepSeek V4 Pro"
      custom={over.custom ?? false}
      reasoning={reasoning}
      outputPricePerMTok={1.1}
      canEdit={over.canEdit ?? true}
      profileLevels={over.profileLevels ?? []}
      pending={false}
      error={null}
      onSave={() => undefined}
      onUseCatalog={() => undefined}
      initiallyEditing={over.editing ?? false}
      initiallyConfirming={over.confirming ?? false}
    />,
  );

describe("the Models tab", () => {
  it("F-137: each model's levels and their source, the override's Use the catalog's, and an unset custom model", () => {
    const html = renderToStaticMarkup(
      <ModelsTable
        rows={[
          tableRow({ id: "c", name: "acme/sql-coder-ft", custom: true, catalogId: null, reasoning: unset, contextWindow: 128_000 }),
          tableRow({ id: "d", name: "DeepSeek V4 Pro", reasoning: override, outputPricePerMTok: 1.1 }),
          tableRow({ id: "g" }),
        ]}
        selectedId="c"
        loading={false}
        onSelect={() => undefined}
        onUseCatalog={() => undefined}
      />,
    );
    expect([...html.matchAll(/data-model="([^"]+)"/g)].map((match) => match[1])).toEqual(["DeepSeek V4 Pro", "GPT-5.5", "acme/sql-coder-ft"]);
    expect(html).toContain("Off, Low, Medium, High, Extra high");
    expect(html).toContain(t("models.reasoning.fromCatalog"));
    expect(html).toContain(t("models.reasoning.byAdmin"));
    expect(html).toContain('data-action="row-use-catalog"');
    expect(html).toContain(t("models.reasoning.notSet"));
    expect(html).toContain(t("models.reasoning.unsetNote"));
    expect(html).toContain("1,000,000");
    expect(html).toContain(t("models.reasoning.customModel"));
  });

  it("F-137: the reasoning-price mark and its footnote show only for a model whose catalog prices reasoning apart", () => {
    const marked = renderToStaticMarkup(<ModelsTable rows={[tableRow({ reasoning: override, outputPricePerMTok: 1.1 })]} selectedId={null} loading={false} onSelect={() => undefined} onUseCatalog={null} />);
    expect(marked).toContain(t("models.reasoning.priceMark"));
    expect(marked).toContain(t("models.reasoning.priceFootnote"));
    expect(marked).not.toContain("row-use-catalog");
    const same = renderToStaticMarkup(<ModelsTable rows={[tableRow({ reasoning: { ...override, reasoningPricePerMTok: 1.1 }, outputPricePerMTok: 1.1 })]} selectedId={null} loading={false} onSelect={() => undefined} onUseCatalog={null} />);
    expect(same).not.toContain(t("models.reasoning.priceMark"));
  });

  it("F-137: empty and loading", () => {
    expect(renderToStaticMarkup(<ModelsTable rows={[]} selectedId={null} loading={false} onSelect={() => undefined} onUseCatalog={null} />)).toContain(t("models.reasoning.empty"));
    expect(renderToStaticMarkup(<ModelsTable rows={null} selectedId={null} loading onSelect={() => undefined} onUseCatalog={null} />)).toContain("animate-pulse");
  });

  it("F-137: the lines' words", () => {
    expect(reasoningLine({ supported: false })).toEqual({ text: t("models.reasoning.doesntReason"), muted: true });
    expect(reasoningLine({ supported: true, toggle: true })).toEqual({ text: t("models.reasoning.onlyToggle"), muted: false });
    expect(sourceLine(unset)).toBe(t("models.reasoning.unsetNote"));
    expect(listedByText(["a", "b", "c", "d"])).toBe("a, b +2");
    expect(sortModelRows([tableRow({ id: "z", name: "z", custom: true }), tableRow({ id: "b", name: "B" })]).map((row) => row.id)).toEqual(["b", "z"]);
  });
});

describe("the model's Reasoning in the panel", () => {
  it("F-137: a catalog model's read view, with Edit for an admin and no Use the catalog's", () => {
    const html = group(catalog(gpt55));
    expect(html).toContain("Off, Low, Medium, High, Extra high");
    expect(html).toContain('data-action="edit-reasoning"');
    expect(html).not.toContain('data-action="use-catalog"');
  });

  it("F-137: an override offers Use the catalog's, which confirms in place with the catalog's levels", () => {
    expect(group(override)).toContain('data-action="use-catalog"');
    const confirming = group(override, { confirming: true });
    expect(confirming).toContain("Use the catalog's levels for DeepSeek V4 Pro? Profiles and tasks on it will offer Default, Low, High and Max.");
    expect(confirming).toContain("Its catalog prices reasoning at $2.19 per million, apart from output.");
  });

  it("F-137: read-only shows no Edit, no Use the catalog's and no form", () => {
    const html = group(override, { canEdit: false, confirming: true });
    expect(html).not.toContain("edit-reasoning");
    expect(html).not.toContain("use-catalog");
    expect(html).not.toContain("reasoning-form");
  });

  it("F-137: a custom model nobody set opens the form for an admin, and Edit keeps the catalog's value beside the form", () => {
    const custom = group(unset, { custom: true });
    expect(custom).toContain('data-testid="reasoning-form"');
    expect(custom).toContain(t("models.reasoning.reasons"));
    const editing = group(catalog(gpt55), { editing: true });
    expect(editing).toContain(t("models.reasoning.levelsLabel"));
    expect(editing).toContain(t("models.reasoning.onlyToggle"));
    expect(editing).toContain("The catalog says: Off, Low, Medium, High, Extra high.");
  });

  it("F-137: the form saves no, levels, or Only on or off, and Yes with nothing ticked can't save", () => {
    const yes = { reasons: true, levels: [], toggleOnly: false } as const;
    expect(controlsOfForm(yes)).toBeNull();
    expect(controlsOfForm({ ...yes, reasons: false })).toEqual({ supported: false });
    const ticked = toggleLevel(toggleLevel(toggleLevel(yes, "high"), "low"), "medium");
    expect(ticked.levels).toEqual(["low", "medium", "high"]);
    expect(controlsOfForm(ticked)).toEqual({ supported: true, effort: ["low", "medium", "high"] });
    expect(offeredOfForm(ticked)).toEqual(["default", "low", "medium", "high"]);
    expect(controlsOfForm({ ...ticked, toggleOnly: true })).toEqual({ supported: true, toggle: true });
    expect(formOf(null)).toEqual({ reasons: false, levels: [], toggleOnly: false });
    expect(formOf(gpt55).levels).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(group(unset, { custom: true })).toContain(t("models.reasoning.offers", { levels: "Default" }));
  });

  it("F-137: a save that drops a level profiles use says what their tasks will run at", () => {
    expect(droppedLines(["max", "max", "high"], ["default", "low", "high"])).toEqual(["2 profiles are set to Max. Their tasks will run at High."]);
    expect(droppedLines(["max"], ["default", "low", "high"])).toEqual(["1 profile is set to Max. Its tasks will run at High."]);
    expect(droppedLines(["high"], ["default", "low", "high"])).toEqual([]);
  });
});
