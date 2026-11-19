"use client";

import { ArrowRightIcon, CheckIcon, CircleSlashIcon } from "lucide-react";

import { whatHappens } from "@/components/projects/project-models-words";
import { PropGroup } from "@/components/shell/page-frame";
import { SkeletonRows } from "@/components/ui/skeleton";
import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The save's preview (ADR 0065: every list save shows what moves before it applies), for a
// project's list and for the organization's default list: one shape from the API for both.

export type Preview = RouterOutputs["projects"]["previewProviders"];

/** The panel while the list has unsaved changes: what moves, what's left with no key. */
export const ProvidersPreview = ({ preview, error, conflict, used }: {
  readonly preview: Preview | undefined;
  readonly error: string | null;
  readonly conflict: boolean;
  /** The models the profiles use, by text: the preview speaks of those alone. */
  readonly used: ReadonlySet<string>;
}) => {
  if (preview === undefined) {
    return (
      <div aria-busy className="space-y-3" data-testid="providers-preview">
        <p className="text-xs font-medium text-faint">{t("projectModels.preview.label")}</p>
        {error === null ? <SkeletonRows rows={3} height="h-11" /> : <p role="alert" className="text-sm text-red">{error}</p>}
      </div>
    );
  }
  const lines = preview.lines.filter((line) => used.has(line.text));
  const changes = lines.filter((line) => line.change !== "keeps").length;
  const happens = whatHappens(
    { boxes: preview.whatHappens.released.count, providerNames: preview.whatHappens.released.providers.map((provider) => provider.name) },
    preview.whatHappens.waiting.count === 0 ? [] : [{ model: preview.whatHappens.waiting.models.map((model) => model.displayName).join(", "), tasks: preview.whatHappens.waiting.count }],
  );
  return (
    <div data-testid="providers-preview">
      <p className="mb-1 text-xs font-medium text-faint">{t("projectModels.preview.label")}</p>
      <h2 className="mb-3 text-[15px] font-semibold">
        {changes === 0 ? t("projectModels.preview.nothing") : plural(changes, "projectModels.preview.changesOne", "projectModels.preview.changesMany")}
      </h2>
      {conflict ? <p role="alert" className="mb-3 text-sm text-red">{t("projectModels.preview.conflict")}</p> : null}
      <ul className="mb-3.5">
        {lines.map((line) => (
          <li key={line.text} className="flex min-h-11 items-start gap-3 py-1" data-testid="preview-line">
            {line.change === "loses" ? (
              <CircleSlashIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75] text-red" />
            ) : line.change === "keeps" ? (
              <CheckIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75] text-faint" />
            ) : (
              <ArrowRightIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75] text-muted" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-ui text-text">{line.displayName}</span>
              {line.change === "loses" ? (
                <span className="block text-sm text-red">{t("projectModels.preview.noKeyHere")}</span>
              ) : line.change === "keeps" ? (
                <span className="block text-sm text-muted">
                  {t("projectModels.preview.staysOn")} <span className="font-mono">{line.after?.providerName}</span>
                </span>
              ) : (
                <span className="block text-sm text-muted">
                  {line.change === "gains" ? t("projectModels.preview.gainsOn") : t("projectModels.preview.movesTo")} <span className="font-mono">{line.after?.providerName}</span>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {happens === null ? null : (
        <PropGroup title={t("projectModels.preview.whatHappens")}>
          <p className="text-sm text-muted">{happens}</p>
        </PropGroup>
      )}
    </div>
  );
};
