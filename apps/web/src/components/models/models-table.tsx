"use client";

import { BoxIcon, CpuIcon } from "lucide-react";

import { SkeletonRows } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/format";
import { t } from "@/lib/messages";

import { PriceMark, priceDiffers, reasoningLine, sourceLine } from "./model-reasoning";
import type { ModelReasoning } from "./model-reasoning";

// The Models tab (F-137, F-088; model-reasoning.md, "The Models tab"): every model a key lists,
// whether it reasons, its levels and where they come from. Sorted by name, custom models last.

export type ModelTableRow = {
  /** One row per model listing: the model's id. */
  readonly id: string;
  readonly name: string;
  /** A custom model's name is its endpoint ID, in mono. */
  readonly custom: boolean;
  readonly logoPath: string | null;
  /** The catalog ID under the name; a custom model reads `custom model`. */
  readonly catalogId: string | null;
  /** The keys (providers) that list it. */
  readonly listedBy: readonly string[];
  readonly contextWindow: number | null;
  readonly outputPricePerMTok: number | null;
  readonly reasoning: ModelReasoning;
};

/** By name, custom models last. */
export const sortModelRows = (rows: readonly ModelTableRow[]): readonly ModelTableRow[] =>
  [...rows].sort((a, b) => (a.custom === b.custom ? a.name.localeCompare(b.name) : a.custom ? 1 : -1));

/** `acme-anthropic, northwind-anthropic`, or the first two and `+2`. */
export const listedByText = (keys: readonly string[]): string =>
  keys.length > 2 ? `${keys.slice(0, 2).join(", ")} ${t("models.reasoning.more", { n: keys.length - 2 })}` : keys.join(", ");

const Logo = ({ row }: { readonly row: ModelTableRow }) => {
  if (row.custom) return <BoxIcon aria-hidden className="size-4 shrink-0 stroke-[1.5] text-muted" />;
  if (row.logoPath === null) return <CpuIcon aria-hidden className="size-4 shrink-0 text-muted" />;
  return <img src={row.logoPath} alt="" className="size-4 shrink-0 opacity-75 invert" />;
};

export const ModelsTable = ({ rows, selectedId, loading, onSelect, onUseCatalog }: {
  readonly rows: readonly ModelTableRow[] | null;
  readonly selectedId: string | null;
  readonly loading: boolean;
  readonly onSelect: (id: string) => void;
  /** `null` for a viewer who can't change reasoning: no `Use the catalog's`. */
  readonly onUseCatalog: ((id: string) => void) | null;
}) => {
  if (loading || rows === null) return <SkeletonRows height="h-14" />;
  if (rows.length === 0) return <p className="border-t border-line py-3 text-muted" data-testid="models-empty">{t("models.reasoning.empty")}</p>;
  const sorted = sortModelRows(rows);
  const marked = sorted.some((row) => priceDiffers(row.reasoning, row.outputPricePerMTok));
  return (
    <div data-testid="models-table">
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="h-[34px] border-b border-line text-left text-[12.5px] font-medium text-faint">
            <th className="pr-3 font-medium">{t("models.reasoning.model")}</th>
            <th className="pr-3 font-medium max-md:hidden">{t("models.reasoning.listedBy")}</th>
            <th className="pr-3 font-medium max-md:hidden">{t("models.reasoning.window")}</th>
            <th className="font-medium">{t("models.reasoning.reasoning")}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const on = row.id === selectedId;
            const line = reasoningLine(row.reasoning.controls);
            return (
              <tr
                key={row.id}
                data-model={row.name}
                aria-selected={on}
                onClick={() => { onSelect(row.id); }}
                className={cn("h-14 cursor-pointer border-b border-line hover:bg-raise", on && "bg-sel hover:bg-sel")}
              >
                <td className="py-2 pr-3 pl-1">
                  <span className="flex items-center gap-3">
                    <Logo row={row} />
                    <span className="min-w-0">
                      <button
                        type="button"
                        className={cn("block truncate text-left text-body text-text", row.custom && "font-mono")}
                        onClick={(event) => { event.stopPropagation(); onSelect(row.id); }}
                      >
                        {row.name}
                      </button>
                      <span className="block truncate font-mono text-xs text-faint">{row.custom ? t("models.reasoning.customModel") : row.catalogId}</span>
                      <span className="hidden truncate font-mono text-xs text-muted max-md:block">{listedByText(row.listedBy)} · {row.contextWindow === null ? "—" : formatCount(row.contextWindow)}</span>
                    </span>
                  </span>
                </td>
                <td className="pr-3 font-mono text-ui text-muted max-md:hidden">{listedByText(row.listedBy)}</td>
                <td className="pr-3 font-mono text-ui max-md:hidden">{row.contextWindow === null ? "—" : formatCount(row.contextWindow)}</td>
                <td className="py-2" data-testid="model-reasoning-cell">
                  <span className={cn("text-[13.5px]", line.muted ? "text-muted" : "text-text")}>{line.text}</span>
                  {priceDiffers(row.reasoning, row.outputPricePerMTok) ? <PriceMark /> : null}
                  <span className="block text-xs text-faint">
                    {sourceLine(row.reasoning)}
                    {row.reasoning.source === "admin" && onUseCatalog !== null ? (
                      <>
                        {" · "}
                        <button type="button" className="text-teal" onClick={(event) => { event.stopPropagation(); onUseCatalog(row.id); }} data-action="row-use-catalog">
                          {t("models.reasoning.useCatalog")}
                        </button>
                      </>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {marked ? <p className="mt-3 text-[12.5px] text-faint" data-testid="reasoning-price-footnote">{t("models.reasoning.priceFootnote")}</p> : null}
    </div>
  );
};
